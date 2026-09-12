'use strict';

const authConfig = require('./config');
const sessions = require('./sessions');
const proxyAuth = require('./proxy');
const { audit } = require('./audit');

const DISABLED_PRINCIPAL = Object.freeze({
  subject: 'local-development',
  displayName: 'Local development',
  roles: ['admin'],
  source: 'disabled'
});

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return { value: null, duplicated: false };
  let value = null;
  let seen = 0;
  for (const pair of raw.split(/; */)) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    seen += 1;
    value = pair.slice(eq + 1).trim();
  }
  return { value, duplicated: seen > 1 };
}

function appendSetCookie(res, line) {
  const existing = res.getHeader('set-cookie');
  if (existing === undefined) res.setHeader('set-cookie', [line]);
  else res.setHeader('set-cookie', (Array.isArray(existing) ? existing : [existing]).concat(line));
}

function setSessionCookie(res, token) {
  appendSetCookie(res, `${authConfig.cookie.name}=${token}; ${authConfig.cookie.attributes}`);
  res.setHeader('cache-control', 'no-store');
}

function clearSessionCookie(res) {
  appendSetCookie(res, `${authConfig.cookie.name}=; ${authConfig.cookie.attributes}; Max-Age=0`);
  res.setHeader('cache-control', 'no-store');
}

function resolvePrincipal(req, res, context) {
  if (authConfig.mode === 'off') {
    return { principal: DISABLED_PRINCIPAL, reason: 'auth-disabled' };
  }

  if (authConfig.mode === 'proxy') {
    const identified = proxyAuth.identify(req);
    if (!identified.ok) {
      audit(identified.reason === 'untrusted-peer' ? 'auth.proxy.untrusted' : 'auth.denied', {
        outcome: 'failure',
        reason: identified.reason,
        sourceAddress: context.sourceAddress,
        method: req.method,
        path: context.pathname,
        requestId: context.requestId,
        userAgent: req.headers['user-agent']
      });
      return { principal: null, reason: identified.reason };
    }
    return {
      principal: {
        subject: identified.subject,
        displayName: identified.displayName,
        roles: identified.roles,
        source: 'proxy'
      },
      reason: 'proxy'
    };
  }

  const cookie = readCookie(req, authConfig.cookie.name);
  if (cookie.duplicated) {
    audit('auth.session.anomaly', {
      outcome: 'defer',
      reason: 'duplicate-session-cookie',
      sourceAddress: context.sourceAddress,
      method: req.method,
      path: context.pathname,
      requestId: context.requestId
    });
  }

  const resolved = sessions.resolve(cookie.value);
  if (!resolved.ok) {
    if (resolved.reason === 'idle-timeout' || resolved.reason === 'absolute-timeout') {
      audit(resolved.reason === 'idle-timeout' ? 'auth.session.expired.idle' : 'auth.session.expired.absolute', {
        outcome: 'failure',
        reason: resolved.reason,
        subject: resolved.subject,
        sessionRef: resolved.sessionRef,
        sourceAddress: context.sourceAddress,
        method: req.method,
        path: context.pathname,
        requestId: context.requestId
      });
      clearSessionCookie(res);
    } else if (resolved.reason === 'unknown-session') {
      audit('auth.session.rejected', {
        outcome: 'failure',
        reason: resolved.reason,
        sourceAddress: context.sourceAddress,
        method: req.method,
        path: context.pathname,
        requestId: context.requestId
      });
      clearSessionCookie(res);
    }
    return { principal: null, reason: resolved.reason };
  }

  const session = resolved.session;
  let key = resolved.key;

  if (session.userAgentDigest !== sessions.digest(req.headers['user-agent'])) {
    audit('auth.session.anomaly', {
      outcome: 'defer',
      reason: 'user-agent-changed',
      subject: session.subject,
      sessionRef: sessions.ref(key),
      sourceAddress: context.sourceAddress,
      requestId: context.requestId
    });
    session.userAgentDigest = sessions.digest(req.headers['user-agent']);
  }

  if (session.sourceAddress !== context.sourceAddress) {
    audit('auth.session.anomaly', {
      outcome: 'defer',
      reason: 'source-address-changed',
      subject: session.subject,
      sessionRef: sessions.ref(key),
      sourceAddress: context.sourceAddress,
      requestId: context.requestId
    });
    session.sourceAddress = context.sourceAddress;
  }

  if (resolved.renew) {
    const rotated = sessions.rotate(key);
    if (rotated) {
      key = rotated.key;
      setSessionCookie(res, rotated.token);
    }
  }

  return {
    principal: {
      subject: session.subject,
      displayName: session.displayName,
      roles: session.roles,
      source: 'session',
      sessionKey: key,
      expiresAt: new Date(session.absoluteExpiresAt).toISOString(),
      idleExpiresAt: new Date(session.lastSeenAt + authConfig.idleTimeoutMs).toISOString()
    },
    reason: 'session'
  };
}

module.exports = {
  resolvePrincipal,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  DISABLED_PRINCIPAL
};
