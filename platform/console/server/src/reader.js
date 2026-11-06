'use strict';

const cache = require('./cache');

function baseClassify(err) {
  const name = (err && err.name) || 'Error';
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);

  if (name === 'NotConfigured') return { reason: 'not-configured', message: msg };
  if (name === 'ValidationError') return { reason: 'invalid-request', message: msg };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|EPIPE/.test(code)) {
    return { reason: 'unreachable', message: msg };
  }
  if (code === 'ETIMEDOUT' || name === 'TimeoutError' || name === 'AbortError') {
    return { reason: 'timeout', message: msg };
  }
  return { reason: 'error', message: msg };
}

function extend(specific) {
  return function classify(err) {
    const answer = specific(err);
    return answer || baseClassify(err);
  };
}

function suffixFor(options, args) {
  if (options.noArgs) return '';
  if (options.keyFor) return ':' + options.keyFor(...args);
  return args.length ? ':' + JSON.stringify(args) : '';
}

function guarded(key, ttlMs, producer, options) {
  const opts = options || {};
  const classify = opts.classify || baseClassify;
  return async function (...args) {
    try {
      if (opts.precheck) {
        const problem = opts.precheck();
        if (problem) return { ok: false, ...problem };
      }
      const r = await cache.through(key + suffixFor(opts, args), ttlMs,
        opts.noArgs ? producer : () => producer(...args));
      return {
        ok: true,
        ...r.value,
        cachedAt: r.cachedAt,
        stale: !!r.stale,
        ...(r.stale ? { staleBecause: classify(r.error || {}) } : {})
      };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  };
}

module.exports = { guarded, baseClassify, extend };
