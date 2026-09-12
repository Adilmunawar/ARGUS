'use strict';

const { positiveInt } = require('./env');

const entries = new Map();

const MAX_ENTRIES = positiveInt('ARGUS_CACHE_MAX_ENTRIES', 500);

const STALE_RETENTION_MULTIPLE = 4;

function retain(key, entry) {
  entries.delete(key);
  entries.set(key, entry);
}

function spent(entry, now) {
  if (entry.inflight) return false;
  if (entry.value === undefined) return true;
  return now - entry.at > entry.ttlMs * STALE_RETENTION_MULTIPLE;
}

function sweep(now) {
  for (const [key, entry] of entries) {
    if (spent(entry, now)) entries.delete(key);
  }
}

function evict() {
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value);
  }
}

async function through(key, ttlMs, producer) {
  const now = Date.now();
  const hit = entries.get(key);

  if (hit && hit.value !== undefined && now - hit.at < ttlMs) {
    retain(key, hit);
    return { value: hit.value, cachedAt: new Date(hit.at).toISOString(), stale: false };
  }

  if (hit && hit.inflight) {
    try {
      const value = await hit.inflight;
      const settled = entries.get(key);
      const at = settled && settled.at !== undefined ? settled.at : Date.now();
      return { value, cachedAt: new Date(at).toISOString(), stale: false };
    } catch (err) {
      if (hit.value !== undefined) {
        return { value: hit.value, cachedAt: new Date(hit.at).toISOString(), stale: true, error: describe(err) };
      }
      throw err;
    }
  }

  sweep(now);

  const inflight = producer();
  retain(key, { ...(hit || {}), ttlMs, inflight });

  try {
    const value = await inflight;
    retain(key, { value, at: Date.now(), ttlMs });
    evict();
    return { value, cachedAt: new Date().toISOString(), stale: false };
  } catch (err) {
    const prior = hit && hit.value !== undefined ? hit : null;
    entries.delete(key);
    if (prior) {
      retain(key, { value: prior.value, at: prior.at, ttlMs });
      evict();
      return { value: prior.value, cachedAt: new Date(prior.at).toISOString(), stale: true, error: describe(err) };
    }
    throw err;
  }
}

function describe(err) {
  return {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? err.message : String(err)
  };
}

function clear() { entries.clear(); }
function size() { return entries.size; }
function has(key) { return entries.has(key); }

module.exports = { through, clear, size, has, MAX_ENTRIES };
