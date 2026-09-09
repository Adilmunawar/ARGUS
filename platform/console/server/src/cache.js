/*
 * A TTL cache with single-flight.
 *
 * Two separate problems, both of which a dashboard hits immediately:
 *
 *   - AWS reads are billed and rate-limited. Ten operators with the estate open
 *     must not become ten DescribeInstances calls a second.
 *   - A slow call must not be started twice. Without single-flight, a page that
 *     loads six panels at once against a cold cache fires six identical calls,
 *     and the first person to open the dashboard after a deploy pays for all of
 *     them. Concurrent callers now wait on the one in-flight promise.
 *
 * Stale-on-error is deliberate: if AWS starts failing, a value from ninety
 * seconds ago with an honest `stale` flag is far more use at three in the
 * morning than an empty panel. The flag is surfaced to the UI, never hidden.
 */
'use strict';

const entries = new Map();

/**
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<any>} producer
 */
async function through(key, ttlMs, producer) {
  const now = Date.now();
  const hit = entries.get(key);

  if (hit && hit.value !== undefined && now - hit.at < ttlMs) {
    return { value: hit.value, cachedAt: new Date(hit.at).toISOString(), stale: false };
  }

  // Someone else is already fetching this exact key: wait for them.
  if (hit && hit.inflight) {
    try {
      const value = await hit.inflight;
      return { value, cachedAt: new Date(entries.get(key).at).toISOString(), stale: false };
    } catch (err) {
      if (hit.value !== undefined) {
        return { value: hit.value, cachedAt: new Date(hit.at).toISOString(), stale: true, error: describe(err) };
      }
      throw err;
    }
  }

  const inflight = producer();
  entries.set(key, { ...(hit || {}), inflight });

  try {
    const value = await inflight;
    entries.set(key, { value, at: Date.now() });
    return { value, cachedAt: new Date().toISOString(), stale: false };
  } catch (err) {
    const prior = hit && hit.value !== undefined ? hit : null;
    entries.set(key, prior ? { value: prior.value, at: prior.at } : {});
    if (prior) {
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

module.exports = { through, clear, size };
