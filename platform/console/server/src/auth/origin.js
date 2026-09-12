'use strict';

const authConfig = require('./config');
const proxy = require('./proxy');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function targetOrigin(req) {
  if (authConfig.publicOrigin) return authConfig.publicOrigin;

  const peer = req.socket && req.socket.remoteAddress;
  if (proxy.peerTrusted(peer)) {
    const scheme = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    if ((scheme === 'http' || scheme === 'https') && forwardedHost) return `${scheme}://${forwardedHost}`;
  }

  const host = req.headers.host;
  if (!host) return '';
  const scheme = req.socket && req.socket.encrypted ? 'https' : 'http';
  return `${scheme}://${host}`;
}

function cookiePresent(req) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return false;
  return raw.split(/; */).some((pair) => pair.slice(0, pair.indexOf('=')).trim() === authConfig.cookie.name);
}

function contentTypeOf(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

function decide(req, pathname) {
  const site = req.headers['sec-fetch-site'];
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  const origin = req.headers.origin;
  const method = req.method;
  const isApi = pathname.startsWith('/api/');
  const safe = SAFE_METHODS.has(method);

  if (isApi && !safe) {
    if (contentTypeOf(req) !== 'application/json') {
      return { allowed: false, reason: 'content-type' };
    }
    if (req.headers[authConfig.clientHeader] !== '1') {
      return { allowed: false, reason: 'missing-client-header' };
    }
  }

  if (site === 'same-site' || site === 'cross-site') {
    return { allowed: false, reason: `sec-fetch-site-${site}` };
  }

  if (site === 'none') {
    if (!isApi && method === 'GET' && mode === 'navigate' && dest !== 'object' && dest !== 'embed') {
      return { allowed: true, signal: 'navigation' };
    }
    return { allowed: false, reason: 'sec-fetch-site-none' };
  }

  if (site === 'same-origin') return { allowed: true, signal: 'sec-fetch-site' };

  if (typeof origin === 'string' && origin.length > 0) {
    const target = targetOrigin(req);
    return target && target === origin
      ? { allowed: true, signal: 'origin' }
      : { allowed: false, reason: 'origin-mismatch' };
  }

  if (cookiePresent(req)) {
    return { allowed: false, reason: 'no-origin-signal' };
  }

  if (isApi && !safe) return { allowed: false, reason: 'no-origin-signal' };

  return { allowed: true, signal: 'no-ambient-authority' };
}

module.exports = { decide, targetOrigin, cookiePresent, SAFE_METHODS };
