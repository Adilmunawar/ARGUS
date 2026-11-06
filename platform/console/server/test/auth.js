'use strict';

const http = require('http');
const assert = require('assert');
const { report, freePort } = require('./helpers');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ARGUS_AUTH_SCRYPT_COST = '16384';
process.env.ARGUS_AUTH_SCRYPT_PARALLELISM = '1';
process.env.ARGUS_AUTH_SCRYPT_MAXMEM = String(64 * 1024 * 1024);

const hash = require('../src/auth/hash.js');

const SERVER = path.resolve(__dirname, '..', 'src', 'index.js');

const PASSWORD = 'correct-horse-battery-staple-7761';
const WRONG_PASSWORD = 'not-the-password-at-all-0000';
const SUBJECT = 'adil';
const PROXY_SECRET = 'f'.repeat(64);

const SCRYPT_ENV = {
  ARGUS_AUTH_SCRYPT_COST: '16384',
  ARGUS_AUTH_SCRYPT_PARALLELISM: '1',
  ARGUS_AUTH_SCRYPT_MAXMEM: String(64 * 1024 * 1024)
};

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: err.message }); }
};

const spawned = [];

async function launch(envOrFn) {
  const port = await freePort();
  const env = typeof envOrFn === 'function' ? envOrFn(port) : envOrFn;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      ...SCRYPT_ENV,
      ARGUS_PORT: String(port),
      ARGUS_HOST: '127.0.0.1',
      ARGUS_LOG_LEVEL: 'error',
      ARGUS_HEARTBEAT_INTERVAL_MS: '3600000',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_PROFILE: '__argus_auth_no_such_profile__',
      AWS_EC2_METADATA_DISABLED: 'true',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const server = { port, child, out: '', err: '', exitCode: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { server.out += d; });
  child.stderr.on('data', (d) => { server.err += d; });
  child.on('exit', (code) => { server.exitCode = code; });
  spawned.push(server);
  return server;
}

function auditLines(server) {
  return server.out.split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => { try { return JSON.parse(line); } catch (err) { return null; } })
    .filter((record) => record && record.stream === 'argus.console.audit');
}

function auditEvents(server) {
  return auditLines(server).map((record) => record.event);
}

async function waitForAudit(server, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000);
  while (Date.now() < deadline) {
    if (auditLines(server).some(predicate)) return true;
    await sleep(50);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function call(server, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? null : opts.body;
    const requestHeaders = { 'sec-fetch-site': 'same-origin', ...(opts.headers || {}) };
    for (const name of Object.keys(requestHeaders)) {
      if (requestHeaders[name] === null) delete requestHeaders[name];
    }
    if (body !== null && requestHeaders['content-length'] === undefined) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: opts.path || '/api/health',
      method: opts.method || 'GET',
      headers: requestHeaders
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function rawRequest(server, text) {
  return new Promise((resolve, reject) => {
    const socket = require('net').createConnection({ host: '127.0.0.1', port: server.port }, () => socket.write(text));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { received += d; });
    socket.on('end', () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(received);
      resolve({ status: m ? Number(m[1]) : 0, headers: {}, body: received.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
    });
    socket.on('error', reject);
  });
}

function openStream(server, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.port,
      path: requestPath,
      method: 'GET',
      headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', ...(headers || {}) }
    }, (res) => {
      let markEnded;
      const stream = {
        status: res.statusCode,
        headers: res.headers,
        text: '',
        ended: new Promise((r) => { markEnded = r; }),
        close() { req.destroy(); },
        until(predicate, timeoutMs) {
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error('the stream never matched')), timeoutMs || 4000);
            const tick = () => {
              if (predicate(stream.text)) { clearTimeout(timer); res.removeListener('data', tick); done(stream.text); }
            };
            res.on('data', tick);
            tick();
          });
        }
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => { stream.text += chunk; });
      res.on('end', () => markEnded());
      res.on('close', () => markEnded());
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}

function login(server, subject, password, extraHeaders) {
  return call(server, {
    method: 'POST',
    path: '/api/auth/login',
    headers: {
      'content-type': 'application/json',
      'x-argus-console': '1',
      ...(extraHeaders || {})
    },
    body: JSON.stringify({ subject, password })
  });
}

function cookieFrom(response) {
  const raw = response.headers['set-cookie'];
  if (!raw || !raw.length) return null;
  const first = raw[raw.length - 1];
  return first.split(';')[0];
}

async function waitForListening(server, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    try {
      const r = await call(server, { path: '/api/health' });
      if (r.status === 200) return true;
    } catch (err) {  }
    await sleep(100);
  }
  return false;
}

function waitForExit(server, timeoutMs) {
  return new Promise((resolve) => {
    if (server.exitCode !== null) return resolve(server.exitCode);
    const timer = setTimeout(() => resolve(server.exitCode), timeoutMs || 15000);
    server.child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function writeOperatorsFile(dir, record, extra) {
  const file = path.join(dir, 'operators.json');
  fs.writeFileSync(file, JSON.stringify({
    operators: [
      { subject: SUBJECT, displayName: 'Adil Munawar', roles: ['admin'], password: record, credentials: [] },
      ...(extra || [])
    ]
  }, null, 2));
  return file;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-auth-'));
  const record = await hash.hash(PASSWORD, {
    cost: 16384, blockSize: 8, parallelism: 1, maxmem: 64 * 1024 * 1024
  });
  const operatorsFile = writeOperatorsFile(dir, record, [
    { subject: 'viewer-op', displayName: 'Viewer', roles: [], password: record, credentials: [] },
    { subject: 'operator-op', displayName: 'Operator', roles: ['operator', 'tier-1'], password: record, credentials: [] },
    { subject: 'security-op', displayName: 'Security', roles: ['security'], password: record, credentials: [] }
  ]);

  const emptyFile = path.join(dir, 'empty.json');
  fs.writeFileSync(emptyFile, JSON.stringify({ operators: [] }));

  const refuseOpen = await launch({ ARGUS_AUTH: 'off', ARGUS_HOST: '0.0.0.0' });
  const refuseOpenCode = await waitForExit(refuseOpen);
  check('auth off on a non-loopback bind refuses to start', () => {
    assert.strictEqual(refuseOpenCode, 1, `exit code ${refuseOpenCode}`);
  });
  check('the refusal names the exposure rather than just failing', () => {
    assert.match(refuseOpen.err, /REFUSING TO START/);
    assert.match(refuseOpen.err, /0\.0\.0\.0/);
    assert.match(refuseOpen.err, /no authentication/i);
    assert.match(refuseOpen.err, /ARGUS_HOST=127\.0\.0\.1/);
  });
  await waitForAudit(refuseOpen, (r) => r.event === 'auth.config.rejected');
  check('the refusal is in the audit stream, not only on stderr', () => {
    assert.ok(auditEvents(refuseOpen).includes('auth.config.rejected'),
      auditEvents(refuseOpen).join(', ') || 'no audit lines');
  });

  const refuseNoOperators = await launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: emptyFile });
  const refuseNoOperatorsCode = await waitForExit(refuseNoOperators);
  check('session mode with no operators refuses to start', () => {
    assert.strictEqual(refuseNoOperatorsCode, 1, `exit code ${refuseNoOperatorsCode}`);
    assert.match(refuseNoOperators.err, /at least one enabled operator/);
  });

  const refuseProxy = await launch({ ARGUS_AUTH: 'proxy' });
  const refuseProxyCode = await waitForExit(refuseProxy);
  check('proxy mode without a trusted peer list and secret refuses to start', () => {
    assert.strictEqual(refuseProxyCode, 1, `exit code ${refuseProxyCode}`);
    assert.match(refuseProxy.err, /ARGUS_AUTH_TRUSTED_PROXY_CIDRS/);
    assert.match(refuseProxy.err, /ARGUS_AUTH_PROXY_SHARED_SECRET/);
  });

  const refuseBadMode = await launch({ ARGUS_AUTH: 'yes-please' });
  const refuseBadModeCode = await waitForExit(refuseBadMode);
  check('an unrecognised auth mode refuses to start rather than guessing', () => {
    assert.strictEqual(refuseBadModeCode, 1, `exit code ${refuseBadModeCode}`);
  });

  const allowLoopbackOff = await launch({ ARGUS_AUTH: 'off' });
  const loopbackOffUp = await waitForListening(allowLoopbackOff);
  check('auth off on loopback still starts, so local development is not blocked', () => {
    assert.strictEqual(loopbackOffUp, true, allowLoopbackOff.err.slice(0, 300));
  });
  const disabledBanner = await call(allowLoopbackOff, { path: '/api/capabilities' });
  check('the disabled mode is announced on every response and in capabilities', () => {
    assert.strictEqual(disabledBanner.headers['x-argus-auth'], 'disabled');
    const body = JSON.parse(disabledBanner.body);
    assert.strictEqual(body.auth.mode, 'off');
    assert.strictEqual(body.auth.authenticated, true);
    assert.strictEqual(body.auth.subject, 'local-development');
  });

  const main = await launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile });
  const mainUp = await waitForListening(main);
  check('session mode starts once it has an operator', () => {
    assert.strictEqual(mainUp, true, main.err.slice(0, 400));
  });

  const anonymousActivity = await call(main, { path: '/api/pg/activity' });
  check('an unauthenticated read of live SQL text is refused', () => {
    assert.strictEqual(anonymousActivity.status, 401, `status ${anonymousActivity.status}`);
    const body = JSON.parse(anonymousActivity.body);
    assert.strictEqual(body.queries, undefined);
    assert.strictEqual(body.activity, undefined);
    assert.strictEqual(body.error, 'unauthenticated');
  });

  for (const route of ['/api/host', '/api/storage/buckets', '/api/secrets/seal-status', '/api/pg/roles',
    '/api/cache/clients', '/api/queues/streams', '/api/overview', '/api/storage/preview?bucket=a&key=b',
    '/api/logs/stream?query=%7B%7D', '/api/metrics/series?name=hostCpuBusyRatio', '/api/alerts/active',
    '/api/containers', '/api/heartbeats', '/api/search/index']) {
    const r = await call(main, { path: route });
    check(`${route} is refused without a session`, () => {
      assert.strictEqual(r.status, 401, `status ${r.status}`);
    });
  }

  const anonymousHealth = await call(main, { path: '/api/health' });
  check('the compose healthcheck endpoint stays public', () => {
    assert.strictEqual(anonymousHealth.status, 200);
    assert.strictEqual(JSON.parse(anonymousHealth.body).status, 'ok');
  });
  check('the public health answer does not fingerprint the build', () => {
    assert.strictEqual(JSON.parse(anonymousHealth.body).version, undefined);
  });

  const anonymousCapabilities = await call(main, { path: '/api/capabilities' });
  check('capabilities answers anonymously with a reduced shape', () => {
    assert.strictEqual(anonymousCapabilities.status, 200);
    const body = JSON.parse(anonymousCapabilities.body);
    assert.strictEqual(body.auth.authenticated, false);
    assert.strictEqual(body.auth.mode, 'session');
    assert.strictEqual(body.aws, undefined, 'the AWS block leaked to an anonymous caller');
    assert.strictEqual(body.region, undefined, 'the region leaked to an anonymous caller');
  });

  const anonymousMetrics = await call(main, { path: '/metrics' });
  check('the Prometheus scrape endpoint stays public, because a scraper carries no session', () => {
    assert.strictEqual(anonymousMetrics.status, 200, `status ${anonymousMetrics.status}`);
    assert.match(String(anonymousMetrics.headers['content-type']), /^text\/plain; version=0\.0\.4/);
    assert.match(anonymousMetrics.body, /# TYPE argus_console_requests_total counter/);
  });
  check('the public exposition does not fingerprint the build either', () => {
    assert.ok(!anonymousMetrics.body.includes('argus_console_build_info'),
      'an anonymous scrape can read the build version that /api/health withholds');
  });

  const crossSiteLogin = await login(main, SUBJECT, PASSWORD, { 'sec-fetch-site': 'cross-site' });
  check('a cross-site sign-in is refused before the password is read', () => {
    assert.strictEqual(crossSiteLogin.status, 403, `status ${crossSiteLogin.status}`);
    assert.strictEqual(JSON.parse(crossSiteLogin.body).error, 'cross-site');
  });
  await waitForAudit(main, (r) => r.event === 'auth.csrf.rejected');
  check('the cross-site refusal is audited', () => {
    assert.ok(auditEvents(main).includes('auth.csrf.rejected'), auditEvents(main).join(', '));
  });

  const formLogin = await call(main, {
    method: 'POST',
    path: '/api/auth/login',
    headers: { 'content-type': 'text/plain', 'x-argus-console': '1' },
    body: JSON.stringify({ subject: SUBJECT, password: PASSWORD })
  });
  check('a sign-in with a form content type is refused', () => {
    assert.strictEqual(formLogin.status, 403, `status ${formLogin.status}`);
  });

  const headerlessLogin = await call(main, {
    method: 'POST',
    path: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: SUBJECT, password: PASSWORD })
  });
  check('a sign-in without the console custom header is refused', () => {
    assert.strictEqual(headerlessLogin.status, 403, `status ${headerlessLogin.status}`);
  });

  const wrongPassword = await login(main, SUBJECT, WRONG_PASSWORD);
  const unknownSubject = await login(main, 'nobody-by-that-name', PASSWORD);
  check('a wrong password is refused', () => assert.strictEqual(wrongPassword.status, 401));
  check('an unknown operator name and a wrong password are indistinguishable', () => {
    assert.strictEqual(wrongPassword.status, unknownSubject.status);
    assert.strictEqual(wrongPassword.body, unknownSubject.body);
  });

  const good = await login(main, SUBJECT, PASSWORD);
  check('correct credentials mint a session', () => {
    assert.strictEqual(good.status, 204, `status ${good.status} ${good.body}`);
  });
  check('the session cookie is HttpOnly, SameSite=Strict and path-scoped', () => {
    const raw = (good.headers['set-cookie'] || [])[0] || '';
    assert.match(raw, /^argus_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/, raw);
  });
  await waitForAudit(main, (r) => r.event === 'auth.login.succeeded');
  check('the sign-in is audited without the credential', () => {
    const line = auditLines(main).find((r) => r.event === 'auth.login.succeeded');
    assert.ok(line, 'no auth.login.succeeded line');
    assert.strictEqual(line.subject, SUBJECT);
    assert.ok(line.sessionRef && line.sessionRef.length === 8, 'no truncated session reference');
  });

  const cookie = cookieFrom(good);

  const authorised = await call(main, { path: '/api/pg/activity', headers: { cookie } });
  check('the session opens the routes it was refused without one', () => {
    assert.notStrictEqual(authorised.status, 401, 'still unauthenticated with a valid cookie');
    assert.strictEqual(authorised.status, 200, `status ${authorised.status}`);
  });

  const whoami = await call(main, { path: '/api/auth/session', headers: { cookie } });
  check('the session endpoint names the operator and when the session dies', () => {
    assert.strictEqual(whoami.status, 200);
    const body = JSON.parse(whoami.body);
    assert.strictEqual(body.subject, SUBJECT);
    assert.deepStrictEqual(body.roles, ['admin']);
    assert.ok(Date.parse(body.expiresAt) > Date.now());
    assert.ok(Date.parse(body.idleExpiresAt) > Date.now());
  });

  const authenticatedCapabilities = await call(main, { path: '/api/capabilities', headers: { cookie } });
  check('capabilities grows its full shape once authenticated', () => {
    const body = JSON.parse(authenticatedCapabilities.body);
    assert.strictEqual(body.auth.authenticated, true);
    assert.strictEqual(body.auth.subject, SUBJECT);
    assert.ok(body.aws, 'the AWS block is missing for an authenticated caller');
    assert.ok(body.streams, 'the stream inventory is missing');
  });

  const strippedSignals = await call(main, {
    path: '/api/host',
    headers: { cookie, 'sec-fetch-site': null }
  });
  check('a cookie arriving with no origin signal at all is refused, not trusted', () => {
    assert.strictEqual(strippedSignals.status, 403, `status ${strippedSignals.status}`);
  });

  const foreignOrigin = await call(main, {
    path: '/api/host',
    headers: { cookie, 'sec-fetch-site': null, origin: 'http://argus.local.evil.com' }
  });
  check('an origin that merely starts with the target origin does not match it', () => {
    assert.strictEqual(foreignOrigin.status, 403, `status ${foreignOrigin.status}`);
  });

  const forged = await call(main, { path: '/api/host', headers: { cookie: 'argus_sid=' + 'A'.repeat(43) } });
  check('a forged session id is refused and the cookie is cleared', () => {
    assert.strictEqual(forged.status, 401);
    assert.match(String((forged.headers['set-cookie'] || [])[0] || ''), /Max-Age=0/);
  });

  const lockoutTarget = 'adil';
  const attempts = [];
  for (let i = 0; i < 6; i += 1) {
    attempts.push(await login(main, lockoutTarget, WRONG_PASSWORD));
  }
  check('six wrong passwords are all refused with the same generic answer', () => {
    for (const [i, r] of attempts.entries()) {
      assert.strictEqual(r.status, 401, `attempt ${i + 1} answered ${r.status}`);
      assert.strictEqual(JSON.parse(r.body).error, 'invalid-credentials');
    }
  });
  await waitForAudit(main, (r) => r.event === 'auth.account.locked');
  check('the account lockout is audited but never revealed to the caller', () => {
    assert.ok(auditEvents(main).includes('auth.account.locked'), auditEvents(main).join(', '));
    for (const r of attempts) assert.notStrictEqual(r.status, 429, 'a 429 told the caller this account exists');
  });

  const throttled = await login(main, lockoutTarget, WRONG_PASSWORD);
  check('past the threshold the source is throttled with a Retry-After', () => {
    assert.strictEqual(throttled.status, 429, `status ${throttled.status}`);
    const retry = Number(throttled.headers['retry-after']);
    assert.ok(Number.isInteger(retry) && retry > 0, `retry-after ${throttled.headers['retry-after']}`);
  });
  await waitForAudit(main, (r) => r.event === 'auth.login.throttled');
  check('the throttle is audited', () => {
    assert.ok(auditEvents(main).includes('auth.login.throttled'), auditEvents(main).join(', '));
  });

  const lockedOutCorrectPassword = await login(main, lockoutTarget, PASSWORD);
  check('the correct password does not walk past an active lockout', () => {
    assert.ok(lockedOutCorrectPassword.status === 429 || lockedOutCorrectPassword.status === 401,
      `status ${lockedOutCorrectPassword.status}`);
  });

  const logout = await call(main, {
    method: 'POST',
    path: '/api/auth/logout',
    headers: { cookie, 'content-type': 'application/json', 'x-argus-console': '1' },
    body: '{}'
  });
  check('signing out clears the cookie and the client-side state', () => {
    assert.strictEqual(logout.status, 204, `status ${logout.status}`);
    assert.match(String((logout.headers['set-cookie'] || [])[0] || ''), /Max-Age=0/);
    assert.strictEqual(logout.headers['clear-site-data'], '"cache", "cookies", "storage"');
  });

  const afterLogout = await call(main, { path: '/api/host', headers: { cookie } });
  check('the token is dead the moment it is signed out, not when it expires', () => {
    assert.strictEqual(afterLogout.status, 401, `status ${afterLogout.status}`);
  });
  await waitForAudit(main, (r) => r.event === 'auth.logout');
  check('the sign-out is audited', () => {
    assert.ok(auditEvents(main).includes('auth.logout'), auditEvents(main).join(', '));
  });

  const REQUIRED_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy',
    'cross-origin-resource-policy', 'cross-origin-opener-policy', 'x-frame-options',
    'x-permitted-cross-domain-policies', 'permissions-policy', 'vary'];

  const matrix = await launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile });
  await waitForListening(matrix);
  const matrixCookie = cookieFrom(await login(matrix, SUBJECT, PASSWORD));

  const responses = {
    200: await call(matrix, { path: '/api/health' }),
    401: await call(matrix, { path: '/api/host' }),
    403: await call(matrix, { path: '/api/host', headers: { 'sec-fetch-site': 'cross-site' } }),
    404: await call(matrix, { path: '/api/no-such-endpoint', headers: { cookie: matrixCookie } }),
    405: await call(matrix, {
      method: 'DELETE',
      path: '/api/host',
      headers: { cookie: matrixCookie, 'content-type': 'application/json', 'x-argus-console': '1' }
    }),
    400: await call(matrix, { path: '/api/logs/query', headers: { cookie: matrixCookie } })
  };

  for (const [expected, response] of Object.entries(responses)) {
    check(`a ${expected} response still carries every security header`, () => {
      assert.strictEqual(response.status, Number(expected), `status ${response.status}`);
      for (const name of REQUIRED_HEADERS) {
        assert.ok(response.headers[name], `${name} missing from the ${expected}`);
      }
    });
  }

  check('the baseline content security policy denies everything it does not name', () => {
    assert.match(responses[200].headers['content-security-policy'], /default-src 'none'/);
    assert.match(responses[200].headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(responses[200].headers['content-security-policy'], /form-action 'none'/);
  });
  check('responses vary on the headers the origin decision reads', () => {
    assert.match(responses[200].headers.vary, /Sec-Fetch-Site/);
    assert.match(responses[200].headers.vary, /Origin/);
    assert.match(responses[200].headers.vary, /Cookie/);
  });
  check('no response advertises the server or the framework', () => {
    for (const response of Object.values(responses)) {
      assert.strictEqual(response.headers.server, undefined);
      assert.strictEqual(response.headers['x-powered-by'], undefined);
    }
  });
  check('a plain-http deployment is not sent an HSTS policy it cannot honour', () => {
    assert.strictEqual(responses[200].headers['strict-transport-security'], undefined);
  });
  check('every response carries a request id an operator can quote', () => {
    assert.match(responses[404].headers['x-argus-request-id'] || '', /^[0-9a-f-]{36}$/);
  });

  const staticPage = await call(main, { path: '/index.html' });
  check('the console itself stays public so the sign-in screen can load', () => {
    assert.strictEqual(staticPage.status, 200, `status ${staticPage.status}`);
  });

  check('no audit line ever carries a credential, a token or a cookie', () => {
    const text = JSON.stringify(auditLines(main));
    assert.strictEqual(text.includes(PASSWORD), false, 'the password reached the audit stream');
    assert.strictEqual(text.includes(WRONG_PASSWORD), false, 'a guessed password reached the audit stream');
    assert.strictEqual(text.includes(cookie.split('=')[1]), false, 'the session token reached the audit stream');
    assert.strictEqual(/"cookie"/i.test(text), false, 'a cookie header reached the audit stream');
  });
  check('no line of ordinary server output carries a credential either', () => {
    assert.strictEqual(main.out.includes(PASSWORD), false);
    assert.strictEqual(main.out.includes(cookie.split('=')[1]), false);
    assert.strictEqual(main.err.includes(PASSWORD), false);
  });

  const secure = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_AUTH_SECURE_COOKIES: '1'
  });
  await waitForListening(secure);
  const secureLogin = await login(secure, SUBJECT, PASSWORD);
  check('a secure deployment gets the __Host- prefixed cookie', () => {
    assert.strictEqual(secureLogin.status, 204, `status ${secureLogin.status} ${secureLogin.body}`);
    const raw = (secureLogin.headers['set-cookie'] || [])[0] || '';
    assert.match(raw, /^__Host-argus_sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/, raw);
  });

  const shortLived = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_AUTH_IDLE_TIMEOUT_MS: '900',
    ARGUS_AUTH_SWEEP_INTERVAL_MS: '600000'
  });
  await waitForListening(shortLived);
  const shortLogin = await login(shortLived, SUBJECT, PASSWORD);
  const shortCookie = cookieFrom(shortLogin);
  const beforeIdle = await call(shortLived, { path: '/api/host', headers: { cookie: shortCookie } });
  await sleep(1200);
  const afterIdle = await call(shortLived, { path: '/api/host', headers: { cookie: shortCookie } });
  check('a session that goes idle past its timeout stops working', () => {
    assert.strictEqual(beforeIdle.status, 200, `before idle: ${beforeIdle.status}`);
    assert.strictEqual(afterIdle.status, 401, `after idle: ${afterIdle.status}`);
  });
  await waitForAudit(shortLived, (r) => r.event === 'auth.session.expired.idle');
  check('the idle expiry is audited by name', () => {
    assert.ok(auditEvents(shortLived).includes('auth.session.expired.idle'), auditEvents(shortLived).join(', '));
  });

  const renewing = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_AUTH_RENEW_MS: '1'
  });
  await waitForListening(renewing);
  const renewLogin = await login(renewing, SUBJECT, PASSWORD);
  const firstCookie = cookieFrom(renewLogin);
  await sleep(20);
  const rotated = await call(renewing, { path: '/api/host', headers: { cookie: firstCookie } });
  const secondCookie = cookieFrom(rotated);
  check('a session past its renewal window is handed a new id', () => {
    assert.strictEqual(rotated.status, 200, `status ${rotated.status}`);
    assert.ok(secondCookie, 'no rotated cookie was issued');
    assert.notStrictEqual(secondCookie, firstCookie, 'the same session id came back');
  });
  const replayed = await call(renewing, { path: '/api/host', headers: { cookie: firstCookie } });
  check('the rotated-away session id is dead, so a stolen one has a short life', () => {
    assert.strictEqual(replayed.status, 401, `status ${replayed.status}`);
  });
  const withRotated = await call(renewing, { path: '/api/host', headers: { cookie: secondCookie } });
  check('the new session id works', () => assert.strictEqual(withRotated.status, 200));
  await waitForAudit(renewing, (r) => r.event === 'auth.session.renewed');
  check('the renewal is audited', () => {
    assert.ok(auditEvents(renewing).includes('auth.session.renewed'), auditEvents(renewing).join(', '));
  });

  const proxied = await launch({
    ARGUS_AUTH: 'proxy',
    ARGUS_AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128',
    ARGUS_AUTH_PROXY_SHARED_SECRET: PROXY_SECRET
  });
  const proxiedUp = await waitForListening(proxied);
  check('proxy mode starts once it knows which peers to trust', () => {
    assert.strictEqual(proxiedUp, true, proxied.err.slice(0, 400));
  });

  const noSecret = await call(proxied, { path: '/api/host', headers: { 'remote-user': 'adil' } });
  check('an identity header without the proof-of-proxy secret is worth nothing', () => {
    assert.strictEqual(noSecret.status, 401, `status ${noSecret.status}`);
  });

  const wrongSecret = await call(proxied, {
    path: '/api/host',
    headers: { 'remote-user': 'adil', 'x-argus-proxy-auth': 'e'.repeat(64) }
  });
  check('a wrong proxy secret is refused', () => {
    assert.strictEqual(wrongSecret.status, 401, `status ${wrongSecret.status}`);
  });

  const joinedIdentity = await call(proxied, {
    path: '/api/host',
    headers: { 'remote-user': 'root, adil', 'x-argus-proxy-auth': PROXY_SECRET }
  });
  await waitForAudit(proxied, (r) => r.reason === 'duplicate-identity-header');
  check('a duplicated identity header is refused rather than silently resolved', () => {
    assert.strictEqual(joinedIdentity.status, 401, `status ${joinedIdentity.status}`);
    const line = auditLines(proxied).find((r) => r.reason === 'duplicate-identity-header');
    assert.ok(line, auditLines(proxied).map((r) => r.reason).join(', '));
  });

  const proxiedOk = await call(proxied, {
    path: '/api/host',
    headers: {
      'remote-user': 'adil',
      'remote-groups': 'platform-admins, oncall',
      'x-argus-proxy-auth': PROXY_SECRET
    }
  });
  check('a request that clears all three proxy gates is admitted', () => {
    assert.strictEqual(proxiedOk.status, 200, `status ${proxiedOk.status}`);
  });

  const proxiedIdentity = await call(proxied, {
    path: '/api/auth/session',
    headers: { 'remote-user': 'adil', 'remote-groups': 'platform-admins', 'x-argus-proxy-auth': PROXY_SECRET }
  });
  check('the proxy identity becomes the console identity, groups and all', () => {
    const body = JSON.parse(proxiedIdentity.body);
    assert.strictEqual(body.subject, 'adil');
    assert.strictEqual(body.source, 'proxy');
    assert.deepStrictEqual(body.roles, ['platform-admins']);
  });

  const proxyLogin = await login(proxied, SUBJECT, PASSWORD);
  check('proxy mode has no sign-in form to attack', () => {
    assert.strictEqual(proxyLogin.status, 404, `status ${proxyLogin.status}`);
  });

  const readOnlyLogin = await login(main, 'someone-else', WRONG_PASSWORD);
  check('signing in is not refused by the read-only gate', () => {
    assert.notStrictEqual(readOnlyLogin.status, 405,
      'the default read-only deployment would be impossible to sign into');
  });

  check('the shipped scrypt parameters need an explicit maxmem, and we pass one', () => {
    const crypto = require('node:crypto');
    const defaults = require('../src/auth/config.js').scrypt;
    assert.throws(() => crypto.scryptSync('a', 'b', 32, {
      N: 65536, r: 8, p: 2
    }), /maxmem|scrypt/i, 'Node accepted OWASP scrypt parameters without maxmem, so this guard is stale');
    assert.strictEqual(Number.isInteger(defaults.maxmem) && defaults.maxmem >= 128 * 65536 * 8, true,
      `configured maxmem ${defaults.maxmem} is below what the default parameters need`);
  });

  check('a password record round-trips and a wrong password does not', async () => {
    assert.ok(hash.parse(record), 'the generated record does not parse');
    assert.strictEqual(hash.parse('scrypt$N=1$only$three'), null);
    assert.strictEqual(hash.parse('argon2id$m=1,t=1,p=1$aaaa$bbbb'), null,
      'an algorithm this Node cannot run was accepted');
  });

  const verified = await hash.verify(PASSWORD, record);
  const refused = await hash.verify(WRONG_PASSWORD, record);
  check('verification accepts the right password and only the right password', () => {
    assert.strictEqual(verified, true);
    assert.strictEqual(refused, false);
  });

  const tiers = await launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile });
  await waitForListening(tiers);

  const forgedHost = await call(tiers, {
    path: '/api/identity/principals',
    headers: { cookie: cookieFrom(await login(tiers, SUBJECT, PASSWORD)), host: `rebound.example.test:${tiers.port}` }
  });
  check('a forged Host with Sec-Fetch-Site same-origin is misdirected, not answered', () => {
    assert.strictEqual(forgedHost.status, 421, `status ${forgedHost.status}`);
    const body = JSON.parse(forgedHost.body);
    assert.strictEqual(body.reason, 'misdirected');
    assert.ok(!forgedHost.body.includes('operators'), 'principal data reached a rebound origin');
  });
  await waitForAudit(tiers, (r) => r.event === 'auth.host.rejected');
  check('the misdirected request is audited', () => {
    assert.ok(auditEvents(tiers).includes('auth.host.rejected'));
  });

  const allowedHosts = await launch((port) => ({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_ALLOWED_HOSTS: `console.example.test:${port}, plain.example.test`,
    ARGUS_AUTH_PUBLIC_ORIGIN: 'https://argus.example.test'
  }));
  await waitForListening(allowedHosts);
  const hostAnswers = {
    listed: await call(allowedHosts, { headers: { host: `console.example.test:${allowedHosts.port}` } }),
    listedWrongPort: await call(allowedHosts, { headers: { host: 'console.example.test:1' } }),
    anyPort: await call(allowedHosts, { headers: { host: 'plain.example.test:4443' } }),
    publicOrigin: await call(allowedHosts, { headers: { host: 'argus.example.test' } }),
    unlisted: await call(allowedHosts, { headers: { host: 'elsewhere.example.test' } }),
    noHost: await rawRequest(allowedHosts, 'GET /api/health HTTP/1.0\r\n\r\n')
  };
  check('ARGUS_ALLOWED_HOSTS and the public origin host are answered', () => {
    assert.strictEqual(hostAnswers.listed.status, 200, `listed ${hostAnswers.listed.status}`);
    assert.strictEqual(hostAnswers.anyPort.status, 200, `any port ${hostAnswers.anyPort.status}`);
    assert.strictEqual(hostAnswers.publicOrigin.status, 200, `public origin ${hostAnswers.publicOrigin.status}`);
  });
  check('a host outside the allow list, or a listed host on another port, is misdirected', () => {
    assert.strictEqual(hostAnswers.listedWrongPort.status, 421, `wrong port ${hostAnswers.listedWrongPort.status}`);
    assert.strictEqual(hostAnswers.unlisted.status, 421, `unlisted ${hostAnswers.unlisted.status}`);
    assert.strictEqual(hostAnswers.noHost.status, 421, `no host ${hostAnswers.noHost.status}`);
  });

  const offWithHosts = await launch({ ARGUS_AUTH: 'off', ARGUS_ALLOWED_HOSTS: 'console.example.test' });
  await waitForListening(offWithHosts);
  const offForeign = await call(offWithHosts, { path: '/api/host', headers: { host: 'console.example.test' } });
  const offLoopback = await call(offWithHosts, { path: '/api/host', headers: { host: `localhost:${offWithHosts.port}` } });
  check('with authentication off only loopback host names are answered, whatever the allow list says', () => {
    assert.strictEqual(offForeign.status, 421, `foreign ${offForeign.status}`);
    assert.strictEqual(offLoopback.status, 200, `loopback ${offLoopback.status}`);
  });

  const tierCookies = {};
  for (const subject of ['viewer-op', 'operator-op', 'security-op', SUBJECT]) {
    const signedIn = await login(tiers, subject, PASSWORD);
    tierCookies[subject] = cookieFrom(signedIn);
  }
  const TIER_ROUTES = [
    ['/api/host', 'viewer'],
    ['/api/heartbeats', 'viewer'],
    ['/api/pg/activity', 'operator'],
    ['/api/logs/labels', 'operator'],
    ['/api/audit/recent', 'security'],
    ['/api/identity/principals', 'security'],
    ['/api/aws/identity', 'admin'],
    ['/api/overview', 'admin']
  ];
  const RANKS = { viewer: 1, operator: 2, security: 3, admin: 4 };
  const HOLDS = { 'viewer-op': 'viewer', 'operator-op': 'operator', 'security-op': 'security', [SUBJECT]: 'admin' };
  for (const [subject, held] of Object.entries(HOLDS)) {
    for (const [route, needed] of TIER_ROUTES) {
      const answer = await call(tiers, { path: route, headers: { cookie: tierCookies[subject] } });
      const expectAllowed = RANKS[held] >= RANKS[needed];
      check(`${held} ${expectAllowed ? 'reads' : 'is refused'} ${route}`, () => {
        if (expectAllowed) {
          assert.strictEqual(answer.status, 200, `status ${answer.status} ${answer.body.slice(0, 120)}`);
        } else {
          assert.strictEqual(answer.status, 403, `status ${answer.status}`);
          const body = JSON.parse(answer.body);
          assert.strictEqual(body.ok, false);
          assert.strictEqual(body.error, 'forbidden');
          assert.strictEqual(body.reason, 'role');
          assert.strictEqual(body.required, needed);
          assert.ok(body.message.includes(needed));
        }
      });
    }
  }
  const viewerSession = JSON.parse((await call(tiers, { path: '/api/auth/session', headers: { cookie: tierCookies['viewer-op'] } })).body);
  check('an operator record with no roles is a viewer', () => {
    assert.deepStrictEqual(viewerSession.roles, []);
    assert.strictEqual(viewerSession.tier, 'viewer');
  });
  const viewerUnknown = await call(tiers, { path: '/api/not-a-route', headers: { cookie: tierCookies['viewer-op'] } });
  const adminUnknown = await call(tiers, { path: '/api/not-a-route', headers: { cookie: tierCookies[SUBJECT] } });
  check('an unmapped API path is denied by default, so a viewer cannot map the API', () => {
    assert.strictEqual(viewerUnknown.status, 403, `viewer ${viewerUnknown.status}`);
    assert.strictEqual(adminUnknown.status, 404, `admin ${adminUnknown.status}`);
  });
  await waitForAudit(tiers, (r) => r.event === 'auth.role.denied');
  check('a role denial is audited with the role it needed', () => {
    const line = auditLines(tiers).find((r) => r.event === 'auth.role.denied');
    assert.ok(line, 'no auth.role.denied line');
    assert.ok(['operator', 'security', 'admin'].includes(line.required));
  });

  const strangerName = 'hunter2-typed-into-the-name-box';
  await login(tiers, strangerName, WRONG_PASSWORD);
  await login(tiers, 'operator-op', WRONG_PASSWORD);
  await waitForAudit(tiers, (r) => r.event === 'auth.login.failed' && r.subject === 'operator-op');
  check('a failed sign-in for a name that is not an operator never logs the name', () => {
    assert.strictEqual(tiers.out.includes(strangerName), false, 'the typed name reached the log');
    const unknown = auditLines(tiers).filter((r) => r.event === 'auth.login.failed' && /^unknown:[0-9a-f]{8}$/.test(String(r.subject)));
    assert.ok(unknown.length >= 1, 'no unknown:<hmac> subject was logged');
  });
  check('a failed sign-in for a known operator still names the operator', () => {
    assert.ok(auditLines(tiers).some((r) => r.event === 'auth.login.failed' && r.subject === 'operator-op'));
  });

  const unauthenticatedHarness = await call(tiers, { path: '/tests/live.js' });
  check('the browser test harness is not served', () => {
    assert.strictEqual(unauthenticatedHarness.status, 404, `status ${unauthenticatedHarness.status}`);
  });

  const twoCookies = await call(tiers, {
    path: '/api/host',
    headers: { cookie: `${tierCookies[SUBJECT]}; argus_sid=${'B'.repeat(43)}` }
  });
  check('two session cookies on one request are refused and cleared', () => {
    assert.strictEqual(twoCookies.status, 401, `status ${twoCookies.status}`);
    assert.strictEqual(JSON.parse(twoCookies.body).reason, 'duplicate-session-cookie');
    assert.match(String((twoCookies.headers['set-cookie'] || [])[0] || ''), /Max-Age=0/);
  });

  for (const [expected, response] of Object.entries(responses)) {
    if (expected === '200') continue;
    check(`a ${expected} carries the one error envelope`, () => {
      const body = JSON.parse(response.body);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(typeof body.reason, 'string');
      assert.strictEqual(typeof body.error, 'string');
      assert.ok(body.message && body.message.length > 10);
    });
  }

  const METRICS_TOKEN = 'm'.repeat(40);
  const metered = await launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile, ARGUS_METRICS_TOKEN: METRICS_TOKEN });
  await waitForListening(metered);
  const scrapeNone = await call(metered, { path: '/metrics' });
  const scrapeWrong = await call(metered, { path: '/metrics', headers: { authorization: 'Bearer ' + 'n'.repeat(40) } });
  const scrapeRight = await call(metered, { path: '/metrics', headers: { authorization: 'Bearer ' + METRICS_TOKEN } });
  check('a metrics token makes /metrics answer only to that bearer token', () => {
    assert.strictEqual(scrapeNone.status, 401, `none ${scrapeNone.status}`);
    assert.match(String(scrapeNone.headers['www-authenticate']), /^Bearer/);
    assert.strictEqual(scrapeWrong.status, 401, `wrong ${scrapeWrong.status}`);
    assert.strictEqual(scrapeRight.status, 200, `right ${scrapeRight.status}`);
    assert.match(scrapeRight.body, /argus_console_build_info/);
  });

  const tokenFile = path.join(dir, 'metrics-token');
  fs.writeFileSync(tokenFile, METRICS_TOKEN + '\n');
  const meteredByFile = await launch({ ARGUS_AUTH: 'off', ARGUS_METRICS_TOKEN_FILE: tokenFile });
  const brokenFile = await launch({ ARGUS_AUTH: 'off', ARGUS_METRICS_TOKEN_FILE: path.join(dir, 'no-such-token') });
  await waitForListening(meteredByFile);
  await waitForListening(brokenFile);
  const byFileNone = await call(meteredByFile, { path: '/metrics' });
  const byFileRight = await call(meteredByFile, { path: '/metrics', headers: { authorization: 'Bearer ' + METRICS_TOKEN } });
  const brokenRight = await call(brokenFile, { path: '/metrics', headers: { authorization: 'Bearer ' + METRICS_TOKEN } });
  check('a token file works like the variable, and a missing one closes /metrics rather than opening it', () => {
    assert.strictEqual(byFileNone.status, 401, `file none ${byFileNone.status}`);
    assert.strictEqual(byFileRight.status, 200, `file right ${byFileRight.status}`);
    assert.strictEqual(brokenRight.status, 401, `broken ${brokenRight.status}`);
    assert.match(brokenFile.err, /ARGUS_METRICS_TOKEN_FILE/);
  });

  const streamy = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_SSE_HEARTBEAT_MS: '200'
  });
  await waitForListening(streamy);
  const streamCookie = cookieFrom(await login(streamy, SUBJECT, PASSWORD));
  const first = await openStream(streamy, '/api/heartbeats/stream', { cookie: streamCookie });
  await first.until((t) => t.includes('event: open'), 4000).catch(() => {});
  const second = await openStream(streamy, '/api/heartbeats/stream', { cookie: streamCookie });
  await second.until((t) => t.includes('event: open'), 4000).catch(() => {});
  const third = await openStream(streamy, '/api/heartbeats/stream', { cookie: streamCookie });
  await third.ended;
  check('one operator holds at most two live streams', () => {
    assert.strictEqual(first.status, 200, `first ${first.status}`);
    assert.strictEqual(second.status, 200, `second ${second.status}`);
    assert.strictEqual(third.status, 429, `third ${third.status}`);
    const body = JSON.parse(third.text);
    assert.strictEqual(body.reason, 'too-many-streams');
    assert.strictEqual(body.scope, 'principal');
  });
  second.close();

  const headStream = await call(streamy, { method: 'HEAD', path: '/api/heartbeats/stream', headers: { cookie: streamCookie } });
  check('HEAD on a stream route is refused', () => {
    assert.strictEqual(headStream.status, 405, `status ${headStream.status}`);
  });

  await call(streamy, {
    method: 'POST',
    path: '/api/auth/logout',
    headers: { cookie: streamCookie, 'content-type': 'application/json', 'x-argus-console': '1' },
    body: '{}'
  });
  const endedInTime = await Promise.race([first.ended.then(() => true), sleep(3000).then(() => false)]);
  check('a stream opened by a session ends when that session is signed out', () => {
    assert.strictEqual(endedInTime, true, `the stream was still open: ${JSON.stringify(first.text.slice(-200))}`);
    assert.match(first.text, /event: session-ended/);
  });
  first.close();

  const shortStreams = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_SSE_HEARTBEAT_MS: '60000',
    ARGUS_AUTH_ABSOLUTE_TIMEOUT_MS: '1500'
  });
  await waitForListening(shortStreams);
  const shortStreamCookie = cookieFrom(await login(shortStreams, SUBJECT, PASSWORD));
  const capped = await openStream(shortStreams, '/api/heartbeats/stream', { cookie: shortStreamCookie });
  const cappedInTime = await Promise.race([capped.ended.then(() => true), sleep(4000).then(() => false)]);
  check('a stream never outlives the absolute expiry of its session', () => {
    assert.strictEqual(capped.status, 200, `status ${capped.status}`);
    assert.strictEqual(cappedInTime, true, 'the stream outlived its session');
    assert.match(capped.text, /absolute-timeout/);
  });
  capped.close();

  const throttled2 = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_AUTH_TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128',
    ARGUS_AUTH_TRUST_FORWARDED_FOR: '1',
    ARGUS_AUTH_LOCKOUT_THRESHOLD: '3'
  });
  await waitForListening(throttled2);
  const from = (address) => ({ 'x-forwarded-for': address });

  for (let i = 0; i < 4; i += 1) await login(throttled2, 'operator-op', WRONG_PASSWORD, from('203.0.113.10'));
  await waitForAudit(throttled2, (r) => r.event === 'auth.account.locked');

  const normalStarted = Date.now();
  const firstFromD = await login(throttled2, 'operator-op', WRONG_PASSWORD, from('203.0.113.30'));
  const normalMs = Date.now() - normalStarted;
  const lockedStarted = Date.now();
  const lockedFromD = await login(throttled2, 'operator-op', PASSWORD, from('203.0.113.30'));
  const lockedMs = Date.now() - lockedStarted;
  check('a locked subject is still refused to a source that has been failing', () => {
    assert.strictEqual(firstFromD.status, 401, `first ${firstFromD.status}`);
    assert.strictEqual(lockedFromD.status, 401, `locked ${lockedFromD.status}`);
  });
  check('the locked path spends scrypt time on a decoy, so timing does not reveal the lock', () => {
    assert.ok(lockedMs >= normalMs * 0.4, `locked ${lockedMs} ms against a normal ${normalMs} ms`);
  });

  const cleanSource = await login(throttled2, 'operator-op', PASSWORD, from('203.0.113.20'));
  check('a source with no recent failures signs in through a subject lock another source caused', () => {
    assert.strictEqual(cleanSource.status, 204, `status ${cleanSource.status} ${cleanSource.body}`);
  });

  const burst = await Promise.all([0, 1, 2, 3].map(() => login(throttled2, 'security-op', WRONG_PASSWORD, from('203.0.113.40'))));
  const burstStatuses = burst.map((r) => r.status);
  check('one source gets one verification in flight; the rest are told it is busy', () => {
    assert.ok(burstStatuses.includes(401), `statuses ${burstStatuses.join(',')}`);
    assert.ok(burstStatuses.includes(429), `statuses ${burstStatuses.join(',')}`);
    const busy = burst.find((r) => r.status === 429);
    assert.strictEqual(JSON.parse(busy.body).reason, 'busy');
  });
  await waitForAudit(throttled2, (r) => r.reason === 'verify-in-flight');
  const afterBurst = await login(throttled2, 'security-op', PASSWORD, from('203.0.113.40'));
  check('busy answers count as soft failures, so a burst still trips the source throttle', () => {
    assert.strictEqual(afterBurst.status, 429, `status ${afterBurst.status}`);
    assert.strictEqual(JSON.parse(afterBurst.body).reason, 'too-many-attempts');
  });

  await login(throttled2, 'nobody-here', WRONG_PASSWORD, from('198.51.100.7, 203.0.113.99'));
  await login(throttled2, 'nobody-here', WRONG_PASSWORD, from('198.51.100.8, 127.0.0.5'));
  await waitForAudit(throttled2, (r) => r.sourceAddress === '198.51.100.8');
  check('X-Forwarded-For is read from the right, skipping only trusted hops', () => {
    const sources = auditLines(throttled2).filter((r) => r.event === 'auth.login.failed').map((r) => r.sourceAddress);
    assert.ok(sources.includes('203.0.113.99'), `sources ${sources.join(',')}`);
    assert.ok(!sources.includes('198.51.100.7'), 'the leftmost, client-written entry was trusted');
    assert.ok(sources.includes('198.51.100.8'), `sources ${sources.join(',')}`);
  });

  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const ringed = await launch({
    ARGUS_AUTH: 'session',
    ARGUS_AUTH_OPERATORS_FILE: operatorsFile,
    ARGUS_AUDIT_RING_EVENTS: '50',
    ARGUS_STATE_DIR: stateDir
  });
  await waitForListening(ringed);
  const ringCookie = cookieFrom(await login(ringed, SUBJECT, PASSWORD));
  const flood = [];
  for (let i = 0; i < 300; i += 1) flood.push(call(ringed, { path: '/api/host' }));
  await Promise.all(flood);
  const ringAnswer = JSON.parse((await call(ringed, { path: '/api/audit/recent?limit=500', headers: { cookie: ringCookie } })).body);
  check('a flood of unauthenticated requests cannot flush the sign-in from the audit ring', () => {
    assert.ok(ringAnswer.events.some((e) => e.event === 'auth.login.succeeded'), 'the sign-in was evicted');
    const denied = ringAnswer.events.filter((e) => e.event === 'auth.denied');
    assert.strictEqual(denied.length, 1, `${denied.length} denial records for one source in one minute`);
    assert.ok(denied[0].count >= 300, `count ${denied[0].count}`);
  });
  check('a writable state directory persists the security ring', () => {
    assert.strictEqual(ringAnswer.persistence, 'file', JSON.stringify(ringAnswer.persistenceNote));
    const persisted = fs.readFileSync(path.join(stateDir, 'console-audit.jsonl'), 'utf8');
    assert.match(persisted, /auth\.login\.succeeded/);
    assert.ok(!persisted.includes('auth.denied'), 'request denials were persisted with the security events');
  });
  ringed.child.kill('SIGKILL');
  await waitForExit(ringed, 3000);
  const reborn = await launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile, ARGUS_STATE_DIR: stateDir });
  await waitForListening(reborn);
  const rebornCookie = cookieFrom(await login(reborn, SUBJECT, PASSWORD));
  const rebornAnswer = JSON.parse((await call(reborn, { path: '/api/audit/recent', headers: { cookie: rebornCookie } })).body);
  check('persisted security events come back after a restart', () => {
    assert.ok(rebornAnswer.events.some((e) => e.event === 'auth.login.succeeded' && e.restored === true),
      'no restored sign-in');
  });
  const memoryOnly = JSON.parse((await call(tiers, { path: '/api/audit/recent', headers: { cookie: tierCookies['security-op'] } })).body);
  check('an unwritable state directory says so in the audit answer', () => {
    assert.strictEqual(memoryOnly.persistence, 'memory');
    assert.match(String(memoryOnly.persistenceNote), /not writable/);
  });

  for (const server of spawned) {
    if (server.exitCode === null) server.child.kill('SIGKILL');
  }
  fs.rmSync(dir, { recursive: true, force: true });

  process.exit(report(results));
})().catch((err) => {
  console.error('auth harness failed:', err);
  for (const server of spawned) {
    if (server.exitCode === null) server.child.kill('SIGKILL');
  }
  process.exit(1);
});
