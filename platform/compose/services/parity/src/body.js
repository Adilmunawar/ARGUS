'use strict';

const crypto = require('node:crypto');

async function text(response) {
  if (!response || !response.Body) return '';
  if (typeof response.Body.transformToString === 'function') return response.Body.transformToString();
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function payload(size, seed) {
  const source = seed || 'argus-parity';
  return Buffer.from(source.repeat(Math.ceil(size / source.length)).slice(0, size), 'utf8');
}

function md5Base64(buffer) {
  return crypto.createHash('md5').update(buffer).digest('base64');
}

function sha256Base64(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64');
}

function etagShape(etag) {
  if (!etag) return 'absent';
  const bare = etag.replace(/"/g, '');
  return /-\d+$/.test(bare) ? 'multipart' : `hex${bare.length}`;
}

module.exports = { text, payload, md5Base64, sha256Base64, etagShape };
