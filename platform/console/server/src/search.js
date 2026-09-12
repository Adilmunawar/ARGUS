'use strict';

const cache = require('./cache');
const storage = require('./storage');
const pg = require('./pg');
const queues = require('./queues');
const containers = require('./containers');
const alerts = require('./alerts');

const MAX_ITEMS = 2000;
const TTL_MS = 30000;

function bytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function source(kind, answer, project) {
  if (!answer || answer.ok !== true) {
    return {
      kind,
      ok: false,
      count: 0,
      items: [],
      reason: (answer && answer.reason) || 'unreachable',
      message: (answer && answer.message) || 'This reader gave no reason.'
    };
  }
  const items = project(answer).filter((item) => item && item.label);
  return { kind, ok: true, count: items.length, items, stale: answer.stale === true };
}

async function build() {
  const [bucketAnswer, databaseAnswer, streamAnswer, containerAnswer, alertAnswer] = await Promise.all([
    storage.buckets(), pg.databases(), queues.streams(), containers.list(), alerts.active()
  ]);

  const sources = [
    source('bucket', bucketAnswer, (a) => (a.buckets || []).map((b) => ({
      kind: 'Bucket',
      label: b.name,
      hint: [
        b.liveBytes === null || b.liveBytes === undefined ? null : `${bytes(b.liveBytes)} live`,
        b.lock ? `lock ${b.lock}` : null,
        b.versioning ? 'versioned' : null
      ].filter(Boolean).join(' · ') || 'object storage',
      route: 'data',
      rest: ['bucket', b.name],
      params: {}
    }))),

    source('database', databaseAnswer, (a) => (a.databases || []).map((d) => ({
      kind: 'Database',
      label: d.name,
      hint: [d.owner ? `owner ${d.owner}` : null, d.sizeBytes === null ? null : bytes(d.sizeBytes)]
        .filter(Boolean).join(' · ') || 'PostgreSQL',
      route: 'data',
      rest: ['database', d.name],
      params: {}
    }))),

    source('stream', streamAnswer, (a) => (a.streams || []).map((s) => ({
      kind: 'Stream',
      label: s.name,
      hint: [
        typeof s.messages === 'number' ? `${s.messages} messages` : null,
        typeof s.consumerCount === 'number' ? `${s.consumerCount} consumers` : null
      ].filter(Boolean).join(' · ') || 'JetStream',
      route: 'data',
      rest: ['queues'],
      params: { stream: s.name }
    }))),

    source('container', containerAnswer, (a) => (a.containers || []).map((c) => ({
      kind: 'Container',
      label: (c.names && c.names[0]) || c.id,
      hint: [c.state, c.health, c.image].filter(Boolean).join(' · ') || 'container',
      route: 'stack',
      rest: [],
      params: { container: c.id }
    }))),

    source('alert', alertAnswer, (a) => (a.alerts || []).map((al) => ({
      kind: 'Alert',
      label: al.name || al.fingerprint,
      hint: [al.severity, al.summary].filter(Boolean).join(' · ') || 'firing',
      route: 'security',
      rest: [],
      params: { alert: al.fingerprint || al.name }
    })))
  ];

  const items = [];
  let dropped = 0;
  for (const s of sources) {
    for (const item of s.items) {
      if (items.length >= MAX_ITEMS) { dropped += 1; continue; }
      items.push(item);
    }
  }

  return {
    items,
    count: items.length,
    truncated: dropped > 0,
    droppedForCap: dropped,
    cap: MAX_ITEMS,
    sources: sources.map((s) => ({
      kind: s.kind,
      ok: s.ok,
      count: s.count,
      stale: s.stale === true,
      reason: s.ok ? null : s.reason,
      message: s.ok ? null : s.message
    })),
    partial: sources.some((s) => !s.ok),
    at: new Date().toISOString()
  };
}

async function index() {
  const r = await cache.through('search:index', TTL_MS, build);
  return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
}

module.exports = { index, MAX_ITEMS, TTL_MS };
