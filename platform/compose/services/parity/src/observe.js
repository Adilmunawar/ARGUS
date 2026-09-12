'use strict';

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

function rootCause(err) {
  let cursor = err;
  const seen = new Set();
  while (cursor && cursor.cause && !seen.has(cursor.cause)) {
    seen.add(cursor.cause);
    cursor = cursor.cause;
  }
  return cursor || err;
}

function isNetworkFailure(err) {
  const cause = rootCause(err);
  if (NETWORK_CODES.has(err && err.code)) return true;
  if (NETWORK_CODES.has(cause && cause.code)) return true;
  const name = (err && err.name) || '';
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorOutcome(err) {
  const meta = (err && err.$metadata) || {};
  const code = (err && (err.Code || err.code)) || null;
  const name = (err && err.name) || 'Error';
  const outcome = typeof code === 'string' && /^[A-Za-z]/.test(code) ? code : name;
  const record = {
    outcome,
    status: typeof meta.httpStatusCode === 'number' ? meta.httpStatusCode : null,
    message: (err && err.message) || String(err),
  };
  if (err && err.parityDetail) record.detail = err.parityDetail;
  return record;
}

async function observe(fn) {
  const started = process.hrtime.bigint();
  try {
    const detail = await fn();
    return {
      outcome: 'ok',
      status: 200,
      detail: detail === undefined ? {} : detail,
      ms: Number((process.hrtime.bigint() - started) / 1000000n),
    };
  } catch (err) {
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    if (isNetworkFailure(err)) {
      const cause = rootCause(err);
      return {
        outcome: 'unreachable',
        status: null,
        message: (cause && cause.message) || (err && err.message) || 'unreachable',
        ms,
      };
    }
    return { ...errorOutcome(err), ms };
  }
}

module.exports = { observe, isNetworkFailure, rootCause };
