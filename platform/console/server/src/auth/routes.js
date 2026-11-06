'use strict';

const crypto = require('node:crypto');

const authConfig = require('./config');
const operators = require('./operators');
const hash = require('./hash');
const sessions = require('./sessions');
const throttle = require('./throttle');
const gate = require('./gate');
const { audit } = require('./audit');
const authorize = require('./authorize');
const { sendError, sendJson } = require('../errors');

const LOGIN_PATH = '/api/auth/login';
const LOGOUT_PATH = '/api/auth/logout';
const SESSION_PATH = '/api/auth/session';

const WRITE_PATHS = new Set([LOGIN_PATH, LOGOUT_PATH]);

const SUBJECT_MAX = 128;

const INVALID_MESSAGE = 'Sign-in failed. Check the operator name and password.';

const SUBJECT_LOG_KEY = crypto.randomBytes(32);

function subjectForLog(subject) {
  if (!subject) return undefined;
  if (operators.find(subject)) return subject;
  return 'unknown:' + crypto.createHmac('sha256', SUBJECT_LOG_KEY).update(subject).digest('hex').slice(0, 8);
}

function invalid(res) {
  return sendError(res, 401, 'invalid-credentials', INVALID_MESSAGE);
}

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

function busyAnswer(res, base, logged, source, reason, message) {
  const penalty = throttle.recordSoftFailure(source);
  audit('auth.login.throttled', { ...base, subject: logged, outcome: 'failure', reason });
  if (penalty.locked) {
    audit('auth.login.throttled', { ...base, outcome: 'failure', reason: 'threshold-exceeded' });
  }
  res.setHeader('retry-after', '2');
  return sendError(res, 429, 'busy', message);
}

async function login(req, res, context) {
  if (authConfig.mode !== 'session') {
    return sendError(res, 404, 'no-such-endpoint',
      `This console authenticates in ${authConfig.mode} mode, so it has no sign-in form.`);
  }

  let body;
  try {
    body = await readJsonBody(req, authConfig.loginBodyMaxBytes);
  } catch (err) {
    if (err.name === 'TooLarge') return sendError(res, 413, 'too-large', err.message);
    return sendError(res, 400, 'invalid-request', err.message);
  }

  const raw = body && typeof body.subject === 'string' ? body.subject.trim() : '';
  const subject = raw.length > SUBJECT_MAX ? '' : raw;
  const password = body && typeof body.password === 'string' ? body.password : '';
  const source = context.sourceAddress;
  const logged = subjectForLog(subject);

  const base = {
    method: req.method,
    path: context.pathname,
    sourceAddress: source,
    requestId: context.requestId,
    userAgent: req.headers['user-agent']
  };

  if (!subject || !password) {
    audit('auth.login.failed', { ...base, outcome: 'failure', reason: 'incomplete', subject: logged });
    return invalid(res);
  }

  const locked = throttle.state(subject, source);
  if (locked.locked === 'source') {
    audit('auth.login.throttled', { ...base, subject: logged, outcome: 'failure', reason: 'source-locked' });
    res.setHeader('retry-after', String(locked.retryAfterSeconds));
    return sendError(res, 429, 'too-many-attempts',
      `Too many failed sign-in attempts from this address. Try again in ${locked.retryAfterSeconds} seconds.`);
  }

  if (!throttle.beginVerify(source)) {
    return busyAnswer(res, base, logged, source, 'verify-in-flight',
      'A sign-in from this address is already being checked. Try again in a moment.');
  }

  const operator = locked.locked === 'subject' ? null : operators.find(subject);

  let matched;
  try {
    matched = await hash.serialize(() =>
      hash.verifyOrSpendTheSameTimeOnADecoy(password, operator ? operator.password : null));
  } catch (err) {
    throttle.endVerify(source);
    if (err && err.name === 'Busy') {
      return busyAnswer(res, base, logged, source, 'verify-queue-full', err.message);
    }
    throw err;
  }
  throttle.endVerify(source);

  if (locked.locked === 'subject') {
    throttle.recordSoftFailure(source);
    audit('auth.account.locked', { ...base, subject: logged, outcome: 'failure', reason: 'subject-locked' });
    return invalid(res);
  }

  if (!matched) {
    const penalty = throttle.recordFailure(subject, source);
    audit('auth.login.failed', { ...base, subject: logged, outcome: 'failure', reason: 'invalid-credentials' });
    if (penalty.subject.locked) {
      audit('auth.account.locked', { ...base, subject: logged, outcome: 'failure', reason: 'threshold-exceeded' });
    }
    if (penalty.source.locked) {
      audit('auth.login.throttled', { ...base, outcome: 'failure', reason: 'threshold-exceeded' });
    }
    return invalid(res);
  }

  throttle.recordSuccess(subject, source);

  const principal = {
    subject: operator.subject,
    displayName: operator.displayName,
    roles: operator.roles
  };
  const minted = sessions.create(principal, source, req.headers['user-agent']);
  gate.setSessionCookie(res, minted.token);
  audit('auth.login.succeeded', {
    ...base,
    subject: operator.subject,
    outcome: 'success',
    sessionRef: sessions.ref(minted.key),
    ...(locked.subjectLockBypassed ? { note: 'subject-lock-bypassed-clean-source' } : {})
  });

  res.writeHead(204);
  return res.end();
}

async function logout(req, res, context) {
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

function session(req, res, context, principal) {
  if (!principal) {
    return sendError(res, 401, 'unauthenticated',
      'Sign in to read this. POST /api/auth/login with an operator name and password.');
  }
  return sendJson(res, 200, {
    ok: true,
    subject: principal.subject,
    displayName: principal.displayName,
    roles: principal.roles,
    tier: authorize.tierOf(principal.roles),
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
  subjectForLog,
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_PATH,
  WRITE_PATHS
};
