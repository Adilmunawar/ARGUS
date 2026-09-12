'use strict';

const config = require('./config');
const cache = require('./cache');
const upstream = require('./upstream');
const { positiveInt } = require('./env');

const LABEL = 'the Docker socket proxy';
const VARIABLE = 'ARGUS_DOCKER_PROXY_URL';

const TIMEOUT_MS = positiveInt('ARGUS_DOCKER_TIMEOUT_MS', config.upstreamTimeoutMs);
const LIST_TTL_MS = positiveInt('ARGUS_DOCKER_LIST_TTL_MS', 10000);
const STATS_TTL_MS = positiveInt('ARGUS_DOCKER_STATS_TTL_MS', 5000);

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const TAIL_MAX = 2000;

function configured() {
  return typeof config.dockerProxyUrl === 'string' && config.dockerProxyUrl.length > 0;
}

function requireConfigured() {
  if (!configured()) throw upstream.notConfigured(LABEL, VARIABLE);
}

function rejected(message) {
  return Object.assign(new Error(message), { name: 'ValidationError' });
}

function containerId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!ID_PATTERN.test(id)) {
    throw rejected('A container id or name is required, and must be a plain Docker identifier. ' +
      'GET /api/containers lists the ones this proxy exposes.');
  }
  return id;
}

function apiPath(suffix) {
  return `${config.dockerApiVersion}/${suffix}`;
}

function url(suffix, params) {
  return upstream.join(config.dockerProxyUrl, apiPath(suffix), params);
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

function summarise(raw) {
  const state = raw.State || 'unknown';
  const status = raw.Status || '';
  const health = /\(healthy\)/i.test(status) ? 'healthy'
    : /\(unhealthy\)/i.test(status) ? 'unhealthy'
      : /\(health: starting\)/i.test(status) ? 'starting' : null;
  return {
    id: raw.Id ? String(raw.Id).slice(0, 12) : null,
    names: Array.isArray(raw.Names) ? raw.Names.map((n) => n.replace(/^\//, '')) : [],
    image: raw.Image || null,
    state,
    status,
    health,
    createdAt: raw.Created ? new Date(raw.Created * 1000).toISOString() : null,
    ports: (Array.isArray(raw.Ports) ? raw.Ports : []).map((p) => ({
      ip: p.IP || null, private: p.PrivatePort, public: p.PublicPort || null, type: p.Type || null
    })),
    labels: raw.Labels || {}
  };
}

const list = guarded('docker:list', LIST_TTL_MS, async () => {
  const answer = await upstream.getJson(url('containers/json', { all: '1' }), { timeoutMs: TIMEOUT_MS });
  const containers = (Array.isArray(answer) ? answer : []).map(summarise);
  return {
    containers,
    count: containers.length,
    running: containers.filter((c) => c.state === 'running').length
  };
});

const inspect = guarded('docker:inspect', LIST_TTL_MS, async (id) => {
  const answer = await upstream.getJson(url(`containers/${encodeURIComponent(id)}/json`), { timeoutMs: TIMEOUT_MS });
  const state = answer.State || {};
  const hostConfig = answer.HostConfig || {};
  const containerConfig = answer.Config || {};
  return {
    id: answer.Id ? String(answer.Id).slice(0, 12) : null,
    name: answer.Name ? String(answer.Name).replace(/^\//, '') : null,
    image: containerConfig.Image || null,
    command: Array.isArray(containerConfig.Cmd) ? containerConfig.Cmd : [],
    entrypoint: Array.isArray(containerConfig.Entrypoint) ? containerConfig.Entrypoint : [],
    labels: containerConfig.Labels || {},
    state: {
      status: state.Status || 'unknown',
      running: state.Running === true,
      exitCode: state.ExitCode === undefined ? null : state.ExitCode,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
      restartCount: answer.RestartCount === undefined ? null : answer.RestartCount,
      health: state.Health ? state.Health.Status : null
    },
    restartPolicy: (hostConfig.RestartPolicy && hostConfig.RestartPolicy.Name) || null,
    memoryLimitBytes: hostConfig.Memory || null,
    environmentWithheld: Array.isArray(containerConfig.Env) ? containerConfig.Env.length : 0
  };
});

function cpuPercent(stats) {
  const cpu = stats.cpu_stats || {};
  const pre = stats.precpu_stats || {};
  const cpuDelta = (cpu.cpu_usage && cpu.cpu_usage.total_usage) - (pre.cpu_usage && pre.cpu_usage.total_usage);
  const systemDelta = cpu.system_cpu_usage - pre.system_cpu_usage;
  const cores = cpu.online_cpus || (cpu.cpu_usage && Array.isArray(cpu.cpu_usage.percpu_usage)
    ? cpu.cpu_usage.percpu_usage.length : 0);
  if (!Number.isFinite(cpuDelta) || !Number.isFinite(systemDelta) || systemDelta <= 0 || !cores) return null;
  return (cpuDelta / systemDelta) * cores;
}

const stats = guarded('docker:stats', STATS_TTL_MS, async (id) => {
  const answer = await upstream.getJson(url(`containers/${encodeURIComponent(id)}/stats`,
    { stream: '0', 'one-shot': '1' }), { timeoutMs: TIMEOUT_MS });
  const memory = answer.memory_stats || {};
  return {
    id,
    at: answer.read || null,
    cpuRatio: cpuPercent(answer),
    memoryUsedBytes: memory.usage === undefined ? null : memory.usage,
    memoryLimitBytes: memory.limit === undefined ? null : memory.limit,
    pids: answer.pids_stats && answer.pids_stats.current !== undefined ? answer.pids_stats.current : null
  };
});

const health = guarded('docker:health', LIST_TTL_MS, async () => {
  const ping = await upstream.getText(url('_ping'), { timeoutMs: TIMEOUT_MS, accept: 'text/plain' });
  let version = null;
  try {
    const answer = await upstream.getJson(url('version'), { timeoutMs: TIMEOUT_MS });
    version = answer && answer.ApiVersion ? answer.ApiVersion : null;
  } catch (err) {
    version = null;
  }
  return {
    url: config.dockerProxyUrl,
    apiVersion: config.dockerApiVersion,
    reachable: String(ping.body || '').trim().toUpperCase() === 'OK',
    daemonApiVersion: version,
    writesImpossible: true
  };
});

function demultiplex(onFrame) {
  let buffered = Buffer.alloc(0);
  return function feed(chunk) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    for (;;) {
      if (buffered.length < 8) return;
      const streamType = buffered[0];
      const size = buffered.readUInt32BE(4);
      if (buffered.length < 8 + size) return;
      onFrame(streamType, buffered.subarray(8, 8 + size));
      buffered = buffered.subarray(8 + size);
    }
  };
}

function looksMultiplexed(contentType) {
  return String(contentType || '').includes('multiplexed-stream');
}

const STREAM_NAMES = { 0: 'stdin', 1: 'stdout', 2: 'stderr' };

function splitLines(state, text, emit, streamName) {
  state.partial += text;
  const parts = state.partial.split('\n');
  state.partial = parts.pop();
  for (const line of parts) {
    if (line.length === 0) continue;
    emit(streamName, line.replace(/\r$/, ''));
  }
}

function boundedTail(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, TAIL_MAX);
}

async function openLogs(options, handlers) {
  if (!configured()) {
    handlers.onUnavailable(upstream.classify(upstream.notConfigured(LABEL, VARIABLE), LABEL, TIMEOUT_MS));
    return () => {};
  }

  let response;
  try {
    response = await upstream.getStream(url(`containers/${encodeURIComponent(options.id)}/logs`, {
      stdout: '1', stderr: '1', timestamps: '1', follow: '1', tail: String(options.tail), since: options.since
    }), { timeoutMs: 0, accept: '*/*' });
  } catch (err) {
    handlers.onUnavailable(upstream.classify(err, LABEL, TIMEOUT_MS));
    return () => {};
  }

  const multiplexed = looksMultiplexed(response.headers['content-type']);
  const state = { partial: '' };

  const emit = (streamName, line) => {
    const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/.exec(line);
    handlers.onLine({
      stream: streamName,
      at: match ? match[1] : null,
      line: match ? match[2] : line
    });
  };

  if (multiplexed) {
    const feed = demultiplex((streamType, payload) => {
      splitLines(state, payload.toString('utf8'), emit, STREAM_NAMES[streamType] || 'stdout');
    });
    response.on('data', feed);
  } else {
    response.on('data', (chunk) => splitLines(state, chunk.toString('utf8'), emit, 'stdout'));
  }

  response.on('error', (err) => handlers.onUnavailable(upstream.classify(err, LABEL, TIMEOUT_MS)));
  response.on('end', () => handlers.onClose && handlers.onClose());

  return () => { response.destroy(); };
}

async function openEvents(handlers) {
  if (!configured()) {
    handlers.onUnavailable(upstream.classify(upstream.notConfigured(LABEL, VARIABLE), LABEL, TIMEOUT_MS));
    return () => {};
  }

  let response;
  try {
    response = await upstream.getStream(url('events', {
      since: String(Math.floor(Date.now() / 1000)),
      filters: JSON.stringify({ type: ['container'] })
    }), { timeoutMs: 0 });
  } catch (err) {
    handlers.onUnavailable(upstream.classify(err, LABEL, TIMEOUT_MS));
    return () => {};
  }

  let partial = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    partial += chunk;
    const parts = partial.split('\n');
    partial = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (err) { continue; }
      const actor = event.Actor || {};
      const attributes = actor.Attributes || {};
      handlers.onEvent({
        action: event.Action || null,
        type: event.Type || null,
        name: attributes.name || null,
        image: attributes.image || null,
        at: event.time ? new Date(event.time * 1000).toISOString() : null
      });
    }
  });

  response.on('error', (err) => handlers.onUnavailable(upstream.classify(err, LABEL, TIMEOUT_MS)));
  response.on('end', () => handlers.onClose && handlers.onClose());

  return () => { response.destroy(); };
}

module.exports = {
  configured,
  list,
  inspect,
  stats,
  health,
  openLogs,
  openEvents,
  demultiplex,
  containerId,
  boundedTail,
  LABEL,
  VARIABLE,
  TIMEOUT_MS
};
