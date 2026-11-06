'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STREAM = 'argus.console.audit';

const SERVICE = 'argus-console-server';

const PATH_MAX = 512;
const AGENT_MAX = 256;

const COLLAPSE_WINDOW_MS = 60000;
const COLLAPSE_KEYS_MAX = 2048;

const PERSIST_FILE_NAME = 'console-audit.jsonl';
const PERSIST_ROTATE_BYTES = 4 * 1024 * 1024;
const PERSIST_RESTORE_MAX_BYTES = 8 * 1024 * 1024;

function positive(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const RING_MAX = positive('ARGUS_AUDIT_RING_EVENTS', 2000);
const SECURITY_RING_MAX = positive('ARGUS_AUDIT_SECURITY_RING_EVENTS', 1000);

const COLLAPSIBLE = new Set([
  'auth.denied',
  'auth.csrf.rejected',
  'auth.session.rejected',
  'auth.session.anomaly',
  'auth.proxy.untrusted',
  'auth.login.throttled',
  'auth.host.rejected',
  'auth.role.denied',
  'auth.metrics.denied'
]);

const defaultSink = (line) => process.stdout.write(line + '\n');
let sink = defaultSink;

const general = { records: [], max: RING_MAX, dropped: 0 };
const security = { records: [], max: SECURITY_RING_MAX, dropped: 0 };

const collapsing = new Map();
let collapsedCount = 0;

let seq = 0;
const startedAt = new Date().toISOString();

const persistence = { mode: 'memory', file: null, bytes: 0, reason: null, restored: 0 };

function isSecurity(event) {
  return /^auth\.(login|account|config|role)\./.test(event) || event === 'auth.logout';
}

function isCollapsible(event, fields) {
  if (COLLAPSIBLE.has(event)) return true;
  return event === 'auth.login.failed' && !!fields && fields.reason === 'incomplete';
}

function push(ring, record) {
  ring.records.push(record);
  if (ring.records.length > ring.max) {
    const over = ring.records.length - ring.max;
    ring.records.splice(0, over);
    ring.dropped += over;
  }
}

function cap(value, limit) {
  const text = String(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function initPersistence() {
  const dir = process.env.ARGUS_AUDIT_DIR || process.env.ARGUS_STATE_DIR || '/state';
  const file = path.join(dir, PERSIST_FILE_NAME);
  try {
    fs.appendFileSync(file, '');
    const stat = fs.statSync(file);
    persistence.mode = 'file';
    persistence.file = file;
    persistence.bytes = stat.size;
    if (stat.size > 0 && stat.size <= PERSIST_RESTORE_MAX_BYTES) restore(file);
  } catch (err) {
    persistence.mode = 'memory';
    persistence.file = null;
    persistence.reason = `${dir} is not writable by this process (${err && err.code ? err.code : 'unknown'}), ` +
      'so security events are kept in memory only and are lost on restart. Every event is still written to the log.';
  }
}

function restore(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines.slice(-SECURITY_RING_MAX)) {
    let record;
    try { record = JSON.parse(line); } catch (err) { continue; }
    if (!record || typeof record !== 'object' || typeof record.event !== 'string') continue;
    seq += 1;
    push(security, { ...record, seq, restored: true });
    persistence.restored += 1;
  }
}

function persist(record) {
  if (persistence.mode !== 'file') return;
  const line = JSON.stringify(record) + '\n';
  try {
    if (persistence.bytes + line.length > PERSIST_ROTATE_BYTES) {
      fs.renameSync(persistence.file, persistence.file + '.1');
      persistence.bytes = 0;
    }
    fs.appendFileSync(persistence.file, line);
    persistence.bytes += Buffer.byteLength(line);
  } catch (err) {
    persistence.mode = 'memory';
    persistence.reason = `Writing ${persistence.file} failed (${err && err.code ? err.code : 'unknown'}), ` +
      'so security events are now kept in memory only.';
  }
}

function collapseKey(event, record, now) {
  const window = Math.floor(now / COLLAPSE_WINDOW_MS);
  return [event, record.reason || '', record.sourceAddress || '', record.subject || '', record.path && event === 'auth.role.denied' ? record.path : '', window].join('|');
}

function flushCollapsed(now) {
  const current = Math.floor((now === undefined ? Date.now() : now) / COLLAPSE_WINDOW_MS);
  for (const [key, entry] of collapsing) {
    if (entry.window >= current) continue;
    collapsing.delete(key);
    if (entry.record.count > 1) {
      sink(JSON.stringify({
        ts: new Date().toISOString(),
        stream: STREAM,
        service: SERVICE,
        event: 'audit.collapsed',
        of: entry.record.event,
        reason: entry.record.reason,
        sourceAddress: entry.record.sourceAddress,
        subject: entry.record.subject,
        count: entry.record.count,
        firstAt: entry.record.ts,
        lastAt: entry.record.lastAt
      }));
    }
  }
}

const flusher = setInterval(() => flushCollapsed(), COLLAPSE_WINDOW_MS);
flusher.unref();

function audit(event, fields) {
  const now = Date.now();
  const record = { ts: new Date(now).toISOString(), stream: STREAM, service: SERVICE, event };
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'path') record.path = cap(value, PATH_MAX);
    else if (key === 'userAgent') record.userAgent = cap(value, AGENT_MAX);
    else record[key] = value;
  }

  if (isCollapsible(event, record)) {
    let key = collapseKey(event, record, now);
    const window = Math.floor(now / COLLAPSE_WINDOW_MS);
    if (!collapsing.has(key) && collapsing.size >= COLLAPSE_KEYS_MAX) {
      flushCollapsed(now);
      if (collapsing.size >= COLLAPSE_KEYS_MAX) key = `${event}|overflow|${window}`;
    }
    const existing = collapsing.get(key);
    if (existing) {
      existing.record.count += 1;
      existing.record.lastAt = record.ts;
      collapsedCount += 1;
      return;
    }
    record.count = 1;
    record.lastAt = record.ts;
    seq += 1;
    const stored = { seq, ...record };
    collapsing.set(key, { record: stored, window });
    push(isSecurity(event) ? security : general, stored);
    if (isSecurity(event)) persist(record);
    sink(JSON.stringify(record));
    return;
  }

  seq += 1;
  const stored = { seq, ...record };
  if (isSecurity(event)) {
    push(security, stored);
    persist(record);
  } else {
    push(general, stored);
  }
  sink(JSON.stringify(record));
}

function recent() {
  return general.records.concat(security.records).sort((a, b) => a.seq - b.seq);
}

function dropped() {
  return general.dropped + security.dropped;
}

function droppedByRing() {
  return { general: general.dropped, security: security.dropped };
}

function collapsed() {
  return collapsedCount;
}

function since() {
  return startedAt;
}

function persistenceState() {
  return {
    mode: persistence.mode,
    file: persistence.file,
    restored: persistence.restored,
    reason: persistence.reason
  };
}

function setSink(fn) {
  sink = typeof fn === 'function' ? fn : defaultSink;
}

initPersistence();

module.exports = {
  audit,
  setSink,
  recent,
  dropped,
  droppedByRing,
  collapsed,
  since,
  persistenceState,
  flushCollapsed,
  isSecurity,
  STREAM,
  RING_MAX,
  SECURITY_RING_MAX
};
