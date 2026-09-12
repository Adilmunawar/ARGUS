'use strict';

const authConfig = require('./config');
const operators = require('./operators');
const hash = require('./hash');
const sessions = require('./sessions');
const throttle = require('./throttle');
const gate = require('./gate');
const { audit } = require('./audit');

const LOGIN_PATH = '/api/auth/login';
const LOGOUT_PATH = '/api/auth/logout';
const SESSION_PATH = '/api/auth/session';

const WRITE_PATHS = new Set([LOGIN_PATH, LOGOUT_PATH]);

const INVALID_CREDENTIALS = {
  ok: false,
  error: 'invalid-credentials',
  message: 'Sign-in failed. Check the operator name and password.'
};

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(Object.assign(new Error('The sign-in request body is too large.'), { name: 'TooLarge' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('The request body is not valid JSON.'), { name: 'ValidationError' }));
      }
    });
    req.on('error', reject);
  });
}

async function login(req, res, context, send) {
  if (authConfig.mode !== 'session') {
    return send(res, 404, {
      ok: false,
      error: 'no-such-endpoint',
      message: `This console authenticates in ${authConfig.mode} mode, so it has no sign-in form.`
    });
  }

  let body;
  try {
    body = await readJsonBody(req, authConfig.loginBodyMaxBytes);
  } catch (err) {
    const status = err.name === 'TooLarge' ? 413 : 400;
    return send(res, status, { ok: false, error: err.name, message: err.message });
  }

  const subject = body && typeof body.subject === 'string' ? body.subject.trim() : '';
  const password = body && typeof body.password === 'string' ? body.password : '';

  const base = {
    method: req.method,
    path: context.pathname,
    sourceAddress: context.sourceAddress,
    requestId: context.requestId,
    userAgent: req.headers['user-agent']
  };

  if (!subject || !password) {
    audit('auth.login.failed', { ...base, outcome: 'failure', reason: 'incomplete', subject: subject || undefined });
    return send(res, 401, INVALID_CREDENTIALS);
  }

  const locked = throttle.state(subject, context.sourceAddress);
  if (locked.locked === 'source') {
    audit('auth.login.throttled', { ...base, subject, outcome: 'failure', reason: 'source-locked' });
    res.setHeader('retry-after', String(locked.retryAfterSeconds));
    return send(res, 429, {
      ok: false,
      error: 'too-many-attempts',
      message: `Too many failed sign-in attempts from this address. Try again in ${locked.retryAfterSeconds} seconds.`
    });
  }
  if (locked.locked === 'subject') {
    audit('auth.account.locked', { ...base, subject, outcome: 'failure', reason: 'subject-locked' });
    return send(res, 401, INVALID_CREDENTIALS);
  }

  const operator = operators.find(subject);

  let matched;
  try {
    matched = await hash.serialize(() =>
      hash.verifyOrSpendTheSameTimeOnADecoy(password, operator ? operator.password : null));
  } catch (err) {
    if (err && err.name === 'Busy') {
      audit('auth.login.throttled', { ...base, subject, outcome: 'failure', reason: 'verify-queue-full' });
      res.setHeader('retry-after', '2');
      return send(res, 429, { ok: false, error: 'busy', message: err.message });
    }
    throw err;
  }

  if (!matched) {
    const penalty = throttle.recordFailure(subject, context.sourceAddress);
    audit('auth.login.failed', { ...base, subject, outcome: 'failure', reason: 'invalid-credentials' });
    if (penalty.subject.locked) {
      audit('auth.account.locked', { ...base, subject, outcome: 'failure', reason: 'threshold-exceeded' });
    }
    if (penalty.source.locked) {
      audit('auth.login.throttled', { ...base, outcome: 'failure', reason: 'threshold-exceeded' });
    }
    return send(res, 401, INVALID_CREDENTIALS);
  }

  throttle.recordSuccess(subject, context.sourceAddress);

  const principal = {
    subject: operator.subject,
    displayName: operator.displayName,
    roles: operator.roles
  };
  const minted = sessions.create(principal, context.sourceAddress, req.headers['user-agent']);
  gate.setSessionCookie(res, minted.token);
  audit('auth.login.succeeded', {
    ...base,
    subject: operator.subject,
    outcome: 'success',
    sessionRef: sessions.ref(minted.key)
  });

  res.writeHead(204);
  return res.end();
}

async function logout(req, res, context, send) {
  const cookie = gate.readCookie(req, authConfig.cookie.name);
  const resolved = sessions.resolve(cookie.value);
  if (resolved.ok) {
    sessions.destroy(resolved.key);
    audit('auth.logout', {
      method: req.method,
      path: context.pathname,
      sourceAddress: context.sourceAddress,
      requestId: context.requestId,
      subject: resolved.session.subject,
      sessionRef: sessions.ref(resolved.key),
      outcome: 'success'
    });
  }
  gate.clearSessionCookie(res);
  res.setHeader('clear-site-data', '"cache", "cookies", "storage"');
  res.writeHead(204);
  return res.end();
}

function session(req, res, context, send, principal) {
  if (!principal) {
    return send(res, 401, {
      ok: false,
      error: 'unauthenticated',
      message: 'Sign in to read this. POST /api/auth/login with an operator name and password.'
    });
  }
  return send(res, 200, {
    ok: true,
    subject: principal.subject,
    displayName: principal.displayName,
    roles: principal.roles,
    source: principal.source,
    expiresAt: principal.expiresAt || null,
    idleExpiresAt: principal.idleExpiresAt || null
  });
}

function isAuthRoute(pathname) {
  return pathname === LOGIN_PATH || pathname === LOGOUT_PATH || pathname === SESSION_PATH;
}

module.exports = {
  login,
  logout,
  session,
  isAuthRoute,
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_PATH,
  WRITE_PATHS
};
