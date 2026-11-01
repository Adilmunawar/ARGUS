'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sources-'));
const gitops = path.join(dir, 'gitops');
const runbooks = path.join(dir, 'runbooks');
fs.mkdirSync(path.join(gitops, 'apps', 'orders'), { recursive: true });
fs.mkdirSync(path.join(gitops, 'apps', 'empty'), { recursive: true });
fs.mkdirSync(path.join(gitops, 'environments'), { recursive: true });
fs.mkdirSync(path.join(gitops, 'identity'), { recursive: true });
fs.mkdirSync(path.join(runbooks, 'drills'), { recursive: true });

fs.writeFileSync(path.join(gitops, 'apps', 'orders', 'app.yaml'), [
  'apiVersion: argus/v1',
  'kind: ServiceFabricApp',
  'metadata: { name: orders, owner: riley, tier: 1, repo: org/orders }',
  'spec:',
  '  identity: gmsa-orders$',
  '  package: { bucket: argus-artifacts, key: "orders/{{ version }}.sfpkg", signature: authenticode }',
  '  services:',
  '    - name: OrdersApi',
  '      type: GuestExecutable',
  '      instances: 3',
  '      endpoints: [{ name: http, port: 5141 }]',
  '      env:',
  '        Jwt__SigningKey: "{{ openbao:kv/orders/jwt-signing-key#value }}"',
  '        Ai__ApiKey: "{{ openbao:kv/orders/anthropic#value }}"',
  '        Again: "{{ openbao:kv/orders/anthropic#value }}"',
  '    - name: OrdersWeb',
  '      type: GuestExecutable',
  '      instances: 2',
  '  ingress: { host: orders.example, upstream: OrdersApi, waf: owasp-crs }',
  '  health: { probe: { path: /health, upstream: OrdersApi, intervalSeconds: 10 }, upgradePolicy: { failureAction: Rollback } }',
  '  egress: { allow: [api.example.com] }',
  '  alerts: alerts.yaml',
  ''
].join('\n'));
fs.writeFileSync(path.join(gitops, 'apps', 'orders', 'alerts.yaml'), [
  'groups:',
  '  - name: orders',
  '    rules:',
  '      - alert: OrdersHigh5xx',
  '        expr: up == 0',
  '        for: 5m',
  '        labels: { severity: page }',
  ''
].join('\n'));
fs.writeFileSync(path.join(gitops, 'apps', 'empty', 'README.md'), '# later\n');
fs.writeFileSync(path.join(gitops, 'environments', 'production.yaml'), [
  'apiVersion: argus/v1',
  'kind: Environment',
  'name: production',
  'apps:',
  '  orders: { version: 2026.09.08.1, sha256: "<filled by CI>" }',
  '  caddy: { version: 2.10.0, sha256: "abc123" }',
  ''
].join('\n'));
fs.writeFileSync(path.join(gitops, 'identity', 'gmsa.yaml'), [
  'apiVersion: argus/v1',
  'kind: ServiceAccounts',
  'accounts:',
  '  - { name: gmsa-orders$, hosts: [sf-*], tier: 1, sql: [orders_db], s3: [argus-uploads:r] }',
  '  - { name: svc-ml, hosts: [gpu-01], tier: 1, kind: linux-sssd }',
  ''
].join('\n'));
fs.writeFileSync(path.join(runbooks, 'README.md'), '# Runbooks\n\nIndex.\n');
fs.writeFileSync(path.join(runbooks, 'sql-01-restore-drill.md'), [
  '---',
  'id: sql-01-restore-drill',
  'title: Monthly restore drill',
  'tier: 1',
  'approval: operator',
  'params:',
  '  - { name: Target, type: string, default: sql-drill-01 }',
  '---',
  '## When',
  'Monthly.',
  '## Steps',
  '1. Restore.',
  '2. Verify.',
  '## Rollback',
  'None.',
  ''
].join('\n'));
fs.writeFileSync(path.join(runbooks, 'drills', 'README.md'), '# Drill reports\n');
const identities = path.join(dir, 's3.json');
fs.writeFileSync(identities, JSON.stringify({ identities: [
  { name: 'argus-console', credentials: [{ accessKey: 'argus-console', secretKey: 'never-shown' }], actions: ['Read:argus-backups'] }
] }));
const operators = path.join(dir, 'operators.json');
fs.writeFileSync(operators, JSON.stringify({ operators: [
  { subject: 'adil', displayName: 'Adil', roles: ['operator'], password: 'scrypt$N=16384,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ$dGFndGFndGFndGFndGFndGFndGFndGFndGFndGFndGFndGFn' }
] }));

process.env.ARGUS_GITOPS_DIR = gitops;
process.env.ARGUS_RUNBOOKS_DIR = runbooks;
process.env.ARGUS_S3_IDENTITIES_FILE = identities;
process.env.ARGUS_AUTH = 'session';
process.env.ARGUS_AUTH_OPERATORS_FILE = operators;

const sources = require('../src/sources.js');
const auditLog = require('../src/auth/audit.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: err.message }); }
};

(async () => {
  const apps = await sources.apps();
  check('gitops apps are read from app.yaml files', () => {
    assert.strictEqual(apps.ok, true);
    assert.strictEqual(apps.count, 1);
    assert.strictEqual(apps.apps[0].name, 'orders');
    assert.strictEqual(apps.apps[0].owner, 'riley');
    assert.strictEqual(apps.apps[0].tier, 1);
  });
  check('service instances and endpoints are summarised', () => {
    const a = apps.apps[0];
    assert.strictEqual(a.instances, 5);
    assert.strictEqual(a.services.length, 2);
    assert.deepStrictEqual(a.services[0].endpoints, [{ name: 'http', port: 5141 }]);
    assert.strictEqual(a.services[0].envKeys, 3);
  });
  check('secret references are counted once each and never carry a value', () => {
    const a = apps.apps[0];
    assert.deepStrictEqual(a.secretRefs, ['kv/orders/jwt-signing-key', 'kv/orders/anthropic']);
    assert.ok(!JSON.stringify(a).includes('never-shown'));
  });
  check('ingress, health, egress and alert rules come through', () => {
    const a = apps.apps[0];
    assert.strictEqual(a.ingress.host, 'orders.example');
    assert.strictEqual(a.health.failureAction, 'Rollback');
    assert.deepStrictEqual(a.egress, ['api.example.com']);
    assert.deepStrictEqual(a.alertRules, [{ name: 'OrdersHigh5xx', severity: 'page', for: '5m' }]);
  });
  check('a directory without app.yaml is reported as a problem, not an app', () => {
    assert.strictEqual(apps.problems.length, 1);
    assert.strictEqual(apps.problems[0].directory, 'empty');
  });

  const envs = await sources.environments();
  check('environments list declared versions and whether the digest is pinned', () => {
    assert.strictEqual(envs.ok, true);
    assert.strictEqual(envs.applied, false);
    const prod = envs.environments[0];
    assert.strictEqual(prod.name, 'production');
    assert.deepStrictEqual(prod.apps.map((a) => [a.app, a.version, a.pinned]), [['caddy', '2.10.0', true], ['orders', '2026.09.08.1', false]]);
  });

  const accounts = await sources.serviceAccounts();
  check('service accounts are read from identity/gmsa.yaml', () => {
    assert.strictEqual(accounts.ok, true);
    assert.strictEqual(accounts.count, 2);
    assert.strictEqual(accounts.accounts[1].kind, 'linux-sssd');
    assert.deepStrictEqual(accounts.accounts[0].sql, ['orders_db']);
  });

  const ids = sources.s3Identities();
  check('object store identities list names and access keys but never a secret key', () => {
    assert.strictEqual(ids.ok, true);
    assert.deepStrictEqual(ids.identities[0].accessKeys, ['argus-console']);
    assert.ok(!JSON.stringify(ids).includes('never-shown'));
  });

  const ops = sources.consoleOperators();
  check('console operators are listed without their password records', () => {
    assert.strictEqual(ops.ok, true);
    assert.strictEqual(ops.count, 1);
    assert.strictEqual(ops.operators[0].subject, 'adil');
    assert.ok(!JSON.stringify(ops).includes('scrypt$'));
  });

  const principals = await sources.principals({ pgRoles: async () => ({ ok: false, reason: 'not-configured', message: 'no pg' }) });
  check('principals fan out and a missing reader degrades to not-configured', () => {
    assert.strictEqual(principals.ok, true);
    assert.strictEqual(principals.postgres.reason, 'not-configured');
    assert.strictEqual(principals.console.count, 1);
    assert.strictEqual(principals.serviceAccounts.count, 2);
  });

  const books = await sources.runbooks();
  check('runbooks are listed with their front matter, sections and step counts', () => {
    assert.strictEqual(books.ok, true);
    assert.strictEqual(books.executable, false);
    assert.strictEqual(books.count, 3);
    const drill = books.runbooks.find((r) => r.id === 'sql-01-restore-drill');
    assert.strictEqual(drill.title, 'Monthly restore drill');
    assert.strictEqual(drill.approval, 'operator');
    assert.deepStrictEqual(drill.sections, ['When', 'Steps', 'Rollback']);
    assert.strictEqual(drill.steps, 2);
    assert.deepStrictEqual(drill.params, [{ name: 'Target', type: 'string', default: 'sql-drill-01' }]);
  });
  check('index files sort last and nested directories are walked', () => {
    assert.strictEqual(books.runbooks[0].id, 'sql-01-restore-drill');
    assert.ok(books.runbooks.some((r) => r.path === 'drills/README.md' && r.isIndex));
  });
  check('a runbook body is served with its front matter split out', () => {
    const body = sources.runbookBody('sql-01-restore-drill.md');
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.meta.tier, 1);
    assert.ok(body.body.startsWith('## When'));
  });
  check('a runbook path cannot leave the directory or name a non-markdown file', () => {
    for (const bad of ['../x.md', '/etc/passwd.md', 'drills/../../x.md', 'README.txt', 'C:/x.md', '']) {
      assert.throws(() => sources.runbookBody(bad), (err) => err.name === 'ValidationError', bad);
    }
    assert.throws(() => sources.runbookBody('missing.md'), (err) => err.name === 'NotFound');
  });

  auditLog.setSink(() => {});
  auditLog.audit('test.one', { subject: 'adil', outcome: 'success' });
  auditLog.audit('test.two', { subject: 'adil', outcome: 'failure', path: 'x'.repeat(600) });
  const recent = sources.auditRecent('1');
  check('recent audit events are kept in memory, newest first, bounded by the limit', () => {
    assert.strictEqual(recent.ok, true);
    assert.strictEqual(recent.count, 1);
    assert.strictEqual(recent.total, 2);
    assert.strictEqual(recent.events[0].event, 'test.two');
    assert.ok(recent.events[0].path.length < 600);
    assert.strictEqual(recent.persistence, 'memory');
  });
  check('an unusable limit falls back rather than failing', () => {
    assert.strictEqual(sources.auditRecent('nope').count, 2);
    assert.strictEqual(sources.auditRecent('100000').count, 2);
  });

  process.env.ARGUS_GITOPS_DIR = path.join(dir, 'nowhere');
  delete require.cache[require.resolve('../src/sources.js')];
  const absent = require('../src/sources.js');
  const noApps = await absent.apps();
  check('an unmounted gitops directory is reported as not-configured, not thrown', () => {
    assert.strictEqual(noApps.ok, false);
    assert.strictEqual(noApps.reason, 'not-configured');
    assert.ok(/nowhere/.test(noApps.message));
  });

  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  results.forEach((r) => console.log(`  ${r.ok ? 'ok   ' : 'FAIL '} ${r.name}${r.ok ? '' : '\n        ' + r.detail}`));
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length);
})().catch((err) => { console.error(err); process.exit(1); });
