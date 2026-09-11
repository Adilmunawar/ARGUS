/*
 * The queues, as the console sees them.
 *
 * This is the SQS + SNS + EventBridge replacement's read side (ADR-0010): the
 * NATS server itself, the JetStream account and what it is allowed to use, the
 * state of each stream, and how far behind each consumer is.
 *
 * IT READS THE MONITORING PORT, NOT THE CLIENT PORT. Everything here comes
 * from the HTTP endpoints on 8222 -- /varz, /connz, /jsz, /healthz -- over
 * plain node:http. That buys three things a JetStream client connection does
 * not. There is no NATS client library to add to an egress-restricted image.
 * There is no credential in this file and no parameter to pass one, because
 * the monitoring port asks for none. And a read cannot become a write by
 * accident: the monitoring port cannot publish, purge or delete, whereas the
 * `agent` credential on 4222 can do all three (nats-server.conf says so
 * plainly -- both users hold the same privileges inside the ARGUS account).
 *
 * Message BODIES are not reachable this way. Listing a dead letter and
 * replaying it needs the client port, the password, and a client library, and
 * none of that is here.
 *
 * Four things this file refuses to do, each because the obvious version is
 * actively misleading on a queue dashboard.
 *
 * IT NEVER ADDS THE TWO LAG NUMBERS TOGETHER. num_pending is work the consumer
 * has not been handed yet; num_ack_pending is work it was handed and has not
 * acknowledged. A queue that is deep and a worker that is stuck are different
 * incidents with different fixes -- add a worker, versus find out why the one
 * you have stopped acking -- and a single "lag" figure is exactly the number
 * that cannot tell you which you are looking at. They are reported side by
 * side, always, and there is no field here that sums them.
 *
 * IT NEVER READS A ZERO OUT OF A DISABLED JETSTREAM. On 2.11.4, a server with
 * JetStream off answers /jsz with HTTP 200 and
 * {"disabled":true,"streams":0,"consumers":0,"messages":0}. Rendering that
 * response's counters gives a page that says the estate has no queues and no
 * messages, which is equally true of a healthy idle server and of a broker
 * that cannot store anything. The `disabled` flag is checked before any
 * counter in that document is believed.
 *
 * IT NEVER PRINTS THE uint64 SENTINEL AS A SIZE. An account with no JetStream
 * limits reports reserved_memory and reserved_storage as 18446744073709551615
 * -- uint64(-1), meaning "no limit" -- which formatted as bytes is an
 * exabyte-scale figure, not a measurement. With the account block set, the
 * same fields carry the conf's max_mem and max_file. So the field is the limit
 * when it is set and a sentinel when it is not, and the two are separated here.
 *
 * IT NEVER CALLS AN EMPTY STREAM AN UNREADABLE ONE, OR THE REVERSE. A stream
 * that exists and holds nothing reports messages:0 with first_seq:0 and the Go
 * zero timestamp, and that is a real measurement. A stream whose state could
 * not be established reports null and says why. They are never the same value.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const cache = require('./cache');

/* ------------------------------------------------------------------ config --- */

const MONITOR = (process.env.ARGUS_NATS_MONITOR_URL || 'http://nats:8222').replace(/\/+$/, '');

/* The NATS ACCOUNT, not a user. An account is a hard subject-space boundary,
   and JetStream is enabled per account: a server can have JetStream running
   perfectly while this account has none, which is a different fault with a
   different fix. Named here so that fault can be told apart from the others. */
const ACCOUNT = process.env.ARGUS_NATS_ACCOUNT || 'ARGUS';

const TIMEOUT_MS = Number(process.env.ARGUS_UPSTREAM_TIMEOUT_MS || 8000);

/* Deliberately shorter than the storage TTLs. Capacity moves over hours;
   consumer lag moves over seconds, and a lag figure half a minute old is the
   one number on this screen that can be stale enough to send somebody after
   the wrong problem. The reads it caches are a local HTTP GET against a
   container on the same bridge, so the cost of the shorter window is small. */
const TTL_MS = Number(process.env.ARGUS_QUEUE_CACHE_TTL_MS || 5000);

/* One malformed upstream must not take the console's heap with it. /jsz with
   consumers and config asked for is the largest document here and grows with
   the number of consumers, not with the number of messages. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/* Checked once, at load, so a typo in the environment surfaces as "not
   configured" with the variable named -- rather than as a connection error
   that reads like NATS is down. */
const MONITOR_ERROR = (function () {
  let u;
  try { u = new URL(MONITOR); } catch (err) {
    return `ARGUS_NATS_MONITOR_URL is not a URL: ${JSON.stringify(MONITOR)}.`;
  }
  if (!/^https?:$/.test(u.protocol)) {
    return `ARGUS_NATS_MONITOR_URL must be an http(s) URL; it is ${JSON.stringify(MONITOR)}. ` +
           'The monitoring port speaks HTTP; a nats:// URL belongs in ARGUS_NATS_URL.';
  }
  return null;
})();

/* ------------------------------------------------------------------- http --- */

/**
 * A bounded JSON GET against the monitoring port.
 *
 * `accept` exists for /healthz, which answers 503 when something is wrong and
 * puts the reason in the body. Treating that like any other non-200 would turn
 * the single most informative response the server can give -- "this stream has
 * no leader" -- into "NATS is unreachable", and send the operator to check the
 * network instead of the stream.
 */
function getJson(path, options) {
  const opts = options || {};
  const accept = opts.accept || [200];
  const url = MONITOR + path;

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return reject(new Error(`bad url ${url}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      timeout: opts.timeoutMs || TIMEOUT_MS,
      headers: { accept: 'application/json' }
    }, (res) => {
      const status = res.statusCode;
      if (accept.indexOf(status) === -1) {
        res.resume();
        return reject(Object.assign(new Error(`${url} answered ${status}`), { status }));
      }
      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error(`${url} response exceeded ${MAX_BODY_BYTES} bytes`));
          return;
        }
        body += d;
      });
      res.on('end', () => {
        /* Measured: /healthz?account=X&stream=Y for an asset that does not
           exist answers 404 with a zero-length body. An empty body is a fact
           about the response, not a parse failure, so it is reported as one. */
        if (!body.trim()) return resolve({ status, json: null, empty: true });
        try { resolve({ status, json: JSON.parse(body), empty: false }); }
        catch (err) { reject(Object.assign(new Error(`${url} did not return JSON`), { status })); }
      });
    });

    req.on('timeout', () => req.destroy(
      new Error(`${url} did not answer within ${opts.timeoutMs || TIMEOUT_MS} ms`)));
    req.on('error', reject);
  });
}

/**
 * Turn an upstream failure into something with a next action attached.
 *
 * "Failed to fetch" tells an operator nothing. The three failures that
 * actually happen here are a NATS that was never started, a URL pointing at
 * the client port, and a URL pointing at nothing -- and each has a different
 * fix.
 */
function classify(err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);
  const status = err && err.status;

  /* Node reports an HTTP request against a non-HTTP listener as an HPE_ parse
     error. The overwhelmingly likely cause is 4222 in the URL: the client port
     answers with the NATS protocol's INFO line, which is not HTTP at all. */
  if (/^HPE_/.test(code) || /Parse Error/i.test(msg)) {
    return {
      reason: 'not-monitoring-port',
      message: `${MONITOR} answered, but not with HTTP. That is what the NATS CLIENT port (4222) does: it ` +
        'speaks the NATS protocol. ARGUS_NATS_MONITOR_URL must point at the HTTP monitoring port, ' +
        'which nats-server.conf puts on 8222.'
    };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/.test(code + msg)) {
    return {
      reason: 'unreachable',
      message: `${MONITOR} is not reachable from the console. NATS carries a compose PROFILE, so a plain ` +
        '`docker compose up -d` does not start it -- `docker compose --profile queues up -d` in ' +
        'platform/compose does. Check with `docker compose ps`: if argus-nats is not listed, it was ' +
        'never started; if it is listed as unhealthy, `docker compose logs nats` names the reason.'
    };
  }
  if (/did not answer within/i.test(msg) || /ETIMEDOUT/.test(code)) {
    return {
      reason: 'timeout',
      message: `${MONITOR} did not answer within ${TIMEOUT_MS} ms. The monitoring port is served by the ` +
        'same process that serves clients, so a monitoring timeout usually means the server itself is ' +
        'blocked rather than that monitoring is slow.'
    };
  }
  if (/did not return JSON/i.test(msg)) {
    return {
      reason: 'not-json',
      message: `${MONITOR} answered with something that is not JSON. Check that ARGUS_NATS_MONITOR_URL ` +
        'points at a NATS monitoring port and not at a proxy or a different service.'
    };
  }
  if (status === 404) {
    return {
      reason: 'no-such-endpoint',
      message: `${MONITOR} answered 404. The monitoring endpoints are /varz, /connz, /jsz and /healthz; ` +
        'a 404 from one of those means this is not a NATS monitoring port.'
    };
  }
  if (/exceeded .* bytes/i.test(msg)) {
    return {
      reason: 'too-large',
      message: msg + '. That document grows with the number of consumers, not the number of messages.'
    };
  }
  return { reason: 'error', message: msg };
}

/**
 * A reader that reports why it could not answer instead of throwing.
 *
 * The router never sees an exception from this module, and "NATS was never
 * started" arrives as a normal state with a fix attached rather than as a 500.
 */
function reader(produce) {
  return async function (...args) {
    if (MONITOR_ERROR) return { ok: false, reason: 'not-configured', message: MONITOR_ERROR };
    try {
      return { ok: true, ...(await produce(...args)) };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  };
}

/* ---------------------------------------------------------------- helpers --- */

/**
 * A JetStream limit has THREE states and they must not collapse into two.
 *
 *   set        a real ceiling, from the account or server configuration
 *   unlimited  explicitly no ceiling -- uint64(-1) on an account, or a
 *              negative value in a stream config
 *   unknown    the monitoring port does not carry this one at all
 *
 * "unlimited" and "unknown" look identical if you only have a nullable number,
 * and they are opposites: one means nothing will stop a runaway publisher, the
 * other means we cannot say whether anything would.
 */
function limitOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { state: 'unknown', value: null };
  /* uint64(-1) survives JSON.parse as 18446744073709551616, past
     Number.MAX_SAFE_INTEGER. Anything up there is a sentinel, not a size. */
  if (v < 0 || v >= Number.MAX_SAFE_INTEGER) return { state: 'unlimited', value: null };
  return { state: 'set', value: v };
}

/* The field is `value` and not `bytes` because these ceilings are not all
   byte counts: max_deliver is a number of attempts and max_ack_pending is a
   number of messages. Naming it `bytes` is how a UI ends up rendering a
   five-delivery retry budget as "5 B". */

/** Usage against a ceiling, but only when there is a ceiling to divide by. */
function ratio(used, lim) {
  if (!lim || lim.state !== 'set' || !(lim.value > 0)) return null;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return used / lim.value;
}

/* Go marshals an unset time.Time as year 1, so an empty stream's first_ts and
   last_ts arrive as "0001-01-01T00:00:00Z". That is not a timestamp; it is the
   absence of one, and a UI that formats it renders "1 January 1" beside a
   stream that is simply empty. */
function when(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.indexOf('0001-01-01') === 0) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** NATS reports durations in nanoseconds; operators think in seconds. */
function secondsOf(ns) {
  return typeof ns === 'number' && Number.isFinite(ns) ? ns / 1e9 : null;
}

/* Go's `omitempty` elides a zero int, so a counter that is missing from one of
   these documents is genuinely zero rather than unmeasured. This is the ONE
   place absence may be read as zero, and it is named so that it does not
   spread to fields where absence means unknown. */
function counterOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------ raw reads ----- */

/*
 * The three JetStream readers share ONE cached /jsz snapshot.
 *
 * Not an optimisation. Stream state and consumer lag are rendered on the same
 * screen and are read from each other -- "4 pending against a stream holding
 * 7" only means something if both numbers describe the same instant. Three
 * independent fetches would drift by seconds and produce a pending count
 * larger than the stream it is pending on, which reads as a bug in the broker.
 *
 * cache.through also gives single-flight, so a screen opening four panels at
 * once makes one request, and stale-on-error, so a blip shows the last known
 * state flagged as old rather than an empty page.
 */
const JSZ_PATH = '/jsz?accounts=true&streams=true&consumers=true&config=true';

function jszSnapshot() {
  return cache.through('queues:jsz', TTL_MS, () => getJson(JSZ_PATH));
}

function varzSnapshot() {
  return cache.through('queues:varz', TTL_MS, () => getJson('/varz'));
}

/* auth=true is what adds `authorized_user` and `account` to each connection.
   Without it the console can see that something is connected but not which
   credential it holds, which is the only interesting part on a two-user
   account. The limit bounds the response; the server still reports the true
   total separately, so truncation is visible rather than silent. */
function connzSnapshot() {
  return cache.through('queues:connz', TTL_MS, () => getJson('/connz?auth=true&limit=64'));
}

/* 503 is a real answer here, not a failure -- see getJson. */
function healthzSnapshot() {
  return cache.through('queues:healthz', TTL_MS, () => getJson('/healthz?details=true', { accept: [200, 503] }));
}

/* ------------------------------------------------------- jetstream state ---- */

const NOT_ENABLED_FIX =
  'JetStream is not enabled on this server. It is turned on by the `jetstream { ... }` block in ' +
  'platform/compose/services/queues/nats-server.conf, which also pins max_memory_store and ' +
  'max_file_store -- without those pins JetStream sizes itself against the whole WSL2 VM. If the ' +
  'block is present, the server is not running that file: check the bind mount in docker-compose.yml ' +
  'and `docker compose logs nats`.';

const NO_ACCOUNT_FIX =
  `JetStream is running on this server, but account ${ACCOUNT} cannot use it. An account needs its OWN ` +
  '`jetstream: { ... }` block inside `accounts { ... }` in nats-server.conf; without one, every client ' +
  'in that account fails with "JetStream not enabled for account" while /healthz and /jsz both report ' +
  'JetStream as perfectly enabled server-wide. That is the same symptom as an outage and a completely ' +
  'different fix.';

/**
 * Resolve the account's JetStream state from one /jsz document.
 *
 * Returns a discriminated result rather than a boolean, because there are
 * three states and only one of them is a working queue estate. The order of
 * the checks is load-bearing: `disabled` is inspected before any counter,
 * since a disabled server reports zeroes for all of them.
 */
function resolveAccount(jsz) {
  if (!jsz || typeof jsz !== 'object') {
    return { state: 'unknown', message: 'The /jsz endpoint did not return a JetStream document.' };
  }
  if (jsz.disabled === true) {
    return { state: 'disabled-server-wide', message: NOT_ENABLED_FIX };
  }
  const details = Array.isArray(jsz.account_details) ? jsz.account_details : null;
  if (!details || details.length === 0) {
    /* A server with JetStream on and no JetStream accounts. Same fix as a
       missing account block, and it is worth saying that the zeroes above it
       in the same document are not evidence of an empty estate. */
    return { state: 'no-jetstream-accounts', message: NO_ACCOUNT_FIX };
  }

  const exact = details.filter((a) => a && a.name === ACCOUNT)[0];
  if (exact) return { state: 'enabled', detail: exact, nameMatched: true };

  /* The configured name does not match anything the server reports. If there
     is exactly one JetStream account, it is almost certainly the one meant --
     but the mismatch is surfaced rather than smoothed over, because reporting
     somebody else's account under our name is worse than saying we are unsure. */
  if (details.length === 1 && details[0] && details[0].name) {
    return {
      state: 'enabled',
      detail: details[0],
      nameMatched: false,
      message: `ARGUS_NATS_ACCOUNT is set to ${ACCOUNT}, and the only JetStream account on this server is ` +
        `${details[0].name}. The figures below are ${details[0].name}'s.`
    };
  }
  return {
    state: 'account-not-found',
    message: `This server has JetStream accounts (${details.map((a) => a && a.name).join(', ')}) but none ` +
      `named ${ACCOUNT}. Set ARGUS_NATS_ACCOUNT to the right one, or add a jetstream block to ${ACCOUNT} ` +
      'in nats-server.conf.'
  };
}

/** Every stream in the resolved account, or null when there is no account. */
function streamDetails(resolved) {
  if (resolved.state !== 'enabled') return null;
  const d = resolved.detail;
  return Array.isArray(d.stream_detail) ? d.stream_detail : [];
}

/* --------------------------------------------------------------- server ----- */

/**
 * The NATS process itself: what it is, how long it has been up, who is on it.
 *
 * /varz answers even when JetStream is off or the account is misconfigured,
 * which makes it the one call that can distinguish "the broker is down" from
 * "the broker is up and the queues are not usable". The queue screen leans on
 * that distinction, so this reader never fails because of JetStream.
 */
const server = reader(async () => {
  const snap = await varzSnapshot();
  const v = snap.value.json || {};

  /* JetStream off answers /varz with `"jetstream": {}` -- the key is there and
     empty. Presence of the key proves nothing; presence of its config does. */
  const js = v.jetstream || {};
  const jsEnabled = !!(js.config && typeof js.config === 'object');

  /* connz is fetched separately so that a failure there costs the connection
     list and nothing else. */
  let clients = null;
  let clientsError = null;
  let clientsTotal = null;
  try {
    const c = (await connzSnapshot()).value.json || {};
    clientsTotal = numOrNull(c.total);
    clients = (c.connections || []).map((k) => ({
      cid: numOrNull(k.cid),
      kind: k.kind || null,
      name: k.name || null,
      lang: k.lang || null,
      libVersion: k.version || null,
      account: k.account || null,
      /* Which CREDENTIAL, not which privilege. nats-server.conf gives `argus`
         and `agent` identical rights inside this account, so this column tells
         you who connected and never what they may do. The console's read-only
         behaviour comes from the console process, not from this name. */
      authorizedUser: k.authorized_user || null,
      ip: k.ip || null,
      port: numOrNull(k.port),
      startedAt: when(k.start),
      uptime: k.uptime || null,
      idle: k.idle || null,
      rtt: k.rtt || null,
      pendingBytes: numOrNull(k.pending_bytes),
      subscriptions: numOrNull(k.subscriptions),
      inMsgs: numOrNull(k.in_msgs),
      outMsgs: numOrNull(k.out_msgs)
    }));
  } catch (err) {
    clientsError = classify(err).message;
  }

  const sc = v.slow_consumer_stats || {};

  return {
    monitorUrl: MONITOR,
    serverName: v.server_name || null,
    serverId: v.server_id || null,
    version: v.version || null,
    gitCommit: v.git_commit || null,
    go: v.go || null,
    startedAt: when(v.start),
    serverTime: when(v.now),
    uptime: v.uptime || null,
    cores: numOrNull(v.cores),
    memBytes: numOrNull(v.mem),
    cpuPercent: numOrNull(v.cpu),

    connections: {
      current: numOrNull(v.connections),
      sinceStart: numOrNull(v.total_connections),
      max: limitOf(v.max_connections),
      /* A slow consumer is a client the server DISCONNECTED for not keeping
         up. It is a count of past events, not a current condition, so it never
         clears on its own -- a non-zero value here is history until restart. */
      disconnectedAsSlow: numOrNull(v.slow_consumers),
      disconnectedAsSlowByKind: {
        clients: numOrNull(sc.clients),
        routes: numOrNull(sc.routes),
        gateways: numOrNull(sc.gateways),
        leafnodes: numOrNull(sc.leafs)
      },
      listed: clients,
      listedTotal: clientsTotal,
      listedTruncated: clients !== null && clientsTotal !== null && clientsTotal > clients.length,
      listError: clientsError,
      credentialNote: 'authorized_user identifies which credential a connection used. It does not imply ' +
        'a privilege level: inside this account both users hold the same rights.'
    },

    traffic: {
      inMsgs: numOrNull(v.in_msgs),
      outMsgs: numOrNull(v.out_msgs),
      inBytes: numOrNull(v.in_bytes),
      outBytes: numOrNull(v.out_bytes),
      subscriptions: numOrNull(v.subscriptions),
      /* Cumulative since start, not a rate. Two readings and the interval
         between them is the only honest way to a messages-per-second figure,
         and this module does not keep the previous reading. */
      cumulative: true
    },

    limits: {
      maxPayloadBytes: limitOf(v.max_payload),
      /* Per CONNECTION, not server-wide: how much the server will buffer for
         one slow client before disconnecting it. */
      maxPendingBytesPerConnection: limitOf(v.max_pending)
    },

    /* varz reports `"cluster": {}` on a single node. Absence of a cluster is
       the deployed truth here (one node, on purpose) and is reported as that
       rather than as a cluster of size zero. */
    clustered: !!(v.cluster && v.cluster.name),
    clusterName: (v.cluster && v.cluster.name) || null,
    routes: numOrNull(v.routes),
    leafnodes: numOrNull(v.leafnodes),

    jetstream: jsEnabled
      ? {
          enabledServerWide: true,
          storeDir: (js.config && js.config.store_dir) || null,
          maxMemory: limitOf(js.config && js.config.max_memory),
          maxStorage: limitOf(js.config && js.config.max_storage),
          /* Server-wide totals across every account. The per-account limits
             are what actually bind -- see account(). */
          memoryUsedBytes: numOrNull(js.stats && js.stats.memory),
          storageUsedBytes: numOrNull(js.stats && js.stats.storage),
          accounts: numOrNull(js.stats && js.stats.accounts),
          apiTotal: numOrNull(js.stats && js.stats.api && js.stats.api.total),
          apiErrors: numOrNull(js.stats && js.stats.api && js.stats.api.errors)
        }
      : { enabledServerWide: false, message: NOT_ENABLED_FIX },

    cachedAt: snap.cachedAt,
    stale: !!snap.stale,
    at: new Date().toISOString()
  };
});

/* -------------------------------------------------------------- account ----- */

/**
 * What the ARGUS account is using, against what it is allowed to use.
 *
 * A STREAM that hits its own max_bytes applies its discard policy and affects
 * only itself. An ACCOUNT that hits max_file refuses publishes to EVERY stream
 * in it -- including ARGUS_DEADLETTER, the one that would have recorded the
 * failure.
 *
 * The limits come from a field that does not look like a limit. In /jsz,
 * account_details[].reserved_memory and reserved_storage carry the ACCOUNT's
 * configured max_mem and max_file, and they do not move as streams are added.
 * On a server with no account limits the same two fields are uint64(-1). Note
 * that the identically named fields at the TOP level of /jsz mean something
 * else entirely -- the sum of the max_bytes reserved by streams -- so they are
 * not interchangeable and are not read here.
 */
const account = reader(async () => {
  const snap = await jszSnapshot();
  const jsz = snap.value.json || {};
  const resolved = resolveAccount(jsz);

  const base = {
    account: ACCOUNT,
    jetStream: resolved.state,
    cachedAt: snap.cachedAt,
    stale: !!snap.stale,
    at: new Date().toISOString()
  };

  if (resolved.state !== 'enabled') {
    return { ...base, usable: false, message: resolved.message, usage: null, limits: null };
  }

  const d = resolved.detail;
  const memoryLimit = limitOf(d.reserved_memory);
  const storageLimit = limitOf(d.reserved_storage);
  const memoryUsed = numOrNull(d.memory);
  const storageUsed = numOrNull(d.storage);

  /* Counted from the streams the server actually reported, not read from a
     summary field, so this count and the list on the streams screen cannot
     disagree. */
  const streams = streamDetails(resolved) || [];
  let consumerCount = 0;
  let reservedByStreams = 0;
  const unbounded = [];
  for (const s of streams) {
    consumerCount += (s && Array.isArray(s.consumer_detail))
      ? s.consumer_detail.length
      : counterOr0(s && s.state && s.state.consumer_count);
    const mb = limitOf(s && s.config && s.config.max_bytes);
    if (mb.state === 'set') reservedByStreams += mb.value;
    else unbounded.push((s && s.name) || 'unnamed');
  }

  /* The ordering invariant the whole limit design rests on: the sum of the
     per-stream ceilings must stay under the account ceiling, so that a runaway
     publisher hits its own stream's discard policy before it can freeze every
     other stream in the account. Computed only when every stream declares a
     ceiling -- one unbounded stream makes the sum meaningless, and reporting a
     total that omits it would be worse than reporting no total. */
  let reservation;
  if (unbounded.length) {
    reservation = {
      totalBytes: null,
      complete: false,
      unboundedStreams: unbounded,
      withinAccountLimit: null,
      message: `${unbounded.length} stream(s) declare no max_bytes, so the reserved total cannot be ` +
        'computed. An unbounded stream can fill the account limit on its own and stop publishes to ' +
        'every other stream, including the dead-letter stream.'
    };
  } else {
    const within = storageLimit.state === 'set' ? reservedByStreams <= storageLimit.value : null;
    reservation = {
      totalBytes: reservedByStreams,
      complete: true,
      unboundedStreams: [],
      withinAccountLimit: within,
      message: within === false
        ? 'The streams together reserve more than the account is allowed to store. The account limit will ' +
          'bind before the stream limits do, which means a full stream stops publishes to ALL of them ' +
          'rather than only to itself. Lower a stream max_bytes, or raise max_file for the account.'
        : null
    };
  }

  return {
    ...base,
    usable: true,
    accountReported: d.name || null,
    nameMatched: resolved.nameMatched !== false,
    message: resolved.message || null,

    usage: {
      memoryBytes: memoryUsed,
      storageBytes: storageUsed,
      streams: streams.length,
      consumers: consumerCount,
      apiTotal: numOrNull(d.api && d.api.total),
      /* Cumulative JetStream API errors for this account since the server
         started. Non-zero is not necessarily current: one rejected `stream
         add` at boot counts forever. */
      apiErrors: numOrNull(d.api && d.api.errors),
      haAssets: numOrNull(d.ha_assets)
    },

    limits: {
      memory: memoryLimit,
      storage: storageLimit,
      /* Not available over the monitoring port, and said so rather than
         guessed. max_streams, max_consumers and max_bytes_required are in the
         account's jetstream block but /jsz does not carry them, and reporting
         them as 0 would read as "no streams allowed" while reporting them as
         unlimited would be a claim nothing here measured. */
      maxStreams: { state: 'unknown', value: null },
      maxConsumers: { state: 'unknown', value: null },
      maxBytesRequired: { state: 'unknown', value: null },
      unknownReason: 'The NATS monitoring port does not expose an account\'s max_streams, max_consumers ' +
        'or max_bytes_required. They are declared in the ARGUS account block of nats-server.conf, and ' +
        '`nats account info` reads them back from the server with a credential this console does not use.'
    },

    usageRatio: {
      memory: ratio(memoryUsed, memoryLimit),
      storage: ratio(storageUsed, storageLimit)
    },

    streamReservation: reservation,

    consequence: 'An account that reaches its storage limit refuses publishes to EVERY stream in it, ' +
      'including the dead-letter stream that would have recorded the failure. A stream that reaches its ' +
      'own max_bytes affects only itself.'
  };
});

/* --------------------------------------------------------------- streams ---- */

/**
 * Per-stream state: how much is held, and over which sequence range.
 *
 * first_seq and last_seq are reported alongside the message count because they
 * answer a question the count cannot. A stream holding 400 messages whose
 * first_seq is 1 has never discarded anything; one whose first_seq is 90,000
 * has been dropping the oldest for a while, and on a `discard: old` stream
 * that is silent data loss which no counter here goes red about.
 */
const streams = reader(async () => {
  const snap = await jszSnapshot();
  const jsz = snap.value.json || {};
  const resolved = resolveAccount(jsz);

  const base = {
    account: ACCOUNT,
    jetStream: resolved.state,
    cachedAt: snap.cachedAt,
    stale: !!snap.stale,
    at: new Date().toISOString()
  };

  if (resolved.state !== 'enabled') {
    return { ...base, streams: null, count: null, message: resolved.message };
  }

  const rows = (streamDetails(resolved) || []).map((s) => {
    const cfg = s.config || {};
    const st = s.state || null;

    /* A stream that exists and holds nothing, versus one whose state could not
       be established. Both would render as zeroes and they mean the opposite
       things, so the second case reports null and says why.
       Two ways state is not trustworthy: it is absent from the document, or
       the stream has no elected leader -- a leaderless stream still appears in
       /jsz, with a state that is not authoritative.

       The `cluster` block is NOT evidence of a cluster. Measured: a single-node
       R1 stream reports cluster:{leader:"nats-1"} while /varz reports no
       cluster at all, so reading that block as "this stream is clustered" would
       put a replication claim on the screen for a stream that has exactly one
       copy. What it does carry is the leader, and an EMPTY leader inside a
       present block is therefore a real signal rather than the normal case. */
    const hasClusterBlock = !!(s.cluster && typeof s.cluster === 'object' && Object.keys(s.cluster).length);
    const leaderless = hasClusterBlock && !s.cluster.leader;
    const stateKnown = !!st && !leaderless;

    const maxBytes = limitOf(cfg.max_bytes);
    const bytes = stateKnown ? numOrNull(st.bytes) : null;
    const messages = stateKnown ? numOrNull(st.messages) : null;

    const attention = [];
    if (stateKnown && maxBytes.state === 'unlimited') {
      attention.push({
        code: 'stream-unbounded', severity: 'warn',
        message: 'This stream declares no max_bytes. One runaway publisher on it fills the ACCOUNT limit ' +
          'and stops publishes to every stream in the account, including the dead-letter stream.'
      });
    }
    const fill = ratio(bytes, maxBytes);
    if (fill !== null && fill >= 0.9) {
      attention.push({
        code: 'stream-nearly-full',
        severity: fill >= 0.98 ? 'bad' : 'warn',
        message: cfg.discard === 'new'
          ? 'This stream is nearly at its max_bytes and discards `new`, so publishers will start getting ' +
            'errors. That is the intended behaviour for a job queue -- the producer can retry or alert -- ' +
            'but it is a failure the producer sees, not a silent one.'
          : 'This stream is nearly at its max_bytes and discards `old`, so the oldest messages are being ' +
            'dropped to make room. No publisher sees an error and nothing else here goes red.'
      });
    }
    if (stateKnown && counterOr0(st.consumer_count) === 0) {
      attention.push({
        code: 'stream-no-consumer', severity: 'info',
        message: cfg.retention === 'interest'
          ? 'No consumer is registered and retention is `interest`, so everything published to this ' +
            'stream is discarded on arrival.'
          : 'No consumer is registered. With `limits` retention the messages are still kept, so this is a ' +
            'deliberate state for some streams here and not by itself a fault.'
      });
    }
    if (cfg.num_replicas === 1) {
      attention.push({
        code: 'stream-r1', severity: 'info',
        message: 'R1: one replica, no redundancy. If this node\'s volume is lost, every message in this ' +
          'stream is lost with it. An R1 stream on a multi-node cluster reports itself healthy right up ' +
          'to the moment its one node dies.'
      });
    }

    return {
      name: s.name || null,
      createdAt: when(s.created),
      description: cfg.description || null,
      subjects: Array.isArray(cfg.subjects) ? cfg.subjects : null,

      stateKnown,
      stateUnknownReason: stateKnown ? null
        : leaderless
          ? 'This stream is clustered and reports no leader, so its message count and sequence numbers are ' +
            'not authoritative. Nothing can be published to or consumed from a stream with no leader.'
          : 'The server returned this stream without a state block, so its contents are unknown here.',

      messages,
      bytes,
      firstSeq: stateKnown ? numOrNull(st.first_seq) : null,
      firstAt: stateKnown ? when(st.first_ts) : null,
      lastSeq: stateKnown ? numOrNull(st.last_seq) : null,
      lastAt: stateKnown ? when(st.last_ts) : null,
      /* `first_seq` of 0 on an empty stream is the server's own encoding of
         "nothing here", not sequence zero -- there is no sequence zero. */
      empty: stateKnown ? counterOr0(st.messages) === 0 : null,
      subjectsWithMessages: stateKnown ? counterOr0(st.num_subjects) : null,
      deletedMessages: stateKnown ? counterOr0(st.num_deleted) : null,
      consumerCount: stateKnown ? counterOr0(st.consumer_count) : null,

      config: {
        retention: cfg.retention || null,
        discard: cfg.discard || null,
        storage: cfg.storage || null,
        replicas: numOrNull(cfg.num_replicas),
        maxBytes,
        maxAgeSeconds: secondsOf(cfg.max_age),
        duplicateWindowSeconds: secondsOf(cfg.duplicate_window),
        maxMsgs: limitOf(cfg.max_msgs),
        maxMsgSize: limitOf(cfg.max_msg_size),
        allowDirect: cfg.allow_direct === true,
        sealed: cfg.sealed === true,
        denyDelete: cfg.deny_delete === true,
        denyPurge: cfg.deny_purge === true
      },

      fillRatio: fill,
      /* The node currently serving this stream. On one node that is this
         server naming itself, which is why it is reported as a leader and not
         as evidence of redundancy -- `replicated` below is the field that
         answers whether a second copy exists. */
      leader: hasClusterBlock ? (s.cluster.leader || null) : null,
      replicated: numOrNull(cfg.num_replicas) > 1,
      attention
    };
  });

  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return {
    ...base,
    streams: rows,
    count: rows.length,
    /* Deliberately no "expected streams" list. The stream table lives in
       platform/compose/services/queues/init/apply.sh, which is mounted into
       nats-init and not into the console; copying it here would create a
       second declaration that drifts from the one that is actually applied.
       So this reader reports what exists and never claims something is
       missing. */
    inventorySource: 'the NATS server (/jsz), not a declared list',
    unreadable: rows.filter((r) => !r.stateKnown).map((r) => r.name)
  };
});

/* ------------------------------------------------------------- consumers ---- */

/**
 * Consumer lag, as the two separate numbers it actually is.
 *
 *   pending      messages in the stream this consumer has NOT been handed yet.
 *                Growing pending means work is arriving faster than it is
 *                being taken. The fix is usually more workers.
 *
 *   ackPending   messages this consumer WAS handed and has not acknowledged.
 *                Growing ackPending means the worker took the job and did not
 *                finish it -- slow, blocked, or dead. More workers does not
 *                help; in the worst case it makes it worse.
 *
 * These are added together in a lot of dashboards, and the sum is the one
 * number that cannot distinguish the two incidents. There is no field in this
 * payload that combines them and there should never be one.
 *
 * Two more numbers earn their place beside those:
 *
 *   waiting      pull requests currently parked, waiting for a message. A pull
 *                consumer only receives what it asks for, so this is the
 *                closest thing to "a worker is connected and asking".
 *
 *   redelivered  messages currently being delivered again. At-least-once means
 *                a redelivery does NOT prove the work failed -- the common case
 *                is that the work succeeded and the ack was late or lost.
 */
const consumers = reader(async () => {
  const snap = await jszSnapshot();
  const jsz = snap.value.json || {};
  const resolved = resolveAccount(jsz);

  const base = {
    account: ACCOUNT,
    jetStream: resolved.state,
    cachedAt: snap.cachedAt,
    stale: !!snap.stale,
    at: new Date().toISOString()
  };

  if (resolved.state !== 'enabled') {
    return { ...base, consumers: null, count: null, message: resolved.message };
  }

  const details = streamDetails(resolved) || [];
  const rows = [];
  const streamsWithoutConsumers = [];

  for (const s of details) {
    const list = Array.isArray(s.consumer_detail) ? s.consumer_detail : [];
    if (!list.length) { streamsWithoutConsumers.push(s.name || null); continue; }

    for (const c of list) {
      const cfg = c.config || {};
      const pending = numOrNull(c.num_pending);
      const ackPending = numOrNull(c.num_ack_pending);
      const waiting = numOrNull(c.num_waiting);
      const redelivered = numOrNull(c.num_redelivered);
      const maxAckPending = limitOf(cfg.max_ack_pending);
      const maxDeliver = limitOf(cfg.max_deliver);
      const backoff = Array.isArray(cfg.backoff) ? cfg.backoff.map(secondsOf) : null;

      const attention = [];

      /* Nothing is being handed out and nothing is in flight, while work is
         waiting. Deliberately requires ALL THREE conditions: a busy worker
         also shows waiting=0, because it is processing rather than parked, so
         waiting=0 alone proves nothing. With ackPending=0 as well, there is
         nothing in flight either, and the only readings consistent with that
         are a worker that is not running and a worker that is not pulling. */
      if (pending > 0 && waiting === 0 && ackPending === 0) {
        attention.push({
          code: 'nothing-pulling', severity: 'warn',
          message: `${pending} message(s) are waiting, no pull request is parked, and nothing is in ` +
            'flight. Consistent with no worker running for this consumer. Note that the dead-letter ' +
            'stream stays EMPTY in exactly this situation -- the max-deliveries advisory is only ' +
            'published when a consumer next pulls -- so a quiet dead-letter count is not reassurance here.'
        });
      }

      /* At the ceiling, JetStream stops delivering to this consumer entirely
         until an ack lands or an ack_wait expires. Pending then grows while
         the consumer looks idle, which is the least intuitive stall here. */
      if (maxAckPending.state === 'set' && ackPending !== null && ackPending >= maxAckPending.value) {
        attention.push({
          code: 'ack-pending-at-ceiling', severity: 'bad',
          message: `${ackPending} unacknowledged message(s) has reached this consumer's max_ack_pending ` +
            `of ${maxAckPending.value}. The server will deliver nothing more to it until an ack arrives ` +
            'or an ack_wait expires, so pending will keep growing while the consumer appears idle.'
        });
      }

      /* Straight out of the retry policy's own design: a consumer with
         unlimited deliveries never produces a max-deliveries advisory, so
         nothing it poisons ever reaches the dead-letter stream. The CLI's
         default is -1, which makes this the failure you get by not choosing. */
      if (maxDeliver.state === 'unlimited') {
        attention.push({
          code: 'never-dead-letters', severity: 'warn',
          message: 'max_deliver is unlimited, so a poisoned message is redelivered forever and no ' +
            'max-deliveries advisory is ever published. Nothing on this consumer can reach the ' +
            'dead-letter stream.'
        });
      }

      if (redelivered > 0) {
        attention.push({
          code: 'redelivering', severity: 'info',
          message: `${redelivered} message(s) are being delivered again. This does not mean the work ` +
            'failed: an ack that arrived after ack_wait costs a delivery exactly like a failure does, so ' +
            'a worker that is succeeding slowly burns its retry budget and is eventually dead-lettered ' +
            'having never once failed.'
        });
      }

      rows.push({
        stream: c.stream_name || s.name || null,
        name: c.name || null,
        createdAt: when(c.created),
        description: cfg.description || null,
        filterSubject: cfg.filter_subject || (Array.isArray(cfg.filter_subjects) ? cfg.filter_subjects.join(' ') : null),

        /* The two numbers. Never summed, never adjacent to a total. */
        pending,
        ackPending,
        waiting,
        redelivered,

        deliveredStreamSeq: numOrNull(c.delivered && c.delivered.stream_seq),
        deliveredConsumerSeq: numOrNull(c.delivered && c.delivered.consumer_seq),
        ackFloorStreamSeq: numOrNull(c.ack_floor && c.ack_floor.stream_seq),
        ackFloorConsumerSeq: numOrNull(c.ack_floor && c.ack_floor.consumer_seq),
        lastActiveAt: when(c.delivered && c.delivered.last_active),

        config: {
          ackPolicy: cfg.ack_policy || null,
          deliverPolicy: cfg.deliver_policy || null,
          replayPolicy: cfg.replay_policy || null,
          /* A pull consumer has no deliver_subject. The distinction matters:
             max_pending on the server bites push consumers and is close to
             unreachable for pull consumers, which only get what they ask for. */
          pull: !cfg.deliver_subject,
          ackWaitSeconds: secondsOf(cfg.ack_wait),
          /* ack_wait is not an independent setting when a backoff policy
             exists: JetStream sets it to the FIRST backoff step and silently
             discards whatever was asked for. The two are reported together so
             that nobody reads the ack_wait as a declaration in its own right. */
          backoffSeconds: backoff,
          ackWaitIsFirstBackoffStep: !!(backoff && backoff.length),
          maxDeliver,
          maxAckPending,
          maxWaiting: limitOf(cfg.max_waiting),
          /* num_replicas of 0 on a CONSUMER does not mean it has no replicas.
             It means the consumer inherits the stream's replica count, which is
             the default and the normal reading here -- so it is reported as
             inheritance and never as the number zero, which on a replica column
             reads as "this is not replicated at all". */
          replicas: cfg.num_replicas > 0 ? cfg.num_replicas : null,
          replicasInheritedFromStream: cfg.num_replicas === 0
        },

        attention
      });
    }
  }

  rows.sort((a, b) => String(a.stream + '/' + a.name).localeCompare(String(b.stream + '/' + b.name)));

  return {
    ...base,
    consumers: rows,
    count: rows.length,
    /* Reported as a fact, with no verdict attached. Some streams here are
       deliberately consumer-less -- a durable nobody pulls from reports a lag
       that only ever grows, which is a true number that means nothing. */
    streamsWithoutConsumers,
    lagNote: 'pending and ackPending are separate measurements and are not added together anywhere. ' +
      'pending is work not yet handed out (the queue is deep); ackPending is work handed out and not ' +
      'acknowledged (the worker is slow, blocked or gone). They call for opposite responses.'
  };
});

/* ---------------------------------------------------------------- health ---- */

/**
 * Is the queue estate actually usable, and if not, which part is not?
 *
 * The container healthcheck cannot answer this, and neither can /healthz on
 * its own. Measured on 2.11.4: a server started with JetStream completely
 * disabled answers /healthz -- and /healthz?js-enabled-only=true -- with HTTP
 * 200 {"status":"ok"}. So a green /healthz is evidence that the process is
 * running and is NOT evidence that a message can be stored. This reader
 * therefore treats /healthz as one component among four rather than as the
 * verdict, and says so in what it returns.
 */
const health = reader(async () => {
  const components = [];
  let varz = null;
  let varzError = null;

  const t0 = Date.now();
  try {
    varz = (await varzSnapshot()).value.json || {};
    components.push({
      name: 'monitoring endpoint', reachable: true,
      detail: `${varz.server_name || 'nats'} ${varz.version || ''}`.trim(),
      latencyMs: Date.now() - t0
    });
  } catch (err) {
    const c = classify(err);
    varzError = c;
    components.push({ name: 'monitoring endpoint', reachable: false, latencyMs: Date.now() - t0, error: c.message });
  }

  /* Nothing below this line can be established without /varz, and guessing at
     it would mean inventing components. The reader stops and says which one
     step failed. */
  if (!varz) {
    return {
      verdict: 'unreachable',
      usable: false,
      components,
      reason: varzError.reason,
      message: varzError.message,
      healthz: null,
      at: new Date().toISOString()
    };
  }

  const jsEnabled = !!(varz.jetstream && varz.jetstream.config);
  components.push({
    name: 'jetstream (server)', reachable: true, ok: jsEnabled,
    error: jsEnabled ? undefined : NOT_ENABLED_FIX
  });

  /* /healthz, read for what it is: 503 with a body naming the broken asset is
     the most useful answer it gives, so it is accepted as a response rather
     than treated as a transport failure. */
  let healthz = null;
  try {
    const h = await healthzSnapshot();
    const body = h.value.json || {};
    healthz = {
      httpStatus: h.value.status,
      status: body.status || (h.value.empty ? null : 'unknown'),
      errors: Array.isArray(body.errors)
        ? body.errors.map((e) => ({
            type: e.type || null, account: e.account || null,
            stream: e.stream || null, consumer: e.consumer || null, error: e.error || null
          }))
        : [],
      error: body.error || null
    };
    components.push({
      name: 'healthz', reachable: true, ok: h.value.status === 200 && body.status === 'ok',
      detail: body.status || null,
      error: h.value.status === 200 ? undefined : (body.error || `healthz answered ${h.value.status}`)
    });
  } catch (err) {
    const c = classify(err);
    components.push({ name: 'healthz', reachable: false, error: c.message });
  }

  /* The account check is what turns "the broker is up" into "the queues work".
     It is a separate component because its failure mode is invisible from
     every other one: JetStream enabled server-wide, healthz green, and every
     client in the account failing. */
  let accountState = { state: 'unknown', message: 'The JetStream account could not be read.' };
  let streamRows = [];
  let jszError = null;
  try {
    const jsz = (await jszSnapshot()).value.json || {};
    accountState = resolveAccount(jsz);
    streamRows = streamDetails(accountState) || [];
  } catch (err) {
    jszError = classify(err);
  }

  const accountOk = accountState.state === 'enabled';
  components.push({
    name: `jetstream (account ${ACCOUNT})`,
    reachable: !jszError,
    ok: accountOk,
    error: jszError ? jszError.message : (accountOk ? undefined : accountState.message)
  });

  /* Counted from the same snapshot the other readers use, so the header and
     the tables below it cannot contradict each other. */
  let leaderless = 0;
  let unbounded = 0;
  for (const s of streamRows) {
    if (s.cluster && Object.keys(s.cluster).length && !s.cluster.leader) leaderless += 1;
    if (limitOf(s.config && s.config.max_bytes).state !== 'set') unbounded += 1;
  }

  const healthzBad = !!(healthz && (healthz.httpStatus !== 200 || healthz.status !== 'ok'));

  /* Four states, not two. `degraded` exists because "the broker is running and
     the queues do not work" is the most common real failure here and it is
     neither up nor down. */
  let verdict;
  if (!jsEnabled) verdict = 'jetstream-disabled';
  /* Checked before the account verdict. /varz answering while /jsz does not is
     a state where the account MIGHT be fine and we cannot say -- calling it
     `account-unusable` there would report a fault that was never observed, and
     send somebody to edit nats-server.conf over a failed read. */
  else if (jszError) verdict = 'unknown';
  else if (!accountOk) verdict = 'account-unusable';
  else if (healthzBad || leaderless > 0) verdict = 'degraded';
  else verdict = 'ok';

  return {
    verdict,
    /* null, not false, when the verdict is `unknown`. false is a claim that
       the queues do not work; this is the state where nothing was established
       either way, and the two must not render the same. */
    usable: verdict === 'unknown' ? null : (verdict === 'ok' || verdict === 'degraded'),
    components,
    healthz,
    server: {
      name: varz.server_name || null,
      version: varz.version || null,
      uptime: varz.uptime || null,
      connections: numOrNull(varz.connections),
      clustered: !!(varz.cluster && varz.cluster.name)
    },
    jetstream: {
      enabledServerWide: jsEnabled,
      account: ACCOUNT,
      accountState: accountState.state,
      accountMessage: accountOk ? null : accountState.message
    },
    streams: {
      count: accountOk ? streamRows.length : null,
      leaderless,
      withoutMaxBytes: unbounded
    },
    /* Stated in the payload, not only in this file, because the next person to
       wire an alert will wire it to whatever the API says is healthy. */
    healthzCaveat: 'A green /healthz means the process is running. Measured on 2.11.4, a server with ' +
      'JetStream disabled still answers /healthz with 200 ok, so it is not on its own evidence that a ' +
      'message can be stored. The jetstream components above are.',
    at: new Date().toISOString()
  };
});

module.exports = {
  server,
  account,
  streams,
  consumers,
  health,
  classify,
  MONITOR_URL: MONITOR,
  ACCOUNT
};
