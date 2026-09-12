'use strict';

const { positiveInt } = require('../env');
const base = require('../config');

const MODES = new Set(['session', 'proxy', 'off']);

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']);

const failures = [];
const notes = [];

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function isLoopback(address) {
  const trimmed = String(address || '').trim().toLowerCase();
  if (LOOPBACK.has(trimmed)) return true;
  return /^127\./.test(trimmed);
}

function readMode() {
  const raw = process.env.ARGUS_AUTH;
  if (raw === undefined || raw === '') return 'session';
  const value = String(raw).trim().toLowerCase();
  if (MODES.has(value)) return value;
  failures.push(`ARGUS_AUTH=${JSON.stringify(raw)} is not one of session, proxy or off. ` +
    'Authentication is not a setting to guess at, so this process refuses to start rather than ' +
    'fall back to a mode nobody chose.');
  return 'session';
}

function readOrigin(raw) {
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch (err) { parsed = null; }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    notes.push(`ARGUS_AUTH_PUBLIC_ORIGIN=${JSON.stringify(raw)} is not an http or https origin, ` +
      'so the target origin is derived from the request instead.');
    return '';
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function readCidrs(raw) {
  const out = [];
  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const slash = trimmed.lastIndexOf('/');
    if (slash < 1) {
      failures.push(`ARGUS_AUTH_TRUSTED_PROXY_CIDRS entry ${JSON.stringify(trimmed)} has no prefix length. ` +
        'Write it as an address and a prefix, for example 172.28.0.0/16.');
      continue;
    }
    const address = trimmed.slice(0, slash);
    const bits = Number(trimmed.slice(slash + 1));
    const family = address.includes(':') ? 'ipv6' : 'ipv4';
    const limit = family === 'ipv6' ? 128 : 32;
    if (!Number.isInteger(bits) || bits < 0 || bits > limit) {
      failures.push(`ARGUS_AUTH_TRUSTED_PROXY_CIDRS entry ${JSON.stringify(trimmed)} has a prefix length ` +
        `that is not between 0 and ${limit}.`);
      continue;
    }
    out.push({ address, bits, family });
  }
  return out;
}

function headerName(name, fallback) {
  const raw = process.env[name];
  const value = String(raw === undefined || raw === '' ? fallback : raw).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(value)) {
    notes.push(`${name}=${JSON.stringify(raw)} is not a valid header name, so ${fallback} is used instead.`);
    return fallback;
  }
  return value;
}

const mode = readMode();
const publicOrigin = readOrigin(process.env.ARGUS_AUTH_PUBLIC_ORIGIN);

const secureCookies = (() => {
  const raw = process.env.ARGUS_AUTH_SECURE_COOKIES;
  if (raw !== undefined && raw !== '') return bool('ARGUS_AUTH_SECURE_COOKIES', false);
  if (publicOrigin) return publicOrigin.startsWith('https:');
  return !isLoopback(base.host);
})();

const trustedProxyCidrs = readCidrs(process.env.ARGUS_AUTH_TRUSTED_PROXY_CIDRS);

const authConfig = {
  mode,
  publicOrigin,
  secureCookies,
  bindIsLoopback: isLoopback(base.host),

  operatorsFile: process.env.ARGUS_AUTH_OPERATORS_FILE || '/config/operators.json',

  cookie: secureCookies
    ? { name: '__Host-argus_sid', attributes: 'Path=/; Secure; HttpOnly; SameSite=Strict' }
    : { name: 'argus_sid', attributes: 'Path=/; HttpOnly; SameSite=Strict' },

  idleTimeoutMs: positiveInt('ARGUS_AUTH_IDLE_TIMEOUT_MS', 1800000),
  absoluteTimeoutMs: positiveInt('ARGUS_AUTH_ABSOLUTE_TIMEOUT_MS', 28800000),
  renewMs: positiveInt('ARGUS_AUTH_RENEW_MS', 3600000),
  maxSessions: positiveInt('ARGUS_AUTH_MAX_SESSIONS', 64),
  sweepIntervalMs: positiveInt('ARGUS_AUTH_SWEEP_INTERVAL_MS', 60000),

  lockoutThreshold: positiveInt('ARGUS_AUTH_LOCKOUT_THRESHOLD', 5),
  lockoutWindowMs: positiveInt('ARGUS_AUTH_LOCKOUT_WINDOW_MS', 900000),
  lockoutBaseMs: positiveInt('ARGUS_AUTH_LOCKOUT_BASE_MS', 1000),
  lockoutMaxMs: positiveInt('ARGUS_AUTH_LOCKOUT_MAX_MS', 900000),

  verifyQueueMax: positiveInt('ARGUS_AUTH_VERIFY_QUEUE_MAX', 4),
  loginBodyMaxBytes: positiveInt('ARGUS_AUTH_LOGIN_BODY_MAX_BYTES', 4096),

  scrypt: {
    cost: positiveInt('ARGUS_AUTH_SCRYPT_COST', 65536),
    blockSize: positiveInt('ARGUS_AUTH_SCRYPT_BLOCK_SIZE', 8),
    parallelism: positiveInt('ARGUS_AUTH_SCRYPT_PARALLELISM', 2),
    maxmem: positiveInt('ARGUS_AUTH_SCRYPT_MAXMEM', 100663296)
  },

  originEnforce: bool('ARGUS_AUTH_ORIGIN_ENFORCE', true),
  clientHeader: headerName('ARGUS_AUTH_CLIENT_HEADER', 'x-argus-console'),

  trustedProxyCidrs,
  proxyIdentityHeader: headerName('ARGUS_AUTH_PROXY_IDENTITY_HEADER', 'remote-user'),
  proxyGroupsHeader: headerName('ARGUS_AUTH_PROXY_GROUPS_HEADER', 'remote-groups'),
  proxyNameHeader: headerName('ARGUS_AUTH_PROXY_NAME_HEADER', 'remote-name'),
  proxySecretHeader: headerName('ARGUS_AUTH_PROXY_SECRET_HEADER', 'x-argus-proxy-auth'),
  proxySharedSecret: process.env.ARGUS_AUTH_PROXY_SHARED_SECRET || '',
  trustForwardedFor: bool('ARGUS_AUTH_TRUST_FORWARDED_FOR', false),

  hstsMaxAge: positiveInt('ARGUS_AUTH_HSTS_MAX_AGE', 63072000),

  failures,
  notes
};

authConfig.hstsApplies = publicOrigin.startsWith('https:');

authConfig.isLoopback = isLoopback;

authConfig.bootFailures = function bootFailures(operatorCount) {
  const out = failures.slice();

  if (mode === 'off' && !authConfig.bindIsLoopback) {
    out.push(`ARGUS_AUTH=off is a local-development mode and binds only to loopback. This process is set to ` +
      `bind ${base.host}, which would publish bucket contents, live SQL statement text, Postgres role names ` +
      'and vault seal state to anything that can reach the port, with no authentication at all. ' +
      'Set ARGUS_AUTH=session and point ARGUS_AUTH_OPERATORS_FILE at an operator file, or set ARGUS_HOST=127.0.0.1.');
  }

  if (mode === 'session' && operatorCount === 0) {
    out.push(`ARGUS_AUTH=session needs at least one enabled operator. ` +
      `${authConfig.operatorsFile} names no readable records. ` +
      'Generate one with `npm run hash-operator-password` and mount the file read-only.');
  }

  if (mode === 'proxy' && trustedProxyCidrs.length === 0) {
    out.push('ARGUS_AUTH=proxy needs ARGUS_AUTH_TRUSTED_PROXY_CIDRS. Without it every client that can reach ' +
      'this port can assert any identity by sending a header.');
  }

  if (mode === 'proxy' && !authConfig.proxySharedSecret) {
    out.push('ARGUS_AUTH=proxy needs ARGUS_AUTH_PROXY_SHARED_SECRET. The peer address alone is not proof of ' +
      'identity: anything sharing the proxy subnet would inherit the proxy\'s authority.');
  }

  return out;
};

module.exports = authConfig;
