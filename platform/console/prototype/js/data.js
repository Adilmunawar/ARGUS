/* Argus Console: the demonstration dataset.
 *
 * The prototype has no backend. Every number below is invented, but the shape of
 * it is not: entities, identities, ports, buckets and dependencies are taken from
 * docs/02-APPLICATION-INFRASTRUCTURE-MAP.md so that a screen built against this
 * data will still be correct when a real API replaces it.
 *
 * Loaded as a classic script so the console runs from file:// with no build step
 * and no network, which ADR-0027 requires.
 */
(function () {
  'use strict';

  var A = (window.ARGUS = window.ARGUS || {});

  // A fixed clock keeps screenshots and tests deterministic.
  var NOW = new Date('2026-09-08T09:14:00Z');

  function minutesAgo(n) { return new Date(NOW.getTime() - n * 60000); }
  function hoursAgo(n) { return minutesAgo(n * 60); }
  function daysAgo(n) { return hoursAgo(n * 24); }

  // A small deterministic generator, so a series looks alive but never changes
  // between runs. Tests compare rendered output, so randomness would be a bug.
  function series(count, base, spread, seed) {
    var out = [], s = seed || 1;
    for (var i = 0; i < count; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      out.push(Math.round((base + ((s / 2147483648) - 0.5) * spread) * 100) / 100);
    }
    return out;
  }

  var data = {
    now: NOW,

    environments: [
      { id: 'production', label: 'Production', tone: 'cane' },
      { id: 'staging', label: 'Staging', tone: 'brand' }
    ],

    // The signed-in operator. Role drives what every screen allows.
    me: {
      name: 'Adil Munawar',
      upn: 'adil@argus.local',
      role: 'Operator',
      roles: ['Viewer', 'Operator', 'Approver', 'Security', 'Admin'],
      tier: 1,
      mfa: 'FIDO2 security key',
      elevation: null
    },

    sites: [
      { id: 'a', name: 'Site A', location: 'Lahore', role: 'primary', link: 'up', latencyMs: 4, replicationLagS: 38 },
      { id: 'b', name: 'Site B', location: 'Karachi colocation', role: 'secondary', link: 'up', latencyMs: 27, replicationLagS: 214 }
    ],

    hosts: [
      { name: 'hv-01', site: 'a', role: 'Hyper-V + S2D', cpu: 41, mem: 63, uptimeDays: 62, patchAgeDays: 6, wdac: 'audit', s2d: 'healthy', vms: 7, state: 'ok' },
      { name: 'hv-02', site: 'a', role: 'Hyper-V + S2D', cpu: 38, mem: 58, uptimeDays: 62, patchAgeDays: 6, wdac: 'audit', s2d: 'healthy', vms: 6, state: 'ok' },
      { name: 'hv-03', site: 'a', role: 'Hyper-V + S2D', cpu: 55, mem: 71, uptimeDays: 12, patchAgeDays: 34, wdac: 'audit', s2d: 'repairing', vms: 8, state: 'warn' },
      { name: 'gpu-01', site: 'a', role: 'ML node (Ubuntu)', cpu: 78, mem: 66, uptimeDays: 41, patchAgeDays: 11, wdac: 'n/a', s2d: 'n/a', vms: 0, state: 'ok' },
      { name: 'hgs-01', site: 'a', role: 'Host Guardian Service', cpu: 4, mem: 22, uptimeDays: 88, patchAgeDays: 6, wdac: 'audit', s2d: 'n/a', vms: 0, state: 'ok' },
      { name: 'hv-b01', site: 'b', role: 'Hyper-V, replica target', cpu: 19, mem: 44, uptimeDays: 55, patchAgeDays: 9, wdac: 'audit', s2d: 'healthy', vms: 5, state: 'ok' },
      { name: 'hv-b02', site: 'b', role: 'Hyper-V, replica target', cpu: 16, mem: 39, uptimeDays: 55, patchAgeDays: 9, wdac: 'audit', s2d: 'healthy', vms: 4, state: 'ok' }
    ],

    vms: [
      { name: 'sql-01', host: 'hv-01', site: 'a', os: 'Windows Server 2025', role: 'SQL Server 2022, AG primary', vcpu: 16, ram: 128, ip: '10.31.0.20', state: 'running', replica: 'healthy', checkpointAgeMin: 4, connect: ['rdp', 'powershell'], zone: 'DATA 31' },
      { name: 'sql-02', host: 'hv-b01', site: 'b', os: 'Windows Server 2025', role: 'AG async secondary', vcpu: 16, ram: 128, ip: '10.131.0.20', state: 'running', replica: 'n/a', checkpointAgeMin: 0, connect: ['rdp', 'powershell'], zone: 'DATA-B' },
      { name: 'pg-01', host: 'hv-02', site: 'a', os: 'Windows Server 2025', role: 'PostgreSQL 17 + PostGIS', vcpu: 8, ram: 64, ip: '10.31.0.30', state: 'running', replica: 'healthy', checkpointAgeMin: 7, connect: ['rdp', 'powershell'], zone: 'DATA 31' },
      { name: 'dc-01', host: 'hv-01', site: 'a', os: 'Windows Server 2025 Core', role: 'AD DS, DNS, FSMO', vcpu: 4, ram: 8, ip: '10.11.0.10', state: 'running', replica: 'off', checkpointAgeMin: 0, connect: ['powershell'], zone: 'TIER0 11' },
      { name: 'dc-02', host: 'hv-02', site: 'a', os: 'Windows Server 2025 Core', role: 'AD DS, DNS', vcpu: 4, ram: 8, ip: '10.11.0.11', state: 'running', replica: 'off', checkpointAgeMin: 0, connect: ['powershell'], zone: 'TIER0 11' },
      { name: 'adfs-01', host: 'hv-03', site: 'a', os: 'Windows Server 2025', role: 'AD FS, OIDC and SAML', vcpu: 4, ram: 8, ip: '10.11.0.20', state: 'running', replica: 'healthy', checkpointAgeMin: 9, connect: ['rdp', 'powershell'], zone: 'TIER0 11' },
      { name: 'ca-issuing-01', host: 'hv-02', site: 'a', os: 'Windows Server 2025', role: 'AD CS issuing CA', vcpu: 4, ram: 8, ip: '10.11.0.30', state: 'running', replica: 'healthy', checkpointAgeMin: 11, connect: ['rdp'], zone: 'TIER0 11' },
      { name: 'legacy-landsurvey-01', host: 'hv-03', site: 'a', os: 'Windows Server 2019', role: 'Legacy LandSurvey API (IIS)', vcpu: 4, ram: 16, ip: '10.30.1.40', state: 'running', replica: 'healthy', checkpointAgeMin: 6, connect: ['rdp', 'powershell'], zone: 'PLATFORM 30' },
      { name: 'siem-01', host: 'hv-03', site: 'a', os: 'Ubuntu 24.04 LTS', role: 'Wazuh manager, indexer, dashboard', vcpu: 8, ram: 32, ip: '10.12.0.10', state: 'running', replica: 'healthy', checkpointAgeMin: 5, connect: ['ssh'], zone: 'SEC 12' },
      { name: 'guac-01', host: 'hv-02', site: 'a', os: 'Ubuntu 24.04 LTS', role: 'Guacamole RDP/SSH gateway', vcpu: 4, ram: 8, ip: '10.30.1.50', state: 'running', replica: 'healthy', checkpointAgeMin: 8, connect: ['ssh'], zone: 'PLATFORM 30' },
      { name: 'wef-01', host: 'hv-01', site: 'a', os: 'Windows Server 2025', role: 'Event forwarding collector', vcpu: 4, ram: 16, ip: '10.12.0.20', state: 'running', replica: 'healthy', checkpointAgeMin: 12, connect: ['rdp', 'powershell'], zone: 'SEC 12' },
      { name: 'runner-01', host: 'hv-03', site: 'a', os: 'Windows Server 2025', role: 'GitHub Actions runner, code signing', vcpu: 8, ram: 32, ip: '10.32.0.10', state: 'running', replica: 'off', checkpointAgeMin: 0, connect: ['rdp'], zone: 'BUILD 32' },
      { name: 'forgejo-01', host: 'hv-01', site: 'a', os: 'Windows Server 2025', role: 'Forgejo mirror', vcpu: 4, ram: 8, ip: '10.32.0.20', state: 'running', replica: 'healthy', checkpointAgeMin: 14, connect: ['rdp'], zone: 'BUILD 32' },
      { name: 'kuma-b01', host: 'hv-b02', site: 'b', os: 'Windows Server 2025', role: 'Uptime Kuma, status page', vcpu: 2, ram: 4, ip: '10.120.0.10', state: 'running', replica: 'n/a', checkpointAgeMin: 0, connect: ['rdp'], zone: 'DMZ-B' }
    ],

    sfNodes: [
      { name: 'sf-01', host: 'hv-01', seed: true, ud: 0, state: 'up', apps: ['ArgusConsoleApi', 'Caddy', 'Nats', 'OpenBao'] },
      { name: 'sf-02', host: 'hv-02', seed: true, ud: 1, state: 'up', apps: ['ArgusConsoleWeb', 'Nats', 'OpenBao', 'MillsApi'] },
      { name: 'sf-03', host: 'hv-03', seed: true, ud: 2, state: 'up', apps: ['ArgusReconciler', 'Nats', 'OpenBao', 'MillsApi'] },
      { name: 'sf-04', host: 'hv-01', seed: false, ud: 3, state: 'up', apps: ['MillsApi', 'MillsWeb', 'Garnet', 'Titiler'] },
      { name: 'sf-05', host: 'hv-02', seed: false, ud: 4, state: 'upgrading', apps: ['MillsGateway', 'MillsWeb', 'Garnet', 'Martin'] }
    ],

    apps: [
      {
        name: 'mills', display: 'Mills Dashboard', owner: 'zayan', tier: 1, env: 'production',
        version: '2026.09.08.1', staging: '2026.09.08.2', health: 'ok', instances: 3,
        p95: 212, rps: 47, errorRate: 0.0021, slo: 99.94, uptimeDays: 14,
        deployedAt: hoursAgo(3), identity: 'gmsa-mills$', host: 'mills.zaraatdost.pk',
        depends: { databases: ['umairv3_db', 'FarmerFacilitatorDb'], buckets: ['argus-survey-pictures'], caches: ['Garnet'], queues: ['argus.ingest.mills.*'], secrets: ['kv/mills/jwt-signing-key', 'kv/mills/anthropic'], external: ['api.anthropic.com', 'earthengine.googleapis.com'] },
        services: [
          { name: 'MillsGateway', exe: 'MillsDashboard.Gateway.exe', instances: 2, port: 5140 },
          { name: 'MillsApi', exe: 'MillsDashboard.Api.exe', instances: 3, port: 5141 },
          { name: 'MillsWeb', exe: 'node.exe', instances: 2, port: 3100 }
        ],
        trend: { rps: series(24, 47, 22, 7), p95: series(24, 212, 90, 11), err: series(24, 0.2, 0.3, 13) }
      },
      {
        name: 'loan', display: 'Farmer Loan API', owner: 'zayan', tier: 1, env: 'production',
        version: '2026.09.01.3', staging: '2026.09.01.3', health: 'ok', instances: 2,
        p95: 143, rps: 9, errorRate: 0.0004, slo: 99.99, uptimeDays: 38,
        deployedAt: daysAgo(7), identity: 'gmsa-loan$', host: 'loans.zaraatdost.pk',
        depends: { databases: ['FarmerFacilitatorDb'], buckets: ['argus-survey-pictures'], caches: ['Garnet'], queues: [], secrets: ['db/creds/loan-api'], external: [] },
        services: [{ name: 'LoanApi', exe: 'Loan.Api.exe', instances: 2, port: 5160 }],
        trend: { rps: series(24, 9, 6, 17), p95: series(24, 143, 40, 19), err: series(24, 0.05, 0.1, 23) }
      },
      {
        name: 'agis', display: 'AGIS', owner: 'adil', tier: 2, env: 'production',
        version: '2026.08.22.4', staging: '2026.09.05.1', health: 'warn', instances: 2,
        p95: 688, rps: 4, errorRate: 0.0139, slo: 99.71, uptimeDays: 17,
        deployedAt: daysAgo(17), identity: 'gmsa-agis$', host: 'agis.zaraatdost.pk',
        depends: { databases: ['argus_geo'], buckets: ['argus-rasters'], caches: [], queues: [], secrets: ['kv/agis/firebase'], external: ['firebase.googleapis.com'] },
        services: [{ name: 'AgisWeb', exe: 'node.exe', instances: 2, port: 3400 }],
        trend: { rps: series(24, 4, 3, 29), p95: series(24, 688, 260, 31), err: series(24, 1.4, 1.2, 37) }
      },
      {
        name: 'console', display: 'Argus Console', owner: 'adil', tier: 0, env: 'production',
        version: '0.5.0', staging: '0.5.1', health: 'ok', instances: 3,
        p95: 74, rps: 3, errorRate: 0, slo: 100, uptimeDays: 21,
        deployedAt: daysAgo(2), identity: 'gmsa-console$', host: 'console.zaraatdost.pk',
        depends: { databases: ['ArgusConsole', 'argus_console_events'], buckets: ['argus-sessions'], caches: ['Garnet'], queues: [], secrets: ['kv/console/session-key'], external: [] },
        services: [
          { name: 'ArgusConsoleApi', exe: 'Argus.Console.Api.exe', instances: 3, port: 5200 },
          { name: 'ArgusConsoleWeb', exe: 'node.exe', instances: 2, port: 3200 }
        ],
        trend: { rps: series(24, 3, 2, 41), p95: series(24, 74, 25, 43), err: series(24, 0, 0.02, 47) }
      },
      {
        name: 'caddy', display: 'Caddy edge', owner: 'platform', tier: 1, env: 'production',
        version: '2.10.0', staging: '2.10.0', health: 'ok', instances: 2,
        p95: 3, rps: 64, errorRate: 0.0009, slo: 99.98, uptimeDays: 62,
        deployedAt: daysAgo(30), identity: 'gmsa-caddy$', host: '10.20.0.10',
        depends: { databases: [], buckets: [], caches: [], queues: [], secrets: [], external: ["Let's Encrypt"] },
        services: [{ name: 'Caddy', exe: 'caddy.exe', instances: 2, port: 443 }],
        trend: { rps: series(24, 64, 30, 53), p95: series(24, 3, 2, 59), err: series(24, 0.09, 0.1, 61) }
      },
      {
        name: 'nats', display: 'NATS JetStream', owner: 'platform', tier: 1, env: 'production',
        version: '2.11.4', staging: '2.11.4', health: 'ok', instances: 3,
        p95: 1, rps: 118, errorRate: 0, slo: 100, uptimeDays: 62,
        deployedAt: daysAgo(30), identity: 'gmsa-nats$', host: 'nats.argus.local',
        depends: { databases: [], buckets: [], caches: [], queues: [], secrets: [], external: [] },
        services: [{ name: 'Nats', exe: 'nats-server.exe', instances: 3, port: 4222 }],
        trend: { rps: series(24, 118, 40, 67), p95: series(24, 1, 1, 71), err: series(24, 0, 0.01, 73) }
      },
      {
        name: 'openbao', display: 'OpenBao', owner: 'platform', tier: 0, env: 'production',
        version: '2.6.1', staging: '2.6.1', health: 'ok', instances: 3,
        p95: 6, rps: 21, errorRate: 0, slo: 100, uptimeDays: 62,
        deployedAt: daysAgo(30), identity: 'gmsa-openbao$', host: 'openbao.argus.local',
        depends: { databases: [], buckets: [], caches: [], queues: [], secrets: [], external: [] },
        services: [{ name: 'OpenBao', exe: 'bao.exe', instances: 3, port: 8200 }],
        trend: { rps: series(24, 21, 9, 79), p95: series(24, 6, 3, 83), err: series(24, 0, 0.01, 89) }
      }
    ],

    deployments: [
      { id: 1847, app: 'mills', version: '2026.09.08.2', env: 'production', author: 'zayan', state: 'awaiting', opened: minutesAgo(24), approvals: [], checks: { build: 'pass', tests: 'pass', trivy: 'pass', sbom: 'pass', signature: 'verified', vulnerable: 'pass' }, sha: '4f2a91c', plan: [{ kind: 'ServiceFabricApp', name: 'mills', from: '2026.09.08.1', to: '2026.09.08.2', action: 'upgrade' }, { kind: 'PrometheusRule', name: 'MillsSlowP95', from: '> 1s', to: '> 800ms', action: 'update' }], blast: { services: ['MillsApi (3)', 'MillsWeb (2)', 'MillsGateway (2)'], dependents: ['MillsWeb', 'MillsGateway', 'functions-mills-ingest', 'functions-mills-precompute'], sessions: 4 } },
      { id: 1846, app: 'agis', version: '2026.09.05.1', env: 'staging', author: 'adil', state: 'inflight', opened: minutesAgo(6), approvals: ['adil'], checks: { build: 'pass', tests: 'pass', trivy: 'pass', sbom: 'pass', signature: 'verified', vulnerable: 'warn' }, sha: 'b71e0d4', progress: { ud: 2, total: 5, healthy: true }, plan: [{ kind: 'ServiceFabricApp', name: 'agis', from: '2026.08.22.4', to: '2026.09.05.1', action: 'upgrade' }], blast: { services: ['AgisWeb (2)'], dependents: [], sessions: 0 } },
      { id: 1845, app: 'console', version: '0.5.0', env: 'production', author: 'adil', state: 'done', opened: daysAgo(2), approvals: ['zayan'], checks: { build: 'pass', tests: 'pass', trivy: 'pass', sbom: 'pass', signature: 'verified', vulnerable: 'pass' }, sha: 'aaa5607', durationS: 214, outcome: 'healthy', plan: [], blast: { services: [], dependents: [], sessions: 0 } },
      { id: 1844, app: 'mills', version: '2026.09.08.1', env: 'production', author: 'zayan', state: 'done', opened: hoursAgo(3), approvals: ['adil'], checks: { build: 'pass', tests: 'pass', trivy: 'pass', sbom: 'pass', signature: 'verified', vulnerable: 'pass' }, sha: '9c3d10a', durationS: 187, outcome: 'healthy', plan: [], blast: { services: [], dependents: [], sessions: 0 } },
      { id: 1843, app: 'mills', version: '2026.09.07.4', env: 'production', author: 'zayan', state: 'rolledback', opened: daysAgo(1), approvals: ['adil'], checks: { build: 'pass', tests: 'pass', trivy: 'pass', sbom: 'pass', signature: 'verified', vulnerable: 'pass' }, sha: '2e88f31', durationS: 96, outcome: 'health policy failed at UD 1, rolled back automatically', plan: [], blast: { services: [], dependents: [], sessions: 0 } }
    ],

    buckets: [
      { name: 'argus-survey-pictures', objects: 1163402, sizeTB: 1.21, lock: null, lockDays: 0, replication: 'none', lagS: 0, owner: 'gmsa-mills-jobs$', growth: 3.1 },
      { name: 'argus-rasters', objects: 8140, sizeTB: 2.04, lock: null, lockDays: 0, replication: 'none', lagS: 0, owner: 'svc-ml', growth: 8.4 },
      { name: 'argus-sentinel', objects: 41208, sizeTB: 5.11, lock: null, lockDays: 0, replication: 'none', lagS: 0, owner: 'svc-ml', growth: 22.0 },
      { name: 'argus-ml', objects: 2044, sizeTB: 0.49, lock: null, lockDays: 0, replication: 'siteB', lagS: 91, owner: 'svc-ml', growth: 6.2 },
      { name: 'argus-artifacts', objects: 612, sizeTB: 0.03, lock: 'COMPLIANCE', lockDays: 365, replication: 'siteB', lagS: 14, owner: 'gmsa-ci$', growth: 0.4 },
      { name: 'argus-backups', objects: 18422, sizeTB: 3.24, lock: 'COMPLIANCE', lockDays: 35, replication: 'siteB', lagS: 214, owner: 'gmsa-backup$', growth: 2.2 },
      { name: 'argus-logs', objects: 92110, sizeTB: 1.02, lock: 'COMPLIANCE', lockDays: 400, replication: 'siteB', lagS: 61, owner: 'gmsa-loki$', growth: 4.8 },
      { name: 'argus-sessions', objects: 341, sizeTB: 0.28, lock: 'COMPLIANCE', lockDays: 400, replication: 'siteB', lagS: 33, owner: 'gmsa-guacamole$', growth: 1.1 }
    ],

    databases: [
      /* No lastLog and an RPO of three hours, because SIMPLE recovery means the
         recovery point is the last differential, not the last log backup. */
      { name: 'umairv3_db', engine: 'SQL Server 2022', host: 'sql-01', sizeGB: 611, ag: 'argus-ag1', agState: 'synchronising', lagS: 3, recovery: 'SIMPLE', lastFull: hoursAgo(9), lastDiff: hoursAgo(3), lastLog: null, lastVerified: daysAgo(6), rpoMin: 180, connections: 34 },
      { name: 'FarmerFacilitatorDb', engine: 'SQL Server 2022', host: 'sql-01', sizeGB: 52, ag: 'argus-ag1', agState: 'synchronising', lagS: 3, recovery: 'FULL', lastFull: hoursAgo(9), lastDiff: hoursAgo(3), lastLog: minutesAgo(11), lastVerified: daysAgo(6), rpoMin: 11, connections: 6 },
      { name: 'ArgusConsole', engine: 'SQL Server 2022', host: 'sql-01', sizeGB: 4, ag: 'argus-ag1', agState: 'synchronising', lagS: 3, recovery: 'FULL', lastFull: hoursAgo(9), lastDiff: hoursAgo(3), lastLog: minutesAgo(11), lastVerified: daysAgo(6), rpoMin: 11, connections: 9 },
      { name: 'pgstac', engine: 'PostgreSQL 17', host: 'pg-01', sizeGB: 88, ag: null, agState: 'n/a', lagS: 0, recovery: 'WAL', lastFull: hoursAgo(14), lastDiff: null, lastLog: minutesAgo(4), lastVerified: daysAgo(13), rpoMin: 4, connections: 5 },
      { name: 'argus_geo', engine: 'PostgreSQL 17', host: 'pg-01', sizeGB: 74, ag: null, agState: 'n/a', lagS: 0, recovery: 'WAL', lastFull: hoursAgo(14), lastDiff: null, lastLog: minutesAgo(4), lastVerified: daysAgo(13), rpoMin: 4, connections: 11 },
      { name: 'argus_ml', engine: 'PostgreSQL 17', host: 'pg-01', sizeGB: 41, ag: null, agState: 'n/a', lagS: 0, recovery: 'WAL', lastFull: hoursAgo(14), lastDiff: null, lastLog: minutesAgo(4), lastVerified: daysAgo(13), rpoMin: 4, connections: 3 }
    ],

    queues: [
      { stream: 'argus.ingest.mills', messages: 12841, rate: 4.2, consumers: 2, lag: 3, dlq: 0 },
      { stream: 'argus.export', messages: 3110, rate: 0.4, consumers: 1, lag: 0, dlq: 2 },
      { stream: 'argus.ai', messages: 884, rate: 0.2, consumers: 1, lag: 0, dlq: 0 },
      { stream: 'argus.sentinel.scene', messages: 402, rate: 0.1, consumers: 3, lag: 0, dlq: 1 },
      { stream: 'argus.pipeline', messages: 1620, rate: 0.6, consumers: 2, lag: 11, dlq: 0 }
    ],

    cache: { memoryUsedGB: 6.1, memoryTotalGB: 8, hitRate: 0.947, opsPerSec: 3120, evictions: 41, prefixes: [{ key: 'mills:boundary:', keys: 18402, mb: 2210 }, { key: 'mills:mapgeom:', keys: 9110, mb: 3080 }, { key: 'mills:report:', keys: 2044, mb: 620 }, { key: 'loan:kibor:', keys: 88, mb: 12 }] },

    secrets: [
      { path: 'kv/mills/jwt-signing-key', leases: 3, rotatedDays: 12, policyDays: 90, reads24h: 6 },
      { path: 'kv/mills/anthropic', leases: 1, rotatedDays: 44, policyDays: 90, reads24h: 214 },
      { path: 'kv/mills/ee-service-key', leases: 1, rotatedDays: 103, policyDays: 90, reads24h: 18 },
      { path: 'kv/mills/legacy-jwt', leases: 1, rotatedDays: 12, policyDays: 90, reads24h: 2 },
      { path: 'db/creds/mills-api', leases: 9, rotatedDays: 0, policyDays: 1, reads24h: 41 },
      { path: 'db/creds/loan-api', leases: 4, rotatedDays: 0, policyDays: 1, reads24h: 12 },
      { path: 'kv/ci/github', leases: 2, rotatedDays: 61, policyDays: 90, reads24h: 34 },
      { path: 'kv/console/session-key', leases: 3, rotatedDays: 2, policyDays: 30, reads24h: 3 }
    ],

    people: [
      { name: 'Adil Munawar', upn: 'adil', tier: 1, mfa: 'FIDO2', lastSignIn: minutesAgo(14), groups: ['Argus-Console-Operators', 'Argus-Console-Approvers'], elevated: false },
      { name: 'Zayan', upn: 'zayan', tier: 1, mfa: 'FIDO2', lastSignIn: hoursAgo(2), groups: ['Argus-Console-Operators'], elevated: false },
      { name: 'Umair', upn: 'umair', tier: 2, mfa: 'TOTP', lastSignIn: daysAgo(1), groups: ['Argus-Console-Viewers'], elevated: false },
      { name: 'Platform contractor', upn: 'contractor', tier: 1, mfa: 'FIDO2', lastSignIn: hoursAgo(5), groups: ['Argus-Console-Operators'], elevated: true, elevationExpires: minutesAgo(-88) }
    ],

    grants: [
      { id: 'g-441', principal: 'contractor', group: 'Argus-Tier1-Operators', reason: 'September restore drill', granted: minutesAgo(32), expires: minutesAgo(-88), approver: 'adil', state: 'active' },
      { id: 'g-440', principal: 'zayan', group: 'Argus-Tier0-Admins', reason: 'CA CRL renewal', granted: daysAgo(2), expires: daysAgo(2), approver: 'adil', state: 'expired' },
      { id: 'g-442', principal: 'umair', group: 'Argus-Console-Operators', reason: 'Cover on-call Friday', granted: null, expires: null, approver: null, state: 'requested' }
    ],

    gmsas: [
      { name: 'gmsa-mills$', hosts: 'sf-*', tier: 1, sql: ['umairv3_db', 'FarmerFacilitatorDb'], s3: ['argus-survey-pictures:r'], rotatedDays: 11 },
      { name: 'gmsa-mills-jobs$', hosts: 'sf-*', tier: 1, sql: ['umairv3_db'], s3: ['argus-survey-pictures:rw'], rotatedDays: 11 },
      { name: 'gmsa-loan$', hosts: 'sf-*', tier: 1, sql: ['FarmerFacilitatorDb'], s3: [], rotatedDays: 19 },
      { name: 'gmsa-console$', hosts: 'sf-*', tier: 1, sql: ['ArgusConsole'], s3: ['argus-sessions:r'], rotatedDays: 4 },
      { name: 'gmsa-reconciler$', hosts: 'sf-*', tier: 0, sql: [], s3: ['argus-artifacts:r'], rotatedDays: 4 },
      { name: 'gmsa-backup$', hosts: 'sql-01, sql-02, pg-01', tier: 1, sql: [], s3: ['argus-backups:put-only'], rotatedDays: 22 },
      { name: 'gmsa-guacamole$', hosts: 'guac-01', tier: 1, sql: [], s3: ['argus-sessions:put-only'], rotatedDays: 8 },
      { name: 'gmsa-ci$', hosts: 'runner-01, runner-02', tier: 1, sql: [], s3: ['argus-artifacts:put-only'], rotatedDays: 15 }
    ],

    alerts: [
      { id: 'al-9021', severity: 'critical', source: 'Wazuh', rule: 'WDAC block on a production host', host: 'hv-03', first: minutesAgo(41), last: minutesAgo(9), count: 3, state: 'open', runbook: 'sec-01-suspected-compromise' },
      { id: 'al-9020', severity: 'high', source: 'Suricata', rule: 'Outbound connection not through the egress proxy', host: 'gpu-01', first: hoursAgo(2), last: minutesAgo(22), count: 14, state: 'open', runbook: 'sec-01-suspected-compromise' },
      { id: 'al-9019', severity: 'high', source: 'Prometheus', rule: 'AGIS p95 above 500 ms for 10 minutes', host: 'sf-05', first: hoursAgo(4), last: minutesAgo(3), count: 1, state: 'ack', runbook: null },
      { id: 'al-9018', severity: 'medium', source: 'CrowdSec', rule: 'Credential stuffing, 41 attempts', host: 'caddy', first: hoursAgo(6), last: hoursAgo(5), count: 41, state: 'resolved', runbook: null },
      { id: 'al-9017', severity: 'medium', source: 'Wazuh SCA', rule: 'CIS score fell below 95% on hv-03', host: 'hv-03', first: daysAgo(1), last: hoursAgo(8), count: 1, state: 'open', runbook: null },
      { id: 'al-9016', severity: 'low', source: 'Prometheus', rule: 'Certificate expires in 13 days', host: 'caddy', first: daysAgo(1), last: hoursAgo(1), count: 1, state: 'open', runbook: 'cert-01-renewal-failure' }
    ],

    sessions: [
      { id: 's-2291', user: 'contractor', target: 'sql-01', protocol: 'RDP', started: minutesAgo(28), duration: 1680, reason: 'September restore drill', approver: 'adil', recorded: true, sizeMB: 412, state: 'active' },
      { id: 's-2290', user: 'adil', target: 'gpu-01', protocol: 'SSH', started: hoursAgo(3), duration: 540, reason: 'Ray worker would not start', approver: 'self', recorded: true, sizeMB: 3, state: 'closed' },
      { id: 's-2289', user: 'zayan', target: 'legacy-landsurvey-01', protocol: 'RDP', started: daysAgo(1), duration: 2100, reason: 'IIS application pool recycle', approver: 'adil', recorded: true, sizeMB: 588, state: 'closed' },
      { id: 's-2288', user: 'adil', target: 'siem-01', protocol: 'SSH', started: daysAgo(2), duration: 900, reason: 'Wazuh rule tuning', approver: 'self', recorded: true, sizeMB: 5, state: 'closed' }
    ],

    vulns: [
      { id: 'CVE-2026-21882', severity: 'high', component: 'System.Text.Json 9.0.1', app: 'mills', fixedIn: '9.0.4', waiver: null, found: daysAgo(3) },
      { id: 'CVE-2026-19044', severity: 'medium', component: 'node 22.11.0', app: 'agis', fixedIn: '22.14.0', waiver: null, found: daysAgo(9) },
      { id: 'CVE-2026-18220', severity: 'medium', component: 'Caddy 2.10.0', app: 'caddy', fixedIn: '2.10.2', waiver: { owner: 'adil', until: daysAgo(-21), reason: 'Not reachable, no HTTP/3 in this deployment' }, found: daysAgo(14) },
      { id: 'CVE-2026-14001', severity: 'low', component: 'Newtonsoft.Json 13.0.3', app: 'loan', fixedIn: '13.0.4', waiver: null, found: daysAgo(21) }
    ],

    posture: {
      families: ['Account policy', 'Audit', 'Defender', 'Firewall', 'Network', 'Services', 'User rights'],
      hosts: ['hv-01', 'hv-02', 'hv-03', 'sql-01', 'pg-01', 'siem-01', 'guac-01'],
      scores: {
        'hv-01': [98, 97, 100, 99, 96, 98, 97], 'hv-02': [98, 97, 100, 99, 96, 98, 97],
        'hv-03': [98, 71, 100, 88, 96, 94, 97], 'sql-01': [97, 96, 100, 98, 95, 97, 96],
        'pg-01': [96, 95, 100, 97, 95, 96, 95], 'siem-01': [94, 93, 0, 96, 94, 93, 92],
        'guac-01': [95, 94, 0, 97, 95, 94, 93]
      }
    },

    backups: [
      /* SIMPLE recovery keeps no log chain, so this store cannot have one.
         ADR-0031 proposes moving to FULL; until it lands, this is what the
         protection actually is. */
      { store: 'umairv3_db', kind: 'SQL differential', cadence: 'every 3 h', last: hoursAgo(3), lock: '35 d', site: 'A + B', state: 'warn' },
      { store: 'FarmerFacilitatorDb', kind: 'SQL log', cadence: 'every 15 min', last: minutesAgo(11), lock: '35 d', site: 'A + B', state: 'ok' },
      { store: 'pgstac / argus_geo / argus_ml', kind: 'WAL (wal-g)', cadence: 'continuous', last: minutesAgo(4), lock: '35 d', site: 'A + B', state: 'ok' },
      { store: 'argus-survey-pictures', kind: 'Kopia', cadence: 'daily', last: hoursAgo(11), lock: '35 d', site: 'A + B', state: 'ok' },
      { store: 'argus-rasters', kind: 'Kopia', cadence: 'monthly', last: daysAgo(19), lock: '35 d', site: 'A + B', state: 'warn' },
      { store: 'Every VM', kind: 'Hyper-V Replica', cadence: 'every 5 min', last: minutesAgo(4), lock: 'n/a', site: 'B', state: 'ok' }
    ],

    drills: [
      { id: '2026-08-14-sql-01-restore-drill', kind: 'Restore', target: 'umairv3_db', ran: daysAgo(25), durationMin: 47, rtoTargetMin: 480, outcome: 'pass', by: 'adil' },
      { id: '2026-07-11-sql-01-restore-drill', kind: 'Restore', target: 'umairv3_db', ran: daysAgo(59), durationMin: 52, rtoTargetMin: 480, outcome: 'pass', by: 'zayan' },
      { id: '2026-06-20-dr-01-site-a-loss', kind: 'DR', target: 'Site A', ran: daysAgo(80), durationMin: 402, rtoTargetMin: 480, outcome: 'pass', by: 'adil' }
    ],

    pipelines: [
      { asset: 'parcels', state: 'fresh', lastRun: hoursAgo(6), durationS: 190, sla: 24, upstream: [] },
      { asset: 's2_periods', state: 'fresh', lastRun: hoursAgo(5), durationS: 2410, sla: 24, upstream: ['parcels'] },
      { asset: 's1_periods', state: 'fresh', lastRun: hoursAgo(5), durationS: 1980, sla: 24, upstream: ['parcels'] },
      { asset: 'phenology', state: 'stale', lastRun: hoursAgo(31), durationS: 880, sla: 24, upstream: ['s2_periods'] },
      { asset: 'v5_train_table', state: 'stale', lastRun: hoursAgo(33), durationS: 4100, sla: 24, upstream: ['phenology', 's1_periods'] },
      { asset: 'v5_model', state: 'fresh', lastRun: hoursAgo(9), durationS: 7200, sla: 168, upstream: ['v5_train_table'] },
      { asset: 'parcel_predictions', state: 'failed', lastRun: hoursAgo(2), durationS: 41, sla: 24, upstream: ['v5_model'] }
    ],

    models: [
      { run: 'v5.3', metric: 'macro F1', value: 0.871, trained: daysAgo(4), rows: 1840221, promoted: true },
      { run: 'v5.2', metric: 'macro F1', value: 0.864, trained: daysAgo(18), rows: 1802114, promoted: false },
      { run: 'v5.1', metric: 'macro F1', value: 0.849, trained: daysAgo(41), rows: 1780004, promoted: false },
      { run: 'segformer-b5-04', metric: 'mIoU', value: 0.782, trained: daysAgo(7), rows: 42011, promoted: true }
    ],

    endpoints: [
      { name: 'v5/predict', backend: 'Ray Serve', p95: 88, rps: 2.1, canary: 0, state: 'ok' },
      { name: 'segformer/infer', backend: 'Ray Serve', p95: 1240, rps: 0.2, canary: 10, state: 'ok' }
    ],

    gpu: { name: 'gpu-01', cards: [{ id: 0, model: 'L40S 48 GB', util: 91, memUsedGB: 41, memTotalGB: 48, tempC: 71, user: 'dagster: v5_model' }, { id: 1, model: 'L40S 48 GB', util: 12, memUsedGB: 6, memTotalGB: 48, tempC: 44, user: 'jupyterhub: umair' }], queue: [{ job: 'segformer-b5-05', user: 'adil', waitingMin: 12 }] },

    runbooks: [
      { id: 'hv-01-drain-node', title: 'Live-migrate VMs off a host for maintenance', tier: 1, approval: 'operator', params: [{ name: 'Host', type: 'select', options: ['hv-01', 'hv-02', 'hv-03'] }], lastRun: daysAgo(11) },
      { id: 'sql-01-restore-drill', title: 'Monthly restore drill for umairv3_db', tier: 1, approval: 'operator', params: [{ name: 'Target', type: 'string', value: 'sql-drill-01' }], lastRun: daysAgo(25) },
      { id: 'sql-02-ag-failover', title: 'Planned or forced AG failover to Site B', tier: 1, approval: 'approver', params: [{ name: 'Mode', type: 'select', options: ['planned', 'forced'] }], lastRun: daysAgo(80) },
      { id: 'ob-01-unseal', title: 'OpenBao unseal ceremony, three key holders', tier: 0, approval: 'approver', params: [], lastRun: daysAgo(62) },
      { id: 'sec-01-suspected-compromise', title: 'Quarantine a host, preserve evidence, page security', tier: 1, approval: 'security', params: [{ name: 'Host', type: 'select', options: ['hv-01', 'hv-02', 'hv-03', 'gpu-01', 'sql-01'] }], lastRun: null },
      { id: 'sec-03-ransomware', title: 'Freeze bucket writes, isolate, begin Site B restore', tier: 1, approval: 'security', params: [], lastRun: null },
      { id: 'dr-01-site-a-loss', title: 'Full failover to Site B', tier: 0, approval: 'approver', params: [{ name: 'Reason', type: 'string', value: '' }], lastRun: daysAgo(80) },
      { id: 'cert-01-renewal-failure', title: 'Caddy or AD CS certificate renewal failed', tier: 1, approval: 'operator', params: [{ name: 'Host', type: 'string', value: 'caddy' }], lastRun: daysAgo(120) }
    ],

    cost: {
      // Amortised from docs/07-HARDWARE-AND-LICENSING.md over 36 months, plus power.
      monthlyTotalUsd: 9140,
      breakdown: [
        { app: 'mills', cpu: 1840, storage: 610, gpu: 0, total: 2450 },
        { app: 'ml pipelines', cpu: 420, storage: 980, gpu: 2600, total: 4000 },
        { app: 'console', cpu: 210, storage: 20, gpu: 0, total: 230 },
        { app: 'loan', cpu: 340, storage: 90, gpu: 0, total: 430 },
        { app: 'agis', cpu: 280, storage: 340, gpu: 0, total: 620 },
        { app: 'platform overhead', cpu: 1010, storage: 400, gpu: 0, total: 1410 }
      ],
      awsBaselineUsd: 11800,
      forecast: [{ resource: 'argus-sentinel capacity', full: '2027-04', headroomPct: 38 }, { resource: 'hv-03 memory', full: '2026-12', headroomPct: 29 }]
    },

    audit: [
      { at: minutesAgo(6), actor: 'adil', role: 'Operator', action: 'deployment.approve', target: 'agis 2026.09.05.1 (staging)', pr: 1846, ip: '10.99.0.14' },
      { at: minutesAgo(24), actor: 'zayan', role: 'Operator', action: 'deployment.open', target: 'mills 2026.09.08.2 (production)', pr: 1847, ip: '10.99.0.21' },
      { at: minutesAgo(28), actor: 'contractor', role: 'Operator', action: 'session.start', target: 'sql-01 (RDP, recorded)', pr: null, ip: '10.99.0.31' },
      { at: minutesAgo(32), actor: 'adil', role: 'Approver', action: 'grant.approve', target: 'contractor to Argus-Tier1-Operators for 2 h', pr: null, ip: '10.99.0.14' },
      { at: hoursAgo(3), actor: 'reconciler', role: 'System', action: 'reconcile.apply', target: 'mills 2026.09.08.1 to production', pr: 1844, ip: '10.30.0.31' },
      { at: hoursAgo(3), actor: 'adil', role: 'Operator', action: 'secret.rotate', target: 'kv/mills/jwt-signing-key', pr: null, ip: '10.99.0.14' },
      { at: hoursAgo(8), actor: 'system', role: 'System', action: 'alert.raise', target: 'CIS score fell below 95% on hv-03', pr: null, ip: '10.12.0.10' },
      { at: daysAgo(1), actor: 'reconciler', role: 'System', action: 'reconcile.rollback', target: 'mills 2026.09.07.4, health policy failed', pr: 1843, ip: '10.30.0.31' },
      { at: daysAgo(1), actor: 'zayan', role: 'Operator', action: 'session.start', target: 'legacy-landsurvey-01 (RDP, recorded)', pr: null, ip: '10.99.0.21' },
      { at: daysAgo(2), actor: 'adil', role: 'Admin', action: 'reconciler.pause', target: 'paused 11 min for manual repair', pr: null, ip: '10.99.0.14' }
    ],

    reconciler: { state: 'running', lastSync: minutesAgo(1), head: 'aaa5607', drift: 0, pendingPlans: 1, applyLagS: 42 },

    exitProgress: { phase: 2, phases: 7, percent: 34, awsRemaining: ['1 Windows EC2 instance', '1 S3 bucket (read-only)'] }
  };

  /*
   * Convenience lookups the screens rely on.
   *
   * An index is built on first use and rebuilt whenever the underlying array
   * is replaced. The array identity is compared rather than cached once,
   * because the stress harness swaps whole collections in.
   */
  function indexBy(getArray, key) {
    var indexed = null, map = null;
    return function (value) {
      var arr = getArray();
      if (!arr) return undefined;
      if (arr !== indexed) {
        indexed = arr;
        map = Object.create(null);
        for (var i = 0; i < arr.length; i++) {
          var k = arr[i] && arr[i][key];
          if (k !== undefined && k !== null && !(k in map)) map[k] = arr[i];
        }
      }
      return map[value];
    };
  }

  data.appByName = indexBy(function () { return data.apps; }, 'name');
  data.vmByName = indexBy(function () { return data.vms; }, 'name');
  data.personByUpn = indexBy(function () { return data.people; }, 'upn');

  A.data = data;
  A.time = { NOW: NOW, minutesAgo: minutesAgo, hoursAgo: hoursAgo, daysAgo: daysAgo, series: series };
})();
