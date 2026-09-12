/*
 * Argus console API: authentication tests.
 *
 *   node test/auth.js
 *
 * Every server here is a real child process on a real port, because the two
 * highest-value assertions in this file are about a process that REFUSES TO
 * START. An in-process harness cannot observe that at all: the refusal is
 * process.exit(1), and the only honest way to test it is to run it.
 *
 * Exit code is the failure count, so CI can gate on it.
 */
'use strict';

const http = require('http');
const assert = require('assert');
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

let nextPort = Number(process.env.AUTH_TEST_PORT || 8910);
function takePort() {
  nextPort += 1;
  return nextPort;
}

const spawned = [];

function launch(env) {
  const port = takePort();
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
    } catch (err) { /* not up yet */ }
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
  const operatorsFile = writeOperatorsFile(dir, record);

  const emptyFile = path.join(dir, 'empty.json');
  fs.writeFileSync(emptyFile, JSON.stringify({ operators: [] }));

  /* ----------------------------------------------------- boot refusals --- */

  const refuseOpen = launch({ ARGUS_AUTH: 'off', ARGUS_HOST: '0.0.0.0' });
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

  const refuseNoOperators = launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: emptyFile });
  const refuseNoOperatorsCode = await waitForExit(refuseNoOperators);
  check('session mode with no operators refuses to start', () => {
    assert.strictEqual(refuseNoOperatorsCode, 1, `exit code ${refuseNoOperatorsCode}`);
    assert.match(refuseNoOperators.err, /at least one enabled operator/);
  });

  const refuseProxy = launch({ ARGUS_AUTH: 'proxy' });
  const refuseProxyCode = await waitForExit(refuseProxy);
  check('proxy mode without a trusted peer list and secret refuses to start', () => {
    assert.strictEqual(refuseProxyCode, 1, `exit code ${refuseProxyCode}`);
    assert.match(refuseProxy.err, /ARGUS_AUTH_TRUSTED_PROXY_CIDRS/);
    assert.match(refuseProxy.err, /ARGUS_AUTH_PROXY_SHARED_SECRET/);
  });

  const refuseBadMode = launch({ ARGUS_AUTH: 'yes-please' });
  const refuseBadModeCode = await waitForExit(refuseBadMode);
  check('an unrecognised auth mode refuses to start rather than guessing', () => {
    assert.strictEqual(refuseBadModeCode, 1, `exit code ${refuseBadModeCode}`);
  });

  const allowLoopbackOff = launch({ ARGUS_AUTH: 'off' });
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

  /* --------------------------------------------------------- session mode --- */

  const main = launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile });
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

  for (const path of ['/api/host', '/api/storage/buckets', '/api/secrets/seal-status', '/api/pg/roles',
    '/api/cache/clients', '/api/queues/streams', '/api/overview', '/api/storage/preview?bucket=a&key=b',
    '/api/logs/stream?query=%7B%7D', '/api/metrics/series?name=hostCpuBusyRatio', '/api/alerts/active',
    '/api/containers', '/api/heartbeats']) {
    const r = await call(main, { path });
    check(`${path} is refused without a session`, () => {
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

  /* ------------------------------------------------------------- lockout --- */

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

  /* ------------------------------------------------------------- logout --- */

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

  /* ------------------------------------------------------------ headers --- */

  const REQUIRED_HEADERS = ['content-security-policy', 'x-content-type-options', 'referrer-policy',
    'cross-origin-resource-policy', 'cross-origin-opener-policy', 'x-frame-options',
    'x-permitted-cross-domain-policies', 'permissions-policy', 'vary'];

  const matrix = launch({ ARGUS_AUTH: 'session', ARGUS_AUTH_OPERATORS_FILE: operatorsFile });
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

  /* -------------------------------------------------- nothing secret logged --- */

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

  /* ------------------------------------------------- secure cookie profile --- */

  const secure = launch({
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

  /* ------------------------------------------------------ expiry and renewal --- */

  const shortLived = launch({
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

  const renewing = launch({
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

  /* ---------------------------------------------------------- proxy mode --- */

  const proxied = launch({
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

  /* ------------------------------------------------- read-only carve-out --- */

  const readOnlyLogin = await login(main, 'someone-else', WRONG_PASSWORD);
  check('signing in is not refused by the read-only gate', () => {
    assert.notStrictEqual(readOnlyLogin.status, 405,
      'the default read-only deployment would be impossible to sign into');
  });

  /* --------------------------------------------- the scrypt memory cliff --- */

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

  /* -------------------------------------------------------------- report --- */

  for (const server of spawned) {
    if (server.exitCode === null) server.child.kill('SIGKILL');
  }
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : '   ' + r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length);
})().catch((err) => {
  console.error('auth harness failed:', err);
  for (const server of spawned) {
    if (server.exitCode === null) server.child.kill('SIGKILL');
  }
  process.exit(1);
});
