'use strict';

const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('assert');

const MASTER_PORT = Number(process.env.STORAGE_MASTER_PORT || 8961);
const DEAD_PORT = MASTER_PORT + 1;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-storage-test-'));
const bucketsFile = path.join(workDir, 'buckets.yaml');
const stateDir = path.join(workDir, 'state');
fs.mkdirSync(stateDir, { recursive: true });

fs.writeFileSync(bucketsFile, [
  'buckets:',
  '  - name: argus-backups',
  '    owner: platform',
  '    versioning: true',
  '    objectLock:',
  '      mode: COMPLIANCE',
  '      days: 35',
  '  - name: argus-logs',
  '    owner: platform',
  '  - name: argus-ml',
  '    owner: platform',
  ''
].join('\n'));

process.env.ARGUS_SEAWEED_MASTER_URL = `http://127.0.0.1:${MASTER_PORT}`;
process.env.ARGUS_BUCKETS_FILE = bucketsFile;
process.env.ARGUS_STATE_DIR = stateDir;
process.env.ARGUS_UPSTREAM_TIMEOUT_MS = '3000';
process.env.ARGUS_LOG_LEVEL = 'error';

const storage = require('../src/storage.js');
const cache = require('../src/cache.js');

const VOL_STATUS = {
  Version: '30GB 3.97',
  Volumes: {
    Max: 60,
    Free: 57,
    DataCenters: {
      'site-a': {
        compose: {
          'seaweed-volume:8080': [
            {
              Id: 1, Size: 10485760, Collection: 'argus-backups', Version: 3,
              FileCount: 412, DeleteCount: 7, DeletedByteCount: 81920, ReadOnly: false
            },
            {
              Id: 2, Size: 5242880, Collection: 'argus-backups', Version: 3,
              FileCount: 88, DeleteCount: 0, DeletedByteCount: 0, ReadOnly: false
            },
            {
              Id: 3, Size: 1048576, Collection: 'argus-logs', Version: 3,
              FileCount: 9000, DeleteCount: 1200, DeletedByteCount: 262144, ReadOnly: false
            },
            {
              Id: 4, Size: 4096, Collection: '', Version: 3,
              FileCount: 3, DeleteCount: 0, DeletedByteCount: 0, ReadOnly: false
            }
          ]
        }
      }
    }
  }
};

const asked = [];

const master = http.createServer((req, res) => {
  asked.push(req.url);
  const url = req.url.split('?')[0];
  const body = url === '/vol/status' ? VOL_STATUS : { error: 'no such endpoint' };
  const text = JSON.stringify(body);
  res.writeHead(url === '/vol/status' ? 200 : 404, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
});

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: err.message }); }
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function rowFor(answer, name) {
  return (answer.buckets || []).find((b) => b.name === name) || null;
}

(async () => {
  await listen(master, MASTER_PORT);

  fs.writeFileSync(path.join(stateDir, 'storage-init.json'), JSON.stringify({
    at: '2026-09-12T00:00:00.000Z',
    profile: 'dev',
    probeBucket: 'argus-worm-probe',
    buckets: [
      { name: 'argus-backups', status: 'verified', versioning: true,
        lock: { mode: 'COMPLIANCE', days: 35, declared: 'COMPLIANCE/35d' }, lifecycleDays: null },
      { name: 'argus-logs', status: 'verified', versioning: false, lock: null, lifecycleDays: 30 },
      { name: 'argus-ml', status: 'created', versioning: false, lock: null, lifecycleDays: null }
    ],
    actual: [
      { name: 'argus-backups', createdAt: '2026-09-01T00:00:00.000Z' },
      { name: 'argus-logs', createdAt: '2026-09-01T00:00:00.000Z' },
      { name: 'argus-ml', createdAt: '2026-09-01T00:00:00.000Z' }
    ],
    worm: {
      at: '2026-09-12T00:00:00.000Z',
      bucket: 'argus-worm-probe',
      verdict: 'enforced',
      detail: 'The versioned delete was refused with AccessDenied. Retention is enforced by the S3 gateway.',
      probedMode: 'COMPLIANCE',
      probedDays: 1,
      defaultRetentionStamped: 'stamped',
      defaultRetentionDetail: 'An object PUT with no lock headers came back stamped COMPLIANCE.',
      filerBypass: 'open',
      filerBypassDetail: 'DELETE through the filer succeeded (204).'
    }
  }, null, 2));

  const answer = await storage.buckets();

  check('per-collection figures come from the master, and no volume server is contacted', () => {
    assert.strictEqual(answer.ok, true, JSON.stringify(answer).slice(0, 300));
    assert.deepStrictEqual(asked, ['/vol/status'], `asked ${asked.join(', ')}`);
    assert.match(answer.countsFrom, /\/vol\/status/);
  });

  check('two volumes of one collection add up into one bucket row', () => {
    const b = rowFor(answer, 'argus-backups');
    assert.ok(b, 'argus-backups is missing from the answer');
    assert.strictEqual(b.volumes, 2);
    assert.strictEqual(b.diskBytes, 10485760 + 5242880);
    assert.strictEqual(b.needles, 412 + 88);
  });

  check('what a vacuum would return is published beside what fills the disk', () => {
    const b = rowFor(answer, 'argus-backups');
    assert.strictEqual(b.reclaimableBytes, 81920);
    assert.strictEqual(b.liveBytes, 10485760 + 5242880 - 81920);
    assert.strictEqual(b.deletedNeedles, 7);
    assert.strictEqual(b.liveNeedles, 412 + 88 - 7);
  });

  check('a needle count is never presented as an object count', () => {
    const b = rowFor(answer, 'argus-logs');
    assert.strictEqual(b.objects, null, 'an object count was invented');
    assert.strictEqual(answer.countsAreNeedles, true);
    assert.match(b.objectsReason, /needles/i);
    assert.match(b.objectsReason, /4 MB/);
    assert.strictEqual(b.liveNeedles, 9000 - 1200);
    assert.strictEqual(b.liveBytes, 1048576 - 262144);
  });

  check('a bucket nothing has been written to is unknown, never zero', () => {
    const b = rowFor(answer, 'argus-ml');
    assert.ok(b, 'argus-ml is missing from the answer');
    assert.strictEqual(b.unknownSize, true);
    assert.strictEqual(b.diskBytes, null);
    assert.strictEqual(b.liveBytes, null);
    assert.strictEqual(b.needles, null);
    assert.strictEqual(b.volumes, 0);
    assert.match(b.unknownSizeReason, /Nothing has been written/);
  });

  check('the default collection is not reported as a bucket', () => {
    assert.strictEqual(rowFor(answer, ''), null);
    assert.strictEqual(answer.count, 3);
  });

  const locked = await storage.lockStatus();
  check('the filer bypass is reported beside the WORM verdict, not folded into it', () => {
    assert.strictEqual(locked.determined, true);
    assert.strictEqual(locked.verdict, 'enforced');
    assert.strictEqual(locked.filerBypass, 'open');
    assert.ok(locked.filerBypassDetail && locked.filerBypassDetail.length > 10, 'the caveat carries no explanation');
    assert.strictEqual(locked.defaultRetentionStamped, 'stamped');
  });

  cache.clear();
  process.env.ARGUS_SEAWEED_MASTER_URL = `http://127.0.0.1:${DEAD_PORT}`;
  delete require.cache[require.resolve('../src/storage.js')];
  const offline = require('../src/storage.js');
  const withoutMaster = await offline.buckets();

  check('a master that does not answer makes the sizes unknown, not zero', () => {
    assert.strictEqual(withoutMaster.ok, true);
    assert.strictEqual(withoutMaster.topologyOk, false);
    const b = rowFor(withoutMaster, 'argus-backups');
    assert.strictEqual(b.diskBytes, null);
    assert.strictEqual(b.reclaimableBytes, null);
    assert.strictEqual(b.needles, null);
    assert.match(b.unknownSizeReason, /master could not be read/);
  });

  master.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : '   ' + r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length);
})().catch((err) => {
  console.error('storage harness failed:', err);
  process.exit(1);
});
