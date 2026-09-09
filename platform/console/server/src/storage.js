/*
 * The object store, as the console sees it.
 *
 * This is the S3 replacement's read side: topology and capacity from the
 * SeaweedFS master and volume servers, buckets and objects over the S3 API,
 * and the declared intent from platform/gitops/storage/buckets.yaml.
 *
 * Three things this file refuses to do, each because the obvious version is
 * actively misleading on a storage dashboard.
 *
 * IT NEVER SHOWS A SIZE IT DID NOT MEASURE. SeaweedFS reports usage per
 * COLLECTION, and a bucket nothing has been written to yet has no collection
 * and therefore no volumes -- the topology genuinely knows nothing about it.
 * Rendering that as "0 B" is not a rounding decision, it is the difference
 * between "this bucket is empty" and "we have no idea", and those lead to
 * opposite actions next to a bucket called argus-backups. Unknown stays
 * unknown, and the UI is expected to say so.
 *
 * IT NEVER WALKS A BUCKET TO ANSWER A PAGE LOAD. There is no cheap object
 * count in S3, and a dashboard that quietly issues thousands of ListObjectsV2
 * requests on every refresh is how a storage bill doubles and how a cluster
 * gets a load spike every time somebody leaves a tab open. Counts come from
 * the volume servers -- O(volume servers), not O(objects) -- and are labelled
 * approximate because they include deleted-but-not-compacted space. The one
 * endpoint that does walk is explicitly budgeted and only reachable from a
 * button a human pressed.
 *
 * IT NEVER CALLS A LOCK ENFORCED BECAUSE IT IS CONFIGURED. That verdict comes
 * from storage-init, which attempted a real delete of a real object version
 * under real retention. See tools/init-object-storage.js.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const YAML = require('yaml');

const config = require('./config');
const cache = require('./cache');

/* ------------------------------------------------------------------ config --- */

const MASTER = process.env.ARGUS_SEAWEED_MASTER_URL || 'http://seaweed-master:9333';
const FILER = process.env.ARGUS_SEAWEED_FILER_URL || 'http://seaweed-filer:8888';
const S3_ENDPOINT = process.env.ARGUS_S3_ENDPOINT || 'http://seaweed-s3:8333';
const S3_REGION = process.env.ARGUS_S3_REGION || 'us-east-1';
const BUCKETS_FILE = process.env.ARGUS_BUCKETS_FILE || '/config/buckets.yaml';
const STATE_DIR = process.env.ARGUS_STATE_DIR || '/state';
const TIMEOUT_MS = Number(process.env.ARGUS_UPSTREAM_TIMEOUT_MS || 8000);

/* The master hands out CONTAINER-INTERNAL volume-server URLs (seaweed-volume:8080).
   In network that is exactly right. Running the console on the Windows host for
   front-end work, it resolves to nothing -- so capacity and per-bucket sizes
   would silently come back empty and look like an empty cluster.

   This map rewrites them, e.g. ARGUS_SEAWEED_NODE_URL_MAP="seaweed-volume:8080=127.0.0.1:8080".
   Without it, those fields report `unavailable` with a reason. What is NOT used
   is SeaweedFS's own -publicUrl: that changes the URL the master gives to EVERY
   client including the in-network filer, which breaks writes to fix a display. */
const NODE_URL_MAP = (() => {
  const raw = process.env.ARGUS_SEAWEED_NODE_URL_MAP || '';
  const map = new Map();
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split('=').map((s) => (s || '').trim());
    if (from && to) map.set(from, to);
  }
  return map;
})();

function mapNodeUrl(authority) {
  return NODE_URL_MAP.get(authority) || authority;
}

/* ------------------------------------------------------------------- http --- */

/** A bounded JSON GET with no dependency and no redirect following. */
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return reject(new Error(`bad url ${url}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;
    /* The SeaweedFS filer serves a BROWSABLE HTML PAGE on the same paths as its
       JSON API and picks between them on Accept alone. Without this header the
       probe gets a valid 200 full of HTML, fails to parse it, and reports a
       perfectly healthy filer as unreachable. */
    const req = lib.get(url, {
      timeout: timeoutMs || TIMEOUT_MS,
      headers: { accept: 'application/json' }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`${url} answered ${res.statusCode}`), { status: res.statusCode }));
      }
      let body = '';
      res.setEncoding('utf8');
      /* A volume server with thousands of volumes returns a large document.
         Cap it rather than let one upstream exhaust the console's heap. */
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > 16 * 1024 * 1024) { req.destroy(new Error(`${url} response exceeded 16 MB`)); return; }
        body += d;
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`${url} did not return JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url} did not answer within ${timeoutMs || TIMEOUT_MS} ms`)));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------- s3 --- */

let sdk = null;
let sdkError = null;
function s3sdk() {
  if (sdk || sdkError) return sdk;
  try { sdk = require('@aws-sdk/client-s3'); }
  catch (err) { sdkError = 'The AWS SDK is not installed. Run `npm install` in platform/console/server.'; }
  return sdk;
}

let client = null;
function s3() {
  const m = s3sdk();
  if (!m) return null;
  if (!client) {
    client = new m.S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      /* SeaweedFS is path-style only. Virtual-host style resolves
         bucket.seaweed-s3, which no DNS here answers -- so the failure arrives
         as ENOTFOUND and looks like a network problem rather than a config one. */
      forcePathStyle: true,
      maxAttempts: 2,
      requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 3000 }
    });
  }
  return client;
}

/**
 * Classify an upstream failure into something with a next action attached.
 *
 * "Failed to fetch" tells an operator nothing. Whether the gateway is down,
 * the credential is wrong, or the clock has drifted are three different
 * problems with three different fixes, and only the last is non-obvious enough
 * that people lose an afternoon to it.
 */
function classify(err) {
  const name = (err && (err.name || err.Code)) || 'Error';
  const msg = (err && err.message) || String(err);
  const status = err && err.$metadata && err.$metadata.httpStatusCode;

  if (/RequestTimeTooSkewed/i.test(name + msg)) {
    return {
      reason: 'clock-skew',
      message: 'The S3 gateway rejected the request signature because this clock and the server clock disagree. ' +
        'WSL2 drifts after the host sleeps. Fix with: wsl --shutdown, or `hwclock -s` inside the distro.'
    };
  }
  if (status === 403 || /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/i.test(name)) {
    return {
      reason: 'denied',
      message: 'The S3 gateway refused this credential or this action. The console identity is scoped to the ' +
        'buckets declared in buckets.yaml, so a bucket created outside that file is not visible to it. ' +
        'It also cannot call ListBuckets, which needs a store-wide grant it deliberately does not hold.'
    };
  }
  if (/NoSuchBucket/i.test(name)) return { reason: 'no-such-bucket', message: 'That bucket does not exist.' };
  if (/NoSuchKey|NotFound/i.test(name) || status === 404) {
    return { reason: 'not-found', message: 'That object does not exist.' };
  }
  if (/TimeoutError|ETIMEDOUT|did not answer/i.test(name + msg)) {
    return { reason: 'timeout', message: `The object store did not answer within ${TIMEOUT_MS} ms.` };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH/i.test(name + msg)) {
    return {
      reason: 'unreachable',
      message: 'The object store is not reachable from the console. Is the stack up? ' +
        '`docker compose ps` in platform/compose.'
    };
  }
  return { reason: 'error', message: msg };
}

/** A reader that reports why it could not answer instead of throwing. */
function guarded(key, ttlMs, producer) {
  return async function (...args) {
    try {
      const r = await cache.through(key + (args.length ? ':' + JSON.stringify(args) : ''), ttlMs,
        () => producer(...args));
      return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  };
}

/* ------------------------------------------------------------- declared ----- */

let declaredCache = null;
let declaredAt = 0;

/**
 * What buckets.yaml says the estate should look like.
 *
 * Read from the same committed file storage-init drives from, so the console
 * cannot disagree with what was actually applied. Deliberately NOT read from
 * bucket tags: the map is a file in the repository, and putting a second copy
 * of it in the object store creates two sources that drift.
 */
function declared() {
  if (declaredCache && Date.now() - declaredAt < 60000) return declaredCache;
  try {
    const doc = YAML.parse(fs.readFileSync(BUCKETS_FILE, 'utf8'));
    const map = new Map();
    for (const b of (doc && doc.buckets) || []) {
      if (!b || !b.name) continue;
      map.set(b.name, {
        owner: b.owner || null,
        readers: b.readers || [],
        versioning: !!b.versioning,
        objectLock: b.objectLock || null,
        lifecycleDays: b.lifecycle && b.lifecycle.expireDays ? Number(b.lifecycle.expireDays) : null,
        /* Declared intent for Site B. There is no Site B, so this is rendered
           as "not configured" and never as a replication lag of zero -- a lag
           of zero is what a healthy replica looks like, and there is no
           replica. */
        replicationDeclared: !!(b.replication && b.replication.siteB),
        backup: b.backup === 'none' ? null : b.backup || null
      });
    }
    declaredCache = { map, error: null };
  } catch (err) {
    declaredCache = { map: new Map(), error: `${BUCKETS_FILE} could not be read: ${err.message}` };
  }
  declaredAt = Date.now();
  return declaredCache;
}

/** The WORM verdict storage-init proved by attempting a real delete. */
function lockProbe() {
  for (const name of ['storage-init.json', 'worm-verdict.json']) {
    try {
      return JSON.parse(fs.readFileSync(`${STATE_DIR}/${name}`, 'utf8'));
    } catch (err) { /* try the next one */ }
  }
  return null;
}

/* ------------------------------------------------------------- topology ----- */

async function topology() {
  const status = await getJson(`${MASTER}/dir/status`);
  const t = status.Topology || {};
  const nodes = [];
  for (const dc of t.DataCenters || []) {
    for (const rack of dc.Racks || []) {
      for (const n of rack.DataNodes || []) {
        nodes.push({
          url: n.Url,
          reachAt: mapNodeUrl(n.Url),
          dataCenter: dc.Id,
          rack: rack.Id,
          volumes: n.Volumes,
          maxVolumes: n.Max
        });
      }
    }
  }
  return {
    version: status.Version || null,
    slotsMax: t.Max === undefined ? null : t.Max,
    slotsFree: t.Free === undefined ? null : t.Free,
    layouts: t.Layouts || [],
    nodes
  };
}

/** Per-volume-server detail. One request per node, never per object. */
async function nodeStatuses(nodes) {
  return Promise.all(nodes.map(async (n) => {
    try {
      const s = await getJson(`http://${n.reachAt}/status`, 4000);
      return { ...n, ok: true, version: s.Version || null, disks: s.DiskStatuses || [], volumeList: s.Volumes || [] };
    } catch (err) {
      /* Named explicitly, because the in-network vs on-host distinction is the
         single most likely reason this fails and the message should say so. */
      return {
        ...n, ok: false, disks: [], volumeList: [],
        error: NODE_URL_MAP.size === 0 && !/^(127\.|localhost)/.test(n.reachAt)
          ? `${n.url} is not reachable from this process. That URL is container-internal: either run the ` +
            `console on the argus network, or set ARGUS_SEAWEED_NODE_URL_MAP.`
          : `${n.reachAt}: ${err.message}`
      };
    }
  }));
}

/* ------------------------------------------------------------- endpoints ---- */

/**
 * Is the object store actually usable, and if not, which part is not?
 *
 * Container health checks cannot answer this. The S3 gateway's probe is
 * liveness only -- there is no unauthenticated S3 path that means "ready", and
 * once identities are loaded every anonymous request is a 403 that looks
 * identical to a gateway which has not read its config. The only proof is a
 * signed call, which is what this makes.
 */
const health = guarded('storage:health', 10000, async () => {
  const components = [];
  const probe = async (name, url) => {
    const t0 = Date.now();
    try {
      const j = await getJson(url, 4000);
      components.push({ name, reachable: true, version: j.Version || null, latencyMs: Date.now() - t0 });
      return j;
    } catch (err) {
      components.push({ name, reachable: false, latencyMs: Date.now() - t0, error: err.message });
      return null;
    }
  };

  const master = await probe('master', `${MASTER}/dir/status`);
  await probe('filer', `${FILER}/?limit=1`);

  let topo = null;
  let nodeRows = [];
  if (master) {
    topo = await topology();
    nodeRows = await nodeStatuses(topo.nodes);
    for (const n of nodeRows) {
      components.push({
        name: `volume ${n.url}`, reachable: n.ok,
        version: n.version || null, latencyMs: null, error: n.error || undefined
      });
    }
  }

  /* The signed call. It is separate from reachability on purpose: every
     component can be up while this fails, and that combination is almost always
     clock skew after the host slept, which no amount of restarting fixes. */
  let signedCallOk = false;
  let signedReason = null;
  const c = s3();
  if (!c) {
    signedReason = { reason: 'no-sdk', message: sdkError };
  } else {
    /* NOT ListBuckets: that needs a global Write on SeaweedFS 3.97, which this
       identity deliberately does not hold. A one-key list against a bucket the
       console is actually granted proves the same three things -- gateway up,
       config loaded, signature accepted -- using a privilege it already needs. */
    const first = [...declared().map.keys()][0];
    if (!first) {
      signedReason = { reason: 'no-buckets-declared', message: `${BUCKETS_FILE} declares no buckets to probe with.` };
    } else {
      try {
        await c.send(new (s3sdk().ListObjectsV2Command)({ Bucket: first, MaxKeys: 1 }));
        signedCallOk = true;
      } catch (err) {
        signedReason = classify(err);
      }
    }
  }

  /* Writable means the master has a writable volume for SOME collection. It
     does not mean this console may write -- the console identity has no Write
     action anywhere, deliberately. */
  const writables = (topo ? topo.layouts : []).reduce((a, l) => a + ((l.writables || []).length), 0);

  return {
    components,
    s3: { signedCallOk, ...(signedReason ? { reason: signedReason.reason, message: signedReason.message } : {}) },
    writable: writables > 0,
    freeVolumes: topo ? topo.slotsFree : null,
    topologyReachable: !!topo && nodeRows.every((n) => n.ok),
    at: new Date().toISOString()
  };
});

/**
 * Capacity, with the limit that actually binds named.
 *
 * There are two ceilings and the disk is usually not the one you hit. Volumes
 * are pre-sized slots: volumeSizeLimitMB x -max is a hard cap, and past it
 * writes fail with "no writable volumes" while df still shows the disk half
 * empty. Reporting only free bytes means the failure arrives with no warning
 * from this screen.
 */
const capacity = guarded('storage:capacity', 15000, async () => {
  const topo = await topology();
  const rows = await nodeStatuses(topo.nodes);

  const nodes = rows.map((n) => {
    const all = n.disks.reduce((a, d) => a + (d.all || 0), 0);
    const used = n.disks.reduce((a, d) => a + (d.used || 0), 0);
    const free = n.disks.reduce((a, d) => a + (d.free || 0), 0);
    return {
      url: n.url, ok: n.ok, error: n.error || null,
      dataCenter: n.dataCenter, rack: n.rack,
      allBytes: n.ok ? all : null,
      usedBytes: n.ok ? used : null,
      freeBytes: n.ok ? free : null,
      volumes: n.volumes, maxVolumes: n.maxVolumes,
      slotsFree: n.maxVolumes === undefined ? null : n.maxVolumes - n.volumes
    };
  });

  const reachable = nodes.filter((n) => n.ok);
  const totals = reachable.length ? {
    allBytes: reachable.reduce((a, n) => a + n.allBytes, 0),
    usedBytes: reachable.reduce((a, n) => a + n.usedBytes, 0),
    freeBytes: reachable.reduce((a, n) => a + n.freeBytes, 0)
  } : null;

  /* Which ceiling is closer. Both are reported; the UI is told which to lead
     with rather than having to work it out. */
  const slotBytes = topo.slotsFree !== null
    ? topo.slotsFree * Number(process.env.ARGUS_S3_VOLUME_SIZE_MB || 1024) * 1024 * 1024
    : null;
  let binding = 'unknown';
  if (slotBytes !== null && totals) {
    binding = slotBytes < totals.freeBytes ? 'volume-slots' : 'disk';
  }

  return {
    nodes,
    totals,
    slots: { max: topo.slotsMax, free: topo.slotsFree, volumeSizeMB: Number(process.env.ARGUS_S3_VOLUME_SIZE_MB || 1024) },
    available: totals && slotBytes !== null ? Math.min(totals.freeBytes, slotBytes) : (totals ? totals.freeBytes : null),
    binding,
    /* Named so nobody compares this with a figure from a real host. Inside
       WSL2 this is the ext4 VHDX, not the Windows volume. */
    scope: 'the WSL2 virtual disk, not the Windows volume it lives on',
    partial: nodes.some((n) => !n.ok),
    at: new Date().toISOString()
  };
});

/**
 * Every bucket, with size from the volume topology rather than a walk.
 *
 * SeaweedFS names a bucket's volumes by COLLECTION, so summing the volumes of
 * one collection is the whole cost -- one request per volume server, whatever
 * the object count. It is approximate: volume size includes the file header
 * and space belonging to deleted-but-not-compacted objects. It is labelled so.
 */
const buckets = guarded('storage:buckets', 15000, async () => {
  const dec = declared();
  const probe = lockProbe();

  /* Deliberately NOT ListBuckets.
   *
   * SeaweedFS 3.97 requires a GLOBAL Write action to authorise ListBuckets --
   * measured, see the s3.json comment in platform/compose/docker-compose.yml.
   * Global Write means write to every bucket in the store, including any added
   * after this credential was issued, which is a large privilege to hold for a
   * screen that lists names.
   *
   * So the console holds per-bucket grants and reads the enumeration from what
   * storage-init recorded while it briefly held admin. That is strictly more
   * informative than ListBuckets would have been: it carries both what exists
   * and what was declared, so drift between them is visible instead of being
   * flattened into one list. */
  const inventory = probe && Array.isArray(probe.actual) ? probe.actual : null;
  const listed = inventory
    ? { Buckets: inventory.filter((b) => b.name !== (probe.probeBucket || 'argus-worm-probe'))
        .map((b) => ({ Name: b.name, CreationDate: b.createdAt })) }
    /* No record yet. Fall back to the declared set so the screen is not empty,
       and say which list it is -- an operator must never have to guess whether
       they are looking at reality or at intent. */
    : { Buckets: [...dec.map.keys()].map((name) => ({ Name: name, CreationDate: null })) };
  const inventorySource = inventory ? 'storage-init' : 'buckets.yaml (declared, not verified)';

  /* Per-collection totals, computed once for every bucket at once. */
  const byCollection = new Map();
  let topologyOk = true;
  let topologyError = null;
  try {
    const topo = await topology();
    const rows = await nodeStatuses(topo.nodes);
    for (const n of rows) {
      if (!n.ok) { topologyOk = false; topologyError = n.error; continue; }
      for (const v of n.volumeList) {
        const key = v.Collection || '';
        const agg = byCollection.get(key) || { sizeBytes: 0, files: 0, deleted: 0, deletedBytes: 0, volumes: 0 };
        agg.sizeBytes += v.Size || 0;
        agg.files += v.FileCount || 0;
        agg.deleted += v.DeleteCount || 0;
        agg.deletedBytes += v.DeletedByteCount || 0;
        agg.volumes += 1;
        byCollection.set(key, agg);
      }
    }
  } catch (err) {
    topologyOk = false;
    topologyError = err.message;
  }

  /* Per-bucket lock state, from what storage-init recorded when it applied and
     verified the configuration. */
  const initRows = new Map();
  if (probe && Array.isArray(probe.buckets)) {
    for (const b of probe.buckets) initRows.set(b.name, b);
  }
  const wormVerdict = probe ? (probe.worm ? probe.worm.verdict : probe.verdict) || 'unknown' : 'unknown';

  const rows = (listed.Buckets || []).map((b) => {
    const name = b.Name;
    const d = dec.map.get(name) || null;
    const agg = byCollection.get(name) || null;
    const applied = initRows.get(name) || null;

    /* The rule this whole file exists for. No volumes for a collection means
       the topology has nothing to say -- not that the bucket holds nothing. */
    const unknownSize = !topologyOk || !agg;

    return {
      name,
      createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null,
      sizeBytes: unknownSize ? null : Math.max(0, agg.sizeBytes - agg.deletedBytes),
      objects: unknownSize ? null : Math.max(0, agg.files - agg.deleted),
      objectsApprox: true,
      unknownSize,
      unknownSizeReason: unknownSize
        ? (topologyOk
            ? 'Nothing has been written to this bucket yet, so it has no volumes and the topology reports no size. Browse it to see its contents.'
            : `The volume servers could not be read: ${topologyError}`)
        : null,
      volumes: agg ? agg.volumes : 0,

      versioning: applied ? !!applied.versioning : (d ? d.versioning : null),
      lock: applied && applied.lock ? applied.lock.mode : null,
      lockDays: applied && applied.lock ? applied.lock.days : null,
      lockDeclared: d && d.objectLock ? `${d.objectLock.mode}/${d.objectLock.days}d` : null,
      /* Enforcement is a property of the SERVER, proven once per boot against a
         dedicated probe bucket -- not a property of this bucket. Reporting it
         per bucket would imply it was tested per bucket. */
      lockEnforced: applied && applied.lock ? wormVerdict : null,

      owner: d ? d.owner : null,
      lifecycleDays: applied ? applied.lifecycleDays : (d ? d.lifecycleDays : null),
      backup: d ? d.backup : null,
      /* Not "0 s lag". There is one node. */
      replication: d && d.replicationDeclared ? 'declared for Site B, not configured' : 'not configured'
    };
  });

  rows.sort((a, b) => a.name.localeCompare(b.name));

  /* Drift, stated rather than implied. A bucket in one list and not the other
     is the interesting case on a storage screen, and merging the two lists
     silently is how it stops being visible. */
  const declaredNames = new Set(dec.map.keys());
  const actualNames = new Set(rows.map((r) => r.name));

  return {
    buckets: rows,
    count: rows.length,
    inventorySource,
    inventoryError: probe && probe.actualError ? probe.actualError : null,
    drift: {
      declaredButMissing: [...declaredNames].filter((n) => !actualNames.has(n)),
      existsButUndeclared: [...actualNames].filter((n) => !declaredNames.has(n))
    },
    declaredError: dec.error,
    topologyOk,
    topologyError,
    wormVerdict,
    at: new Date().toISOString()
  };
});

/* ------------------------------------------------------------- browsing ----- */

const MAX_KEYS = 200;

/**
 * Validate a bucket name against the S3 grammar.
 *
 * Applied to the BUCKET only. The same check applied to a prefix rejects every
 * real prefix -- prefixes contain slashes, and legitimately contain spaces,
 * dots and unicode -- which is a way to ship a browser that cannot browse.
 */
function badBucket(name) {
  if (typeof name !== 'string' || name.length < 3 || name.length > 63) return 'Bucket names are 3 to 63 characters.';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) return 'That is not a valid bucket name.';
  return null;
}

/**
 * Validate a prefix or key on the properties that actually matter.
 *
 * Length, traversal and control characters. Not a character allowlist: S3 keys
 * are arbitrary UTF-8 and a real survey photograph is as likely as not to have
 * a space, a bracket or an accent in its name.
 */
function badKey(key, label) {
  if (typeof key !== 'string') return `${label} must be a string.`;
  if (key.length > 1024) return `${label} is longer than the 1024-character S3 limit.`;
  if (key.includes('..')) return `${label} may not contain "..".`;
  /* Explicit escapes, never literal control bytes in the source: a raw 0x00
     in a regex is invisible in every editor, survives review, and is exactly
     how this line was wrong the first time it was written. */
  /* Checked by code point, with no escape sequence anywhere.

     The regex form of this line was written twice and mangled twice: the
     tooling that generated it collapsed the escape into the raw byte it
     denotes, so the source contained an invisible NUL that every editor
     renders as nothing and every reviewer reads straight past. A loop over
     charCodeAt cannot be corrupted that way, because there is nothing in it
     to corrupt. */
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 32 || code === 127) return `${label} contains a control character.`;
  }
  return null;
}

/* EncodingType='url' is requested so that a key containing a character which is
   illegal in XML does not truncate or corrupt the response. The SDK does NOT
   decode it back -- every Key, Prefix and CommonPrefix has to be decoded here,
   or the console displays "my%20photo.jpg" and, worse, sends that back as the
   key for the next request. */
function decodeMaybe(s) {
  if (typeof s !== 'string') return s;
  try {
    /* A space is encoded as "+", not "%20", and decodeURIComponent leaves "+"
       alone -- so decoding without this line turns "survey 900.txt" into
       "survey+900.txt". That is not a display nit: the corrupted name is what
       gets sent back as the key for preview and delete, and it matches nothing.
       Photographs from a survey device are named with spaces essentially
       always, so this affects most real keys and none of the test ones.
       Replacing every "+" is safe because a literal plus arrives as %2B. */
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch (err) { return s; }
}

/* ── SeaweedFS returns corrupted keys when listing a versioned bucket ──────────
 *
 * Measured on clean, unmodified SeaweedFS 3.97, 3.99 and 4.00 (the newest
 * release at the time of writing), so this is upstream and a version bump does
 * not fix it:
 *
 *   PUT  probe/nested/file.txt          into a bucket with versioning Enabled
 *   GET  probe/nested/file.txt          -> OK, the correct bytes
 *   LIST                                -> "probe/nested/probe/nested/file.txt"
 *   GET  that listed key                -> NoSuchKey
 *
 * The stored object is fine. Only the LISTING is wrong, and it is wrong in one
 * specific way: the directory part is emitted twice. For a true key T whose
 * directory is D, the listing returns D + T. Flat keys have an empty D and come
 * back correct, which is why this hides until somebody uses a prefix.
 *
 * This matters here more than it might elsewhere: every object-locked bucket is
 * necessarily versioned, so the buckets this console most needs to browse --
 * backups, logs, sessions, artifacts -- are exactly the affected ones. A
 * browser that shows those keys is showing names that do not exist, and every
 * click on one 404s.
 *
 * The repair is exact rather than heuristic: if the directory part of a listed
 * key is precisely some string repeated twice, the true key is one copy of it
 * plus the basename. But it is NOT applied on the strength of that shape alone
 * -- `a/b/a/b/file.txt` is a legitimate key, and a future SeaweedFS that fixes
 * this would then have its correct keys corrupted BY US, which is a worse
 * failure than the one being worked around.
 *
 * So the server is asked. One HEAD against the repaired candidate decides, and
 * the verdict is cached per bucket. A fixed upstream answers "the listed key is
 * real", the repair switches itself off, and nothing here needs changing.
 */
const keyRepairVerdict = new Map();

function undoubleKey(listed) {
  const cut = listed.lastIndexOf('/');
  if (cut < 0) return null;                    // flat key: never affected
  const dir = listed.slice(0, cut + 1);        // includes the trailing slash
  if (dir.length % 2 !== 0) return null;
  const half = dir.length / 2;
  if (dir.slice(0, half) !== dir.slice(half)) return null;
  return dir.slice(0, half) + listed.slice(cut + 1);
}

/**
 * Decide, once per bucket, whether this server's listing needs repairing.
 *
 * Returns true only when the repaired key exists AND the listed key does not.
 * Anything less certain leaves the keys alone: showing a name that is wrong is
 * bad, and silently renaming a name that was right is worse.
 */
async function needsKeyRepair(bucket, sampleListedKey) {
  if (keyRepairVerdict.has(bucket)) return keyRepairVerdict.get(bucket);

  const candidate = undoubleKey(sampleListedKey);
  if (!candidate) { keyRepairVerdict.set(bucket, false); return false; }

  const c = s3();
  const m = s3sdk();
  let listedExists = true;
  let candidateExists = false;
  try {
    await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: sampleListedKey }));
  } catch (err) {
    listedExists = false;
  }
  try {
    await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: candidate }));
    candidateExists = true;
  } catch (err) { /* leave false */ }

  const verdict = candidateExists && !listedExists;
  keyRepairVerdict.set(bucket, verdict);
  return verdict;
}

async function listObjects({ bucket, prefix, cursor }) {
  const bad = badBucket(bucket) || badKey(prefix || '', 'The prefix');
  if (bad) throw Object.assign(new Error(bad), { name: 'ValidationError' });

  const c = s3();
  if (!c) throw new Error(sdkError);
  const m = s3sdk();
  const p = prefix || '';

  /* Detect the doubling with one cheap flat read before choosing a strategy.
     It has to be flat: at a nested prefix the buggy server returns only
     CommonPrefixes and no keys at all, so a delimiter listing has nothing in it
     to detect on. */
  let repaired = keyRepairVerdict.get(bucket);
  if (repaired === undefined) {
    const sniff = await c.send(new m.ListObjectsV2Command({
      Bucket: bucket, Prefix: p || undefined, MaxKeys: 1, EncodingType: 'url'
    }));
    const first = (sniff.Contents || []).map((o) => decodeMaybe(o.Key))[0];
    repaired = first ? await needsKeyRepair(bucket, first) : false;
    if (!first) keyRepairVerdict.delete(bucket);   // nothing to learn from; ask again later
  }

  /* ---------------------------------------------------------------- normal ---
     A server that lists correctly gets the correct treatment: one directory
     level, collapsed by the server, 200 keys whatever the bucket holds. */
  if (!repaired) {
    const out = await c.send(new m.ListObjectsV2Command({
      Bucket: bucket,
      Prefix: p || undefined,
      Delimiter: '/',
      MaxKeys: MAX_KEYS,
      ContinuationToken: cursor || undefined,
      EncodingType: 'url'
    }));
    return {
      bucket,
      prefix: p,
      keyRepair: { applied: false },
      folders: (out.CommonPrefixes || []).map((x) => decodeMaybe(x.Prefix)),
      objects: (out.Contents || []).map((o) => ({
        key: decodeMaybe(o.Key),
        sizeBytes: o.Size,
        modifiedAt: o.LastModified ? new Date(o.LastModified).toISOString() : null,
        etag: o.ETag ? o.ETag.replace(/"/g, '') : null,
        storageClass: o.StorageClass || null
      })).filter((o) => o.key !== p),
      cursor: out.NextContinuationToken || null,
      truncated: !!out.IsTruncated,
      pageSize: MAX_KEYS,
      at: new Date().toISOString()
    };
  }

  /* -------------------------------------------------------------- repaired ---
     Server-side collapsing CANNOT be used here. The stored path for a key T is
     dirname(T) + T, so at prefix P the remainder always begins with a repeat of
     the path and every entry collapses into one meaningless CommonPrefix --
     which is exactly the "2026/09/mill-04/2026/" that gave this away.
     Every stored path for a key under P still BEGINS with P, so a flat listing
     at P finds them all; the directory level is then assembled here.

     This reads more keys than a delimiter listing would, and that cost is real
     on a large bucket. It is bounded by SCAN_MAX and reported, rather than
     hidden. */
  const SCAN_MAX = 2000;
  const seenKeys = new Map();
  const folders = new Set();
  let scanned = 0;
  let token = cursor || undefined;
  let truncated = false;

  do {
    const out = await c.send(new m.ListObjectsV2Command({
      Bucket: bucket, Prefix: p || undefined, MaxKeys: 1000,
      ContinuationToken: token, EncodingType: 'url'
    }));
    for (const o of out.Contents || []) {
      scanned += 1;
      const listedKey = decodeMaybe(o.Key);
      const trueKey = undoubleKey(listedKey) || listedKey;
      if (!trueKey.startsWith(p)) continue;      // a sibling caught by the prefix
      const rest = trueKey.slice(p.length);
      if (!rest) continue;                        // the prefix placeholder itself
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        folders.add(p + rest.slice(0, slash + 1));
      } else if (!seenKeys.has(trueKey)) {
        seenKeys.set(trueKey, {
          key: trueKey,
          sizeBytes: o.Size,
          modifiedAt: o.LastModified ? new Date(o.LastModified).toISOString() : null,
          etag: o.ETag ? o.ETag.replace(/"/g, '') : null,
          storageClass: o.StorageClass || null
        });
      }
    }
    token = out.IsTruncated ? out.NextContinuationToken : null;
    if (scanned >= SCAN_MAX && token) { truncated = true; break; }
  } while (token);

  return {
    bucket,
    prefix: p,
    keyRepair: {
      applied: true,
      reason: 'This SeaweedFS returns the directory part of a key twice when listing a versioned bucket ' +
              '(reproduced on 3.97, 3.99 and 4.00; the stored objects themselves are correct). These names ' +
              'have been corrected and checked against the server, and this level was assembled here rather ' +
              'than by the server, because its own prefix collapsing cannot work while the keys are wrong.',
      keysScanned: scanned
    },
    folders: [...folders].sort(),
    objects: [...seenKeys.values()].sort((a, b) => a.key.localeCompare(b.key)),
    cursor: null,
    truncated,
    pageSize: SCAN_MAX,
    at: new Date().toISOString()
  };
}

/**
 * One object, and specifically whether it can be deleted.
 *
 * `deletable` is computed here rather than in the browser so the UI can disable
 * Delete with "under object lock until 14 October" instead of offering it and
 * turning a 403 into a support question.
 */
async function describeObject({ bucket, key }) {
  const bad = badBucket(bucket) || badKey(key, 'The key');
  if (bad) throw Object.assign(new Error(bad), { name: 'ValidationError' });

  const c = s3();
  if (!c) throw new Error(sdkError);
  const m = s3sdk();

  const head = await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: key }));

  let retention = null;
  let legalHold = null;
  /* Both are absent on an unlocked object and on a server that does not
     implement them, and those are different things -- so a failure here is
     recorded rather than flattened into "no retention". */
  let lockReadable = true;
  try {
    const r = await c.send(new m.GetObjectRetentionCommand({ Bucket: bucket, Key: key }));
    if (r.Retention) {
      retention = {
        mode: r.Retention.Mode || null,
        until: r.Retention.RetainUntilDate ? new Date(r.Retention.RetainUntilDate).toISOString() : null
      };
    }
  } catch (err) {
    if (!/NoSuchObjectLockConfiguration|NotFound|404/i.test(err.name || '')) lockReadable = false;
  }
  try {
    const h = await c.send(new m.GetObjectLegalHoldCommand({ Bucket: bucket, Key: key }));
    legalHold = h.LegalHold && h.LegalHold.Status === 'ON';
  } catch (err) { /* absent is the normal case */ }

  const now = Date.now();
  const held = retention && retention.until && Date.parse(retention.until) > now;
  /* `deletable` has to mean "a delete would succeed", not "the object is not
     locked". The console being read-only is just as real a blocker as
     retention, and leaving it out produced deletable:true sitting next to a
     reason explaining that it cannot be deleted -- the exact contradiction this
     field exists to prevent. Three blockers, one answer. */
  const deletable = !held && !legalHold && !!config.allowWrites;

  return {
    bucket,
    key,
    sizeBytes: head.ContentLength,
    contentType: head.ContentType || null,
    etag: head.ETag ? head.ETag.replace(/"/g, '') : null,
    versionId: head.VersionId || null,
    modifiedAt: head.LastModified ? new Date(head.LastModified).toISOString() : null,
    retention,
    legalHold,
    lockReadable,
    deletable,
    deletableReason: legalHold
      ? 'A legal hold is set on this object. It cannot be deleted until the hold is released.'
      : held
        ? `Object lock (${retention.mode}) retains this until ${retention.until.slice(0, 10)}.`
        : !config.allowWrites
          ? 'This console is running read-only (ARGUS_ALLOW_WRITES is not set), so it refuses every ' +
            'delete before it reaches the object store.'
          : null,
    at: new Date().toISOString()
  };
}

/* --------------------------------------------------------------- preview ---- */

/* An extension ALLOWLIST, not the object's own Content-Type.
 *
 * These are user-uploaded survey photographs. Serving them from the console's
 * own origin with the content type the uploader chose is stored XSS against the
 * control plane: upload an .html, open its preview, and the script runs with
 * the console's origin. The allowlist decides the type; the object's stated
 * type is ignored entirely. */
const PREVIEWABLE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf'
};
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

function previewType(key) {
  const dot = key.lastIndexOf('.');
  if (dot < 0) return null;
  return PREVIEWABLE[key.slice(dot).toLowerCase()] || null;
}

/**
 * Stream one object to the browser, with every safety the type allows.
 *
 * Returns a descriptor the router turns into a response, so this module never
 * touches ServerResponse and stays testable.
 */
async function previewObject({ bucket, key }) {
  const bad = badBucket(bucket) || badKey(key, 'The key');
  if (bad) throw Object.assign(new Error(bad), { name: 'ValidationError' });

  const type = previewType(key);
  if (!type) {
    throw Object.assign(
      new Error('That file type cannot be previewed in the console. Only images, plain text, CSV, JSON and PDF are.'),
      { name: 'UnsupportedType' });
  }

  const c = s3();
  if (!c) throw new Error(sdkError);
  const m = s3sdk();

  const head = await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength > PREVIEW_MAX_BYTES) {
    throw Object.assign(
      new Error(`That object is ${Math.round(head.ContentLength / 1048576)} MB. Preview is capped at 5 MB.`),
      { name: 'TooLarge' });
  }

  const out = await c.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
  return { stream: out.Body, contentType: type, contentLength: head.ContentLength };
}

/* ------------------------------------------------------------ prefix size --- */

/* The one endpoint that walks, and it is budgeted twice over: a key ceiling, a
   wall-clock ceiling, and a process-wide lock so two operators pressing
   Calculate cannot double the load. It returns `complete: false` rather than a
   wrong total when it runs out of either budget -- an under-count presented as
   a total is worse than an honest partial. */
const PREFIX_BUDGET_KEYS = 50000;
const PREFIX_BUDGET_MS = 20000;
let prefixScanInFlight = false;

async function prefixSize({ bucket, prefix }) {
  const bad = badBucket(bucket) || badKey(prefix || '', 'The prefix');
  if (bad) throw Object.assign(new Error(bad), { name: 'ValidationError' });

  if (prefixScanInFlight) {
    throw Object.assign(
      new Error('Another size calculation is already running. They are deliberately serialised: this is the one ' +
                'operation here that reads every key under a prefix.'),
      { name: 'Busy' });
  }
  prefixScanInFlight = true;
  const started = Date.now();
  try {
    const c = s3();
    if (!c) throw new Error(sdkError);
    const m = s3sdk();

    let cursor;
    let sizeBytes = 0;
    let objectCount = 0;
    let keysScanned = 0;
    let complete = true;

    do {
      if (keysScanned >= PREFIX_BUDGET_KEYS || Date.now() - started > PREFIX_BUDGET_MS) {
        complete = false;
        break;
      }
      const out = await c.send(new m.ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix || undefined, MaxKeys: 1000,
        ContinuationToken: cursor, EncodingType: 'url'
      }));
      for (const o of out.Contents || []) {
        sizeBytes += o.Size || 0;
        objectCount += 1;
      }
      keysScanned += (out.Contents || []).length;
      cursor = out.IsTruncated ? out.NextContinuationToken : null;
    } while (cursor);

    return {
      bucket, prefix: prefix || '',
      complete, sizeBytes, objectCount, keysScanned,
      budgetKeys: PREFIX_BUDGET_KEYS, budgetMs: PREFIX_BUDGET_MS,
      elapsedMs: Date.now() - started,
      note: complete ? null
        : `Stopped at ${keysScanned} keys. This is a lower bound, not the total.`,
      at: new Date().toISOString()
    };
  } finally {
    prefixScanInFlight = false;
  }
}

/* ----------------------------------------------------------- lock status ---- */

/**
 * Whether immutability is real, from the probe that actually tested it.
 *
 * ADR-0020 makes immutability the answer to its first threat. Everything else
 * in this file reads configuration; this reads the result of an attempted
 * delete of a locked object version. A configured lock that is not enforced
 * looks identical to an enforced one from every other endpoint.
 */
async function lockStatus() {
  const probe = lockProbe();
  const dec = declared();

  if (!probe) {
    return {
      ok: true,
      determined: false,
      message: 'No lock probe result is available. storage-init writes it on every boot; if the stack is up ' +
               'and this is still missing, check `docker compose logs storage-init`.',
      buckets: [],
      anyUnenforced: null,
      at: new Date().toISOString()
    };
  }

  const worm = probe.worm || probe;
  const rows = (probe.buckets || []).filter((b) => b.lock).map((b) => ({
    name: b.name,
    lockEnabled: true,
    mode: b.lock.mode,
    days: b.lock.days,
    declared: b.lock.declared,
    /* One verdict, from one probe, applied to every locked bucket -- and said
       out loud, because a per-bucket column implies a per-bucket test. */
    enforced: worm.verdict || 'unknown',
    probeError: worm.verdict === 'unknown' ? worm.detail : null
  }));

  /* Any bucket that buckets.yaml says should be locked but which the probe
     record does not show as locked. This is the case that cannot be repaired
     in place, so it is surfaced separately rather than as a warning. */
  const appliedNames = new Set((probe.buckets || []).filter((b) => b.lock).map((b) => b.name));
  const missing = [];
  for (const [name, d] of dec.map) {
    if (d.objectLock && !appliedNames.has(name)) missing.push(name);
  }

  return {
    ok: true,
    determined: true,
    verdict: worm.verdict,
    detail: worm.detail,
    probedAt: worm.at || probe.at || null,
    /* Never let a verdict from a laptop be read as a verdict about production. */
    scope: worm.scope || 'unknown',
    profile: probe.profile || null,
    devOverrides: probe.devOverrides || null,
    buckets: rows,
    missingLock: missing,
    anyUnenforced: worm.verdict !== 'enforced',
    problems: probe.problems || [],
    at: new Date().toISOString()
  };
}

module.exports = {
  health,
  capacity,
  buckets,
  listObjects,
  describeObject,
  previewObject,
  prefixSize,
  lockStatus,
  classify,
  PREVIEW_MAX_BYTES
};
