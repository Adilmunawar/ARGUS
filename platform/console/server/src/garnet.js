'use strict';

const net = require('node:net');

const cache = require('./cache');
const { positiveInt } = require('./env');

const int = positiveInt;

const HOST = process.env.ARGUS_GARNET_HOST || 'garnet';
const PORT = int('ARGUS_GARNET_PORT', 6379);
const USER = process.env.ARGUS_GARNET_USER || 'console';

const PASSWORD = process.env.ARGUS_GARNET_PASSWORD || '';

const TIMEOUT_MS = int('ARGUS_GARNET_TIMEOUT_MS', int('ARGUS_UPSTREAM_TIMEOUT_MS', 8000));

const MEM_LIMIT_BYTES = (() => {
  const n = Number(process.env.ARGUS_GARNET_MEM_LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const PROBE_TTL_MS = int('ARGUS_GARNET_PROBE_TTL_MS', 10000);

const DBSIZE_TTL_MS = int('ARGUS_GARNET_DBSIZE_TTL_MS', 300000);

const MAX_REPLY_BYTES = 8 * 1024 * 1024;

function encode(args) {
  let out = '*' + args.length + '\r\n';
  for (const a of args) {
    const s = String(a);
    out += '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
  }
  return Buffer.from(out, 'utf8');
}

class ProtocolError extends Error {
  constructor(message) { super(message); this.name = 'ProtocolError'; }
}

function parse(buf, i) {
  if (i >= buf.length) return null;
  const type = buf[i];
  const crlf = buf.indexOf('\r\n', i + 1, 'utf8');
  if (crlf < 0) return null;
  const head = buf.toString('utf8', i + 1, crlf);
  const after = crlf + 2;

  switch (type) {
    case 0x2b:
      return { value: head, next: after };
    case 0x2d:
      return { value: { resperror: head }, next: after };
    case 0x3a: {
      const n = Number(head);
      if (!Number.isFinite(n)) throw new ProtocolError(`the server sent ":${head}", which is not a number`);
      return { value: n, next: after };
    }
    case 0x24: {
      const len = Number(head);
      if (!Number.isFinite(len)) throw new ProtocolError(`the server sent a bulk string of length "${head}"`);
      if (len === -1) return { value: null, next: after };
      if (after + len + 2 > buf.length) return null;
      return { value: buf.toString('utf8', after, after + len), next: after + len + 2 };
    }
    case 0x2a: {
      const count = Number(head);
      if (!Number.isFinite(count)) throw new ProtocolError(`the server sent an array of length "${head}"`);
      if (count === -1) return { value: null, next: after };
      const items = [];
      let at = after;
      for (let k = 0; k < count; k += 1) {
        const item = parse(buf, at);
        if (!item) return null;
        items.push(item.value);
        at = item.next;
      }
      return { value: items, next: at };
    }
    default:
      throw new ProtocolError(
        `the server began a reply with 0x${type.toString(16)} ("${String.fromCharCode(type)}"), which is not RESP2. ` +
        'This client never sends HELLO, so the server should not have switched protocol.');
  }
}

function isRespError(v) { return !!v && typeof v === 'object' && typeof v.resperror === 'string'; }

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.fatal = null;
    this.closing = false;

    socket.on('data', (d) => this._onData(d));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._fail(new Error('the cache closed the connection before it answered')));
  }

  _fail(err) {
    if (!this.fatal) this.fatal = err;
    while (this.pending.length) {
      const p = this.pending.shift();
      clearTimeout(p.timer);
      p.reject(this.fatal);
    }
  }

  _onData(chunk) {
    if (this.closing) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_REPLY_BYTES) {
      this.socket.destroy();
      return this._fail(new ProtocolError(`the cache sent more than ${MAX_REPLY_BYTES} bytes for one reply`));
    }
    for (;;) {
      let out;
      try {
        out = parse(this.buf, 0);
      } catch (err) {
        this.socket.destroy();
        return this._fail(err);
      }
      if (!out) return;
      this.buf = this.buf.subarray(out.next);
      const p = this.pending.shift();
      if (!p) {
        this.socket.destroy();
        return this._fail(new ProtocolError('the cache sent a reply nothing had asked for'));
      }
      clearTimeout(p.timer);
      p.resolve(out.value);
    }
  }

  raw(args, label) {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        this._fail(new Error(`the cache did not answer ${label} within ${TIMEOUT_MS} ms`));
      }, TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
      this.socket.write(encode(args));
    });
  }

  async call(args, label) {
    const v = await this.raw(args, label);
    if (isRespError(v)) return { ok: false, error: v.resperror };
    return { ok: true, value: v };
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    try { this.socket.end(encode(['QUIT'])); } catch (err) {  }
    const t = setTimeout(() => { try { this.socket.destroy(); } catch (err) {  } }, 1000);
    if (typeof t.unref === 'function') t.unref();
  }
}

function open() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(
        new Error(`${HOST}:${PORT} did not accept a connection within ${TIMEOUT_MS} ms`),
        { code: 'ETIMEDOUT' }));
    }, TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(new Connection(socket));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}
class NotConfigured extends Error {
  constructor(message) { super(message); this.name = 'NotConfigured'; }
}

async function connectAuthenticated() {
  if (!PASSWORD) {
    throw new NotConfigured(
      'ARGUS_GARNET_PASSWORD is not set, so the console has no credential for the cache and does not guess one. ' +
      'Compose passes it as GARNET_CONSOLE_PASSWORD, which bootstrap.ps1 generates into platform/compose/.env ' +
      'and renders into secrets/garnet/users.acl. Running the console outside Compose, set ' +
      'ARGUS_GARNET_PASSWORD, ARGUS_GARNET_USER and ARGUS_GARNET_HOST in this process\'s environment.');
  }
  const conn = await open();
  const auth = await conn.call(['AUTH', USER, PASSWORD], 'AUTH');
  if (!auth.ok) {
    conn.close();
    throw new AuthError(
      `The cache refused the console credential: ${auth.error}. ` +
      'ARGUS_GARNET_PASSWORD and the hash in platform/compose/secrets/garnet/users.acl are rendered from the same ' +
      'GARNET_CONSOLE_PASSWORD; a mismatch means one of them was regenerated without the other. Re-run ' +
      'bootstrap.ps1 in platform/compose, then restart the garnet and console containers.');
  }
  return conn;
}

function classify(err) {
  const name = (err && err.name) || 'Error';
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);

  if (name === 'NotConfigured') return { reason: 'not-configured', message: msg };
  if (name === 'AuthError') return { reason: 'denied', message: msg };
  if (name === 'ProtocolError') {
    return {
      reason: 'protocol',
      message: `${HOST}:${PORT} answered something that is not RESP: ${msg}. Is that port really Garnet?`
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      reason: 'unreachable',
      message: `Nothing is listening on ${HOST}:${PORT}. Garnet sits behind the \`cache\` Compose profile, so a ` +
        'plain `docker compose up -d` does not start it: run `docker compose --profile cache up -d` in ' +
        'platform/compose.'
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      reason: 'unreachable',
      message: `${HOST} does not resolve from this process. That is a container-internal name: either run the ` +
        'console on the argus network, or point it at the published port with ARGUS_GARNET_HOST=127.0.0.1 and ' +
        'ARGUS_GARNET_PORT set to GARNET_PORT from platform/compose/.env.'
    };
  }
  if (code === 'ETIMEDOUT' || /did not answer|did not accept/i.test(msg)) {
    return { reason: 'timeout', message: `${msg} The cache is up enough to hold a socket open but not to reply.` };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || /closed the connection/i.test(msg)) {
    return {
      reason: 'unreachable',
      message: `${msg} Check \`docker compose logs garnet\`: a Garnet whose ACL file failed to parse refuses to ` +
        'start at all, and one that is restarting drops connections mid-command.'
    };
  }
  return { reason: 'error', message: msg };
}

function guarded(key, ttlMs, producer) {
  return async function () {
    try {
      const r = await cache.through(key, ttlMs, producer);
      return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  };
}

function parseInfo(text) {
  const sections = new Map();
  const flat = new Map();
  let current = '(unsectioned)';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      current = line.slice(1).trim() || '(unsectioned)';
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;
    if (!sections.has(current)) sections.set(current, new Map());
    sections.get(current).set(name, value);
    flat.set(name.toLowerCase(), { name, value, section: current });
  }
  return { sections, flat };
}

function metric(info, candidates, note) {
  if (!info) {
    return { value: null, field: null, unavailable: 'INFO could not be read from this server.' };
  }
  for (const name of candidates) {
    const hit = info.flat.get(name.toLowerCase());
    if (!hit) continue;
    const n = Number(hit.value);
    if (Number.isFinite(n)) return { value: n, field: hit.name, section: hit.section };
    return {
      value: null, field: hit.name, section: hit.section,
      unavailable: `${hit.name} is "${hit.value}", which is not a number.`
    };
  }
  return {
    value: null,
    field: null,
    unavailable: `This Garnet did not report ${candidates.join(' or ')} in INFO.` + (note ? ' ' + note : '')
  };
}

function text(info, candidates) {
  if (!info) return { value: null, field: null, unavailable: 'INFO could not be read from this server.' };
  for (const name of candidates) {
    const hit = info.flat.get(name.toLowerCase());
    if (hit) return { value: hit.value, field: hit.name, section: hit.section };
  }
  return { value: null, field: null, unavailable: `This Garnet did not report ${candidates.join(' or ')} in INFO.` };
}

function noperm(commandLabel, aclToken, error) {
  const said = String(error === undefined || error === null ? '' : error);
  if (/^NOPERM/i.test(said)) {
    return `The cache refused ${commandLabel}: ${said}. The rule for user "${USER}" in ` +
      `platform/compose/secrets/garnet/users.acl is supposed to grant ${aclToken}; it does not, so this panel has ` +
      'no source. bootstrap.ps1 renders that file, and services/cache/garnet.conf documents the exact rule it ' +
      'must contain.';
  }
  return `The cache refused ${commandLabel}: ${said}. That is not a permission error, so widening ${aclToken} in ` +
    'users.acl will not fix it -- check `docker compose logs garnet` and whether this build still has that command.';
}

const EVICTIONS_ARE_NOT_A_THING = {
  available: false,
  reason: 'no-such-metric',
  message: 'Garnet does not evict, and has no eviction counter, because it has no maxmemory to evict against. ' +
    'Past the in-memory region of the hybrid log, records are written to disk and stay live -- reading one is a ' +
    'disk read, not a miss. There is no count of keys dropped under memory pressure because no key is dropped ' +
    'under memory pressure. The pressure signal on this cache is the spill ratio; the only hard ceiling is the ' +
    "container's mem_limit, and reaching that kills the process rather than shedding keys."
};

async function probe() {
  const startedAt = Date.now();
  const conn = await connectAuthenticated();
  try {
    let form = 'INFO ALL';
    let raw = await conn.call(['INFO', 'ALL'], 'INFO ALL');
    if (!raw.ok) {
      form = 'INFO';
      raw = await conn.call(['INFO'], 'INFO');
    }

    const info = raw.ok && typeof raw.value === 'string' ? parseInfo(raw.value) : null;
    const infoError = raw.ok
      ? (info ? null : 'INFO answered with something that was not a text payload.')
      : noperm('INFO', '+info', raw.error);

    const whoami = await conn.call(['ACL', 'WHOAMI'], 'ACL WHOAMI');

    const time = await conn.call(['TIME'], 'TIME');
    const localAt = Date.now();

    const maxmemory = await conn.call(['CONFIG', 'GET', 'maxmemory'], 'CONFIG GET maxmemory');
    const maxclients = await conn.call(['CONFIG', 'GET', 'maxclients'], 'CONFIG GET maxclients');

    const clientList = await conn.call(['CLIENT', 'LIST'], 'CLIENT LIST');

    return {
      info,
      infoForm: form,
      infoError,
      whoami,
      time,
      localAt,
      maxmemory,
      maxclients,
      clientList,
      probeMs: Date.now() - startedAt,
      at: new Date().toISOString()
    };
  } finally {
    conn.close();
  }
}

const cachedProbe = () => cache.through('garnet:probe', PROBE_TTL_MS, probe);

function configValue(reply) {
  if (!reply || !reply.ok) return { present: false, value: null, error: reply ? reply.error : null };
  const arr = Array.isArray(reply.value) ? reply.value : [];
  if (arr.length < 2) return { present: false, value: null, error: null };
  return { present: true, value: arr[1], error: null };
}

const serverInfo = guarded('garnet:server', PROBE_TTL_MS, async () => {
  const p = await cachedProbe();
  const v = p.value;
  const info = v.info;

  const opsPerSec = metric(info, ['instantaneous_ops_per_sec'],
    'That field is produced by the metrics sampling task, which is off unless MetricsSamplingFrequency is set in ' +
    'services/cache/garnet.conf.');

  let serverEpochMs = null;
  let skewMs = null;
  if (v.time.ok && Array.isArray(v.time.value) && v.time.value.length >= 2) {
    const secs = Number(v.time.value[0]);
    const micros = Number(v.time.value[1]);
    if (Number.isFinite(secs) && Number.isFinite(micros)) {
      serverEpochMs = secs * 1000 + micros / 1000;
      skewMs = Math.round(v.localAt - serverEpochMs);
    }
  }

  return {
    reachable: true,
    endpoint: `${HOST}:${PORT}`,
    infoForm: v.infoForm,
    infoError: v.infoError,
    sections: info ? [...info.sections.keys()] : [],

    server: {
      garnetVersion: text(info, ['garnet_version']),
      redisCompatVersion: text(info, ['redis_version']),
      mode: text(info, ['redis_mode', 'mode']),
      os: text(info, ['os']),
      processId: metric(info, ['process_id', 'processId']),
      tcpPort: metric(info, ['tcp_port']),
      uptimeSeconds: metric(info, ['uptime_in_seconds']),
      runId: text(info, ['run_id'])
    },

    identity: v.whoami.ok
      ? { user: v.whoami.value, expected: USER, matches: v.whoami.value === USER }
      : { user: null, expected: USER, matches: null, unavailable: noperm('ACL WHOAMI', '+acl|whoami', v.whoami.error) },

    clock: {
      serverEpochMs,
      consoleEpochMs: v.localAt,
      skewMs,
      unavailable: serverEpochMs === null
        ? (v.time.ok ? 'TIME answered in a shape this reader does not recognise.' : noperm('TIME', '+time', v.time.error))
        : null,
      note: 'Skew here breaks nothing in the cache itself -- RESP carries no signature -- but it is what makes two ' +
        'services disagree about when a TTL expires. WSL2 drifts after the Windows host sleeps.'
    },

    throughput: {
      opsPerSec,
      totalCommandsProcessed: metric(info, ['total_commands_processed']),
      totalReads: metric(info, ['total_read_commands_processed']),
      totalWrites: metric(info, ['total_write_commands_processed']),
      totalConnectionsReceived: metric(info, ['total_connections_received']),
      netInputBytes: metric(info, ['total_net_input_bytes']),
      netOutputBytes: metric(info, ['total_net_output_bytes'])
    },

    hitRate: {
      available: false,
      reason: 'no-such-metric',
      message: 'Garnet publishes no keyspace_hits/keyspace_misses, so there is no hit rate to compute. The nearest ' +
        'honest figures are the per-command counters in INFO COMMANDSTATS, which count calls rather than hits, and ' +
        'they are not the same thing: a GET that returns nil is a call. A real hit rate has to come from the ' +
        'application that owns the keys.'
    },
    evictions: EVICTIONS_ARE_NOT_A_THING,

    probeMs: v.probeMs,
    at: v.at
  };
});

function spillOf(name, begin, head, tail) {
  const row = {
    log: name,
    beginAddress: begin,
    headAddress: head,
    tailAddress: tail,
    spilledBytes: null,
    residentBytes: null,
    logBytes: null,
    spillRatio: null,
    unavailable: null
  };
  if (!(begin <= head && head <= tail)) {
    row.unavailable = `${name} reported begin=${begin}, head=${head}, tail=${tail}, which are not in ascending ` +
      'order. This reader will not derive a ratio from addresses it cannot interpret.';
    return row;
  }
  row.spilledBytes = head - begin;
  row.residentBytes = tail - head;
  row.logBytes = tail - begin;
  if (row.logBytes === 0) {
    row.unavailable = 'The log is empty, so there is no ratio to take yet. Garnet starts cold on every boot ' +
      '(Recover is false), so this is the expected state until something writes.';
    return row;
  }
  row.spillRatio = row.spilledBytes / row.logBytes;
  return row;
}

const memory = guarded('garnet:memory', PROBE_TTL_MS, async () => {
  const p = await cachedProbe();
  const v = p.value;
  const info = v.info;

  const process_ = metric(info,
    ['proc_physical_memory_size', 'used_memory_rss', 'used_memory', 'gc_committed_bytes'],
    'Without it there is no numerator for the container-limit gauge.');

  const usedRatio = process_.value !== null && MEM_LIMIT_BYTES ? process_.value / MEM_LIMIT_BYTES : null;

  const logs = [];
  if (info) {
    for (const [lower, hit] of info.flat) {
      if (!lower.endsWith('.beginaddress')) continue;
      const prefix = hit.name.slice(0, hit.name.length - '.BeginAddress'.length);
      const begin = metric(info, [prefix + '.BeginAddress']);
      const head = metric(info, [prefix + '.HeadAddress', prefix + '.SafeHeadAddress']);
      const tail = metric(info, [prefix + '.TailAddress']);
      if (begin.value === null || head.value === null || tail.value === null) continue;
      const row = spillOf(prefix, begin.value, head.value, tail.value);
      row.memoryBytes = metric(info, [prefix + '.CurrentMemorySizeBytes']);
      row.memoryLimitBytes = metric(info, [prefix + '.MaxMemorySizeBytes']);
      row.memoryRatio = row.memoryBytes.value !== null && row.memoryLimitBytes.value
        ? row.memoryBytes.value / row.memoryLimitBytes.value
        : null;
      logs.push(row);
    }
    logs.sort((a, b) => a.log.localeCompare(b.log));
  }

  let worst = null;
  for (const row of logs) {
    if (row.spillRatio === null) continue;
    if (!worst || row.spillRatio > worst.spillRatio) worst = row;
  }

  const mm = configValue(v.maxmemory);

  return {
    reachable: true,
    endpoint: `${HOST}:${PORT}`,

    container: {
      processBytes: process_.value,
      processField: process_.field,
      processUnavailable: process_.unavailable || null,
      limitBytes: MEM_LIMIT_BYTES,
      limitSource: MEM_LIMIT_BYTES
        ? 'ARGUS_GARNET_MEM_LIMIT_BYTES, which bootstrap generates from the same value as the container mem_limit'
        : null,
      limitUnavailable: MEM_LIMIT_BYTES ? null
        : 'ARGUS_GARNET_MEM_LIMIT_BYTES is not set, so there is no denominator for this gauge. The console cannot ' +
          "read another container's cgroup, and this reader will not substitute a guess. Compose sets it; outside " +
          'Compose, set it to the same number of bytes as GARNET_MEM_LIMIT.',
      usedRatio,
      note: 'mem_limit applies to the whole container -- the .NET runtime, the buffer pool and the network buffers ' +
        'as well as the store -- and it is the only hard ceiling in this deployment. Nothing is evicted when it is ' +
        'reached: the container is killed.'
    },

    logs,
    spillRatio: worst ? worst.spillRatio : null,
    spillRatioLog: worst ? worst.log : null,
    spilling: worst ? worst.spilledBytes > 0 : null,
    spillUnavailable: logs.length ? null
      : 'This build reported no log addresses in INFO, so the spill ratio -- the pressure signal on this cache -- ' +
        'cannot be computed. INFO STORE is where they live; check that INFO is readable and that the server is ' +
        'Garnet rather than a Redis-compatible stand-in.',
    spillDirectory: text(info, ['LogDir']),

    maxmemory: {
      configured: mm.present,
      value: mm.present ? mm.value : null,
      evidence: v.maxmemory.ok
        ? (mm.present
            ? 'CONFIG GET maxmemory returned a value on this server, which is new: the gauge above should be ' +
              'rechecked against it.'
            : 'CONFIG GET maxmemory returned an empty result just now. The parameter is not unset, it does not ' +
              'exist on this server, so there is no ceiling for it to be under and nothing is evicted at one.')
        : noperm('CONFIG GET', '+config|get', v.maxmemory.error)
    },
    evictions: EVICTIONS_ARE_NOT_A_THING,

    probeMs: v.probeMs,
    at: v.at
  };
});

function parseClientLine(line) {
  const out = {};
  for (const pair of line.trim().split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function intOrNull(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const clients = guarded('garnet:clients', PROBE_TTL_MS, async () => {
  const p = await cachedProbe();
  const v = p.value;

  let list = null;
  let listUnavailable = null;
  if (!v.clientList.ok) {
    listUnavailable = noperm('CLIENT LIST', '+client|list', v.clientList.error);
  } else if (typeof v.clientList.value !== 'string') {
    listUnavailable = 'CLIENT LIST answered with something that was not a text payload.';
  } else {
    list = v.clientList.value.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
      const f = parseClientLine(line);
      return {
        id: f.id || null,
        address: f.addr || null,
        name: f.name || null,
        user: f.user || null,
        database: intOrNull(f.db),
        ageSeconds: intOrNull(f.age),
        idleSeconds: intOrNull(f.idle),
        lastCommand: f.cmd || null,
        resp: intOrNull(f.resp)
      };
    });
  }

  const mc = configValue(v.maxclients);
  const limit = mc.present ? intOrNull(mc.value) : null;
  const connected = metric(v.info, ['connected_clients']);
  const count = list ? list.length : connected.value;

  return {
    reachable: true,
    endpoint: `${HOST}:${PORT}`,
    count,
    countSource: list ? 'CLIENT LIST' : (connected.value !== null ? 'INFO connected_clients' : null),
    countUnavailable: count === null
      ? (listUnavailable || connected.unavailable || 'Neither CLIENT LIST nor connected_clients was readable.')
      : null,
    connectedClients: connected,
    limit,
    limitUnavailable: limit === null
      ? 'This server did not report a connection limit through CONFIG GET maxclients. NetworkConnectionLimit is ' +
        'set to 256 in services/cache/garnet.conf, but that is a committed intention rather than a reading, and ' +
        'this reader does not report a number it could not take from the server.'
      : null,
    clients: list || [],
    clientsUnavailable: listUnavailable,
    note: 'This list includes the console\'s own connection, which is opened and closed for each read.',
    probeMs: v.probeMs,
    at: v.at
  };
});

const keyspace = guarded('garnet:keyspace', DBSIZE_TTL_MS, async () => {
  const conn = await connectAuthenticated();
  let reply;
  try {
    reply = await conn.call(['DBSIZE'], 'DBSIZE');
  } finally {
    conn.close();
  }

  return {
    reachable: true,
    endpoint: `${HOST}:${PORT}`,
    keys: reply.ok && typeof reply.value === 'number' ? reply.value : null,
    keysUnavailable: reply.ok
      ? (typeof reply.value === 'number' ? null : 'DBSIZE answered with something that was not an integer.')
      : noperm('DBSIZE', '+dbsize', reply.error),
    keysNote: 'Counted by walking the store, not read from a counter, so this figure is as of the timestamp below ' +
      'and is refreshed at most every ' + Math.round(DBSIZE_TTL_MS / 1000) + ' s. It counts one logical database: ' +
      'garnet.conf pins MaxDatabases to 1, so there is nowhere else for a key to be.',

    byPrefix: {
      available: false,
      reason: 'no-read-privilege',
      message: 'Breaking the keyspace down by prefix needs SCAN or KEYS to enumerate, and MEMORY USAGE or GET to ' +
        'size what it finds. The console credential holds none of them: its rule in users.acl is -@all plus a ' +
        'fixed list, and +get, +mget, +keys, +scan, +hgetall and +memory|usage are all deliberately outside it. ' +
        'That is not an oversight to be fixed by widening the rule -- the console is a dashboard, and a ' +
        'compromised console process must not be able to read a session token or a survey record out of the ' +
        'cache. A per-prefix breakdown has to come from the application that writes those keys.'
    },
    keyIsolationNote: 'Garnet ACLs have no key patterns either: `~*` is accepted and ignored, and any narrower ' +
      'pattern makes the server refuse to start. There is no per-prefix isolation on this cache -- only credential ' +
      'and command separation -- so a tenant boundary that needs it needs a second Garnet instance.',
    evictions: EVICTIONS_ARE_NOT_A_THING,
    at: new Date().toISOString()
  };
});

const health = guarded('garnet:health', PROBE_TTL_MS, async () => {
  const at = new Date().toISOString();

  let authRequired = null;
  let authProbe = null;
  let anonymousAnswered = false;
  try {
    const conn = await open();
    try {
      const ping = await conn.call(['PING'], 'PING');
      anonymousAnswered = true;
      if (ping.ok) {
        authRequired = false;
        authProbe = 'An unauthenticated PING was answered. AUTHENTICATION IS OFF on this cache: anything that can ' +
          'reach ' + HOST + ':' + PORT + ' has full rights, FLUSHALL included. The cause is almost always a ' +
          'missing `user default off` line in platform/compose/secrets/garnet/users.acl -- Garnet creates ' +
          '`default` with +@all and no password when the ACL file does not define it. Re-run bootstrap.ps1 in ' +
          'platform/compose and restart the garnet container.';
      } else if (/^(NOAUTH|NOPERM|WRONGPASS)/i.test(ping.error)) {
        authRequired = true;
        authProbe = `An unauthenticated PING was refused (${ping.error}), so authentication is on.`;
      } else {
        authRequired = null;
        authProbe = `An unauthenticated PING was answered with "${ping.error}", which is neither PONG nor an ` +
          'authentication error. This probe cannot tell from that whether the cache requires a credential. ' +
          '`docker compose logs garnet-init` has the boot-time verdict.';
      }
    } finally {
      conn.close();
    }
  } catch (err) {
    const c = classify(err);
    authProbe = `The unauthenticated probe could not reach the cache: ${c.message}`;
  }

  let probeResult = null;
  let failure = null;
  try {
    const p = await cachedProbe();
    probeResult = p.value;
  } catch (err) {
    failure = classify(err);
  }

  const notes = [];
  let status;
  if (failure && failure.reason === 'not-configured') {
    status = 'not-configured';
  } else if (failure && (failure.reason === 'unreachable' || failure.reason === 'timeout' || failure.reason === 'protocol')) {
    status = 'unreachable';
  } else if (failure && failure.reason === 'denied') {
    status = 'denied';
  } else if (failure) {
    status = 'unreachable';
  } else {
    status = 'ok';
  }

  if (authRequired === false) status = 'insecure';

  let spill = null;
  if (probeResult) {
    if (probeResult.infoError) {
      notes.push(probeResult.infoError);
      if (status === 'ok') status = 'degraded';
    }
    for (const [label, token, reply] of [
      ['ACL WHOAMI', '+acl|whoami', probeResult.whoami],
      ['TIME', '+time', probeResult.time],
      ['CONFIG GET', '+config|get', probeResult.maxmemory],
      ['CLIENT LIST', '+client|list', probeResult.clientList]
    ]) {
      if (!reply.ok) {
        notes.push(noperm(label, token, reply.error));
        if (status === 'ok') status = 'degraded';
      }
    }
    if (probeResult.whoami.ok && probeResult.whoami.value !== USER) {
      notes.push(`The credential authenticated as "${probeResult.whoami.value}", not "${USER}". ` +
        'ARGUS_GARNET_USER and users.acl disagree, and the console is holding whatever grants that other rule has.');
      if (status === 'ok') status = 'degraded';
    }

    const m = await memory();
    if (m.ok) {
      spill = {
        ratio: m.spillRatio,
        log: m.spillRatioLog,
        spilling: m.spilling,
        unavailable: m.spillUnavailable,
        directory: m.spillDirectory ? m.spillDirectory.value : null
      };
      if (m.spilling) {
        notes.push('Part of the log is on disk. That is not a fault and nothing has been lost -- spilled records ' +
          'are still live and still served -- but reads of them are disk reads, and the spill area is capped at ' +
          'SegmentSize x CompactionMaxSegments, past which the oldest segment is deleted whole and the keys in it ' +
          'are gone. Watch this ratio rather than a memory percentage.');
      }
      if (m.container && m.container.limitUnavailable) notes.push(m.container.limitUnavailable);
    }
  }

  const reachable = anonymousAnswered ? true
    : !failure ? true
      : failure.reason === 'denied' ? true
        : false;

  return {
    status,
    reachable,
    endpoint: `${HOST}:${PORT}`,
    user: USER,
    reason: failure ? failure.reason : null,
    message: failure ? failure.message : null,

    authRequired,
    authProbe,

    version: probeResult && probeResult.info
      ? (probeResult.info.flat.get('garnet_version') || { value: null }).value || null
      : null,
    uptimeSeconds: probeResult ? metric(probeResult.info, ['uptime_in_seconds']).value : null,
    probeMs: probeResult ? probeResult.probeMs : null,

    spill,
    evictions: EVICTIONS_ARE_NOT_A_THING,

    notes,
    scope: 'This checks one Garnet at ' + HOST + ':' + PORT + ' with the console credential, plus one ' +
      'unauthenticated PING. It cannot see the ACL file itself -- ACL LIST prints every password hash on the ' +
      'server, so the console is deliberately not permitted to run it -- and it does not verify that the console ' +
      'is denied the commands it should be denied. garnet-init proves that at boot: `docker compose logs ' +
      'garnet-init`.',
    at
  };
});

module.exports = {
  serverInfo,
  memory,
  clients,
  keyspace,
  health,
  classify
};
