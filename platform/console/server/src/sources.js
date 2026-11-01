'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const cache = require('./cache');
const operators = require('./auth/operators');
const auditLog = require('./auth/audit');

const GITOPS_DIR = process.env.ARGUS_GITOPS_DIR || '/config/gitops';
const RUNBOOKS_DIR = process.env.ARGUS_RUNBOOKS_DIR || '/config/runbooks';
const S3_IDENTITIES_FILE = process.env.ARGUS_S3_IDENTITIES_FILE || '';
const TTL_MS = 15000;
const RUNBOOK_BODY_MAX = 512 * 1024;
const AUDIT_LIMIT_MAX = 500;

function rejected(message) {
  return Object.assign(new Error(message), { name: 'ValidationError' });
}

function missing(what, where, err) {
  return {
    ok: false,
    reason: 'not-configured',
    message: `${what} could not be read from ${where}: ${err && err.code ? err.code : (err && err.message) || 'unknown'}. ` +
      'Mount the directory into the console or point the variable at it.'
  };
}

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function secretRefs(value, out) {
  if (typeof value === 'string') {
    const re = /\{\{\s*openbao:([^}#\s]+)(?:#[^}\s]*)?\s*\}\}/g;
    let m;
    while ((m = re.exec(value)) !== null) out.push(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((v) => secretRefs(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => secretRefs(v, out));
  }
  return out;
}

function summariseApp(dir, name, doc, stat) {
  const meta = doc.metadata || {};
  const spec = doc.spec || {};
  const services = Array.isArray(spec.services) ? spec.services : [];
  const refs = secretRefs(spec, []);
  const alertsFile = typeof spec.alerts === 'string' ? spec.alerts : null;
  const alertRules = [];
  if (alertsFile) {
    try {
      const alerts = readYaml(path.join(dir, alertsFile));
      (alerts.groups || []).forEach((g) => (g.rules || []).forEach((r) => {
        if (r.alert) alertRules.push({ name: r.alert, severity: (r.labels && r.labels.severity) || null, for: r.for || null });
      }));
    } catch (err) {
      alertRules.push({ name: null, error: `${alertsFile}: ${err.message}` });
    }
  }
  return {
    name: meta.name || name,
    directory: name,
    kind: doc.kind || null,
    apiVersion: doc.apiVersion || null,
    owner: meta.owner || null,
    repo: meta.repo || null,
    tier: meta.tier === undefined ? null : meta.tier,
    identity: spec.identity || null,
    package: spec.package ? { bucket: spec.package.bucket || null, key: spec.package.key || null, signature: spec.package.signature || null } : null,
    services: services.map((s) => ({
      name: s.name || null,
      type: s.type || null,
      exe: s.exe || null,
      instances: Number.isInteger(s.instances) ? s.instances : null,
      endpoints: Array.isArray(s.endpoints) ? s.endpoints.map((e) => ({ name: e.name || null, port: e.port === undefined ? null : e.port })) : [],
      resources: s.resources || null,
      envKeys: s.env && typeof s.env === 'object' ? Object.keys(s.env).length : 0
    })),
    instances: services.reduce((n, s) => n + (Number.isInteger(s.instances) ? s.instances : 0), 0),
    ingress: spec.ingress ? {
      host: spec.ingress.host || null,
      upstream: spec.ingress.upstream || null,
      waf: spec.ingress.waf || null,
      rateLimit: spec.ingress.rateLimit || null
    } : null,
    health: spec.health && spec.health.probe ? {
      path: spec.health.probe.path || null,
      upstream: spec.health.probe.upstream || null,
      intervalSeconds: spec.health.probe.intervalSeconds || null,
      failureAction: spec.health.upgradePolicy ? spec.health.upgradePolicy.failureAction || null : null
    } : null,
    egress: spec.egress && Array.isArray(spec.egress.allow) ? spec.egress.allow : [],
    secretRefs: Array.from(new Set(refs)),
    alertsFile,
    alertRules,
    declaredAt: stat.mtime.toISOString(),
    file: path.relative(GITOPS_DIR, path.join(dir, 'app.yaml')).replace(/\\/g, '/')
  };
}

async function apps() {
  const r = await cache.through('gitops:apps:' + GITOPS_DIR, TTL_MS, async () => {
    const appsDir = path.join(GITOPS_DIR, 'apps');
    let entries;
    try {
      entries = fs.readdirSync(appsDir, { withFileTypes: true });
    } catch (err) {
      throw Object.assign(new Error('gitops apps directory unreadable'), { name: 'NotConfigured', cause: err, where: appsDir });
    }
    const out = [];
    const problems = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(appsDir, entry.name);
      const file = path.join(dir, 'app.yaml');
      let stat;
      try { stat = fs.statSync(file); } catch (err) {
        problems.push({ directory: entry.name, message: 'has no app.yaml, so it is declared only by its README.' });
        continue;
      }
      try {
        out.push(summariseApp(dir, entry.name, readYaml(file) || {}, stat));
      } catch (err) {
        problems.push({ directory: entry.name, message: `app.yaml did not parse: ${err.message}` });
      }
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { apps: out, count: out.length, problems, source: appsDir };
  }).catch((err) => {
    if (err && err.name === 'NotConfigured') return { answer: missing('The GitOps application specs', err.where, err.cause) };
    throw err;
  });
  if (r.answer) return r.answer;
  return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
}

async function environments() {
  const r = await cache.through('gitops:environments:' + GITOPS_DIR, TTL_MS, async () => {
    const dir = path.join(GITOPS_DIR, 'environments');
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      throw Object.assign(new Error('gitops environments unreadable'), { name: 'NotConfigured', cause: err, where: dir });
    }
    const out = [];
    for (const file of entries) {
      if (!/\.ya?ml$/i.test(file)) continue;
      const full = path.join(dir, file);
      try {
        const doc = readYaml(full) || {};
        const declared = doc.apps && typeof doc.apps === 'object' ? doc.apps : {};
        out.push({
          name: doc.name || file.replace(/\.ya?ml$/i, ''),
          kind: doc.kind || null,
          file,
          declaredAt: fs.statSync(full).mtime.toISOString(),
          apps: Object.keys(declared).sort().map((app) => ({
            app,
            version: declared[app] && declared[app].version !== undefined ? String(declared[app].version) : null,
            sha256: declared[app] && declared[app].sha256 ? String(declared[app].sha256) : null,
            pinned: !!(declared[app] && declared[app].sha256 && !/^</.test(String(declared[app].sha256)))
          }))
        });
      } catch (err) {
        out.push({ name: file, error: err.message, apps: [] });
      }
    }
    return { environments: out, count: out.length, source: dir, applied: false,
      note: 'These are declarations. No reconciler runs in this stack, so nothing has applied them to a cluster.' };
  }).catch((err) => {
    if (err && err.name === 'NotConfigured') return { answer: missing('The GitOps environments', err.where, err.cause) };
    throw err;
  });
  if (r.answer) return r.answer;
  return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
}

async function serviceAccounts() {
  const r = await cache.through('gitops:identity:' + GITOPS_DIR, TTL_MS, async () => {
    const file = path.join(GITOPS_DIR, 'identity', 'gmsa.yaml');
    let doc;
    try {
      doc = readYaml(file) || {};
    } catch (err) {
      throw Object.assign(new Error('gitops identity unreadable'), { name: 'NotConfigured', cause: err, where: file });
    }
    const accounts = Array.isArray(doc.accounts) ? doc.accounts : [];
    return {
      accounts: accounts.map((a) => ({
        name: a.name || null,
        hosts: Array.isArray(a.hosts) ? a.hosts : [],
        tier: a.tier === undefined ? null : a.tier,
        kind: a.kind || 'gmsa',
        sql: Array.isArray(a.sql) ? a.sql : [],
        s3: Array.isArray(a.s3) ? a.s3 : [],
        codesign: a.codesign === true,
        notes: a.notes || null
      })),
      count: accounts.length,
      kind: doc.kind || null,
      source: file,
      declaredAt: fs.statSync(file).mtime.toISOString()
    };
  }).catch((err) => {
    if (err && err.name === 'NotConfigured') return { answer: missing('The GitOps service accounts', err.where, err.cause) };
    throw err;
  });
  if (r.answer) return r.answer;
  return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
}

function s3Identities() {
  if (!S3_IDENTITIES_FILE) {
    return { ok: false, reason: 'not-configured', message: 'ARGUS_S3_IDENTITIES_FILE is not set, so the object store identities are not listed.' };
  }
  try {
    const doc = JSON.parse(fs.readFileSync(S3_IDENTITIES_FILE, 'utf8'));
    const list = Array.isArray(doc.identities) ? doc.identities : [];
    return {
      ok: true,
      identities: list.map((i) => ({
        name: i.name || null,
        accessKeys: Array.isArray(i.credentials) ? i.credentials.map((c) => c.accessKey || null) : [],
        actions: Array.isArray(i.actions) ? i.actions : []
      })),
      count: list.length
    };
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: `${S3_IDENTITIES_FILE} could not be read: ${err.code || err.message}.` };
  }
}

function consoleOperators() {
  const loaded = operators.load();
  const list = [];
  for (const record of loaded.records.values()) {
    list.push({ subject: record.subject, displayName: record.displayName, roles: record.roles, source: 'operators.json' });
  }
  return {
    ok: loaded.ok || !loaded.required,
    required: loaded.required,
    operators: list,
    count: list.length,
    problems: loaded.problems,
    file: loaded.file
  };
}

async function principals(readers) {
  const [roles, accounts] = await Promise.all([
    readers && readers.pgRoles ? readers.pgRoles() : Promise.resolve({ ok: false, reason: 'not-configured', message: 'No PostgreSQL reader.' }),
    serviceAccounts()
  ]);
  return {
    ok: true,
    console: consoleOperators(),
    postgres: roles,
    objectStore: s3Identities(),
    serviceAccounts: accounts,
    at: new Date().toISOString()
  };
}

function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try { meta = YAML.parse(m[1]) || {}; } catch (err) { meta = { error: err.message }; }
  return { meta, body: text.slice(m[0].length) };
}

function firstHeading(text) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.isDirectory()) walk(full, base, out);
    else if (/\.md$/i.test(entry.name)) out.push({ full, rel });
  }
  return out;
}

async function runbooks() {
  const r = await cache.through('runbooks:list:' + RUNBOOKS_DIR, TTL_MS, async () => {
    try { fs.readdirSync(RUNBOOKS_DIR); } catch (err) {
      throw Object.assign(new Error('runbooks unreadable'), { name: 'NotConfigured', cause: err, where: RUNBOOKS_DIR });
    }
    const files = walk(RUNBOOKS_DIR, RUNBOOKS_DIR, []);
    const list = files.map(({ full, rel }) => {
      const stat = fs.statSync(full);
      const text = fs.readFileSync(full, 'utf8');
      const { meta, body } = frontMatter(text);
      const steps = (body.match(/^(?:\s*|#{3,}\s+)\d+[.)]\s/gm) || []).length;
      return {
        id: meta.id || rel.replace(/\.md$/i, ''),
        path: rel,
        title: meta.title || firstHeading(body) || rel,
        tier: meta.tier === undefined ? null : meta.tier,
        approval: meta.approval || null,
        params: Array.isArray(meta.params) ? meta.params.map((p) => ({ name: p.name || null, type: p.type || null, default: p.default === undefined ? null : p.default })) : [],
        sections: (body.match(/^##\s+(.+)$/gm) || []).map((h) => h.replace(/^##\s+/, '').trim()),
        steps,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        isIndex: /(^|\/)README\.md$/i.test(rel)
      };
    });
    list.sort((a, b) => Number(a.isIndex) - Number(b.isIndex) || a.path.localeCompare(b.path));
    return { runbooks: list, count: list.length, source: RUNBOOKS_DIR,
      executable: false,
      note: 'Runbooks are documents in this stack. The JEA endpoint that would execute their steps does not exist yet, so the console shows them and records that you read them.' };
  }).catch((err) => {
    if (err && err.name === 'NotConfigured') return { answer: missing('The runbooks', err.where, err.cause) };
    throw err;
  });
  if (r.answer) return r.answer;
  return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
}

function runbookBody(rel) {
  const raw = String(rel || '');
  if (!raw || raw.length > 256 || /\\|\.\.|^\/|^[A-Za-z]:/.test(raw) || !/\.md$/i.test(raw)) {
    throw rejected('A runbook is named by its path under the runbooks directory, ending in .md, with no parent steps.');
  }
  const base = path.resolve(RUNBOOKS_DIR);
  const full = path.resolve(base, raw);
  if (full !== base && !full.startsWith(base + path.sep)) throw rejected('That path leaves the runbooks directory.');
  let text;
  try {
    const stat = fs.statSync(full);
    if (stat.size > RUNBOOK_BODY_MAX) throw rejected('That runbook is larger than the console will render.');
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err.name === 'ValidationError') throw err;
    throw Object.assign(new Error(`No runbook at ${raw}.`), { name: 'NotFound' });
  }
  const { meta, body } = frontMatter(text);
  return { ok: true, path: raw, meta, body, bytes: Buffer.byteLength(text) };
}

function auditRecent(limitRaw) {
  const n = Number(limitRaw);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, AUDIT_LIMIT_MAX) : 100;
  const all = auditLog.recent();
  return {
    ok: true,
    events: all.slice(-limit).reverse(),
    count: Math.min(limit, all.length),
    total: all.length,
    dropped: auditLog.dropped(),
    since: auditLog.since(),
    persistence: 'memory',
    note: 'The console API keeps its most recent audit events in memory since it started. Every event is also written to its log, which Loki keeps.'
  };
}

module.exports = {
  apps,
  environments,
  serviceAccounts,
  principals,
  runbooks,
  runbookBody,
  auditRecent,
  s3Identities,
  consoleOperators
};
