'use strict';

const http = require('http');
const net = require('net');
const assert = require('assert');
const { listen, freePort, checker, report, sleep } = require('./helpers');

const { results, check } = checker();

const GARNET_PASSWORD = 'garnet-stub-password-0001';

const garnetState = { acceptPassword: GARNET_PASSWORD, commands: [] };

function respBulk(text) {
  if (text === null) return '$-1\r\n';
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
}

function respArray(items) {
  return `*${items.length}\r\n` + items.map((i) => respBulk(i)).join('');
}

function parseCommands(buffer) {
  const commands = [];
  let at = 0;
  for (;;) {
    if (at >= buffer.length || buffer[at] !== 0x2a) break;
    const headEnd = buffer.indexOf('\r\n', at);
    if (headEnd < 0) break;
    const count = Number(buffer.toString('utf8', at + 1, headEnd));
    let cursor = headEnd + 2;
    const args = [];
    let complete = true;
    for (let i = 0; i < count; i += 1) {
      const lenEnd = buffer.indexOf('\r\n', cursor);
      if (lenEnd < 0) { complete = false; break; }
      const len = Number(buffer.toString('utf8', cursor + 1, lenEnd));
      if (lenEnd + 2 + len + 2 > buffer.length) { complete = false; break; }
      args.push(buffer.toString('utf8', lenEnd + 2, lenEnd + 2 + len));
      cursor = lenEnd + 2 + len + 2;
    }
    if (!complete) break;
    commands.push(args);
    at = cursor;
  }
  return { commands, rest: buffer.subarray(at) };
}

const INFO_TEXT = [
  '# Server', 'garnet_version:1.0.99', 'uptime_in_seconds:42', 'tcp_port:6379',
  '# Clients', 'connected_clients:1',
  '# Stats', 'total_commands_processed:10', 'instantaneous_ops_per_sec:3', ''
].join('\r\n');

function answer(args, session) {
  const name = String(args[0] || '').toUpperCase();
  const sub = String(args[1] || '').toUpperCase();
  garnetState.commands.push(name + (sub ? ' ' + sub : ''));
  if (name === 'QUIT') return '+OK\r\n';
  if (name === 'AUTH') {
    if (args[2] === garnetState.acceptPassword) { session.authed = true; return '+OK\r\n'; }
    return '-WRONGPASS invalid username-password pair or user is disabled.\r\n';
  }
  if (!session.authed) return '-NOAUTH Authentication required.\r\n';
  if (name === 'PING') return '+PONG\r\n';
  if (name === 'INFO') return respBulk(INFO_TEXT);
  if (name === 'ACL' && sub === 'WHOAMI') return respBulk('console');
  if (name === 'TIME') return respArray([String(Math.floor(Date.now() / 1000)), '0']);
  if (name === 'CONFIG' && sub === 'GET') {
    const key = String(args[2] || '').toLowerCase();
    return respArray([key, key === 'maxclients' ? '256' : '0']);
  }
  if (name === 'CLIENT' && sub === 'LIST') {
    return respBulk('id=7 addr=127.0.0.1:50000 name= user=console db=0 age=1 idle=0 cmd=client|list resp=2\n');
  }
  if (name === 'DBSIZE') return ':42\r\n';
  return `-ERR unknown command '${name}'\r\n`;
}

const garnetStub = net.createServer((socket) => {
  const session = { authed: false };
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const parsed = parseCommands(buffered);
    buffered = parsed.rest;
    for (const args of parsed.commands) socket.write(answer(args, session));
  });
  socket.on('error', () => {});
});

const baoState = { sealed: false, json: true };

const baoStub = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (!baoState.json) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html>not a vault</html>');
  }
  let status = 200;
  let body;
  if (url === '/v1/sys/health') {
    status = baoState.sealed ? 503 : 200;
    body = {
      initialized: true, sealed: baoState.sealed, standby: false, version: '2.9.9',
      cluster_name: 'argus-stub', server_time_utc: Math.floor(Date.now() / 1000)
    };
  } else if (url === '/v1/sys/seal-status') {
    body = { type: 'shamir', initialized: true, sealed: baoState.sealed, t: 1, n: 1, progress: 0, version: '2.9.9' };
  } else if (url === '/v1/sys/leader') {
    body = { ha_enabled: false, is_self: true, leader_address: '' };
  } else {
    status = 404;
    body = { errors: [] };
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
});

function fakeRequest(host, localPort, extra) {
  return { headers: host === undefined ? {} : { host }, socket: { localPort, encrypted: false }, ...(extra || {}) };
}

(async () => {
  const garnetPort = await listen(garnetStub);
  const baoPort = await listen(baoStub);
  const deadPort = await freePort();

  process.env.ARGUS_AUTH = 'off';
  process.env.ARGUS_HOST = '127.0.0.1';
  process.env.ARGUS_PORT = '8787';
  process.env.ARGUS_LOG_LEVEL = 'error';
  process.env.ARGUS_HEARTBEAT_INTERVAL_MS = '3600000';
  process.env.ARGUS_GARNET_HOST = '127.0.0.1';
  process.env.ARGUS_GARNET_PORT = String(garnetPort);
  process.env.ARGUS_GARNET_PASSWORD = GARNET_PASSWORD;
  process.env.ARGUS_GARNET_TIMEOUT_MS = '2000';
  process.env.ARGUS_OPENBAO_ADDR = `http://127.0.0.1:${baoPort}`;
  process.env.ARGUS_UNSEAL_MODE = 'ceremony';

  const errors = require('../src/errors.js');
  const reader = require('../src/reader.js');
  const cache = require('../src/cache.js');
  const authorize = require('../src/auth/authorize.js');
  const hosts = require('../src/auth/hosts.js');
  const scrape = require('../src/auth/scrape.js');
  const garnet = require('../src/garnet.js');
  const secrets = require('../src/secrets.js');
  const audit = require('../src/auth/audit.js');
  audit.setSink(() => {});
  const { routes } = require('../src/index.js');

  check('the error envelope always carries ok, error, reason and message', () => {
    const body = errors.envelope('not-found', 'There is nothing here.', { path: '/x' });
    assert.deepStrictEqual(body, { ok: false, error: 'not-found', reason: 'not-found', message: 'There is nothing here.', path: '/x' });
    const role = errors.envelope('forbidden', 'No.', { reason: 'role' });
    assert.strictEqual(role.error, 'forbidden');
    assert.strictEqual(role.reason, 'role');
  });
  check('errors map to a status by name, by explicit status, or to a generic 500', () => {
    const validation = errors.describeError(Object.assign(new Error('bad'), { name: 'ValidationError' }));
    assert.deepStrictEqual([validation.status, validation.reason], [400, 'invalid-request']);
    const notFound = errors.describeError(Object.assign(new Error('gone'), { name: 'NotFound' }));
    assert.deepStrictEqual([notFound.status, notFound.reason], [404, 'not-found']);
    const explicit = errors.describeError(errors.httpError(409, 'conflict', 'Already there.'));
    assert.deepStrictEqual([explicit.status, explicit.reason], [409, 'conflict']);
    const unknown = errors.describeError(new Error('ECONNRESET at 10.0.0.5 with a stack'));
    assert.strictEqual(unknown.status, 500);
    assert.ok(!unknown.message.includes('10.0.0.5'), 'an internal error message reached the caller');
  });
  check('a module classifier decides the status only for its own errors', () => {
    const storageLike = errors.classifiedAs((err) => ({ reason: /NoSuchKey/.test(err.name) ? 'not-found' : 'error', message: 'x' }));
    assert.throws(() => storageLike(Object.assign(new Error('k'), { name: 'NoSuchKey' })), (err) => err.status === 404);
    assert.throws(() => storageLike(Object.assign(new Error('v'), { name: 'ValidationError' })), (err) => err.name === 'ValidationError');
    assert.throws(() => storageLike(new Error('odd')), (err) => err.status === undefined);
    assert.strictEqual(errors.levelFor(404), 'info');
    assert.strictEqual(errors.levelFor(503), 'error');
  });

  let calls = 0;
  const flaky = reader.guarded('units:flaky', 1, async () => {
    calls += 1;
    if (calls > 1) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    return { value: 7 };
  });
  const fresh = await flaky();
  await sleep(10);
  const stale = await flaky();
  check('a shared reader serves a stale value with the reason it is stale', () => {
    assert.strictEqual(fresh.ok, true);
    assert.strictEqual(fresh.staleBecause, undefined);
    assert.strictEqual(stale.ok, true);
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.value, 7);
    assert.strictEqual(stale.staleBecause.reason, 'unreachable');
  });
  const prechecked = await reader.guarded('units:pre', 1000, async () => ({ value: 1 }),
    { precheck: () => ({ reason: 'not-configured', message: 'Set ARGUS_UNITS to use this.' }) })();
  check('a reader precheck answers without calling the producer', () => {
    assert.deepStrictEqual(prechecked, { ok: false, reason: 'not-configured', message: 'Set ARGUS_UNITS to use this.' });
  });
  check('the base classifier names the common network failures', () => {
    assert.strictEqual(reader.baseClassify(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).reason, 'unreachable');
    assert.strictEqual(reader.baseClassify(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).reason, 'timeout');
    assert.strictEqual(reader.baseClassify(Object.assign(new Error('x'), { name: 'NotConfigured' })).reason, 'not-configured');
    const extended = reader.extend((err) => (err.code === 'EVENDOR' ? { reason: 'vendor', message: 'v' } : null));
    assert.strictEqual(extended(Object.assign(new Error('x'), { code: 'EVENDOR' })).reason, 'vendor');
    assert.strictEqual(extended(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).reason, 'unreachable');
  });

  check('roles form tiers, and a record with no recognised role is a viewer', () => {
    assert.strictEqual(authorize.tierOf([]), 'viewer');
    assert.strictEqual(authorize.tierOf(undefined), 'viewer');
    assert.strictEqual(authorize.tierOf(['tier-1']), 'viewer');
    assert.strictEqual(authorize.tierOf(['operator', 'tier-1']), 'operator');
    assert.strictEqual(authorize.tierOf(['security']), 'security');
    assert.strictEqual(authorize.tierOf(['viewer', 'ADMIN']), 'admin');
  });
  check('each tier reads its own routes and nothing above them', () => {
    const p = (roles) => ({ roles });
    assert.strictEqual(authorize.decide(p([]), '/api/heartbeats/stream').allowed, true);
    assert.strictEqual(authorize.decide(p([]), '/api/storage/objects').allowed, false);
    assert.strictEqual(authorize.decide(p(['operator']), '/api/storage/preview').allowed, true);
    assert.strictEqual(authorize.decide(p(['operator']), '/api/audit/recent').allowed, false);
    assert.strictEqual(authorize.decide(p(['security']), '/api/identity/principals').allowed, true);
    assert.strictEqual(authorize.decide(p(['security']), '/api/aws/cost').allowed, false);
    assert.strictEqual(authorize.decide(p(['admin']), '/api/aws/cost').allowed, true);
    assert.strictEqual(authorize.decide(p(['admin']), '/api/anything-new').allowed, true);
    assert.strictEqual(authorize.decide(p(['security']), '/api/anything-new').allowed, false);
  });
  check('every API route has a role on purpose: mapped, or one of the admin-only routes', () => {
    const ADMIN_ONLY = new Set(['/api/aws/identity', '/api/aws/instances', '/api/aws/buckets', '/api/aws/databases',
      '/api/aws/alarms', '/api/aws/cost', '/api/overview']);
    for (const key of Object.keys(routes)) {
      const route = key.split(' ')[1];
      if (!route.startsWith('/api/')) continue;
      assert.ok(authorize.ROUTE_ROLES[route] || ADMIN_ONLY.has(route), `${route} has no role and is not listed as admin-only`);
    }
    for (const route of Object.keys(authorize.ROUTE_ROLES)) {
      assert.ok(routes['GET ' + route], `${route} is in the role map but is not a route`);
    }
  });

  check('a Host header is parsed into a name and an optional port, and junk is refused', () => {
    assert.deepStrictEqual(hosts.parseHost('LocalHost:8787'), { name: 'localhost', port: 8787 });
    assert.deepStrictEqual(hosts.parseHost('[::1]:9000'), { name: '[::1]', port: 9000 });
    assert.deepStrictEqual(hosts.parseHost('console.example.test'), { name: 'console.example.test', port: null });
    for (const bad of ['', 'a:b', 'x:99999', 'user@host', '[::1', 'a b']) assert.strictEqual(hosts.parseHost(bad), null, bad);
  });
  check('loopback names are answered only on the bound port', () => {
    assert.strictEqual(hosts.check(fakeRequest('127.0.0.1:4100', 4100)).allowed, true);
    assert.strictEqual(hosts.check(fakeRequest('[::1]:4100', 4100)).allowed, true);
    assert.strictEqual(hosts.check(fakeRequest('localhost:8787', 4100)).allowed, true, 'the configured port');
    assert.strictEqual(hosts.check(fakeRequest('localhost:4101', 4100)).allowed, false);
    assert.strictEqual(hosts.check(fakeRequest('127.0.0.2:4100', 4100)).allowed, false);
    assert.strictEqual(hosts.check(fakeRequest(undefined, 4100)).allowed, false);
    assert.strictEqual(hosts.check(fakeRequest('rebound.example.test:4100', 4100)).reason, 'host-not-loopback');
  });

  const openNonLoopback = scrape.createGate({ token: '', bindIsLoopback: false });
  const openLoopback = scrape.createGate({ token: '', bindIsLoopback: true });
  const tokened = scrape.createGate({ token: 't'.repeat(32), bindIsLoopback: false });
  const broken = scrape.createGate({ token: '', problem: '/run/secrets/x could not be read (ENOENT)', bindIsLoopback: true });
  check('metrics are public without a token only on a loopback bind', () => {
    assert.strictEqual(openLoopback.decide(undefined).allowed, true);
    assert.strictEqual(openNonLoopback.decide(undefined).allowed, false);
    assert.match(openNonLoopback.bootNote(), /closed/);
    assert.match(openLoopback.bootNote(), /public/);
  });
  check('a metrics token is compared as a bearer token, and an unusable token file closes the endpoint', () => {
    assert.strictEqual(tokened.decide('Bearer ' + 't'.repeat(32)).allowed, true);
    assert.strictEqual(tokened.decide('bearer ' + 't'.repeat(32)).allowed, true);
    assert.strictEqual(tokened.decide('Bearer ' + 't'.repeat(31)).allowed, false);
    assert.strictEqual(tokened.decide('Basic ' + 't'.repeat(32)).allowed, false);
    assert.strictEqual(tokened.decide(undefined).allowed, false);
    assert.strictEqual(broken.decide('Bearer anything').allowed, false);
    assert.match(broken.bootNote(), /refuses every scrape/);
  });

  const cacheHealth = await garnet.health();
  const cacheKeys = await garnet.keyspace();
  const cacheClients = await garnet.clients();
  const cacheServer = await garnet.serverInfo();
  check('the cache reader authenticates over RESP and reads what the stub serves', () => {
    assert.strictEqual(cacheHealth.ok, true, JSON.stringify(cacheHealth).slice(0, 300));
    assert.strictEqual(cacheHealth.authRequired, true, cacheHealth.authProbe);
    assert.strictEqual(cacheHealth.version, '1.0.99');
    assert.strictEqual(cacheHealth.uptimeSeconds, 42);
    assert.strictEqual(cacheKeys.keys, 42);
    assert.strictEqual(cacheClients.count, 1);
    assert.strictEqual(cacheClients.limit, 256);
    assert.strictEqual(cacheServer.ok, true);
  });
  check('the cache reader never runs a command its credential should not hold', () => {
    for (const forbidden of ['KEYS', 'SCAN', 'GET', 'FLUSHALL', 'ACL LIST']) {
      assert.ok(!garnetState.commands.includes(forbidden), `${forbidden} was sent`);
    }
  });

  cache.clear();
  garnetState.acceptPassword = 'some-other-password';
  const refusedCache = await garnet.serverInfo();
  check('a refused cache credential is reported as denied with the fix', () => {
    assert.strictEqual(refusedCache.ok, false);
    assert.strictEqual(refusedCache.reason, 'denied');
    assert.match(refusedCache.message, /ARGUS_GARNET_PASSWORD/);
  });

  const vault = await secrets.health();
  const vaultSeal = await secrets.sealStatus();
  check('the vault reader reads an unsealed OpenBao as unsealed and usable', () => {
    assert.strictEqual(vault.ok, true, JSON.stringify(vault).slice(0, 300));
    assert.strictEqual(vault.state, 'unsealed');
    assert.strictEqual(vault.usable, true);
    assert.strictEqual(vault.version, '2.9.9');
    assert.strictEqual(vaultSeal.seal.shares, 1);
    assert.strictEqual(vaultSeal.seal.threshold, 1);
  });

  cache.clear();
  baoState.sealed = true;
  const sealedVault = await secrets.health();
  check('a sealed OpenBao is reported as sealed, not as down', () => {
    assert.strictEqual(sealedVault.ok, true);
    assert.strictEqual(sealedVault.state, 'sealed');
    assert.strictEqual(sealedVault.usable, false);
    assert.strictEqual(sealedVault.reachable, true);
  });

  cache.clear();
  baoState.json = false;
  const notBao = await secrets.health();
  check('something that is not OpenBao at the address is named as such', () => {
    assert.strictEqual(notBao.reachable, false);
    assert.strictEqual(notBao.reason, 'not-openbao');
  });

  cache.clear();
  process.env.ARGUS_OPENBAO_ADDR = `http://127.0.0.1:${deadPort}`;
  process.env.ARGUS_GARNET_PORT = String(deadPort);
  delete require.cache[require.resolve('../src/secrets.js')];
  delete require.cache[require.resolve('../src/garnet.js')];
  const deadSecrets = require('../src/secrets.js');
  const deadGarnet = require('../src/garnet.js');
  const deadVault = await deadSecrets.health();
  const deadCache = await deadGarnet.serverInfo();
  check('a vault and a cache that nothing answers for are unreachable, with a next step', () => {
    assert.strictEqual(deadVault.reachable, false);
    assert.strictEqual(deadVault.state, 'unreachable');
    assert.strictEqual(deadCache.ok, false);
    assert.strictEqual(deadCache.reason, 'unreachable');
    assert.match(deadCache.message, /docker compose/);
  });

  garnetStub.close();
  baoStub.close();
  process.exit(report(results));
})().catch((err) => {
  console.error('units harness failed:', err);
  process.exit(1);
});
