'use strict';

const STREAM = 'argus.console.audit';

const SERVICE = 'argus-console-server';

const PATH_MAX = 512;
const AGENT_MAX = 256;

let sink = (line) => process.stdout.write(line + '\n');

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
  sink(JSON.stringify(record));
}

function setSink(fn) {
  sink = typeof fn === 'function' ? fn : ((line) => process.stdout.write(line + '\n'));
}

module.exports = { audit, setSink, STREAM };
