'use strict';

const int = require('./env').positiveInt;

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const config = {
  port: int('ARGUS_PORT', 8787),
  host: process.env.ARGUS_HOST || '127.0.0.1',

  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1',

  cacheTtlMs: int('ARGUS_CACHE_TTL_MS', 30000),

  awsTimeoutMs: int('ARGUS_AWS_TIMEOUT_MS', 8000),

  costEnabled: bool('ARGUS_COST_ENABLED', false),
  costCacheTtlMs: int('ARGUS_COST_CACHE_TTL_MS', 6 * 60 * 60 * 1000),

  allowWrites: bool('ARGUS_ALLOW_WRITES', false),

  webRoot: process.env.ARGUS_WEB_ROOT || '../../prototype',

  logLevel: process.env.ARGUS_LOG_LEVEL || 'info',

  upstreamTimeoutMs: int('ARGUS_UPSTREAM_TIMEOUT_MS', 8000),

  lokiUrl: process.env.ARGUS_LOKI_URL || '',
  lokiTenant: process.env.ARGUS_LOKI_TENANT || '',
  promUrl: process.env.ARGUS_PROM_URL || '',
  alertmanagerUrl: process.env.ARGUS_ALERTMANAGER_URL || '',
  dockerProxyUrl: process.env.ARGUS_DOCKER_PROXY_URL || '',
  dockerApiVersion: process.env.ARGUS_DOCKER_API_VERSION || 'v1.43',

  logRingLines: int('ARGUS_LOG_RING_LINES', 2000),
  logRingQueries: int('ARGUS_LOG_RING_QUERIES', 8),
  logTailLimit: int('ARGUS_LOG_TAIL_LIMIT', 200),

  sseHeartbeatMs: int('ARGUS_SSE_HEARTBEAT_MS', 15000),
  sseRetryMs: int('ARGUS_SSE_RETRY_MS', 3000),
  sseMaxStreams: int('ARGUS_SSE_MAX_STREAMS', 8),

  heartbeatIntervalMs: int('ARGUS_HEARTBEAT_INTERVAL_MS', 30000),
  heartbeatMaxRetries: int('ARGUS_HEARTBEAT_MAX_RETRIES', 2),
  heartbeatBeatCap: int('ARGUS_HEARTBEAT_BEAT_CAP', 1000)
};

module.exports = config;
