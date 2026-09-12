'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const cache = require('./cache');
const { positiveInt } = require('./env');

const MONITOR = (process.env.ARGUS_NATS_MONITOR_URL || 'http://nats:8222').replace(/\/+$/, '');

const ACCOUNT = process.env.ARGUS_NATS_ACCOUNT || 'ARGUS';

const TIMEOUT_MS = positiveInt('ARGUS_UPSTREAM_TIMEOUT_MS', 8000);

const TTL_MS = positiveInt('ARGUS_QUEUE_CACHE_TTL_MS', 5000);

const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

function classify(err) {
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);
  const status = err && err.status;

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

function limitOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { state: 'unknown', value: null };
  if (v < 0 || v >= Number.MAX_SAFE_INTEGER) return { state: 'unlimited', value: null };
  return { state: 'set', value: v };
}

function ratio(used, lim) {
  if (!lim || lim.state !== 'set' || !(lim.value > 0)) return null;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return used / lim.value;
}

function when(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.indexOf('0001-01-01') === 0) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function secondsOf(ns) {
  return typeof ns === 'number' && Number.isFinite(ns) ? ns / 1e9 : null;
}

function counterOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const JSZ_PATH = '/jsz?accounts=true&streams=true&consumers=true&config=true';

function jszSnapshot() {
  return cache.through('queues:jsz', TTL_MS, () => getJson(JSZ_PATH));
}

function varzSnapshot() {
  return cache.through('queues:varz', TTL_MS, () => getJson('/varz'));
}

function connzSnapshot() {
  return cache.through('queues:connz', TTL_MS, () => getJson('/connz?auth=true&limit=64'));
}

function healthzSnapshot() {
  return cache.through('queues:healthz', TTL_MS, () => getJson('/healthz?details=true', { accept: [200, 503] }));
}

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

function resolveAccount(jsz) {
  if (!jsz || typeof jsz !== 'object') {
    return { state: 'unknown', message: 'The /jsz endpoint did not return a JetStream document.' };
  }
  if (jsz.disabled === true) {
    return { state: 'disabled-server-wide', message: NOT_ENABLED_FIX };
  }
  const details = Array.isArray(jsz.account_details) ? jsz.account_details : null;
  if (!details || details.length === 0) {
    return { state: 'no-jetstream-accounts', message: NO_ACCOUNT_FIX };
  }

  const exact = details.filter((a) => a && a.name === ACCOUNT)[0];
  if (exact) return { state: 'enabled', detail: exact, nameMatched: true };

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

function streamDetails(resolved) {
  if (resolved.state !== 'enabled') return null;
  const d = resolved.detail;
  return Array.isArray(d.stream_detail) ? d.stream_detail : [];
}

const server = reader(async () => {
  const snap = await varzSnapshot();
  const v = snap.value.json || {};

  const js = v.jetstream || {};
  const jsEnabled = !!(js.config && typeof js.config === 'object');

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
      cumulative: true
    },

    limits: {
      maxPayloadBytes: limitOf(v.max_payload),
      maxPendingBytesPerConnection: limitOf(v.max_pending)
    },

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
      apiErrors: numOrNull(d.api && d.api.errors),
      haAssets: numOrNull(d.ha_assets)
    },

    limits: {
      memory: memoryLimit,
      storage: storageLimit,
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
    inventorySource: 'the NATS server (/jsz), not a declared list',
    unreadable: rows.filter((r) => !r.stateKnown).map((r) => r.name)
  };
});

const consumers = reader(async (options) => {
  const opts = options || {};
  const wanted = typeof opts.stream === 'string' && opts.stream.trim() ? opts.stream.trim() : null;

  const snap = await jszSnapshot();
  const jsz = snap.value.json || {};
  const resolved = resolveAccount(jsz);

  const base = {
    account: ACCOUNT,
    stream: wanted,
    jetStream: resolved.state,
    cachedAt: snap.cachedAt,
    stale: !!snap.stale,
    at: new Date().toISOString()
  };

  if (resolved.state !== 'enabled') {
    return { ...base, consumers: null, count: null, message: resolved.message };
  }

  const all = streamDetails(resolved) || [];
  const details = wanted ? all.filter((s) => s && s.name === wanted) : all;

  if (wanted && !details.length) {
    return {
      ...base,
      consumers: null,
      count: null,
      message: `Account ${ACCOUNT} has no stream called "${wanted}". Its streams are ` +
        `${all.map((s) => s && s.name).filter(Boolean).join(', ') || '(none)'}.`
    };
  }

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

      if (pending > 0 && waiting === 0 && ackPending === 0) {
        attention.push({
          code: 'nothing-pulling', severity: 'warn',
          message: `${pending} message(s) are waiting, no pull request is parked, and nothing is in ` +
            'flight. Consistent with no worker running for this consumer. Note that the dead-letter ' +
            'stream stays EMPTY in exactly this situation -- the max-deliveries advisory is only ' +
            'published when a consumer next pulls -- so a quiet dead-letter count is not reassurance here.'
        });
      }

      if (maxAckPending.state === 'set' && ackPending !== null && ackPending >= maxAckPending.value) {
        attention.push({
          code: 'ack-pending-at-ceiling', severity: 'bad',
          message: `${ackPending} unacknowledged message(s) has reached this consumer's max_ack_pending ` +
            `of ${maxAckPending.value}. The server will deliver nothing more to it until an ack arrives ` +
            'or an ack_wait expires, so pending will keep growing while the consumer appears idle.'
        });
      }

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
          pull: !cfg.deliver_subject,
          ackWaitSeconds: secondsOf(cfg.ack_wait),
          backoffSeconds: backoff,
          ackWaitIsFirstBackoffStep: !!(backoff && backoff.length),
          maxDeliver,
          maxAckPending,
          maxWaiting: limitOf(cfg.max_waiting),
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
    streamsWithoutConsumers,
    lagNote: 'pending and ackPending are separate measurements and are not added together anywhere. ' +
      'pending is work not yet handed out (the queue is deep); ackPending is work handed out and not ' +
      'acknowledged (the worker is slow, blocked or gone). They call for opposite responses.'
  };
});

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

  let leaderless = 0;
  let unbounded = 0;
  for (const s of streamRows) {
    if (s.cluster && Object.keys(s.cluster).length && !s.cluster.leader) leaderless += 1;
    if (limitOf(s.config && s.config.max_bytes).state !== 'set') unbounded += 1;
  }

  const healthzBad = !!(healthz && (healthz.httpStatus !== 200 || healthz.status !== 'ok'));

  let verdict;
  if (!jsEnabled) verdict = 'jetstream-disabled';
  else if (jszError) verdict = 'unknown';
  else if (!accountOk) verdict = 'account-unusable';
  else if (healthzBad || leaderless > 0) verdict = 'degraded';
  else verdict = 'ok';

  return {
    verdict,
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
