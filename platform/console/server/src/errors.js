'use strict';

const NAME_STATUS = {
  ValidationError: { status: 400, reason: 'invalid-request' },
  NotFound: { status: 404, reason: 'not-found' },
  UnsupportedType: { status: 415, reason: 'unsupported-type' },
  TooLarge: { status: 413, reason: 'too-large' },
  Busy: { status: 429, reason: 'busy' },
  Forbidden: { status: 403, reason: 'forbidden' }
};

const REASON_STATUS = {
  'invalid-request': 400,
  'not-found': 404,
  'no-such-bucket': 404,
  'no-such-database': 404,
  'unsupported-type': 415,
  'too-large': 413,
  busy: 429,
  denied: 403,
  forbidden: 403,
  timeout: 504,
  unreachable: 503,
  'not-configured': 503,
  'no-sdk': 503,
  'clock-skew': 503
};

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { ...BASE_HEADERS, 'content-length': Buffer.byteLength(text), ...(headers || {}) });
  res.end(text);
}

function envelope(reason, message, extra) {
  return { ok: false, error: reason, reason, message, ...(extra || {}) };
}

function sendError(res, status, reason, message, extra, headers) {
  sendJson(res, status, envelope(reason, message, extra), headers);
}

function httpError(status, reason, message, extra) {
  return Object.assign(new Error(message), { name: 'HttpError', status, reason, extra: extra || null });
}

function describeError(err) {
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 && typeof err.reason === 'string') {
    return { status: err.status, reason: err.reason, message: err.message, extra: err.extra || null };
  }
  const named = err && NAME_STATUS[err.name];
  if (named) return { status: named.status, reason: named.reason, message: err.message, extra: null };
  if (err && typeof err.reason === 'string' && REASON_STATUS[err.reason]) {
    return { status: REASON_STATUS[err.reason], reason: err.reason, message: err.message, extra: null };
  }
  return { status: 500, reason: 'internal', message: 'The request failed. The reason is in the server log.', extra: null };
}

function classifiedAs(classify) {
  return (err) => {
    if (err && (NAME_STATUS[err.name] || (Number.isInteger(err.status) && typeof err.reason === 'string'))) throw err;
    const c = classify(err);
    const status = REASON_STATUS[c.reason];
    if (!status) throw err;
    throw httpError(status, c.reason, c.message);
  };
}

function levelFor(status) {
  return status >= 500 ? 'error' : 'info';
}

module.exports = {
  sendJson,
  sendError,
  envelope,
  httpError,
  describeError,
  classifiedAs,
  levelFor,
  REASON_STATUS,
  NAME_STATUS
};
