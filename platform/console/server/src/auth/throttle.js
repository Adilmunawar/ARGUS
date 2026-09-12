'use strict';

const authConfig = require('./config');

const bySubject = new Map();
const bySource = new Map();

const MAX_TRACKED = 4096;

function makeRoom(map, now) {
  if (map.size < MAX_TRACKED) return true;
  for (const [id, record] of map) {
    if (record.lockedUntil <= now && now - record.firstFailureAt > authConfig.lockoutWindowMs) {
      map.delete(id);
      if (map.size < MAX_TRACKED) return true;
    }
  }
  for (const [id, record] of map) {
    if (record.lockedUntil <= now) {
      map.delete(id);
      if (map.size < MAX_TRACKED) return true;
    }
  }
  return false;
}

function entry(map, id, now) {
  let record = map.get(id);
  if (!record) {
    if (!makeRoom(map, now)) return null;
    record = { count: 0, firstFailureAt: 0, lockedUntil: 0 };
    map.set(id, record);
  }
  return record;
}

function lockedFor(record, now) {
  if (!record) return 0;
  return record.lockedUntil > now ? record.lockedUntil - now : 0;
}

function state(subject, source) {
  const now = Date.now();
  const sourceMs = lockedFor(bySource.get(source), now);
  if (sourceMs > 0) {
    return { locked: 'source', retryAfterSeconds: Math.max(1, Math.ceil(sourceMs / 1000)) };
  }
  const subjectMs = lockedFor(bySubject.get(subject), now);
  if (subjectMs > 0) {
    return { locked: 'subject', retryAfterSeconds: Math.max(1, Math.ceil(subjectMs / 1000)) };
  }
  return { locked: null, retryAfterSeconds: 0 };
}

function penalise(map, id, now) {
  const record = entry(map, id, now);
  if (!record) return { locked: false, forMs: 0, count: 0 };
  if (record.firstFailureAt === 0 || now - record.firstFailureAt > authConfig.lockoutWindowMs) {
    record.count = 0;
    record.firstFailureAt = now;
  }
  record.count += 1;
  if (record.count > authConfig.lockoutThreshold) {
    const over = record.count - authConfig.lockoutThreshold - 1;
    const lockMs = Math.min(authConfig.lockoutBaseMs * Math.pow(2, over), authConfig.lockoutMaxMs);
    record.lockedUntil = now + lockMs;
    return { locked: true, forMs: lockMs, count: record.count };
  }
  return { locked: false, forMs: 0, count: record.count };
}

function recordFailure(subject, source) {
  const now = Date.now();
  return {
    subject: penalise(bySubject, subject, now),
    source: penalise(bySource, source, now)
  };
}

function recordSuccess(subject, source) {
  bySubject.delete(subject);
  bySource.delete(source);
}

function sweep() {
  const now = Date.now();
  for (const map of [bySubject, bySource]) {
    for (const [id, record] of map) {
      const windowElapsed = now - record.firstFailureAt > authConfig.lockoutWindowMs;
      if (windowElapsed && record.lockedUntil <= now) map.delete(id);
    }
  }
}

const sweeper = setInterval(sweep, authConfig.sweepIntervalMs);
sweeper.unref();

function clear() {
  bySubject.clear();
  bySource.clear();
}

module.exports = { state, recordFailure, recordSuccess, sweep, clear };
