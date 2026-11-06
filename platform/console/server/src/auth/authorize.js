'use strict';

const TIERS = ['viewer', 'operator', 'security', 'admin'];

const RANK = { viewer: 1, operator: 2, security: 3, admin: 4 };

const VIEWER = [
  '/api/health',
  '/api/capabilities',
  '/api/host',
  '/api/gitops/apps',
  '/api/gitops/environments',
  '/api/gitops/service-accounts',
  '/api/runbooks',
  '/api/runbooks/body',
  '/api/heartbeats',
  '/api/heartbeats/uptime',
  '/api/heartbeats/incidents',
  '/api/heartbeats/stream',
  '/api/storage/buckets',
  '/api/storage/capacity',
  '/api/metrics/series'
];

const OPERATOR = [
  '/api/logs/health',
  '/api/logs/labels',
  '/api/logs/label-values',
  '/api/logs/query',
  '/api/logs/volume',
  '/api/logs/patterns',
  '/api/logs/stream',
  '/api/containers',
  '/api/containers/summary',
  '/api/containers/health',
  '/api/containers/inspect',
  '/api/containers/stats',
  '/api/containers/logs',
  '/api/containers/events',
  '/api/pg/server',
  '/api/pg/databases',
  '/api/pg/activity',
  '/api/pg/statements',
  '/api/pg/replication',
  '/api/pg/tables',
  '/api/pg/health',
  '/api/storage/health',
  '/api/storage/lock-status',
  '/api/storage/objects',
  '/api/storage/object',
  '/api/storage/prefix-size',
  '/api/storage/preview',
  '/api/queues/server',
  '/api/queues/account',
  '/api/queues/streams',
  '/api/queues/consumers',
  '/api/queues/health',
  '/api/cache/server',
  '/api/cache/memory',
  '/api/cache/clients',
  '/api/cache/keyspace',
  '/api/cache/health',
  '/api/secrets/health',
  '/api/secrets/seal-status',
  '/api/secrets/ha',
  '/api/secrets/sandbox',
  '/api/alerts/active',
  '/api/alerts/groups',
  '/api/alerts/silences',
  '/api/alerts/receivers',
  '/api/alerts/health',
  '/api/metrics/health',
  '/api/metrics/targets',
  '/api/metrics/rules',
  '/api/metrics/tsdb',
  '/api/metrics/instant',
  '/api/search/index'
];

const SECURITY = [
  '/api/audit/recent',
  '/api/identity/principals',
  '/api/pg/roles'
];

const ROUTE_ROLES = Object.freeze(Object.assign(
  Object.create(null),
  ...VIEWER.map((p) => ({ [p]: 'viewer' })),
  ...OPERATOR.map((p) => ({ [p]: 'operator' })),
  ...SECURITY.map((p) => ({ [p]: 'security' }))
));

function required(pathname) {
  return ROUTE_ROLES[pathname] || 'admin';
}

function heldRank(roles) {
  let best = 0;
  for (const role of Array.isArray(roles) ? roles : []) {
    const rank = RANK[String(role).trim().toLowerCase()];
    if (rank && rank > best) best = rank;
  }
  return best || RANK.viewer;
}

function tierOf(roles) {
  return TIERS[heldRank(roles) - 1];
}

function decide(principal, pathname) {
  const need = required(pathname);
  const held = tierOf(principal && principal.roles);
  return { allowed: RANK[held] >= RANK[need], required: need, held };
}

module.exports = { decide, required, tierOf, ROUTE_ROLES, TIERS, RANK };
