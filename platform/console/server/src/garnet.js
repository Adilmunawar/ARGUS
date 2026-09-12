/*
 * The cache, as the console sees it.
 *
 * This is the ElastiCache replacement's read side: Microsoft Garnet, spoken to
 * over RESP on a plain TCP socket, with the console's own ACL identity. Five
 * readers -- server state, memory, connections, keyspace size, health -- and
 * nothing that writes, reads a value, or reconfigures anything.
 *
 * Four things this file refuses to do. The first two are the reason it exists.
 *
 * IT NEVER REPORTS AN EVICTION COUNT, BECAUSE GARNET DOES NOT EVICT. Garnet
 * has no maxmemory and no eviction policy; past the in-memory region of its
 * hybrid log, records are written to disk and stay LIVE -- reading one is a
 * disk read, not a miss. Nothing is thrown away to make room, so there is no
 * count of things thrown away, and any figure printed under that heading would
 * be invented. The real risks are the container reaching mem_limit and the
 * spill directory filling the WSL2 disk. The pressure signal is SPILL, and
 * `memory()` computes it from the log addresses the server actually reports.
 * See the block above spillOf() for the detail, including the one way keys DO
 * disappear here (it is a disk ceiling, not memory pressure, and calling it
 * eviction would attach it to the wrong number).
 *
 * IT NEVER SHOWS A NUMBER THE SERVER DID NOT GIVE IT. Every figure below is
 * looked up by field name in this server's own INFO output and reported as
 * `null` with a reason when this build did not emit it. That matters more here
 * than in most places, because Garnet's INFO is deliberately NOT Redis's:
 * keyspace_hits, keyspace_misses, evicted_keys and maxmemory are all absent,
 * and a dashboard that defaults an absent counter to zero shows a measured-
 * looking 0% hit rate for a cache that is serving perfectly. Unknown stays
 * unknown, and it says which field was missing.
 *
 * IT NEVER PRETENDS THE CONSOLE CAN READ THE CACHE. The console credential
 * holds `-@all` plus a fixed list that excludes +get, +mget, +keys, +scan and
 * +memory|usage, on purpose: this is a dashboard, not a client, and a
 * compromised console process must not be able to lift a session token or a
 * survey record out of the cache. So the per-prefix breakdown a cache screen
 * usually leads with is not a missing feature, it is a privilege this console
 * is not allowed to hold -- and the readers that would need it say so, in
 * those words, instead of returning an empty list that reads as "the cache is
 * empty".
 *
 * IT NEVER SENDS A COMMAND WITHOUT A DEADLINE. Every command carries its own
 * timer and every connection is closed when the reader finishes with it. A
 * cache that has stopped answering is the normal reason a page is being
 * loaded; it must not also be the reason the page never renders.
 *
 * On the missing dependency: this speaks RESP itself, in about a hundred lines
 * at the top of the file, rather than pulling in a Redis client. The console
 * runs inside an egress-restricted network (ADR-0027) where every dependency
 * is a thing that has to be reviewed and patched, it needs six read-only
 * commands, and a client library would additionally want to reconnect, retry
 * and pipeline on its own schedule -- behaviour a dashboard has no use for and
 * would have to be configured back out of.
 */
'use strict';

const net = require('node:net');

const cache = require('./cache');
const { positiveInt } = require('./env');

/* ------------------------------------------------------------------ config --- */

/* In-network defaults, matching platform/compose/docker-compose.yml. Running
   the console on the Windows host for front-end work, `garnet` resolves to
   nothing -- classify() names that case explicitly rather than letting it
   arrive as a bare ENOTFOUND. */
/* A bad number in the environment must not become NaN three layers down, where
   it presents as a connection to port NaN or a timeout that never fires. */
const int = positiveInt;

const HOST = process.env.ARGUS_GARNET_HOST || 'garnet';
const PORT = int('ARGUS_GARNET_PORT', 6379);
const USER = process.env.ARGUS_GARNET_USER || 'console';

/* The credential, from the environment and nowhere else. There is no default,
   no file to put one in, and no parameter on any exported function that could
   carry one -- a reader that accepted a password would be a reader an HTTP
   query string could feed. It is also never returned in a payload and never
   put in an error message: the only command that carries it is labelled `AUTH`
   with its arguments dropped before anything can log them. */
const PASSWORD = process.env.ARGUS_GARNET_PASSWORD || '';

const TIMEOUT_MS = int('ARGUS_GARNET_TIMEOUT_MS', int('ARGUS_UPSTREAM_TIMEOUT_MS', 8000));

/* THE DENOMINATOR FOR THE MEMORY GAUGE, AND IT DOES NOT COME FROM THE SERVER.
 *
 * `CONFIG GET maxmemory` returns an EMPTY result on Garnet -- the parameter is
 * not merely unset, it does not exist -- so there is no server-side ceiling to
 * draw a percentage against. The only real ceiling is the container's
 * mem_limit, which lives in Docker's cgroup and which this process cannot
 * read: the console is a different container. bootstrap generates
 * GARNET_MEM_LIMIT and this value from one number so they cannot drift.
 *
 * Absent, it stays null and every ratio computed against it stays null with a
 * reason. A hardcoded fallback here would be a gauge with an invented
 * denominator, which is worse than no gauge: it would keep reading "38% used"
 * after somebody doubled the container's memory. */
const MEM_LIMIT_BYTES = (() => {
  const n = Number(process.env.ARGUS_GARNET_MEM_LIMIT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

/* One INFO round trip serves the three readers that shape it, so a screen with
   three cache panels costs one connection rather than three. */
const PROBE_TTL_MS = int('ARGUS_GARNET_PROBE_TTL_MS', 10000);

/* DBSIZE IS NOT O(1) ON GARNET. It walks the whole store, and once the log has
   spilled that walk reads from disk. Five minutes by default, and deliberately
   not the probe TTL: this must never end up on the path of a page somebody
   leaves open on a second monitor. */
const DBSIZE_TTL_MS = int('ARGUS_GARNET_DBSIZE_TTL_MS', 300000);

/* A reply larger than this is a server we do not understand, not a big INFO.
   The largest thing we ask for is CLIENT LIST bounded by NetworkConnectionLimit
   (256 connections), which is tens of kilobytes. Cap it rather than let one
   upstream exhaust the console's heap. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------- resp --- */

/* Commands go out as RESP arrays of bulk strings, never as inline commands: an
   inline command is split on whitespace by the server, so any argument that
   ever contains a space silently becomes two arguments. Nothing we send today
   contains one; the encoding costs nothing and removes the class. */
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

/**
 * Parse one RESP2 value out of `buf` starting at `i`.
 *
 * Returns { value, next } or null when the buffer does not yet hold a complete
 * value -- "incomplete" has to be distinguishable from "parsed a null", which
 * is why this returns null-the-sentinel for the first and { value: null } for
 * the second.
 *
 * RESP2 only, and that is not an omission: a server speaks RESP3 only after
 * the client sends HELLO 3, and this client never does. An unknown type byte
 * is therefore a real protocol failure and is reported as one, naming the byte,
 * rather than being skipped into a silently wrong reply.
 */
function parse(buf, i) {
  if (i >= buf.length) return null;
  const type = buf[i];
  const crlf = buf.indexOf('\r\n', i + 1, 'utf8');
  if (crlf < 0) return null;
  const head = buf.toString('utf8', i + 1, crlf);
  const after = crlf + 2;

  switch (type) {
    case 0x2b: /* + simple string */
      return { value: head, next: after };
    case 0x2d: /* - error */
      return { value: { resperror: head }, next: after };
    case 0x3a: { /* : integer */
      const n = Number(head);
      if (!Number.isFinite(n)) throw new ProtocolError(`the server sent ":${head}", which is not a number`);
      return { value: n, next: after };
    }
    case 0x24: { /* $ bulk string */
      const len = Number(head);
      if (!Number.isFinite(len)) throw new ProtocolError(`the server sent a bulk string of length "${head}"`);
      if (len === -1) return { value: null, next: after };
      if (after + len + 2 > buf.length) return null;
      return { value: buf.toString('utf8', after, after + len), next: after + len + 2 };
    }
    case 0x2a: { /* * array */
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

/**
 * One connection, one reader, closed when the reader is done.
 *
 * No pooling and no reconnect loop. A dashboard makes a handful of reads a
 * minute behind a TTL cache, so a pool saves a TCP handshake on loopback and
 * costs the whole class of bugs where a half-read socket is handed to the next
 * caller -- which presents as one panel showing another panel's numbers.
 */
class Connection {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.fatal = null;
    /* Set by close(). QUIT is answered with +OK, and that reply arrives with
       nothing queued for it -- which is exactly the "a reply nobody asked for"
       condition below. Without this flag, every clean shutdown would end by
       destroying the socket and recording a protocol error against a
       connection that behaved perfectly. */
    this.closing = false;

    socket.on('data', (d) => this._onData(d));
    socket.on('error', (err) => this._fail(err));
    /* A close with commands outstanding is its own failure, and a specific
       one: Garnet closes the connection rather than replying when the ACL file
       failed to load in a way that leaves no usable user. Reporting it as
       "closed before the reply arrived" beats a generic ECONNRESET. */
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
      /* Nothing subscribes, so there is no legitimate unsolicited reply. One
         means the stream is out of step with the queue and every later reply
         would be attributed to the wrong command -- the failure that shows up
         as a memory figure appearing under "connected clients". */
      if (!p) {
        this.socket.destroy();
        return this._fail(new ProtocolError('the cache sent a reply nothing had asked for'));
      }
      clearTimeout(p.timer);
      p.resolve(out.value);
    }
  }

  /**
   * Send one command and wait for its reply, with its own deadline.
   *
   * `label` is what appears in any error, and it is a fixed string chosen by
   * the caller rather than the arguments joined together, because one of the
   * commands this module sends is AUTH.
   */
  raw(args, label) {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        /* Destroy rather than carry on: the reply may still arrive, and a
           connection whose replies are one behind is worse than a closed one. */
        this.socket.destroy();
        this._fail(new Error(`the cache did not answer ${label} within ${TIMEOUT_MS} ms`));
      }, TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
      this.socket.write(encode(args));
    });
  }

  /**
   * Send one command and classify the answer.
   *
   * A server ERROR REPLY IS NOT AN EXCEPTION. NOPERM is the most likely thing
   * this module hears from a correctly configured estate whose ACL file has
   * drifted, and it is information -- "the console is blind to this one panel,
   * here is the grant it is missing" -- not a failure of the request. Only
   * transport and protocol failures reject, and those are what classify()
   * turns into an envelope.
   */
  async call(args, label) {
    const v = await this.raw(args, label);
    if (isRespError(v)) return { ok: false, error: v.resperror };
    return { ok: true, value: v };
  }

  /**
   * QUIT, then FIN, and destroy only if the server does not close.
   *
   * Not a bare destroy(). An RST from a client that just connected is a
   * session exception on the server side, and Garnet counts those
   * (total_number_resp_server_session_exceptions) -- so a console polling this
   * screen would steadily inflate a counter that an operator is entitled to
   * read as "clients are failing". QUIT needs no grant and works
   * unauthenticated, so this is safe on the anonymous probe too.
   */
  close() {
    if (this.closing) return;
    this.closing = true;
    try { this.socket.end(encode(['QUIT'])); } catch (err) { /* already gone */ }
    /* Unref'd: a server that never closes must not hold the process open, and
       must not delay a shutdown by this timer either. */
    const t = setTimeout(() => { try { this.socket.destroy(); } catch (err) { /* gone */ } }, 1000);
    if (typeof t.unref === 'function') t.unref();
  }
}

function open() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    /* Six small commands in sequence: Nagle would add 40 ms to each one for no
       benefit on a loopback or bridge network. */
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

/** Connect and authenticate, or fail with a reason that names the next action. */
async function connectAuthenticated() {
  if (!PASSWORD) {
    throw new NotConfigured(
      'ARGUS_GARNET_PASSWORD is not set, so the console has no credential for the cache and does not guess one. ' +
      'Compose passes it as GARNET_CONSOLE_PASSWORD, which bootstrap.ps1 generates into platform/compose/.env ' +
      'and renders into secrets/garnet/users.acl. Running the console outside Compose, set ' +
      'ARGUS_GARNET_PASSWORD, ARGUS_GARNET_USER and ARGUS_GARNET_HOST in this process\'s environment.');
  }
  const conn = await open();
  /* The two-argument ACL form. Garnet is in AuthenticationMode=ACL and there
     is no shared password, so the one-argument form would authenticate as
     `default` -- which the ACL file switches off. */
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

/* --------------------------------------------------------------- classify --- */

/**
 * Turn a failure into something with a next action attached.
 *
 * "Cache unavailable" tells an operator nothing. On this estate the three
 * likely causes are entirely different jobs: the cache profile was never
 * started, the console is running on the Windows host where `garnet` is not a
 * name, or the credential and the ACL file have drifted apart.
 */
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

/** A reader that reports why it could not answer instead of throwing. */
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

/* ------------------------------------------------------------------- info --- */

/**
 * Split an INFO payload into sections and a flat lookup.
 *
 * Keys are kept with their original spelling for display and indexed
 * lower-cased for lookup, because the one thing every reader here must be able
 * to say is WHICH field a number came from. Garnet's own names are neither
 * Redis's nor consistently cased (`LogDir`, `Log.BeginAddress`,
 * `proc_physical_memory_size` all appear), and a reader that quietly matched
 * the wrong one would be the exact defect this file is written against.
 */
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

/**
 * Look one number up by name, and say so when it is not there.
 *
 * Nothing calls Number(x) || 0 anywhere below: a field this build did not emit
 * comes back as null carrying the names that were tried, and every caller
 * passes that straight through to the UI.
 */
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

/** The same, for a field whose value is text rather than a number. */
function text(info, candidates) {
  if (!info) return { value: null, field: null, unavailable: 'INFO could not be read from this server.' };
  for (const name of candidates) {
    const hit = info.flat.get(name.toLowerCase());
    if (hit) return { value: hit.value, field: hit.name, section: hit.section };
  }
  return { value: null, field: null, unavailable: `This Garnet did not report ${candidates.join(' or ')} in INFO.` };
}

/**
 * Explain a refused command.
 *
 * A missing grant is phrased as the fix, because by the time anyone reads it
 * the question is what to type. Anything else is quoted and left alone: this
 * has to be able to say "the server refused it and I do not know why" without
 * blaming users.acl for an error that has nothing to do with it -- an "ERR
 * unknown command" from a build that dropped the command would send an
 * operator to edit an ACL file that is already correct.
 */
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

/* Every reader a cache screen might hang an "Evictions" tile off returns this
 * object where the number would have been. It is deliberately not simply
 * omitted: an absent key is defaulted to 0 by whoever writes the screen, and
 * "0 evictions" is the wrong claim. Returning the refusal, with the reason,
 * makes the tile impossible to draw by accident and tells the person who
 * tried why. */
const EVICTIONS_ARE_NOT_A_THING = {
  available: false,
  reason: 'no-such-metric',
  message: 'Garnet does not evict, and has no eviction counter, because it has no maxmemory to evict against. ' +
    'Past the in-memory region of the hybrid log, records are written to disk and stay live -- reading one is a ' +
    'disk read, not a miss. There is no count of keys dropped under memory pressure because no key is dropped ' +
    'under memory pressure. The pressure signal on this cache is the spill ratio; the only hard ceiling is the ' +
    "container's mem_limit, and reaching that kills the process rather than shedding keys."
};

/* ------------------------------------------------------------------ probe --- */

/**
 * One connection, one pass, everything three readers need.
 *
 * Notably NOT including DBSIZE. That command walks the store, so putting it
 * here would attach a full scan to every page load of the cache screen -- see
 * keyspace(), which keeps it behind its own much longer TTL.
 *
 * Every command after AUTH is allowed to fail on its own. A NOPERM on CLIENT
 * LIST must cost the connections panel and nothing else; the alternative is
 * one missing grant blanking a screen that could have rendered five of its six
 * tiles.
 */
async function probe() {
  const startedAt = Date.now();
  const conn = await connectAuthenticated();
  try {
    /* INFO ALL rather than INFO, so this does not depend on which sections
       this build considers default -- STORE, the one that carries the spill
       addresses, is the one that matters and is not guaranteed to be. KEYSPACE
       is excluded by Garnet from both forms precisely because it scans, which
       is the behaviour we want here. If a build refuses ALL, plain INFO still
       answers, and the form that worked is reported so nobody has to wonder
       why a field is missing. */
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

    /* Which identity the server thinks we are. Cheap, and it catches the case
       where ARGUS_GARNET_USER and the ACL file disagree but the password
       happens to match another rule. */
    const whoami = await conn.call(['ACL', 'WHOAMI'], 'ACL WHOAMI');

    /* Clocks. RESP carries no signature so skew does not break the cache the
       way it breaks S3, but it is what makes two services disagree about when
       a TTL expires. WSL2 drifts after the host sleeps. */
    const time = await conn.call(['TIME'], 'TIME');
    const localAt = Date.now();

    /* PROOF, not assertion, that there is no eviction ceiling. On Garnet this
       comes back as an EMPTY array: maxmemory is not unset, it does not exist.
       Asking costs one round trip and turns "the docs say Garnet has no
       maxmemory" into "this server, just now, reported none" -- and it means a
       future Garnet that grows the parameter will be reported honestly. */
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
      /* Round trip for the whole pass, which is the only latency figure this
         module measures. It is NOT a command latency: it covers a connect, an
         AUTH and six commands, and it is labelled that way wherever it shows. */
      probeMs: Date.now() - startedAt,
      at: new Date().toISOString()
    };
  } finally {
    conn.close();
  }
}

const cachedProbe = () => cache.through('garnet:probe', PROBE_TTL_MS, probe);

/* Read the single value out of a `CONFIG GET <param>` reply.
   Garnet answers with a flat [name, value] array, and with an EMPTY array for
   a parameter it does not have -- which is a fact worth reporting, not an
   error to swallow. */
function configValue(reply) {
  if (!reply || !reply.ok) return { present: false, value: null, error: reply ? reply.error : null };
  const arr = Array.isArray(reply.value) ? reply.value : [];
  if (arr.length < 2) return { present: false, value: null, error: null };
  return { present: true, value: arr[1], error: null };
}

/* ------------------------------------------------------------ server state --- */

/**
 * What this cache is, and what it has been doing.
 *
 * The counters here are whatever this build of Garnet actually emits. Two
 * Redis staples are deliberately handled as absences rather than filled in:
 * there is no hit rate (Garnet publishes no keyspace_hits/keyspace_misses, and
 * a computed 0% would be indistinguishable from a real one) and no evictions
 * (see the header). Both come back with the reason attached.
 */
const serverInfo = guarded('garnet:server', PROBE_TTL_MS, async () => {
  const p = await cachedProbe();
  const v = p.value;
  const info = v.info;

  /* instantaneous_ops_per_sec exists only because MetricsSamplingFrequency is
     set in garnet.conf. With Garnet's default of 0 the sampling task never
     runs and this field is a permanent zero -- a measured-looking number
     meaning "nobody is sampling". If it is missing here, say so rather than
     drawing a flat line at the bottom of a chart. */
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
      /* Garnet reports a redis_version for client-library compatibility. It is
         the protocol level this server claims, NOT a Redis it contains, and it
         is labelled here so nobody reads it as one. */
      redisCompatVersion: text(info, ['redis_version']),
      mode: text(info, ['redis_mode', 'mode']),
      os: text(info, ['os']),
      processId: metric(info, ['process_id', 'processId']),
      tcpPort: metric(info, ['tcp_port']),
      uptimeSeconds: metric(info, ['uptime_in_seconds']),
      runId: text(info, ['run_id'])
    },

    /* Who the server says we are. `matches` is the interesting field: it is
       false when the password authenticated against a different rule than the
       one this console thinks it holds. */
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

    /* THE TWO TILES A REDIS-SHAPED SCREEN WILL ASK FOR. Both are answered here
       with a reason rather than left to be filled in by whoever writes the
       screen, because an absent key in a payload is an invitation to default
       it to zero. */
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

/* ---------------------------------------------------------------- memory ---- */

/**
 * The spill ratio for one hybrid log.
 *
 * Garnet's log is addressed as a single growing byte range. Records between
 * BeginAddress and HeadAddress are ON DISK and still live; records between
 * HeadAddress and TailAddress are in memory. So the fraction of the live log
 * that has been pushed out to disk is (Head - Begin) / (Tail - Begin), and
 * that -- not a memory percentage and never an eviction count -- is the number
 * that says "the working set no longer fits".
 *
 * What a rising ratio actually costs, in order: reads of spilled records
 * become disk reads; the spill directory grows inside the same WSL2 virtual
 * disk as Postgres and the object store; and past
 * SegmentSize x CompactionMaxSegments (128 MB x 8 in garnet.conf) the
 * CompactionType=Shift policy DELETES THE OLDEST SEGMENT WHOLE. That last one
 * does lose keys -- but by age of write and a whole file at a time, not by
 * LRU, not by TTL, and not because memory ran short. Reporting it as
 * "evictions" would put a disk-ceiling behaviour under a memory heading and
 * point the operator at the wrong setting.
 *
 * Refuses to interpret addresses that are not ordered begin <= head <= tail:
 * that combination means this reader has misunderstood the field names, and a
 * confidently wrong ratio is worse than an honest gap.
 */
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
    /* Not 0%. A ratio of nothing to nothing is not zero, and on a cache that
       has just started -- Recover is false, so every boot starts cold -- "0%
       spilled" and "there is no log yet" are different things to see. */
    row.unavailable = 'The log is empty, so there is no ratio to take yet. Garnet starts cold on every boot ' +
      '(Recover is false), so this is the expected state until something writes.';
    return row;
  }
  row.spillRatio = row.spilledBytes / row.logBytes;
  return row;
}

/**
 * Memory, against the only ceiling that actually exists.
 *
 * Two numbers, and the difference between them is the whole point:
 *
 *   - the log's in-memory size against LogMemorySize is measured entirely by
 *     the server, and it is NOT a quota -- crossing it spills rather than
 *     fails;
 *   - the container's memory against mem_limit is the hard one, it is what
 *     kills the process, and its denominator has to be handed in from .env
 *     because the console cannot read another container's cgroup.
 *
 * Neither of them is maxmemory, because there is no maxmemory. The reply to
 * `CONFIG GET maxmemory` is included as evidence rather than as a claim.
 */
const memory = guarded('garnet:memory', PROBE_TTL_MS, async () => {
  const p = await cachedProbe();
  const v = p.value;
  const info = v.info;

  /* Which field this came from is reported alongside it, because "memory used"
     is three different numbers on a .NET server -- the managed heap, the
     committed heap and the process working set -- and only the last is
     comparable with a container limit. */
  const process_ = metric(info,
    ['proc_physical_memory_size', 'used_memory_rss', 'used_memory', 'gc_committed_bytes'],
    'Without it there is no numerator for the container-limit gauge.');

  const usedRatio = process_.value !== null && MEM_LIMIT_BYTES ? process_.value / MEM_LIMIT_BYTES : null;

  /* FIND THE LOGS RATHER THAN GUESS THEIR NAMES.
     Garnet keeps more than one hybrid log -- the main store and the object
     store for Hash/List/Set/SortedSet values, and garnet.conf budgets memory
     for both -- and their INFO prefixes differ between builds. So instead of
     hardcoding a prefix that might be wrong, take every field ending in
     `.BeginAddress` as evidence of a log, and emit a row only where all three
     addresses of that same prefix were found. A log this build does not report
     produces no row, which is correct: it produces no invented one either. */
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

  /* One number for the tile: the worst spill ratio across the logs that
     answered, with the log it came from named. A screen that leads with an
     average would hide a fully spilled object store behind an empty main one. */
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
      /* The numerator is measured; the denominator is declared. Both are said
         out loud, because this is the one ratio on the screen whose bottom
         half did not come from the server. */
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

    /* The server-measured half. Reported second on purpose: it is the one that
       looks like a Redis memory gauge and is the one that does not kill
       anything when it fills. */
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

/* --------------------------------------------------------------- clients ---- */

/** One CLIENT LIST line: space-separated field=value pairs. */
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

/**
 * Who is connected.
 *
 * This is a capacity panel as much as an inventory one. garnet.conf pins
 * NetworkConnectionLimit at 256 rather than leaving it unlimited, because each
 * connection costs network buffers and an unlimited limit turns one client
 * with a connection leak into an OOM kill of the whole cache. A leak is
 * visible here well before that, as a client name with a rising count and a
 * rising age.
 */
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
        /* Set by the client with CLIENT SETNAME. Usually empty, and an empty
           name is reported as null rather than as "" so a UI does not render a
           blank cell that looks like a rendering bug. */
        name: f.name || null,
        user: f.user || null,
        database: intOrNull(f.db),
        ageSeconds: intOrNull(f.age),
        idleSeconds: intOrNull(f.idle),
        /* The command currently or most recently executing. Names only --
           Garnet does not put arguments in this field, which is the same
           reason SLOWLOG stays off in garnet.conf: an argument is a value, and
           this console is not permitted to read values. */
        lastCommand: f.cmd || null,
        resp: intOrNull(f.resp)
      };
    });
  }

  const mc = configValue(v.maxclients);
  const limit = mc.present ? intOrNull(mc.value) : null;
  const connected = metric(v.info, ['connected_clients']);
  /* Prefer the count this reader can see over the counter, and say which one
     it used. They can differ legitimately: CLIENT LIST includes this
     console's own connection, which is being torn down as the reply is read. */
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

/* -------------------------------------------------------------- keyspace ---- */

/**
 * How many keys, and nothing about what is in them.
 *
 * TWO WARNINGS ARE ATTACHED TO THIS ONE NUMBER, and both are the reason it has
 * its own reader and its own long TTL rather than living in probe().
 *
 * DBSIZE IS NOT O(1) ON GARNET. It walks the whole store, and once the log has
 * spilled, part of that walk is a disk read. On a cache screen somebody leaves
 * open on a second monitor, at the probe TTL, it would be a scan of the entire
 * store every ten seconds -- competing for the same memory the store is trying
 * not to spill out of. Five minutes by default; a screen that wants it fresher
 * should put it behind a button a human pressed.
 *
 * AND IT IS THE ONLY THING HERE THAT COUNTS KEYS. Everything a cache screen
 * usually shows next to a key count -- the top prefixes, the memory each holds,
 * the biggest keys -- needs SCAN, KEYS or MEMORY USAGE, and the console
 * credential holds none of them by design. Those come back with the reason
 * rather than as an empty table.
 */
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

    /* THE PANEL THIS CONSOLE IS NOT ALLOWED TO DRAW, said in full rather than
       returned empty. An empty prefix table reads as "the cache holds nothing",
       which is the opposite of what is true when it appears. */
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

/* ---------------------------------------------------------------- health ---- */

/**
 * Is the cache usable, is it locked down, and if not, which part is not?
 *
 * Unlike the readers above, this one never comes back ok:false. A health tile
 * has to render something during exactly the outage it exists to report, so
 * "not configured", "unreachable" and "the credential was refused" are values
 * of `status` here rather than failures of the request.
 *
 * THE ANONYMOUS PING IS THE POINT OF THIS FUNCTION.
 *
 * Garnet's ACL loader clears all users, imports the ACL file, and then creates
 * `default` with +@all and NOPASS if -- and only if -- the file did not define
 * one. Drop the `user default off` line from users.acl and every anonymous
 * connection gets full rights, FLUSHALL included. Nothing else in the stack can
 * see that state: the container healthcheck passes on PING *or* NOAUTH (it has
 * to, it runs before any credential exists), and an authenticated console
 * cannot tell the difference either, because its own credential works
 * perfectly in both cases.
 *
 * So the check is to try it: one connection, one PING, no AUTH. NOAUTH is the
 * correct answer. PONG means the cache is wide open to anything that can reach
 * port 6379, and it is reported as `insecure` above every other status. This
 * needs no privilege and changes nothing -- it is the same probe garnet-init
 * makes at boot, made again on every health read, because the ACL file can be
 * edited after boot.
 */
const health = guarded('garnet:health', PROBE_TTL_MS, async () => {
  const at = new Date().toISOString();

  /* Anonymous first, and independently of everything else: it must still run
     when the console has no credential of its own, which is when a
     misconfigured ACL is most likely. */
  let authRequired = null;
  let authProbe = null;
  /* Any RESP answer at all -- PONG or a refusal -- proves the cache is
     reachable, which is worth keeping separately from what the answer said. */
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
        /* Refused, but not for a reason that means "authenticate first". Some
           other server, or a Garnet that has changed what it says -- either
           way this reader has not proved the thing it came to prove, and
           `authRequired` stays null rather than being inferred from a rejection
           it does not understand. */
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

  /* Then the credential this console actually holds. */
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

  /* An open cache outranks every other verdict, including a healthy one: a
     cache that answers all of our reads AND answers everyone else's writes is
     not in an "ok" state. */
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

    /* Reuse the memory reader's arithmetic rather than repeating it, so the
       tile and the panel can never disagree about what "spilling" means. */
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

  /* Deliberately separate from `status`: "we could not reach it" and "we
     reached it and it is wrong" are different jobs, and a UI that reads only a
     colour still gets them right if it reads this too.
     A refused credential is a REACHED cache -- something answered -- and so is
     an answered anonymous PING, which is why that probe settles this even when
     the console holds no credential of its own. */
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
    /* The limit of this whole summary, stated where it is read. */
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
