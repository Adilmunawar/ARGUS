'use strict';

const STREAM = 'argus.console.audit';

const SERVICE = 'argus-console-server';

const PATH_MAX = 512;
const AGENT_MAX = 256;

let sink = (line) => process.stdout.write(line + '\n');

const RING_MAX = Number(process.env.ARGUS_AUDIT_RING_EVENTS) > 0 ? Number(process.env.ARGUS_AUDIT_RING_EVENTS) : 2000;
const ring = [];
let droppedCount = 0;
let seq = 0;
const startedAt = new Date().toISOString();

function remember(record) {
  seq += 1;
  ring.push({ seq, ...record });
  if (ring.length > RING_MAX) {
    ring.splice(0, ring.length - RING_MAX);
    droppedCount += 1;
  }
}

function cap(value, limit) {
  const text = String(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function audit(event, fields) {
  const record = { ts: new Date().toISOString(), stream: STREAM, service: SERVICE, event };
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'path') record.path = cap(value, PATH_MAX);
    else if (key === 'userAgent') record.userAgent = cap(value, AGENT_MAX);
    else record[key] = value;
  }
  remember(record);
  sink(JSON.stringify(record));
}

function recent() {
  return ring.slice();
}

function dropped() {
  return droppedCount;
}

function since() {
  return startedAt;
}

function setSink(fn) {
  sink = typeof fn === 'function' ? fn : ((line) => process.stdout.write(line + '\n'));
}

module.exports = { audit, setSink, recent, dropped, since, STREAM };
