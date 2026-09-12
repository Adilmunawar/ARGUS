'use strict';

const http = require('node:http');
const https = require('node:https');

const config = require('./config');

const MAX_BYTES = 16 * 1024 * 1024;

function notConfigured(label, variable) {
  return Object.assign(
    new Error(`${label} is not configured. Set ${variable} to point at it, or leave it unset and this ` +
      'panel stays empty rather than pretending the service is down.'),
    { name: 'NotConfigured' }
  );
}

function classify(err, label, timeoutMs) {
  const name = (err && err.name) || 'Error';
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);
  const status = err && err.status;

  if (name === 'NotConfigured') return { reason: 'not-configured', message: msg };
  if (name === 'ValidationError') return { reason: 'invalid-request', message: msg };
  if (status === 401 || status === 403) {
    return { reason: 'denied', message: `${label} refused this request with ${status}. ${msg}` };
  }
  if (status === 404) return { reason: 'not-found', message: `${label} has no such resource. ${msg}` };
  if (status === 400 || status === 422) return { reason: 'invalid-request', message: msg };
  if (code === 'ECONNREFUSED') {
    return {
      reason: 'unreachable',
      message: `Nothing is listening where ${label} should be. It sits behind the \`observability\` Compose ` +
        'profile, so a plain `docker compose up -d` does not start it: run ' +
        '`docker compose --profile observability up -d` in platform/compose.'
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      reason: 'unreachable',
      message: `${label} does not resolve from this process. That is a container-internal name, so either run ` +
        'the console on the argus network or point its URL at a published port.'
    };
  }
  if (code === 'ETIMEDOUT' || name === 'TimeoutError' || /did not answer/i.test(msg)) {
    return { reason: 'timeout', message: `${label} did not answer within ${timeoutMs} ms.` };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return { reason: 'unreachable', message: `${label} closed the connection: ${msg}` };
  }
  if (/did not return JSON/i.test(msg)) {
    return { reason: 'protocol', message: msg };
  }
  return { reason: 'error', message: msg };
}

function request(url, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs === undefined ? config.upstreamTimeoutMs : opts.timeoutMs;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(Object.assign(new Error(`${url} is not a URL.`), { name: 'ValidationError' }));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: opts.method || 'GET',
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      headers: { accept: opts.accept || 'application/json', ...(opts.headers || {}) }
    }, (res) => {
      if (opts.stream) {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(Object.assign(new Error(`${parsed.pathname} answered ${res.statusCode}`),
            { status: res.statusCode }));
        }
        return resolve(res);
      }
      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > (opts.maxBytes || MAX_BYTES)) {
          req.destroy(new Error(`${parsed.pathname} returned more than the console will read.`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(Object.assign(new Error(`${parsed.pathname} answered ${res.statusCode}: ${body.slice(0, 200)}`),
            { status: res.statusCode }));
        }
        if (opts.raw) return resolve({ status: res.statusCode, body });
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${parsed.pathname} did not return JSON.`));
        }
      });
    });
    if (timeoutMs > 0) {
      req.on('timeout', () => req.destroy(Object.assign(
        new Error(`${parsed.pathname} did not answer within ${timeoutMs} ms.`), { code: 'ETIMEDOUT' })));
    }
    req.on('error', reject);
    req.end(opts.body);
  });
}

function getJson(url, options) {
  return request(url, options);
}

function getText(url, options) {
  return request(url, { ...options, raw: true });
}

function getStream(url, options) {
  return request(url, { ...options, stream: true });
}

function join(base, path, params) {
  const url = new URL(path, base.endsWith('/') ? base : base + '/');
  for (const [name, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, String(item));
    else url.searchParams.set(name, String(value));
  }
  return url.toString();
}

module.exports = { getJson, getText, getStream, join, classify, notConfigured, MAX_BYTES };
