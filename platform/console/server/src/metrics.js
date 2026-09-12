'use strict';

const config = require('./config');
const cache = require('./cache');
const upstream = require('./upstream');
const { positiveInt } = require('./env');

const LABEL = 'Prometheus';
const VARIABLE = 'ARGUS_PROM_URL';

const TIMEOUT_MS = positiveInt('ARGUS_PROM_TIMEOUT_MS', config.upstreamTimeoutMs);
const HEALTH_TTL_MS = positiveInt('ARGUS_PROM_HEALTH_TTL_MS', 10000);
const SERIES_TTL_MS = positiveInt('ARGUS_PROM_SERIES_TTL_MS', 15000);
const STATUS_TTL_MS = positiveInt('ARGUS_PROM_STATUS_TTL_MS', 30000);

const SERIES = {
  hostCpuBusyRatio:
    '1 - avg without (cpu) (rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  hostMemoryUsedRatio:
    '1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
  hostDiskUsedRatio:
    '1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"})',
  pgConnectionsUsedRatio:
    'sum(pg_stat_database_numbackends) / max(pg_settings_max_connections)',
  pgTransactionRate:
    'sum(rate(pg_stat_database_xact_commit[5m]) + rate(pg_stat_database_xact_rollback[5m]))',
  cacheHitRatio:
    'rate(redis_keyspace_hits_total[5m]) / clamp_min(rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]), 1)',
  cacheMemoryUsedBytes:
    'redis_memory_used_bytes',
  natsSlowConsumers:
    'sum(gnatsd_varz_slow_consumers)',
  natsMessagesInRate:
    'sum(rate(gnatsd_varz_in_msgs[5m]))',
  scrapeTargetsDown:
    'count(up == 0)'
};

const RATIO_SERIES = new Set([
  'hostCpuBusyRatio', 'hostMemoryUsedRatio', 'hostDiskUsedRatio', 'pgConnectionsUsedRatio', 'cacheHitRatio'
]);

const STEP_LADDER = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400];

const WINDOW_MAX_MS = 366 * 24 * 3600 * 1000;
const POINTS_MAX = 1000;

function configured() {
  return typeof config.promUrl === 'string' && config.promUrl.length > 0;
}

function rejected(message) {
  return Object.assign(new Error(message), { name: 'ValidationError' });
}

function seriesNames() {
  return Object.keys(SERIES);
}

function expressionFor(name) {
  const expression = SERIES[name];
  if (!expression) {
    throw rejected(`There is no named series called ${JSON.stringify(String(name || ''))}. ` +
      `This console does not accept free-text PromQL; the names it answers for are: ${seriesNames().join(', ')}.`);
  }
  return expression;
}

function stepFor(startMs, endMs, targetPoints) {
  const spanSeconds = Math.max(1, Math.round((endMs - startMs) / 1000));
  const raw = Math.ceil(spanSeconds / Math.max(1, targetPoints));
  for (const step of STEP_LADDER) if (step >= raw) return step;
  return STEP_LADDER[STEP_LADDER.length - 1];
}

function windowMs(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, WINDOW_MAX_MS);
}

function points(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, POINTS_MAX);
}

function requireConfigured() {
  if (!configured()) throw upstream.notConfigured(LABEL, VARIABLE);
}

function unwrap(answer) {
  if (!answer || answer.status !== 'success') {
    const detail = answer && answer.error ? answer.error : 'no reason given';
    throw Object.assign(new Error(`${LABEL} refused the query: ${detail}`), { name: 'ValidationError' });
  }
  return answer;
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

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const health = guarded('prom:health', HEALTH_TTL_MS, async () => {
  const answer = await upstream.getText(upstream.join(config.promUrl, '-/healthy'),
    { timeoutMs: TIMEOUT_MS, accept: 'text/plain' });
  let ready = false;
  try {
    await upstream.getText(upstream.join(config.promUrl, '-/ready'), { timeoutMs: TIMEOUT_MS, accept: 'text/plain' });
    ready = true;
  } catch (err) {
    ready = false;
  }
  return { url: config.promUrl, healthy: true, ready, detail: String(answer.body || '').trim().slice(0, 200) };
});

const series = guarded('prom:series', SERIES_TTL_MS, async (options) => {
  const expression = expressionFor(options.name);
  const end = Date.now();
  const start = end - options.windowMs;
  const step = stepFor(start, end, options.points);

  const answer = unwrap(await upstream.getJson(upstream.join(config.promUrl, 'api/v1/query_range', {
    query: expression,
    start: Math.round(start / 1000),
    end: Math.round(end / 1000),
    step
  }), { timeoutMs: TIMEOUT_MS }));

  const result = answer.data && Array.isArray(answer.data.result) ? answer.data.result : [];
  return {
    name: options.name,
    expression,
    stepSeconds: step,
    windowMs: options.windowMs,
    isRatio: RATIO_SERIES.has(options.name),
    series: result.map((entry) => ({
      labels: entry.metric || {},
      points: (entry.values || []).map((pair) => ({ at: pair[0] * 1000, value: numeric(pair[1]) }))
    })),
    warnings: Array.isArray(answer.warnings) ? answer.warnings : []
  };
});

const instant = guarded('prom:instant', SERIES_TTL_MS, async (name) => {
  const expression = expressionFor(name);
  const answer = unwrap(await upstream.getJson(upstream.join(config.promUrl, 'api/v1/query', { query: expression }),
    { timeoutMs: TIMEOUT_MS }));
  const result = answer.data && Array.isArray(answer.data.result) ? answer.data.result : [];
  return {
    name,
    expression,
    isRatio: RATIO_SERIES.has(name),
    samples: result.map((entry) => ({
      labels: entry.metric || {},
      at: entry.value ? entry.value[0] * 1000 : null,
      value: entry.value ? numeric(entry.value[1]) : null
    }))
  };
});

const targets = guarded('prom:targets', STATUS_TTL_MS, async () => {
  const answer = unwrap(await upstream.getJson(upstream.join(config.promUrl, 'api/v1/targets', { state: 'any' }),
    { timeoutMs: TIMEOUT_MS }));
  const active = (answer.data && answer.data.activeTargets) || [];
  return {
    targets: active.map((t) => ({
      job: (t.labels && t.labels.job) || null,
      instance: (t.labels && t.labels.instance) || null,
      scrapePool: t.scrapePool || null,
      health: t.health || 'unknown',
      lastScrape: t.lastScrape || null,
      lastError: t.lastError || null
    })),
    down: active.filter((t) => t.health !== 'up').length,
    total: active.length
  };
});

const rules = guarded('prom:rules', STATUS_TTL_MS, async () => {
  const answer = unwrap(await upstream.getJson(upstream.join(config.promUrl, 'api/v1/rules'),
    { timeoutMs: TIMEOUT_MS }));
  const groups = (answer.data && answer.data.groups) || [];
  return {
    groups: groups.map((g) => ({
      name: g.name,
      file: g.file,
      rules: (g.rules || []).map((r) => ({
        name: r.name,
        type: r.type,
        state: r.state || null,
        health: r.health || null,
        lastError: r.lastError || null
      }))
    }))
  };
});

const tsdb = guarded('prom:tsdb', STATUS_TTL_MS, async () => {
  const answer = unwrap(await upstream.getJson(upstream.join(config.promUrl, 'api/v1/status/tsdb'),
    { timeoutMs: TIMEOUT_MS }));
  return { tsdb: answer.data || {} };
});

module.exports = {
  configured,
  health,
  series,
  instant,
  targets,
  rules,
  tsdb,
  seriesNames,
  expressionFor,
  stepFor,
  windowMs,
  points,
  SERIES,
  LABEL,
  VARIABLE,
  TIMEOUT_MS
};
