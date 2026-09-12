'use strict';

const config = require('./config');
const cache = require('./cache');
const upstream = require('./upstream');
const { positiveInt } = require('./env');

const LABEL = 'Alertmanager';
const VARIABLE = 'ARGUS_ALERTMANAGER_URL';

const TIMEOUT_MS = positiveInt('ARGUS_ALERTMANAGER_TIMEOUT_MS', config.upstreamTimeoutMs);
const TTL_MS = positiveInt('ARGUS_ALERTMANAGER_TTL_MS', 10000);

const SEVERITY_RANK = { critical: 0, error: 1, warning: 2, info: 3, none: 4 };

function configured() {
  return typeof config.alertmanagerUrl === 'string' && config.alertmanagerUrl.length > 0;
}

function requireConfigured() {
  if (!configured()) throw upstream.notConfigured(LABEL, VARIABLE);
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

function severityOf(alert) {
  const labels = (alert && alert.labels) || {};
  const raw = String(labels.severity || 'none').toLowerCase();
  return SEVERITY_RANK[raw] === undefined ? 'none' : raw;
}

function shape(alert) {
  const labels = (alert && alert.labels) || {};
  const annotations = (alert && alert.annotations) || {};
  const status = (alert && alert.status) || {};
  return {
    fingerprint: alert.fingerprint || null,
    name: labels.alertname || null,
    severity: severityOf(alert),
    labels,
    summary: annotations.summary || annotations.description || null,
    startsAt: alert.startsAt || null,
    endsAt: alert.endsAt || null,
    generatorURL: alert.generatorURL || null,
    state: status.state || 'unknown',
    silencedBy: Array.isArray(status.silencedBy) ? status.silencedBy : [],
    inhibitedBy: Array.isArray(status.inhibitedBy) ? status.inhibitedBy : []
  };
}

function ranked(alerts) {
  return alerts
    .map(shape)
    .sort((a, b) => {
      const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return String(b.startsAt || '').localeCompare(String(a.startsAt || ''));
    });
}

const active = guarded('alerts:active', TTL_MS, async () => {
  const answer = await upstream.getJson(upstream.join(config.alertmanagerUrl, 'api/v2/alerts', {
    active: 'true', silenced: 'false', inhibited: 'false'
  }), { timeoutMs: TIMEOUT_MS });
  const alerts = ranked(Array.isArray(answer) ? answer : []);
  return {
    alerts,
    count: alerts.length,
    critical: alerts.filter((a) => a.severity === 'critical').length
  };
});

const groups = guarded('alerts:groups', TTL_MS, async () => {
  const answer = await upstream.getJson(upstream.join(config.alertmanagerUrl, 'api/v2/alerts/groups', {
    active: 'true', silenced: 'false', inhibited: 'false'
  }), { timeoutMs: TIMEOUT_MS });
  const list = Array.isArray(answer) ? answer : [];
  return {
    groups: list.map((group) => ({
      labels: group.labels || {},
      receiver: (group.receiver && group.receiver.name) || null,
      alerts: ranked(Array.isArray(group.alerts) ? group.alerts : [])
    }))
  };
});

const silences = guarded('alerts:silences', TTL_MS, async () => {
  const answer = await upstream.getJson(upstream.join(config.alertmanagerUrl, 'api/v2/silences', { active: 'true' }),
    { timeoutMs: TIMEOUT_MS });
  const list = Array.isArray(answer) ? answer : [];
  return {
    silences: list.map((s) => ({
      id: s.id || null,
      comment: s.comment || null,
      createdBy: s.createdBy || null,
      startsAt: s.startsAt || null,
      endsAt: s.endsAt || null,
      state: (s.status && s.status.state) || 'unknown',
      matchers: Array.isArray(s.matchers) ? s.matchers : []
    })),
    count: list.length
  };
});

const receivers = guarded('alerts:receivers', TTL_MS, async () => {
  const answer = await upstream.getJson(upstream.join(config.alertmanagerUrl, 'api/v2/receivers'),
    { timeoutMs: TIMEOUT_MS });
  const list = Array.isArray(answer) ? answer : [];
  return { receivers: list.map((r) => ({ name: r.name || null })), count: list.length };
});

const health = guarded('alerts:health', TTL_MS, async () => {
  const answer = await upstream.getJson(upstream.join(config.alertmanagerUrl, 'api/v2/status'),
    { timeoutMs: TIMEOUT_MS });
  const cluster = answer && answer.cluster ? answer.cluster : {};
  const versionInfo = answer && answer.versionInfo ? answer.versionInfo : {};
  return {
    url: config.alertmanagerUrl,
    clusterStatus: cluster.status || 'unknown',
    peers: Array.isArray(cluster.peers) ? cluster.peers.length : 0,
    version: versionInfo.version || null,
    uptime: answer && answer.uptime ? answer.uptime : null
  };
});

module.exports = { configured, active, groups, silences, receivers, health, LABEL, VARIABLE, TIMEOUT_MS };
