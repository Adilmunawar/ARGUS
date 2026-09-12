'use strict';

const crypto = require('node:crypto');

const authConfig = require('./config');
const { audit } = require('./audit');

const TOKEN_BYTES = 32;

const sessions = new Map();

function keyFor(token) {
  return crypto.hash('sha256', token, 'base64url');
}

function ref(key) {
  return key.slice(0, 8);
}

function digest(value) {
  return crypto.hash('sha256', String(value || ''), 'base64url').slice(0, 16);
}

function evictIfFull() {
  while (sessions.size >= authConfig.maxSessions) {
    let oldestKey = null;
    let oldestSeen = Infinity;
    for (const [key, session] of sessions) {
      if (session.lastSeenAt < oldestSeen) {
        oldestSeen = session.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    const evicted = sessions.get(oldestKey);
    sessions.delete(oldestKey);
    audit('auth.session.evicted', {
      subject: evicted.subject,
      sessionRef: ref(oldestKey),
      outcome: 'success',
      reason: 'max-sessions'
    });
  }
}

function create(principal, sourceAddress, userAgent) {
  evictIfFull();
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const key = keyFor(token);
  const now = Date.now();
  sessions.set(key, {
    subject: principal.subject,
    displayName: principal.displayName,
    roles: principal.roles,
    createdAt: now,
    lastSeenAt: now,
    renewAfter: now + authConfig.renewMs,
    absoluteExpiresAt: now + authConfig.absoluteTimeoutMs,
    sourceAddress,
    userAgentDigest: digest(userAgent)
  });
  return { token, key };
}

function resolve(token) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'no-session' };
  const key = keyFor(token);
  const session = sessions.get(key);
  if (!session) return { ok: false, reason: 'unknown-session' };

  const now = Date.now();
  if (now >= session.absoluteExpiresAt) {
    sessions.delete(key);
    return { ok: false, reason: 'absolute-timeout', subject: session.subject, sessionRef: ref(key) };
  }
  if (now - session.lastSeenAt >= authConfig.idleTimeoutMs) {
    sessions.delete(key);
    return { ok: false, reason: 'idle-timeout', subject: session.subject, sessionRef: ref(key) };
  }

  session.lastSeenAt = now;
  return { ok: true, key, session, renew: now >= session.renewAfter };
}

function rotate(key) {
  const session = sessions.get(key);
  if (!session) return null;
  sessions.delete(key);
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const nextKey = keyFor(token);
  const now = Date.now();
  sessions.set(nextKey, { ...session, lastSeenAt: now, renewAfter: now + authConfig.renewMs });
  audit('auth.session.renewed', {
    subject: session.subject,
    sessionRef: ref(nextKey),
    previousSessionRef: ref(key),
    outcome: 'success'
  });
  return { token, key: nextKey };
}

function destroy(key) {
  return sessions.delete(key);
}

function destroySubject(subject) {
  let removed = 0;
  for (const [key, session] of sessions) {
    if (session.subject === subject) {
      sessions.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function sweep() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now >= session.absoluteExpiresAt) {
      sessions.delete(key);
      audit('auth.session.expired.absolute', { subject: session.subject, sessionRef: ref(key), outcome: 'success' });
    } else if (now - session.lastSeenAt >= authConfig.idleTimeoutMs) {
      sessions.delete(key);
      audit('auth.session.expired.idle', { subject: session.subject, sessionRef: ref(key), outcome: 'success' });
    }
  }
}

const sweeper = setInterval(sweep, authConfig.sweepIntervalMs);
sweeper.unref();

function size() {
  return sessions.size;
}

function clear() {
  sessions.clear();
}

module.exports = { create, resolve, rotate, destroy, destroySubject, sweep, size, clear, ref, digest, keyFor };
