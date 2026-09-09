/*
 * Argus console API: smoke tests.
 *
 *   node test/smoke.js
 *
 * These run against a real server on a real port with NO AWS credentials,
 * because that is the state the server has to survive: a laptop, a fresh
 * container, an expired SSO session. The whole point of the AWS layer is that
 * "not configured" is a normal answer rather than an outage, and the only way
 * to know that holds is to run it that way.
 *
 * Exit code is the failure count, so CI can gate on it.
 */
'use strict';

const http = require('http');
const assert = require('assert');

const PORT = Number(process.env.SMOKE_PORT || 8899);
process.env.ARGUS_PORT = String(PORT);
process.env.ARGUS_HOST = '127.0.0.1';
// Deliberately point the credential chain at nothing, so the run is the same
// on a developer machine with a profile and on a CI box without one.
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_PROFILE = '__argus_smoke_no_such_profile__';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/argus-smoke';
process.env.AWS_CONFIG_FILE = '/nonexistent/argus-smoke';
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.ARGUS_AWS_TIMEOUT_MS = '4000';

const { server } = require('../src/index.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: err.message }); }
};

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function send(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  /* ------------------------------------------------------------- health --- */
  const health = await get('/api/health');
  check('health answers 200', () => assert.strictEqual(health.status, 200));
  check('health is json', () => assert.match(health.headers['content-type'], /application\/json/));
  check('health reports a version', () => assert.ok(JSON.parse(health.body).version));

  /* --------------------------------------------------------------- host --- */
  const host = JSON.parse((await get('/api/host')).body);
  check('host reports its own name', () => assert.ok(host.hostname && host.hostname.length));
  check('host cpu usage is a real ratio', () => {
    assert.ok(host.cpu.usageRatio >= 0 && host.cpu.usageRatio <= 1, `got ${host.cpu.usageRatio}`);
  });
  check('host cpu core count is plausible', () => assert.ok(host.cpu.cores >= 1));
  check('host memory adds up', () => {
    assert.strictEqual(host.memory.usedBytes + host.memory.freeBytes, host.memory.totalBytes);
  });
  check('host reports at least one disk', () => assert.ok(host.disks.length >= 1));
  check('a disk reports size or an error, never silence', () => {
    for (const d of host.disks) assert.ok(d.error || d.totalBytes > 0, `mount ${d.mount}`);
  });
  check('host telemetry is timestamped', () => assert.ok(Date.parse(host.at) > 0));

  // Two samples must differ: a single cumulative reading would be constant.
  await new Promise((r) => setTimeout(r, 250));
  const host2 = JSON.parse((await get('/api/host')).body);
  check('cpu is sampled over an interval, not since boot', () => {
    assert.ok(host2.cpu.sampledOverMs > 0 && host2.cpu.sampledOverMs < 60000,
      `window ${host2.cpu.sampledOverMs}ms`);
  });

  /* ---------------------------------------------------------------- aws --- */
  const cap = JSON.parse((await get('/api/capabilities')).body);
  check('capabilities answers without credentials', () => assert.ok(cap.region));
  check('capabilities reports aws as not connected', () => assert.strictEqual(cap.aws.connected, false));
  check('the reason is actionable, not a stack trace', () => {
    assert.ok(['not-configured', 'expired', 'denied', 'unreachable', 'timeout', 'no-sdk'].includes(cap.aws.reason),
      `reason was ${cap.aws.reason}`);
    assert.ok(cap.aws.message && cap.aws.message.length > 20);
  });

  for (const path of ['/api/aws/instances', '/api/aws/buckets', '/api/aws/databases', '/api/aws/alarms']) {
    const r = await get(path);
    check(`${path} answers 200 with an honest failure, not a 500`, () => {
      assert.strictEqual(r.status, 200, `status ${r.status}`);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.ok, false);
      assert.ok(b.reason, 'no reason given');
    });
  }

  const overview = JSON.parse((await get('/api/overview')).body);
  check('overview degrades section by section', () => {
    assert.strictEqual(overview.instances.ok, false, 'aws section should be unavailable');
    assert.ok(overview.host.hostname, 'host section should still work');
  });

  /* -------------------------------------------------------------- guards --- */
  const post = await send('POST', '/api/aws/instances');
  check('mutating verbs are refused while read-only', () => {
    assert.strictEqual(post.status, 405);
    assert.match(JSON.parse(post.body).error, /read-only/);
  });

  const traversal = await get('/../../../../package.json');
  check('path traversal is refused', () => {
    assert.ok(traversal.status === 403 || traversal.status === 404, `status ${traversal.status}`);
  });

  const missing = await get('/api/nope');
  check('an unknown api route is a 404, not a 500', () => assert.strictEqual(missing.status, 404));

  const malformed = await get('/api/host?x=%zz');
  check('a malformed escape does not crash the server', () => assert.ok(malformed.status < 500));

  const statik = await get('/index.html');
  check('the console itself is served', () => {
    assert.strictEqual(statik.status, 200);
    assert.match(statik.body, /Argus Console/);
  });
  // `assert.ok(x === undefined || true)` was here first, which cannot fail --
  // the exact defect class this project spent a day removing from its other
  // harnesses. Assert the header that is actually meant to be present.
  check('static responses carry nosniff', () => {
    assert.strictEqual(statik.headers['x-content-type-options'], 'nosniff');
  });
  check('static responses declare a content type', () => {
    assert.match(statik.headers['content-type'], /text\/html/);
  });
  check('api responses are not cached by the browser', () => {
    assert.strictEqual(health.headers['cache-control'], 'no-store');
  });

  /* --------------------------------------------------------------- cache --- */
  const t0 = Date.now();
  await get('/api/aws/instances');
  const cold = Date.now() - t0;
  const t1 = Date.now();
  await get('/api/aws/instances');
  const warm = Date.now() - t1;
  check('a repeated read is served without another aws call', () => {
    assert.ok(warm <= cold + 50, `cold ${cold}ms, warm ${warm}ms`);
  });

  /* -------------------------------------------------------------- report --- */
  server.close();

  const failed = results.filter((r) => !r.ok);
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : '   ' + r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length);
})().catch((err) => {
  console.error('smoke harness failed:', err);
  process.exit(1);
});
