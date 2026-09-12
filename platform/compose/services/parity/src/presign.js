'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKey(key) {
  return key.split('/').map(rfc3986).join('/');
}

function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((name) => `${rfc3986(name)}=${rfc3986(params[name])}`)
    .join('&');
}

function presign(options) {
  const {
    endpoint, region, credentials, method, bucket, key,
    expiresIn = 900, signedHeaders = {}, extraQuery = {}, service = 's3',
  } = options;

  const now = options.now || new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const base = new URL(endpoint);
  const path = `${base.pathname.replace(/\/$/, '')}/${bucket}/${encodeKey(key)}`;

  const headers = new Map();
  headers.set('host', base.host);
  for (const [name, value] of Object.entries(signedHeaders)) {
    headers.set(name.toLowerCase(), String(value).trim());
  }
  const headerNames = [...headers.keys()].sort();
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${headers.get(name)}`).join('\n')}\n`;
  const signedHeaderList = headerNames.join(';');

  const query = {
    ...extraQuery,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaderList,
  };

  const canonicalRequest = [
    method,
    path,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    stamp,
    `${dateStamp}/${region}/${service}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const url = `${base.origin}${path}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
  return { url, signature, stringToSign, canonicalRequest, signedHeaders: signedHeaderList };
}

function tamper(url) {
  const marker = 'X-Amz-Signature=';
  const at = url.indexOf(marker) + marker.length;
  const original = url.charAt(at);
  const replacement = original === '0' ? '1' : '0';
  return `${url.slice(0, at)}${replacement}${url.slice(at + 1)}`;
}

function request(url, options) {
  const settings = options || {};
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return reject(err); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      { method: settings.method || 'GET', headers: settings.headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.setTimeout(settings.timeoutMs || 15000, () => req.destroy(new Error('presigned request timed out')));
    req.on('error', reject);
    if (settings.body !== undefined && settings.body !== null) req.write(settings.body);
    req.end();
  });
}

function errorCodeFromBody(body) {
  const match = /<Code>([^<]+)<\/Code>/.exec(body || '');
  return match ? match[1] : null;
}

function postPolicy(options) {
  const { region, credentials, bucket, key, expiresInSeconds = 900, conditions = [], service = 's3' } = options;
  const now = options.now || new Date();
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const credential = `${credentials.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
  const policy = {
    expiration: new Date(now.getTime() + expiresInSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    conditions: [
      { bucket },
      { key },
      { 'x-amz-algorithm': ALGORITHM },
      { 'x-amz-credential': credential },
      { 'x-amz-date': stamp },
      ...conditions,
    ],
  };
  const encoded = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');
  const signature = crypto
    .createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, region, service))
    .update(encoded, 'utf8')
    .digest('hex');
  return {
    policy: encoded,
    fields: {
      key,
      'x-amz-algorithm': ALGORITHM,
      'x-amz-credential': credential,
      'x-amz-date': stamp,
      policy: encoded,
      'x-amz-signature': signature,
    },
  };
}

function multipartForm(fields, file) {
  const boundary = `argusparity${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
    `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
    'utf8',
  ));
  parts.push(Buffer.isBuffer(file.body) ? file.body : Buffer.from(String(file.body), 'utf8'));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}

module.exports = { presign, tamper, request, errorCodeFromBody, postPolicy, multipartForm, encodeKey };
