'use strict';

const http = require('http');
const assert = require('assert');

const PORT = Number(process.env.SMOKE_PORT || 8899);
process.env.ARGUS_PORT = String(PORT);
process.env.ARGUS_HOST = '127.0.0.1';
process.env.ARGUS_AUTH = 'off';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_PROFILE = '__argus_smoke_no_such_profile__';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/argus-smoke';
process.env.AWS_CONFIG_FILE = '/nonexistent/argus-smoke';
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.ARGUS_AWS_TIMEOUT_MS = '4000';

const NATS_PORT = Number(process.env.SMOKE_NATS_PORT || 8898);
process.env.ARGUS_NATS_MONITOR_URL = `http://127.0.0.1:${NATS_PORT}`;

const { server } = require('../src/index.js');
const cache = require('../src/cache.js');
const env = require('../src/env.js');

const JSZ_STUB = {
  account_details: [{
    name: 'ARGUS',
    stream_detail: [
      { name: 'ORDERS', consumer_detail: [{ name: 'packer', stream_name: 'ORDERS', config: {} }] },
      {
        name: 'EVENTS',
        consumer_detail: [
          { name: 'indexer', stream_name: 'EVENTS', config: {} },
          { name: 'archiver', stream_name: 'EVENTS', config: {} }
        ]
      }
    ]
  }]
};

const natsStub = http.createServer((req, res) => {
  const text = JSON.stringify(req.url.startsWith('/jsz') ? JSZ_STUB : {});
  res.writeHead(req.url.startsWith('/jsz') ? 200 : 404, {
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
  await new Promise((r) => natsStub.listen(NATS_PORT, '127.0.0.1', r));

  const health = await get('/api/health');
  check('health answers 200', () => assert.strictEqual(health.status, 200));
  check('health is json', () => assert.match(health.headers['content-type'], /application\/json/));
  check('health reports a version', () => assert.ok(JSON.parse(health.body).version));

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

  await new Promise((r) => setTimeout(r, 250));
  const host2 = JSON.parse((await get('/api/host')).body);
  check('cpu is sampled over an interval, not since boot', () => {
    assert.ok(host2.cpu.sampledOverMs > 0 && host2.cpu.sampledOverMs < 60000,
      `window ${host2.cpu.sampledOverMs}ms`);
  });

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

  for (const path of ['/api/storage/health', '/api/storage/capacity', '/api/storage/buckets']) {
    const r = await get(path);
    check(`${path} degrades to a reason, not a 500`, () => {
      assert.strictEqual(r.status, 200, `status ${r.status}`);
      const b = JSON.parse(r.body);
      if (b.ok === false) {
        assert.ok(b.reason, 'no machine-readable reason');
        assert.ok(b.message && b.message.length > 20, 'no human-readable message');
      }
    });
  }

  const lock = await get('/api/storage/lock-status');
  check('lock-status says "not determined" rather than inventing a verdict', () => {
    assert.strictEqual(lock.status, 200);
    const b = JSON.parse(lock.body);
    if (b.determined) assert.ok(['enforced', 'not-enforced', 'unknown'].includes(b.verdict), `verdict ${b.verdict}`);
    else assert.ok(b.message && /probe|storage-init/i.test(b.message), 'no explanation for the missing verdict');
  });

  const badBucket = await get('/api/storage/objects?bucket=xx');
  check('a bucket name that cannot exist is a 400, not a 500', () => {
    assert.strictEqual(badBucket.status, 400, `status ${badBucket.status}`);
  });

  const badType = await get('/api/storage/preview?bucket=argus-ml&key=payload.exe');
  check('preview refuses a type that is not on the allowlist', () => {
    assert.notStrictEqual(badType.status, 200, 'an executable was previewable');
  });

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

  const searchIndex = await get('/api/search/index');
  check('the search index answers with a reason per source rather than an empty list', () => {
    assert.strictEqual(searchIndex.status, 200, `status ${searchIndex.status}`);
    const b = JSON.parse(searchIndex.body);
    assert.strictEqual(b.ok, true, JSON.stringify(b).slice(0, 300));
    assert.ok(Array.isArray(b.items), 'no items array');
    assert.strictEqual(b.count, b.items.length);
    assert.strictEqual(b.cap, 2000);
    assert.strictEqual(b.partial, true, 'every upstream is absent here, so this answer is partial');
    for (const s of b.sources) {
      if (s.ok) continue;
      assert.ok(s.reason, `${s.kind} failed with no machine-readable reason`);
      assert.ok(s.message && s.message.length > 10, `${s.kind} failed with no explanation`);
    }
  });
  check('every search entry carries the route that opens it', () => {
    for (const item of JSON.parse(searchIndex.body).items) {
      assert.ok(item.kind && item.label, 'an entry has no kind or label');
      assert.ok(item.route, `${item.label} has no route`);
      assert.ok(Array.isArray(item.rest), `${item.label} has no rest segments`);
      assert.ok(item.params && typeof item.params === 'object', `${item.label} has no params`);
    }
  });

  const exposition = await get('/metrics');
  check('the console publishes its own latency and error rate in Prometheus text format', () => {
    assert.strictEqual(exposition.status, 200, `status ${exposition.status}`);
    assert.match(exposition.headers['content-type'], /^text\/plain; version=0\.0\.4/);
    assert.match(exposition.body, /# TYPE argus_console_build_info gauge/);
    assert.match(exposition.body, /argus_console_uptime_seconds \d+/);
    assert.match(exposition.body, /# TYPE argus_console_request_duration_seconds histogram/);
    assert.match(exposition.body, /argus_console_request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
    assert.match(exposition.body, /argus_console_open_streams \d+/);
  });
  check('a request that matched a route is labelled by that route', () => {
    assert.match(exposition.body, /argus_console_requests_total\{route="\/api\/health",status="200"\} \d+/);
  });
  check('an unknown path cannot mint a new label, or one scan turns into a cardinality bomb', () => {
    assert.match(exposition.body, /argus_console_requests_total\{route="unmatched",status="404"\} \d+/);
    assert.ok(!exposition.body.includes('route="/api/nope"'), 'an unmatched path became its own label');
  });

  const statik = await get('/index.html');
  check('the console itself is served', () => {
    assert.strictEqual(statik.status, 200);
    assert.match(statik.body, /Argus Console/);
  });
  check('static responses carry nosniff', () => {
    assert.strictEqual(statik.headers['x-content-type-options'], 'nosniff');
  });
  check('static responses declare a content type', () => {
    assert.match(statik.headers['content-type'], /text\/html/);
  });
  check('api responses are not cached by the browser', () => {
    assert.strictEqual(health.headers['cache-control'], 'no-store');
  });

  const everyConsumer = JSON.parse((await get('/api/queues/consumers')).body);
  check('consumers reads every stream when none is named', () => {
    assert.strictEqual(everyConsumer.ok, true, JSON.stringify(everyConsumer).slice(0, 200));
    assert.strictEqual(everyConsumer.count, 3, `count ${everyConsumer.count}`);
    assert.strictEqual(everyConsumer.stream, null);
  });

  const oneStream = JSON.parse((await get('/api/queues/consumers?stream=EVENTS')).body);
  check('the consumers stream parameter is honoured, not ignored', () => {
    assert.strictEqual(oneStream.stream, 'EVENTS');
    assert.strictEqual(oneStream.count, 2, `count ${oneStream.count}`);
    assert.ok(oneStream.consumers.every((c) => c.stream === 'EVENTS'), 'another stream leaked through the filter');
  });

  const noSuchStream = JSON.parse((await get('/api/queues/consumers?stream=NOPE')).body);
  check('an unknown stream is answered for rather than shown as empty', () => {
    assert.strictEqual(noSuchStream.consumers, null);
    assert.match(noSuchStream.message, /NOPE/);
  });

  const overlongDb = await get('/api/pg/tables?database=' + 'd'.repeat(64));
  check('a database name too long to exist is a 400', () => {
    assert.strictEqual(overlongDb.status, 400, `status ${overlongDb.status}`);
  });

  const controlDb = await get('/api/pg/tables?database=' + encodeURIComponent('main\nmain'));
  check('a database name carrying a control character is a 400', () => {
    assert.strictEqual(controlDb.status, 400, `status ${controlDb.status}`);
  });

  const defaultDb = await get('/api/pg/tables');
  check('tables with no database parameter still answers as data, not a 500', () => {
    assert.strictEqual(defaultDb.status, 200, `status ${defaultDb.status}`);
    assert.ok(JSON.parse(defaultDb.body).ok !== undefined);
  });

  const logged = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return realWrite(chunk, ...rest); };
  await get('/api/nope%0a2000-01-01T00:00:00.000Z%20error%20forged-entry');
  process.stdout.write = realWrite;
  check('a percent-encoded newline in a path cannot forge a log line', () => {
    assert.ok(logged.length >= 1, 'the request was not logged at all');
    for (const entry of logged) {
      assert.strictEqual(entry.indexOf('\n'), entry.length - 1,
        `a log entry carried an embedded newline: ${JSON.stringify(entry)}`);
    }
  });

  process.env.ARGUS_AWS_TIMEOUT_MS = '0';
  process.env.ARGUS_CACHE_TTL_MS = '-1';
  delete require.cache[require.resolve('../src/config.js')];
  const reloadedConfig = require('../src/config.js');
  check('a zero timeout and a negative ttl fall back to their defaults', () => {
    assert.strictEqual(reloadedConfig.awsTimeoutMs, 8000);
    assert.strictEqual(reloadedConfig.cacheTtlMs, 30000);
  });

  const configRejections = [];
  env.reportRejections((line) => configRejections.push(line));
  check('a rejected configuration value is reported and names its variable', () => {
    assert.strictEqual(configRejections.length, 2, configRejections.join(' | '));
    assert.ok(configRejections.some((l) => l.includes('ARGUS_AWS_TIMEOUT_MS')), configRejections.join(' | '));
    assert.ok(configRejections.some((l) => l.includes('ARGUS_CACHE_TTL_MS')), configRejections.join(' | '));
  });

  process.env.SMOKE_INT_MALFORMED = '8s';
  process.env.SMOKE_INT_ZERO = '0';
  process.env.SMOKE_INT_NEGATIVE = '-1';
  process.env.SMOKE_INT_FRACTION = '1.5';
  process.env.SMOKE_INT_GOOD = '250';
  check('a malformed duration falls back rather than becoming NaN', () => {
    assert.strictEqual(env.positiveInt('SMOKE_INT_MALFORMED', 8000), 8000);
    assert.strictEqual(env.positiveInt('SMOKE_INT_ZERO', 8000), 8000);
    assert.strictEqual(env.positiveInt('SMOKE_INT_NEGATIVE', 8000), 8000);
    assert.strictEqual(env.positiveInt('SMOKE_INT_FRACTION', 8000), 8000);
    assert.strictEqual(env.positiveInt('SMOKE_INT_UNSET', 8000), 8000);
    assert.strictEqual(env.positiveInt('SMOKE_INT_GOOD', 8000), 250);
  });

  const reported = [];
  env.reportRejections((line) => reported.push(line));
  check('every rejected value is reported exactly once', () => {
    assert.strictEqual(reported.length, 4, reported.join(' | '));
    assert.ok(reported.some((l) => l.includes('SMOKE_INT_MALFORMED')), reported.join(' | '));
    const again = [];
    env.reportRejections((line) => again.push(line));
    assert.strictEqual(again.length, 0, 'a rejection was reported a second time');
  });

  process.env.SMOKE_INT_SHARED = 'nope';
  env.positiveInt('SMOKE_INT_SHARED', 10);
  env.positiveInt('SMOKE_INT_SHARED', 10);
  const shared = [];
  env.reportRejections((line) => shared.push(line));
  check('a variable several modules read is reported once, not once per module', () => {
    assert.strictEqual(shared.length, 1, shared.join(' | '));
  });

  let upstreamCalls = 0;
  const counted = async () => { upstreamCalls += 1; return { call: upstreamCalls }; };
  const cold = await cache.through('smoke:warmth', 60000, counted);
  const warm = await cache.through('smoke:warmth', 60000, counted);
  check('a repeated read is served without another upstream call', () => {
    assert.strictEqual(upstreamCalls, 1, `the upstream was called ${upstreamCalls} times`);
    assert.deepStrictEqual(warm.value, cold.value);
    assert.strictEqual(warm.stale, false);
  });

  let inflightCalls = 0;
  const slow = async () => { inflightCalls += 1; await new Promise((r) => setTimeout(r, 20)); return 'once'; };
  const together = await Promise.all([
    cache.through('smoke:flight', 60000, slow),
    cache.through('smoke:flight', 60000, slow)
  ]);
  check('concurrent readers share one upstream call', () => {
    assert.strictEqual(inflightCalls, 1, `the upstream was called ${inflightCalls} times`);
    assert.strictEqual(together[0].value, 'once');
    assert.strictEqual(together[1].value, 'once');
  });

  await cache.through('smoke:expiring', 1, async () => 'briefly');
  await new Promise((r) => setTimeout(r, 40));
  await cache.through('smoke:sweeper', 60000, async () => 'anything');
  check('an entry past its retention is swept rather than kept for ever', () => {
    assert.strictEqual(cache.has('smoke:expiring'), false, 'an expired entry survived a later miss');
    assert.strictEqual(cache.has('smoke:sweeper'), true);
  });

  const overflow = cache.MAX_ENTRIES + 50;
  for (let i = 0; i < overflow; i += 1) {
    await cache.through('smoke:bound:' + i, 60000, async () => i);
  }
  check('distinct keys from a query string cannot grow the cache without bound', () => {
    assert.ok(cache.size() <= cache.MAX_ENTRIES,
      `${cache.size()} entries against a cap of ${cache.MAX_ENTRIES}`);
  });
  check('eviction takes the least recently used entry first', () => {
    assert.strictEqual(cache.has('smoke:bound:0'), false, 'the oldest key survived eviction');
    assert.strictEqual(cache.has('smoke:bound:' + (overflow - 1)), true, 'the newest key was evicted');
  });

  server.close();
  natsStub.close();

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
