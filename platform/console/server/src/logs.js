'use strict';

const config = require('./config');
const cache = require('./cache');
const upstream = require('./upstream');
const { positiveInt } = require('./env');

const LABEL = 'Loki';
const VARIABLE = 'ARGUS_LOKI_URL';

const TIMEOUT_MS = positiveInt('ARGUS_LOKI_TIMEOUT_MS', config.upstreamTimeoutMs);
const HEALTH_TTL_MS = positiveInt('ARGUS_LOKI_HEALTH_TTL_MS', 10000);
const LABELS_TTL_MS = positiveInt('ARGUS_LOKI_LABELS_TTL_MS', 30000);
const QUERY_TTL_MS = positiveInt('ARGUS_LOKI_QUERY_TTL_MS', 5000);

const LEVEL_FIELDS = ['detected_level', 'level', 'severity'];

const QUERY_MAX_CHARS = 2048;
const LIMIT_MAX = 5000;

function configured() {
  return typeof config.lokiUrl === 'string' && config.lokiUrl.length > 0;
}

function headers() {
  return config.lokiTenant ? { 'X-Scope-OrgID': config.lokiTenant } : {};
}

function rejected(message) {
  return Object.assign(new Error(message), { name: 'ValidationError' });
}

function requireConfigured() {
  if (!configured()) throw upstream.notConfigured(LABEL, VARIABLE);
}

function selector(raw) {
  const query = typeof raw === 'string' ? raw.trim() : '';
  if (!query) {
    throw rejected('A log query is required, for example {container="argus-console"}. ' +
      'GET /api/logs/labels lists the labels this Loki knows about.');
  }
  if (query.length > QUERY_MAX_CHARS) {
    throw rejected(`A log query is at most ${QUERY_MAX_CHARS} characters.`);
  }
  return query;
}

function boundedLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, LIMIT_MAX);
}

function levelOf(labels) {
  for (const field of LEVEL_FIELDS) {
    const value = labels && labels[field];
    if (typeof value === 'string' && value.length) return value.toLowerCase();
  }
  return 'unknown';
}

function flattenStreams(streams) {
  const out = [];
  for (const entry of Array.isArray(streams) ? streams : []) {
    const labels = entry && entry.stream ? entry.stream : {};
    const level = levelOf(labels);
    for (const pair of Array.isArray(entry.values) ? entry.values : []) {
      out.push({ atNs: pair[0], at: nsToIso(pair[0]), level, line: pair[1], labels });
    }
  }
  return out;
}

function nsToIso(ns) {
  const asNumber = Number(ns);
  if (!Number.isFinite(asNumber)) return null;
  return new Date(Math.round(asNumber / 1e6)).toISOString();
}

function guarded(key, ttlMs, producer) {
  return async function (...args) {
    try {
      requireConfigured();
      const cacheKey = key + (args.length ? ':' + JSON.stringify(args) : '');
      const r = await cache.through(cacheKey, ttlMs, () => producer(...args));
      return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
    } catch (err) {
      return { ok: false, ...upstream.classify(err, LABEL, TIMEOUT_MS) };
    }
  };
}

const health = guarded('loki:health', HEALTH_TTL_MS, async () => {
  const answer = await upstream.getText(upstream.join(config.lokiUrl, 'ready'),
    { timeoutMs: TIMEOUT_MS, headers: headers(), accept: 'text/plain' });
  const text = String(answer.body || '').trim();
  return {
    url: config.lokiUrl,
    tenant: config.lokiTenant || null,
    ready: /ready/i.test(text),
    detail: text.slice(0, 200)
  };
});

const labels = guarded('loki:labels', LABELS_TTL_MS, async () => {
  const answer = await upstream.getJson(upstream.join(config.lokiUrl, 'loki/api/v1/labels'),
    { timeoutMs: TIMEOUT_MS, headers: headers() });
  return { labels: Array.isArray(answer.data) ? answer.data : [] };
});

const labelValues = guarded('loki:label-values', LABELS_TTL_MS, async (name) => {
  const answer = await upstream.getJson(
    upstream.join(config.lokiUrl, `loki/api/v1/label/${encodeURIComponent(name)}/values`),
    { timeoutMs: TIMEOUT_MS, headers: headers() });
  return { name, values: Array.isArray(answer.data) ? answer.data : [] };
});

const query = guarded('loki:query', QUERY_TTL_MS, async (options) => {
  const answer = await upstream.getJson(upstream.join(config.lokiUrl, 'loki/api/v1/query_range', {
    query: options.query,
    limit: options.limit,
    start: options.start,
    end: options.end,
    since: options.since,
    direction: options.direction
  }), { timeoutMs: TIMEOUT_MS, headers: headers() });

  const data = answer && answer.data ? answer.data : {};
  return {
    query: options.query,
    resultType: data.resultType || null,
    lines: flattenStreams(data.result),
    warnings: Array.isArray(answer.warnings) ? answer.warnings : []
  };
});

const volume = guarded('loki:volume', LABELS_TTL_MS, async (options) => {
  const answer = await upstream.getJson(upstream.join(config.lokiUrl, 'loki/api/v1/index/stats', {
    query: options.query,
    start: options.start,
    end: options.end
  }), { timeoutMs: TIMEOUT_MS, headers: headers() });
  return { query: options.query, stats: answer || {} };
});

const patterns = guarded('loki:patterns', LABELS_TTL_MS, async (options) => {
  const answer = await upstream.getJson(upstream.join(config.lokiUrl, 'loki/api/v1/patterns', {
    query: options.query,
    start: options.start,
    end: options.end,
    step: options.step
  }), { timeoutMs: TIMEOUT_MS, headers: headers() });
  return { query: options.query, patterns: (answer && answer.data) || [] };
});

function tailUrl(options) {
  const base = config.lokiUrl.replace(/^http/, 'ws');
  const url = new URL('/loki/api/v1/tail', base);
  url.searchParams.set('query', options.query);
  url.searchParams.set('limit', String(options.limit));
  if (options.delayFor) url.searchParams.set('delay_for', String(options.delayFor));
  if (options.startNs) url.searchParams.set('start', String(options.startNs));
  return url.toString();
}

function openTail(options, handlers) {
  if (!configured()) {
    handlers.onUnavailable(upstream.classify(upstream.notConfigured(LABEL, VARIABLE), LABEL, TIMEOUT_MS));
    return () => {};
  }

  let socket;
  try {
    socket = new WebSocket(tailUrl(options), { headers: headers() });
  } catch (err) {
    handlers.onUnavailable(upstream.classify(err, LABEL, TIMEOUT_MS));
    return () => {};
  }

  let finished = false;
  function finish(code, reason) {
    if (finished) return;
    finished = true;
    if (handlers.onClose) handlers.onClose(code, reason);
  }

  socket.addEventListener('open', () => handlers.onOpen && handlers.onOpen());

  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch (err) {
      return;
    }
    for (const line of flattenStreams(payload.streams)) handlers.onLine(line);
    const drops = Array.isArray(payload.dropped_entries) ? payload.dropped_entries.length : 0;
    if (drops > 0 && handlers.onDropped) handlers.onDropped(drops);
  });

  socket.addEventListener('error', () => {
    handlers.onUnavailable({
      reason: 'unreachable',
      message: `${LABEL} did not accept or keep the tail connection. ` +
        'Check `docker compose --profile observability ps loki`.'
    });
    finish(null, 'the tail socket failed');
  });

  socket.addEventListener('close', (event) => finish(event && event.code, event && event.reason));

  return () => {
    try { socket.close(1000, 'client done'); } catch (err) { finish(1000, ''); }
  };
}

module.exports = {
  configured,
  health,
  labels,
  labelValues,
  query,
  volume,
  patterns,
  openTail,
  selector,
  boundedLimit,
  LABEL,
  VARIABLE,
  TIMEOUT_MS
};
