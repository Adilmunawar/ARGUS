'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const YAML = require('yaml');

const config = require('./config');
const cache = require('./cache');
const { positiveInt } = require('./env');

const MASTER = process.env.ARGUS_SEAWEED_MASTER_URL || 'http://seaweed-master:9333';
const FILER = process.env.ARGUS_SEAWEED_FILER_URL || 'http://seaweed-filer:8888';
const S3_ENDPOINT = process.env.ARGUS_S3_ENDPOINT || 'http://seaweed-s3:8333';
const S3_REGION = process.env.ARGUS_S3_REGION || 'us-east-1';
const BUCKETS_FILE = process.env.ARGUS_BUCKETS_FILE || '/config/buckets.yaml';
const STATE_DIR = process.env.ARGUS_STATE_DIR || '/state';
const TIMEOUT_MS = positiveInt('ARGUS_UPSTREAM_TIMEOUT_MS', 8000);
const VOLUME_SIZE_MB = positiveInt('ARGUS_S3_VOLUME_SIZE_MB', 1024);

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

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return reject(new Error(`bad url ${url}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;
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
      forcePathStyle: true,
      maxAttempts: 2,
      requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 3000 }
    });
  }
  return client;
}

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

let declaredCache = null;
let declaredAt = 0;

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

function lockProbe() {
  for (const name of ['storage-init.json', 'worm-verdict.json']) {
    try {
      return JSON.parse(fs.readFileSync(`${STATE_DIR}/${name}`, 'utf8'));
    } catch (err) {  }
  }
  return null;
}

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

const VOL_STATUS_PATH = '/vol/status';

async function collectionTotals() {
  const doc = await getJson(`${MASTER}${VOL_STATUS_PATH}`);
  const dataCenters = (doc && doc.Volumes && doc.Volumes.DataCenters) || {};
  const byCollection = new Map();
  for (const racks of Object.values(dataCenters)) {
    for (const nodes of Object.values(racks || {})) {
      for (const volumes of Object.values(nodes || {})) {
        for (const v of volumes || []) {
          if (!v) continue;
          const key = v.Collection || '';
          const agg = byCollection.get(key) || {
            volumes: 0, diskBytes: 0, needles: 0, deletedNeedles: 0, reclaimableBytes: 0
          };
          agg.volumes += 1;
          agg.diskBytes += v.Size || 0;
          agg.needles += v.FileCount || 0;
          agg.deletedNeedles += v.DeleteCount || 0;
          agg.reclaimableBytes += v.DeletedByteCount || 0;
          byCollection.set(key, agg);
        }
      }
    }
  }
  return byCollection;
}

async function nodeStatuses(nodes) {
  return Promise.all(nodes.map(async (n) => {
    try {
      const s = await getJson(`http://${n.reachAt}/status`, 4000);
      return { ...n, ok: true, version: s.Version || null, disks: s.DiskStatuses || [] };
    } catch (err) {
      return {
        ...n, ok: false, disks: [],
        error: NODE_URL_MAP.size === 0 && !/^(127\.|localhost)/.test(n.reachAt)
          ? `${n.url} is not reachable from this process. That URL is container-internal: either run the ` +
            `console on the argus network, or set ARGUS_SEAWEED_NODE_URL_MAP.`
          : `${n.reachAt}: ${err.message}`
      };
    }
  }));
}

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

  let signedCallOk = false;
  let signedReason = null;
  const c = s3();
  if (!c) {
    signedReason = { reason: 'no-sdk', message: sdkError };
  } else {
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

  const writables = topo ? topo.layouts.reduce((a, l) => a + ((l.writables || []).length), 0) : null;

  return {
    components,
    s3: { signedCallOk, ...(signedReason ? { reason: signedReason.reason, message: signedReason.message } : {}) },
    writable: writables === null ? null : writables > 0,
    writableUnknownReason: writables === null
      ? 'The SeaweedFS master did not answer, so whether a writable volume exists is unknown -- not "no".'
      : null,
    freeVolumes: topo ? topo.slotsFree : null,
    topologyReachable: !!topo && nodeRows.every((n) => n.ok),
    at: new Date().toISOString()
  };
});

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

  const slotBytes = topo.slotsFree !== null
    ? topo.slotsFree * VOLUME_SIZE_MB * 1024 * 1024
    : null;
  let binding = 'unknown';
  if (slotBytes !== null && totals) {
    binding = slotBytes < totals.freeBytes ? 'volume-slots' : 'disk';
  }

  return {
    nodes,
    totals,
    slots: { max: topo.slotsMax, free: topo.slotsFree, volumeSizeMB: VOLUME_SIZE_MB },
    available: totals && slotBytes !== null ? Math.min(totals.freeBytes, slotBytes) : (totals ? totals.freeBytes : null),
    binding,
    scope: 'the WSL2 virtual disk, not the Windows volume it lives on',
    partial: nodes.some((n) => !n.ok),
    at: new Date().toISOString()
  };
});

const buckets = guarded('storage:buckets', 15000, async () => {
  const dec = declared();
  const probe = lockProbe();

  const inventory = probe && Array.isArray(probe.actual) ? probe.actual : null;
  const listed = inventory
    ? { Buckets: inventory.filter((b) => b.name !== (probe.probeBucket || 'argus-worm-probe'))
        .map((b) => ({ Name: b.name, CreationDate: b.createdAt })) }
    : { Buckets: [...dec.map.keys()].map((name) => ({ Name: name, CreationDate: null })) };
  const inventorySource = inventory ? 'storage-init' : 'buckets.yaml (declared, not verified)';

  let byCollection = new Map();
  let topologyOk = true;
  let topologyError = null;
  try {
    byCollection = await collectionTotals();
  } catch (err) {
    topologyOk = false;
    topologyError = err.message;
  }

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

    const unknownSize = !topologyOk || !agg;

    return {
      name,
      createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null,
      diskBytes: unknownSize ? null : agg.diskBytes,
      diskBytesIsFootprint: true,
      reclaimableBytes: unknownSize ? null : agg.reclaimableBytes,
      liveBytes: unknownSize ? null : agg.diskBytes - agg.reclaimableBytes,

      needles: unknownSize ? null : agg.needles,
      liveNeedles: unknownSize ? null : agg.needles - agg.deletedNeedles,
      deletedNeedles: unknownSize ? null : agg.deletedNeedles,

      objects: null,
      objectsReason: 'These are needles, not objects. The filer splits every file at 4 MB and each version of a ' +
        'versioned object is stored separately, so a 1 GB backup is about 256 needles. Use Calculate on a prefix ' +
        'to walk the bucket for a true object count and logical size.',
      unknownSize,
      unknownSizeReason: unknownSize
        ? (topologyOk
            ? 'Nothing has been written to this bucket yet, so it has no volumes and the master reports no size. Browse it to see its contents.'
            : `The SeaweedFS master could not be read: ${topologyError}`)
        : null,
      volumes: agg ? agg.volumes : 0,

      versioning: applied ? !!applied.versioning : (d ? d.versioning : null),
      lock: applied && applied.lock ? applied.lock.mode : null,
      lockDays: applied && applied.lock ? applied.lock.days : null,
      lockDeclared: d && d.objectLock ? `${d.objectLock.mode}/${d.objectLock.days}d` : null,
      lockEnforced: applied && applied.lock ? wormVerdict : null,

      owner: d ? d.owner : null,
      lifecycleDays: applied ? applied.lifecycleDays : (d ? d.lifecycleDays : null),
      backup: d ? d.backup : null,
      replication: d && d.replicationDeclared ? 'declared for Site B, not configured' : 'not configured'
    };
  });

  rows.sort((a, b) => a.name.localeCompare(b.name));

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
    countsFrom: `${VOL_STATUS_PATH} on the SeaweedFS master`,
    countsAreNeedles: true,
    wormVerdict,
    at: new Date().toISOString()
  };
});

const MAX_KEYS = 200;

function badBucket(name) {
  if (typeof name !== 'string' || name.length < 3 || name.length > 63) return 'Bucket names are 3 to 63 characters.';
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) return 'That is not a valid bucket name.';
  return null;
}

function badKey(key, label) {
  if (typeof key !== 'string') return `${label} must be a string.`;
  if (key.length > 1024) return `${label} is longer than the 1024-character S3 limit.`;
  if (key.includes('..')) return `${label} may not contain "..".`;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 32 || code === 127) return `${label} contains a control character.`;
  }
  return null;
}

function decodeMaybe(s) {
  if (typeof s !== 'string') return s;
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch (err) { return s; }
}

const keyRepairVerdict = new Map();
const KEY_REPAIR_VERDICT_TTL_MS = 10 * 60 * 1000;

function rememberedVerdict(bucket) {
  const held = keyRepairVerdict.get(bucket);
  if (!held) return undefined;
  if (Date.now() - held.at > KEY_REPAIR_VERDICT_TTL_MS) {
    keyRepairVerdict.delete(bucket);
    return undefined;
  }
  return held.verdict;
}

function rememberVerdict(bucket, verdict) {
  keyRepairVerdict.set(bucket, { verdict, at: Date.now() });
}

function undoubleKey(listed) {
  const cut = listed.lastIndexOf('/');
  if (cut < 0) return null;
  const dir = listed.slice(0, cut + 1);
  if (dir.length % 2 !== 0) return null;
  const half = dir.length / 2;
  if (dir.slice(0, half) !== dir.slice(half)) return null;
  return dir.slice(0, half) + listed.slice(cut + 1);
}

async function objectExists(bucket, key) {
  const c = s3();
  const m = s3sdk();
  try {
    await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (classify(err).reason === 'not-found') return false;
    throw err;
  }
}

async function needsKeyRepair(bucket, sampleListedKey) {
  const remembered = rememberedVerdict(bucket);
  if (remembered !== undefined) return remembered;

  const candidate = undoubleKey(sampleListedKey);
  if (!candidate) { rememberVerdict(bucket, false); return false; }

  let listedExists;
  let candidateExists;
  try {
    listedExists = await objectExists(bucket, sampleListedKey);
    candidateExists = await objectExists(bucket, candidate);
  } catch (err) {
    return false;
  }

  const verdict = candidateExists && !listedExists;
  rememberVerdict(bucket, verdict);
  return verdict;
}

async function listObjects({ bucket, prefix, cursor }) {
  const bad = badBucket(bucket) || badKey(prefix || '', 'The prefix');
  if (bad) throw Object.assign(new Error(bad), { name: 'ValidationError' });

  const c = s3();
  if (!c) throw new Error(sdkError);
  const m = s3sdk();
  const p = prefix || '';

  let repaired = rememberedVerdict(bucket);
  if (repaired === undefined) {
    const sniff = await c.send(new m.ListObjectsV2Command({
      Bucket: bucket, Prefix: p || undefined, MaxKeys: 1, EncodingType: 'url'
    }));
    const first = (sniff.Contents || []).map((o) => decodeMaybe(o.Key))[0];
    repaired = first ? await needsKeyRepair(bucket, first) : false;
    if (!first) keyRepairVerdict.delete(bucket);
  }

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
      if (!trueKey.startsWith(p)) continue;
      const rest = trueKey.slice(p.length);
      if (!rest) continue;
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

async function describeObject({ bucket, key }) {
  const bad = badBucket(bucket) || badKey(key, 'The key');
  if (bad) throw Object.assign(new Error(bad), { name: 'ValidationError' });

  const c = s3();
  if (!c) throw new Error(sdkError);
  const m = s3sdk();

  const head = await c.send(new m.HeadObjectCommand({ Bucket: bucket, Key: key }));

  let retention = null;
  let legalHold = null;
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
  } catch (err) {  }

  const now = Date.now();
  const held = retention && retention.until && Date.parse(retention.until) > now;
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
  const declaredBytes = Number.isFinite(head.ContentLength) ? head.ContentLength : null;
  if (declaredBytes !== null && declaredBytes > PREVIEW_MAX_BYTES) {
    throw tooLarge(`That object is ${Math.round(declaredBytes / 1048576)} MB.`);
  }

  const out = await c.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await readCapped(out.Body, PREVIEW_MAX_BYTES);
  return { body, contentType: type, contentLength: body.length, declaredBytes };
}

function tooLarge(what) {
  return Object.assign(
    new Error(`${what} Preview is capped at ${Math.round(PREVIEW_MAX_BYTES / 1048576)} MB.`),
    { name: 'TooLarge' });
}

async function readCapped(source, maxBytes) {
  if (!source) return Buffer.alloc(0);
  const chunks = [];
  let read = 0;
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      read += buf.length;
      if (read > maxBytes) throw tooLarge('That object exceeded the preview cap while it was being read.');
      chunks.push(buf);
    }
  } finally {
    if (typeof source.destroy === 'function') source.destroy();
  }
  return Buffer.concat(chunks, read);
}

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
    enforced: worm.verdict || 'unknown',
    probeError: worm.verdict === 'unknown' ? worm.detail : null
  }));

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
    filerBypass: worm.filerBypass || 'unknown',
    filerBypassDetail: worm.filerBypassDetail
      || 'This run did not probe whether the filer deletes a locked object version. Object Lock is implemented in ' +
         'the S3 gateway alone, so an unmeasured filer is not a closed one.',
    defaultRetentionStamped: worm.defaultRetentionStamped || 'unknown',
    defaultRetentionDetail: worm.defaultRetentionDetail
      || 'This run did not read retention back off an object written with no lock headers, so whether the bucket ' +
         'default reaches real objects is unmeasured.',
    probedAt: worm.at || probe.at || null,
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
