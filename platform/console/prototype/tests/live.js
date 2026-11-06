'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRYPT = { cost: 16384, blockSize: 8, parallelism: 1, maxmem: 64 * 1024 * 1024 };

const SERVER_DIR = path.resolve(__dirname, '..', '..', 'server');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCREEN_MODULES_DIR = path.join(__dirname, 'live-screens');
const SERVER = path.join(SERVER_DIR, 'src', 'index.js');

const EXTERNAL = String(process.env.LIVE_TEST_ORIGIN || '').replace(/\/+$/, '');
const PORT = Number(process.env.LIVE_TEST_PORT || 8977);
const ORIGIN = EXTERNAL || 'http://127.0.0.1:' + PORT;
const SUBJECT = process.env.LIVE_TEST_SUBJECT || 'alex';
const DISPLAY = EXTERNAL ? null : 'Alex Rivera';
const VIEWER_SUBJECT = 'casey';
const VIEWER_DISPLAY = 'Casey Morgan';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'argus-live-shots');

function readPassword() {
  if (!EXTERNAL) return 'correct-horse-battery-staple-7761';
  const file = process.env.LIVE_TEST_PASSWORD_FILE;
  if (!file) throw new Error('LIVE_TEST_ORIGIN is set, so LIVE_TEST_PASSWORD_FILE must name the operator password file.');
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}
const PASSWORD = readPassword();
const VIEWER_PASSWORD = 'viewer-horse-battery-staple-4410';

const ROUTES = ['overview', 'apps', 'deploys', 'compute', 'data', 'identity', 'security', 'ml', 'ops', 'audit', 'stack', 'system', 'storage', 'logs', 'advisor'];
const LIVE_ONLY = ['data', 'storage', 'stack', 'system'];
const FIXTURE_IDS = ['al-9021', 'al-9020', '1847', 'inc-31', 'hv-03', 'Orders Dashboard', 'Riley'];

const ENV_ALLOW = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'];

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (suite, id, pass, detail) => results.push({ suite, id, pass: !!pass, detail: detail || '' });
const skipped = [];
const skip = (suite, id, why) => { skipped.push({ suite, id, why }); };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(url) {
  const lib = /^https:/.test(url) ? https : http;
  return new Promise((resolve, reject) => {
    lib.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function waitForServer(server) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error('server exited early:\n' + server.err + server.out);
    try {
      const r = await get(ORIGIN + '/api/health');
      if (r.status === 200) return;
    } catch (e) { }
    await sleep(100);
  }
  throw new Error('server did not answer /api/health within 15 s:\n' + (server ? server.err : ORIGIN));
}

function serverEnv(extra) {
  const env = {};
  ENV_ALLOW.forEach((k) => { if (process.env[k] !== undefined) env[k] = process.env[k]; });
  return Object.assign(env, {
    ARGUS_AUTH_SCRYPT_COST: String(SCRYPT.cost),
    ARGUS_AUTH_SCRYPT_PARALLELISM: String(SCRYPT.parallelism),
    ARGUS_AUTH_SCRYPT_MAXMEM: String(SCRYPT.maxmem)
  }, extra);
}

async function launch() {
  const hash = require(path.join(SERVER_DIR, 'src', 'auth', 'hash.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-'));
  const admin = await hash.hash(PASSWORD, SCRYPT);
  const viewer = await hash.hash(VIEWER_PASSWORD, SCRYPT);
  const operators = path.join(dir, 'operators.json');
  fs.writeFileSync(operators, JSON.stringify({
    operators: [
      { subject: SUBJECT, displayName: DISPLAY, roles: ['admin'], password: admin },
      { subject: VIEWER_SUBJECT, displayName: VIEWER_DISPLAY, roles: ['viewer'], password: viewer }
    ]
  }));
  const child = spawn(process.execPath, [SERVER], {
    cwd: SERVER_DIR,
    env: serverEnv({
      ARGUS_AUTH: 'session',
      ARGUS_AUTH_OPERATORS_FILE: operators,
      ARGUS_PORT: String(PORT),
      ARGUS_HOST: '127.0.0.1',
      ARGUS_LOG_LEVEL: 'error',
      ARGUS_HEARTBEAT_INTERVAL_MS: '3600000',
      ARGUS_PG_HOST: '',
      ARGUS_OPENBAO_ADDR: '',
      ARGUS_GITOPS_DIR: path.join(REPO_ROOT, 'platform', 'gitops'),
      ARGUS_RUNBOOKS_DIR: path.join(REPO_ROOT, 'docs', 'runbooks'),
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_PROFILE: '__argus_live_no_such_profile__',
      AWS_EC2_METADATA_DISABLED: 'true'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const server = { child, dir, out: '', err: '', exitCode: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { server.out += d; });
  child.stderr.on('data', (d) => { server.err += d; });
  child.on('exit', (code) => { server.exitCode = code; });
  await waitForServer(server);
  return server;
}

const LOCAL_UI = !!EXTERNAL && process.env.LIVE_TEST_LOCAL_UI !== '0';
const UI_ROOT = path.resolve(__dirname, '..');
const UI_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function newContext(browser, opts) {
  const ctx = await browser.newContext(opts);
  if (!LOCAL_UI) return ctx;
  await ctx.route(ORIGIN + '/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.continue();
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(UI_ROOT, rel);
    const served = rel === 'index.html' || rel.indexOf('js/') === 0 || rel.indexOf('assets/') === 0;
    if (!served || !file.startsWith(UI_ROOT + path.sep) || !fs.existsSync(file)) return route.continue();
    return route.fulfill({ status: 200, headers: { 'content-type': UI_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }, body: fs.readFileSync(file) });
  });
  return ctx;
}

async function settle(page, timeout) {
  try {
    await page.waitForFunction(() => {
      const s = window.ARGUS && window.ARGUS.state;
      return !!s && s.renderedGen > 0 && s.pendingPanels === 0;
    }, null, { timeout: timeout || 8000 });
    return true;
  } catch (e) {
    return false;
  }
}

async function goto(page, route) {
  const before = await page.evaluate(() => (window.ARGUS && window.ARGUS.state.renderedGen) || 0);
  await page.evaluate((r) => {
    if (window.location.hash === '#/' + r) window.ARGUS.refresh();
    else window.location.hash = '#/' + r;
  }, route);
  await page.waitForFunction((a) => window.ARGUS && window.ARGUS.state.route === a.r.split('/')[0] && window.ARGUS.state.renderedGen > a.g,
    { r: route, g: before }, { timeout: 4000 });
  await settle(page);
}

async function waitFor(page, fn, arg, timeout) {
  try {
    await page.waitForFunction(fn, arg, { timeout: timeout || 4000 });
    return true;
  } catch (e) {
    return false;
  }
}

const pillText = () => document.getElementById('modepill').textContent.trim();
const dialogTitle = () => { const h = document.querySelector('.dialog h2'); return h ? h.textContent : null; };
const SIGNIN_TITLE = 'Sign in to the console';
const signInShown = () => { const h = document.querySelector('.dialog h2'); return !!h && h.textContent === 'Sign in to the console'; };

async function signIn(page, subject, password) {
  await page.fill('#signin-subject', subject);
  await page.fill('#signin-password', password);
  await page.click('.dialog .btn.primary');
  return waitFor(page, () => !document.querySelector('.dialog') && document.getElementById('modepill').textContent.trim() === 'Live', null, 8000);
}

async function faultMatrix(page) {
  const FAULT = '/api/__fault/';
  const answers = {
    notConfigured: { status: 200, body: { ok: false, reason: 'not-configured', message: 'The fault reader has no upstream. Set ARGUS_FAULT_URL.' } },
    forbidden: { status: 403, body: { ok: false, error: 'forbidden', reason: 'role', message: 'This needs the security role or above, and this session holds viewer.' } },
    notFound: { status: 404, body: { ok: false, error: 'not-found', reason: 'not-found', message: 'Nothing is at this address.' } },
    unreachable: { abort: true },
    timeout: { delayMs: 2500, status: 200, body: { ok: true, late: true } },
    failed: { status: 500, body: { ok: false, error: 'internal', message: 'The request failed. The reason is in the server log.' } },
    stale: { status: 500, body: { ok: false, error: 'internal', message: 'The second read failed.' }, primeFirst: true },
    signedOut: { status: 401, body: { ok: false, error: 'unauthenticated', reason: 'unauthenticated', message: 'Sign in to read this.' } }
  };
  const TRANSIENT = { unreachable: true, timeout: true, failed: true };
  const primed = {};
  await page.route('**' + FAULT + '**', async (route) => {
    const url = new URL(route.request().url());
    const state = url.pathname.slice(FAULT.length);
    const a = answers[state];
    if (!a) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    if (a.primeFirst && !primed[state]) {
      primed[state] = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: 'first read' }) });
    }
    if (a.abort) return route.abort('connectionrefused');
    if (a.delayMs) await sleep(a.delayMs);
    try {
      await route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    } catch (e) { }
  });

  const order = ['notConfigured', 'forbidden', 'notFound', 'unreachable', 'timeout', 'failed', 'stale', 'signedOut'];
  for (const state of order) {
    const out = await page.evaluate(async (a) => {
      const A = window.ARGUS;
      const where = a.fault + a.state;
      if (a.prime) await A.read(where, { ttlMs: 60000 });
      const first = a.state === 'signedOut' ? A.envelopeState(await A.read(where, { ttlMs: 0 })) : null;
      if (a.prime) await new Promise((r) => setTimeout(r, 5));
      let host = document.getElementById('fault-host');
      if (!host) { host = document.createElement('div'); host.id = 'fault-host'; document.body.appendChild(host); }
      while (host.firstChild) host.removeChild(host.firstChild);
      const rendered = [];
      const card = A.livePanel('Fault ' + a.state, where, function (body, data) {
        rendered.push(data);
        const p = document.createElement('p');
        p.textContent = 'rendered ' + JSON.stringify(data);
        body.appendChild(p);
      }, { ttlMs: a.prime ? 1 : 0, timeoutMs: a.state === 'timeout' ? 800 : undefined });
      host.appendChild(card);
      const body = card.querySelector('.livepanel');
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && body.getAttribute('data-state') === 'loading') await new Promise((r) => setTimeout(r, 25));
      const retry = Array.from(body.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent));
      return {
        state: body.getAttribute('data-state'),
        reason: body.getAttribute('data-reason'),
        block: (body.querySelector('[data-state]') || {}).getAttribute ? body.querySelector('[data-state]').getAttribute('data-state') : null,
        retry,
        stamp: !!body.querySelector('.readstamp'),
        rendered: rendered.length,
        first,
        text: body.textContent
      };
    }, { fault: FAULT, state, prime: !!answers[state].primeFirst });
    const leaked = FIXTURE_IDS.filter((w) => out.text.indexOf(w) !== -1);
    rec('FAULT', state + ': the live panel renders data-state="' + state + '"', out.state === state && (state === 'stale' || out.block === state) && (state !== 'signedOut' || out.first === 'signedOut'),
      JSON.stringify({ state: out.state, block: out.block, reason: out.reason }));
    rec('FAULT', state + ': retry is offered ' + (TRANSIENT[state] ? 'because the state is transient' : 'never, because the state is not transient'),
      out.retry === !!TRANSIENT[state], 'retry=' + out.retry);
    if (state === 'stale') {
      rec('FAULT', 'stale: the last reading is still drawn, under a stale block and a read stamp', out.rendered === 1 && out.stamp && /Showing the last value/.test(out.text), JSON.stringify({ rendered: out.rendered, stamp: out.stamp }));
    } else {
      rec('FAULT', state + ': nothing is drawn as if it were a reading', out.rendered === 0 && !out.stamp, JSON.stringify({ rendered: out.rendered, stamp: out.stamp }));
    }
    rec('FAULT', state + ': no fixture value appears in the panel', leaked.length === 0, leaked.join(', ') || 'none');
  }
  await page.unroute('**' + FAULT + '**');
  await page.evaluate(() => { const h = document.getElementById('fault-host'); if (h) h.remove(); });
}

async function fixtureLeaks(page) {
  await goto(page, 'overview');
  await settle(page);
  const shell = await page.evaluate(() => {
    const badge = (id) => { const b = document.getElementById(id); return b ? { hidden: b.hidden, text: b.textContent } : null; };
    return {
      deploy: badge('nav-deploy-badge'),
      alert: badge('nav-alert-badge'),
      advisor: badge('nav-advisor-badge'),
      who: document.querySelector('#whobtn .who-text b').textContent,
      envBtnHidden: document.getElementById('envbtn').hidden
    };
  });
  rec('SHELL', 'the Deployments badge is hidden in live mode because nothing live feeds it', shell.deploy && shell.deploy.hidden, JSON.stringify(shell.deploy));
  const alerts = await page.evaluate(async () => window.ARGUS.openAlerts(await window.ARGUS.read('/api/alerts/active', { ttlMs: 60000 })));
  const wantAlert = alerts && alerts.total ? String(alerts.total) : '';
  rec('SHELL', 'the Security badge carries the live open-alert count or is hidden', (wantAlert ? (!shell.alert.hidden && shell.alert.text === wantAlert) : shell.alert.hidden), JSON.stringify({ badge: shell.alert, live: alerts && alerts.total }));
  rec('SHELL', 'the Advisor badge is not the fixture count of eleven', !(shell.advisor && !shell.advisor.hidden && shell.advisor.text === '11'), JSON.stringify(shell.advisor));
  rec('SHELL', 'the Production/Staging switch is not offered on real data', shell.envBtnHidden);

  await page.click('#bell');
  await waitFor(page, () => !!document.querySelector('.dialog .inbox, .dialog .empty'), null, 6000);
  const inbox = await page.evaluate(() => {
    const d = document.querySelector('.dialog');
    return d ? { title: d.querySelector('h2').textContent, text: d.textContent, kinds: Array.from(d.querySelectorAll('.inbox-row .pill')).map((p) => p.textContent.replace(/^[^A-Za-z]+/, '')) } : { title: '', text: '', kinds: [] };
  });
  const inboxLeak = FIXTURE_IDS.filter((w) => inbox.text.indexOf(w) !== -1);
  rec('SHELL', 'the inbox holds no fixture item in live mode', inboxLeak.length === 0, inbox.title + ' / ' + (inboxLeak.join(', ') || 'no fixture'));
  if (alerts && alerts.total) {
    rec('SHELL', 'the inbox leads with the live Alertmanager groups', inbox.kinds.indexOf('Alert') !== -1 && inbox.text.indexOf(alerts.groups[0].name) !== -1, alerts.groups[0].name + ' / ' + inbox.title);
  } else {
    rec('SHELL', 'the inbox has no alert item when Alertmanager reports none or is not configured', inbox.kinds.indexOf('Alert') === -1, inbox.kinds.join(',') || 'no items');
  }
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await waitFor(page, () => !!document.querySelector('.pal-input'));
  const probes = ['al-9021', '1847', 'inc-31', 'hv-03', 'Orders Dashboard', 'Riley'];
  const palette = {};
  for (const q of probes) {
    await page.fill('.pal-input', q);
    palette[q] = await page.evaluate(() => Array.from(document.querySelectorAll('.pal-item')).map((li) => li.textContent));
  }
  await page.fill('.pal-input', '');
  const leakedResults = probes.filter((q) => palette[q].some((t) => t.indexOf(q) !== -1));
  rec('SHELL', 'the palette finds no fixture id, host or person in live mode', leakedResults.length === 0, leakedResults.join(', ') || 'none');
  const runbookHit = await (async () => {
    await waitFor(page, () => /Live: \d+ resource/.test((document.querySelector('.pal-source') || {}).textContent || ''), null, 6000);
    await page.fill('.pal-input', 'runbook');
    return page.evaluate(() => Array.from(document.querySelectorAll('.pal-item .pal-kind')).filter((k) => k.textContent === 'Runbook').length);
  })();
  rec('SHELL', 'the palette lists live runbooks from the search index', runbookHit > 0, runbookHit + ' runbook results');
  await page.keyboard.press('Escape');

  await goto(page, 'apps/orders');
  const crumb = await page.evaluate(() => document.getElementById('crumb').textContent);
  rec('SHELL', 'the breadcrumb for a live deep link comes from the route, not the fixture name', crumb.indexOf('Orders Dashboard') === -1 && /orders/.test(crumb), crumb);
  await goto(page, 'overview');
}

async function sessionExpiry(browser) {
  const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  const pg = await ctx.newPage();
  const denied = [];
  pg.on('response', (r) => { if (r.status() === 401 && /\/api\//.test(r.url())) denied.push(r.url()); });
  await pg.goto(ORIGIN + '/#/overview', { waitUntil: 'domcontentloaded' });
  await waitFor(pg, () => !!document.getElementById('signin-subject'), null, 6000);
  const ok = await signIn(pg, SUBJECT, PASSWORD);
  if (!ok) { rec('EXPIRY', 'the expiry check could sign in', false); await ctx.close(); return; }
  await settle(pg);
  await pg.evaluate(() => window.ARGUS.__test.setSessionGateMs(0));
  await ctx.clearCookies();
  denied.length = 0;
  await pg.evaluate(() => { window.ARGUS.forget(); window.location.hash = '#/stack'; });
  const back = await waitFor(pg, signInShown, null, 6000);
  await pg.waitForFunction(() => window.ARGUS.state.pendingPanels === 0, null, { timeout: 6000 }).catch(() => {});
  const afterNav = denied.length;
  await pg.evaluate(() => { window.location.hash = '#/data'; });
  await pg.waitForFunction(() => window.ARGUS.state.route === 'data', null, { timeout: 4000 }).catch(() => {});
  await pg.waitForFunction(() => window.ARGUS.state.pendingPanels === 0, null, { timeout: 6000 }).catch(() => {});
  const view = await pg.evaluate(() => ({
    banners: document.querySelectorAll('[data-session-banner]').length,
    shell: !!document.querySelector('#main .signedout-shell'),
    who: document.querySelector('#whobtn .who-text b').textContent,
    deployBadge: document.getElementById('nav-deploy-badge').hidden,
    alertBadge: document.getElementById('nav-alert-badge').hidden,
    fixture: /al-9021|hv-03|Orders Dashboard/.test(document.getElementById('main').textContent)
  }));
  rec('EXPIRY', 'the sign-in dialog comes back after the session ends', back);
  rec('EXPIRY', 'one navigation after expiry costs at most one refused read', afterNav <= 1, afterNav + ' refused reads: ' + denied.slice(0, 3).join(' '));
  rec('EXPIRY', 'a further navigation while signed out sends no read at all', denied.length === afterNav, (denied.length - afterNav) + ' more');
  rec('EXPIRY', 'exactly one session-expired banner is shown', view.banners === 1, view.banners + ' banners');
  rec('EXPIRY', 'the page behind the dialog is a neutral skeleton with no fixture and no badges',
    view.shell && !view.fixture && view.deployBadge && view.alertBadge && view.who === 'Signed out', JSON.stringify(view));
  const resumed = await signIn(pg, SUBJECT, PASSWORD);
  await settle(pg);
  const after = await pg.evaluate(() => ({ shell: !!document.querySelector('#main .signedout-shell'), banners: document.querySelectorAll('[data-session-banner]').length, route: window.ARGUS.state.route }));
  rec('EXPIRY', 'signing in again resumes the screen and drops the banner', resumed && !after.shell && after.banners === 0 && after.route === 'data', JSON.stringify(after));
  await ctx.close();
}

async function viewerChecks(browser) {
  const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  const pg = await ctx.newPage();
  const forbidden = [];
  pg.on('response', (r) => { if (r.status() === 403 && /\/api\//.test(r.url())) forbidden.push(new URL(r.url()).pathname); });
  await pg.goto(ORIGIN + '/#/overview', { waitUntil: 'domcontentloaded' });
  await waitFor(pg, () => !!document.getElementById('signin-subject'), null, 6000);
  const ok = await signIn(pg, VIEWER_SUBJECT, VIEWER_PASSWORD);
  rec('VIEWER', 'a viewer can sign in', ok);
  if (!ok) { await ctx.close(); return; }
  const role = await pg.evaluate(() => document.querySelector('#whobtn .who-text span').textContent);
  rec('VIEWER', 'the header names the viewer role', /viewer/.test(role), role);
  await settle(pg);
  const overview = await pg.evaluate(() => {
    const panel = Array.from(document.querySelectorAll('#main .card')).filter((c) => /Recent activity/.test((c.querySelector('.card-title') || {}).textContent || ''))[0];
    const body = panel ? panel.querySelector('.livepanel') : null;
    return {
      state: body ? body.getAttribute('data-state') : null,
      reason: body ? body.getAttribute('data-reason') : null,
      retry: body ? Array.from(body.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent)) : null,
      failed: document.querySelectorAll('#main [data-state="failed"]').length
    };
  });
  rec('VIEWER', 'the audit ring on Overview is a forbidden state, not an error, for a viewer',
    overview.state === 'forbidden' && overview.reason === 'role' && overview.retry === false, JSON.stringify(overview));
  rec('VIEWER', 'no Overview panel renders a role denial as a failure', overview.failed === 0, overview.failed + ' failed panels');
  rec('VIEWER', 'the server refused the security-only read with 403', forbidden.indexOf('/api/audit/recent') !== -1, forbidden.join(', ') || 'none');
  const tile = await pg.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#main .tile')).map((n) => ({ label: n.querySelector('.tile-label').textContent, state: n.getAttribute('data-state') }));
    return t.filter((x) => x.state && x.state !== 'ok' && x.state !== 'notConfigured');
  });
  rec('VIEWER', 'no Overview tile shows a role denial as a failure', tile.every((t) => t.state === 'forbidden'), JSON.stringify(tile));
  await ctx.close();
}

(async () => {
  let server = null;
  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];
  try {
    if (EXTERNAL) {
      await waitForServer(null);
      console.log('  LIVE_TEST_ORIGIN is ' + EXTERNAL + ': no server is spawned, signing in as ' + SUBJECT + (LOCAL_UI ? ', with the console page served from this working tree (LIVE_TEST_LOCAL_UI=0 to use the image copy).' : '.'));
    } else {
      server = await launch();
    }

    const head = await get(ORIGIN + '/');
    rec('SERVE', 'the API serves the console shell at /', head.status === 200 && /Argus Console/.test(head.body), 'status ' + head.status);
    rec('SERVE', 'the shell carries a content security policy header', /default-src 'none'/.test(String(head.headers['content-security-policy'] || '')), String(head.headers['content-security-policy'] || '').slice(0, 60));
    const anon = await get(ORIGIN + '/api/storage/buckets');
    rec('SERVE', 'a protected read without a session is refused with 401', anon.status === 401, 'status ' + anon.status);
    let anonBody = {};
    try { anonBody = JSON.parse(anon.body); } catch (e) { }
    rec('SERVE', 'the refusal is the one error envelope the console reads', anonBody.ok === false && anonBody.error === 'unauthenticated' && typeof anonBody.message === 'string', anon.body.slice(0, 120));

    browser = await chromium.launch();
    const ctx = await newContext(browser, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const where = (m.location() || {}).url || '';
      consoleErrors.push({ text: m.text(), url: where });
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('requestfailed', (r) => failedReqs.push(r.url() + ' : ' + ((r.failure() || {}).errorText || '')));

    await page.goto(ORIGIN + '/#/overview');
    await page.waitForFunction(() => window.ARGUS && window.ARGUS.state.route === 'overview');

    const askedToSignIn = await waitFor(page, signInShown);
    rec('AUTH', 'a signed-out browser is asked to sign in as soon as the API is probed', askedToSignIn);
    rec('AUTH', 'the data source pill says Signed out', await page.evaluate(pillText) === 'Signed out', await page.evaluate(pillText));
    const behind = await page.evaluate(() => ({
      shell: !!document.querySelector('#main .signedout-shell'),
      who: document.querySelector('#whobtn .who-text b').textContent,
      badges: ['nav-alert-badge', 'nav-deploy-badge', 'nav-advisor-badge'].filter((id) => !document.getElementById(id).hidden)
    }));
    rec('AUTH', 'behind the sign-in dialog the page is a neutral skeleton, signed out, with no badge', behind.shell && behind.who === 'Signed out' && behind.badges.length === 0, JSON.stringify(behind));
    rec('AUTH', 'the sign-in dialog is locked: Escape does not dismiss it', await (async () => {
      await page.keyboard.press('Escape');
      return (await page.evaluate(dialogTitle)) === SIGNIN_TITLE;
    })());
    const dialog = await page.evaluate(() => {
      const foot = Array.from(document.querySelectorAll('.dialog .dialog-foot button')).map((b) => b.textContent.trim());
      const reveal = document.getElementById('signin-reveal');
      return {
        foot,
        where: /platform\/compose\/secrets\/console_operator_password/.test(document.querySelector('.dialog').textContent),
        reveal: reveal ? { tag: reveal.tagName, pressed: reveal.getAttribute('aria-pressed') } : null
      };
    });
    rec('AUTH', 'the dialog says where the bootstrap password is', dialog.where);
    rec('AUTH', 'Sign in comes before Browse sample data instead in the tab order', dialog.foot[0] === 'Sign in' && dialog.foot.indexOf('Browse sample data instead') === 1, dialog.foot.join(' | '));
    rec('AUTH', 'the show-password toggle is a real button with aria-pressed', dialog.reveal && dialog.reveal.tag === 'BUTTON' && dialog.reveal.pressed === 'false', JSON.stringify(dialog.reveal));
    await page.fill('#signin-password', 'peek');
    await page.click('#signin-reveal');
    const revealed = await page.evaluate(() => ({ type: document.getElementById('signin-password').type, pressed: document.getElementById('signin-reveal').getAttribute('aria-pressed') }));
    await page.click('#signin-reveal');
    const hidden = await page.evaluate(() => document.getElementById('signin-password').type);
    rec('AUTH', 'the toggle shows and hides the password and reports it in aria-pressed', revealed.type === 'text' && revealed.pressed === 'true' && hidden === 'password', JSON.stringify(revealed) + ' then ' + hidden);
    await page.fill('#signin-password', '');

    const refused = await page.evaluate(async () => {
      const r = await window.ARGUS.read('/api/storage/buckets', { ttlMs: 0 });
      return r.ok === false && r.error && r.error.reason === 'unauthenticated' && window.ARGUS.envelopeState(r) === 'signedOut';
    });
    rec('AUTH', 'a live read while signed out is refused locally without a request, as the signedOut state', refused);
    await page.screenshot({ path: path.join(SHOTS, 'signin.png') });

    await page.fill('#signin-subject', SUBJECT);
    await page.fill('#signin-password', 'not-the-password-at-all-0000');
    await page.keyboard.press('Enter');
    const wrongShown = await waitFor(page, () => {
      const e = document.getElementById('signin-error');
      return e && !e.hidden && e.textContent.length > 0;
    });
    rec('AUTH', 'a wrong password is reported in the dialog and the dialog stays', wrongShown && (await page.evaluate(dialogTitle)) === SIGNIN_TITLE);
    rec('AUTH', 'the wrong password was cleared from the field', (await page.inputValue('#signin-password')) === '');

    await page.fill('#signin-password', PASSWORD);
    await page.click('.dialog .btn.primary');
    const signedIn = await waitFor(page, () => !document.querySelector('.dialog') && document.getElementById('modepill').textContent.trim() === 'Live', null, 8000);
    rec('AUTH', 'the right password closes the dialog and the pill turns Live', signedIn, await page.evaluate(pillText));
    const who = await page.evaluate(() => ({
      name: document.querySelector('#whobtn .who-text b').textContent,
      role: document.querySelector('#whobtn .who-text span').textContent,
      avatar: document.querySelector('#whobtn .avatar').textContent,
      me: window.ARGUS.me()
    }));
    const wantName = DISPLAY || who.name;
    rec('AUTH', 'the operator pill shows the signed-in principal from the API', who.name === wantName && (EXTERNAL || /admin/.test(who.role)) && who.me === SUBJECT, JSON.stringify(who));
    const flashed = await page.evaluate(() => Array.from(document.querySelectorAll('.flash')).some((f) => /Signed in/.test(f.textContent)));
    rec('AUTH', 'a flash confirms the sign-in', flashed);
    const caps = await page.evaluate(() => window.ARGUS.capabilities());
    rec('AUTH', 'capabilities now carry the principal', caps && caps.auth && caps.auth.authenticated === true && caps.auth.subject === SUBJECT, JSON.stringify(caps && caps.auth));

    for (const route of ROUTES) {
      await goto(page, route);
      const probe = await page.evaluate(() => {
        const main = document.getElementById('main');
        return { chars: main.textContent.trim().length, headings: main.querySelectorAll('h1,h2').length, dialog: !!document.querySelector('.dialog') };
      });
      rec('LIVE', route + ' renders over http while signed in', probe.chars > 80 && probe.headings > 0 && !probe.dialog, JSON.stringify(probe));
      await page.screenshot({ path: path.join(SHOTS, route + '.png') });
    }

    for (const route of LIVE_ONLY) {
      await goto(page, route);
      const text = await page.evaluate(() => document.getElementById('main').textContent);
      const sampleWarning = /sample data|console API is not running/i.test(text);
      rec('LIVE', route + ' reads the API rather than showing the sample-mode notice', !sampleWarning, text.slice(0, 120));
    }

    const capsReads = [];
    const onCaps = (r) => { if (/\/api\/capabilities$/.test(new URL(r.url()).pathname)) capsReads.push(r.url()); };
    page.on('request', onCaps);
    await goto(page, 'overview');
    await goto(page, 'advisor');
    await settle(page, 12000);
    page.off('request', onCaps);
    rec('STORE', 'capabilities are read at most once across Overview and Advisor', capsReads.length <= 1, capsReads.length + ' reads');

    const store = await page.evaluate(async () => {
      const A = window.ARGUS;
      const before = A.__test.cacheSize();
      await A.read('/api/host', { ttlMs: 0 });
      const afterZero = A.__test.cacheSize();
      return { before, afterZero, max: A.__test.CACHE_MAX };
    });
    rec('STORE', 'a ttlMs: 0 read is never cached', store.afterZero <= store.before, JSON.stringify(store));
    rec('STORE', 'the read cache is bounded at about 200 entries', store.max === 200, String(store.max));
    const refusal = await page.evaluate(async () => {
      const r = await window.ARGUS.read('/api/no-such-endpoint-for-the-suite', { ttlMs: 0 });
      return { ok: r.ok, error: r.error, state: window.ARGUS.envelopeState(r) };
    });
    rec('STORE', 'a non-2xx answer carries the status and the server message through', refusal.ok === false && refusal.error && refusal.error.status === 404 && refusal.state === 'notFound' && !!refusal.error.message, JSON.stringify(refusal));

    const modules = fs.existsSync(SCREEN_MODULES_DIR)
      ? fs.readdirSync(SCREEN_MODULES_DIR).filter((f) => /\.js$/.test(f)).sort()
      : [];
    for (const file of modules) {
      const name = file.replace(/\.js$/, '');
      const suite = name.toUpperCase().slice(0, 8);
      let mod;
      try {
        mod = require(path.join(SCREEN_MODULES_DIR, file));
      } catch (err) {
        rec(suite, 'module ' + file + ' loads', false, String(err && err.message));
        continue;
      }
      if (typeof mod !== 'function') {
        rec(suite, 'module ' + file + ' exports a function', false, typeof mod);
        continue;
      }
      try {
        await mod({
          page, rec: (id, pass, detail) => rec(suite, id, pass, detail), skip: (id, why) => skip(suite, id, why),
          goto, waitFor, settle, origin: ORIGIN, server, get, sleep,
          subject: SUBJECT, display: DISPLAY, external: !!EXTERNAL
        });
      } catch (err) {
        rec(suite, 'module ' + file + ' ran to the end', false, String(err && err.stack || err));
      }
    }

    await fixtureLeaks(page);
    await faultMatrix(page);

    const reauth = await waitFor(page, signInShown, null, 4000);
    rec('FAULT', 'signedOut: a 401 from a panel brings the sign-in dialog back', reauth);
    if (reauth) await signIn(page, SUBJECT, PASSWORD);
    await settle(page);

    const stranded = [];
    for (const route of ROUTES) {
      const fresh = await newContext(browser, { viewport: { width: 1280, height: 800 } });
      const pg = await fresh.newPage();
      pg.on('pageerror', (e) => pageErrors.push(route + ': ' + e));
      await pg.goto(ORIGIN + '/#/' + route, { waitUntil: 'domcontentloaded' });
      const asked = await waitFor(pg, signInShown, null, 6000);
      if (!asked) stranded.push(route);
      await fresh.close();
    }
    rec('AUTH', 'a signed-out browser opening any screen directly reaches the sign-in dialog', stranded.length === 0, stranded.join(','));

    const expiring = await newContext(browser, { viewport: { width: 1280, height: 800 } });
    const ep = await expiring.newPage();
    await ep.goto(ORIGIN + '/#/advisor', { waitUntil: 'domcontentloaded' });
    const canSign = await waitFor(ep, () => !!document.getElementById('signin-subject'), null, 6000);
    if (canSign) {
      await ep.fill('#signin-subject', SUBJECT);
      await ep.fill('#signin-password', PASSWORD);
      await ep.keyboard.press('Enter');
    }
    const painted = canSign && await waitFor(ep, () => !document.querySelector('.dialog') && document.querySelectorAll('#main tbody tr[data-key]').length > 0, null, 8000);
    rec('AUTH', 'signing in on the Advisor deep link paints the findings', !!painted);
    if (painted) {
      await ep.evaluate(() => {
        window.fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-argus-console': '1' }, body: '{}' })
          .then(() => { ['/api/host', '/api/capabilities'].forEach((u) => window.ARGUS.forget(u)); return window.ARGUS.read('/api/host', { ttlMs: 0 }); });
      });
    }
    const returned = painted && await waitFor(ep, signInShown, null, 6000);
    rec('AUTH', 'a session ending while on the Advisor brings the dialog back and the page stays responsive', !!returned);
    await expiring.close();

    await sessionExpiry(browser);
    if (EXTERNAL) skip('VIEWER', 'a viewer sees role-denied panels as the forbidden state', 'needs the spawned server, which holds the second (viewer) operator');
    else await viewerChecks(browser);

    const health = await page.evaluate(() => window.ARGUS.storeHealth());
    rec('LIVE', 'the store counted real reads and the last one succeeded', health.reads > 0 && health.lastOkAt && !health.signedOut, JSON.stringify({ reads: health.reads, failures: health.failures }));

    await page.reload();
    await page.waitForFunction(() => window.ARGUS && window.ARGUS.storeMode() === 'live');
    await settle(page);
    rec('AUTH', 'the session survives a reload through the cookie alone', (await page.evaluate(pillText)) === 'Live' && !(await page.evaluate(dialogTitle)), await page.evaluate(pillText));

    await page.evaluate(async () => {
      await window.fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-argus-console': '1' }, body: '{}' });
      window.ARGUS.forget();
      await window.ARGUS.read('/api/host', { ttlMs: 0 });
    });
    const reasked = await waitFor(page, () => {
      const h = document.querySelector('.dialog h2');
      return h && h.textContent === 'Sign in to the console' && document.getElementById('modepill').textContent.trim() === 'Signed out';
    });
    rec('AUTH', 'a 401 from the API after the session ends brings the sign-in dialog back', reasked, await page.evaluate(pillText));

    await signIn(page, SUBJECT, PASSWORD);
    await page.route('**/api/auth/logout', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'internal', message: 'The request failed. The reason is in the server log.' }) }));
    const failedOut = await page.evaluate(() => window.ARGUS.signOutNow());
    const stillIn = await page.evaluate(() => ({
      pill: document.getElementById('modepill').textContent.trim(),
      dialog: !!document.querySelector('.dialog'),
      flash: Array.from(document.querySelectorAll('.flash')).some((f) => /Sign-out failed/.test(f.textContent) && /still signed in/.test(f.textContent))
    }));
    rec('AUTH', 'a sign-out the API does not confirm with 204 leaves the session open and says so', failedOut === false && stillIn.pill === 'Live' && !stillIn.dialog && stillIn.flash, JSON.stringify(stillIn));
    await page.unroute('**/api/auth/logout');

    const outOk = await page.evaluate(() => window.ARGUS.signOutNow());
    const signedOut = await waitFor(page, signInShown);
    rec('AUTH', 'signing out from the console ends the session after a 204 and asks again', outOk === true && signedOut);
    const whoAfter = await page.evaluate(() => document.querySelector('#whobtn .who-text b').textContent);
    rec('AUTH', 'the operator pill says Signed out after sign-out rather than a sample person', whoAfter === 'Signed out', whoAfter);
    const cookieGone = (await ctx.cookies(ORIGIN)).filter((c) => /argus_sid/.test(c.name)).length === 0;
    rec('AUTH', 'the session cookie is cleared on sign-out', cookieGone);

    await page.click('.dialog .dialog-foot .btn.ghost');
    const sample = await waitFor(page, () => !document.querySelector('.dialog') && document.getElementById('modepill').textContent.trim() === 'Sample data');
    rec('AUTH', 'choosing sample data instead closes the dialog and switches the pill', sample, await page.evaluate(pillText));
    await goto(page, 'storage');
    const sampleNotice = await page.evaluate(() => /sample|console API/i.test(document.getElementById('main').textContent));
    rec('AUTH', 'a live-only screen explains itself in sample mode', sampleNotice);

    const slow = await newContext(browser, { viewport: { width: 1280, height: 800 } });
    const sp = await slow.newPage();
    let held = 0;
    await sp.route('**/api/capabilities', async (route) => {
      held += 1;
      if (held === 1) return route.abort('connectionrefused');
      return route.continue();
    });
    await sp.goto(ORIGIN + '/#/overview', { waitUntil: 'domcontentloaded' });
    const downPill = await waitFor(sp, () => document.getElementById('modepill').textContent.trim() === 'API unreachable', null, 6000);
    rec('PROBE', 'a failed first probe over http says API unreachable rather than dropping to sample data', downPill, await sp.evaluate(pillText));
    const recovered = await waitFor(sp, signInShown, null, 8000);
    rec('PROBE', 'the console probes again on its own and reaches the API', recovered && held >= 2, held + ' probes');
    await slow.close();

    const unexpectedErrors = consoleErrors.filter((m) => !/status of 40[13]/.test(m.text) && !/__fault/.test(m.url) && !/status of 500/.test(m.text) && !/status of 404/.test(m.text) && !/ERR_CONNECTION_REFUSED/.test(m.text));
    rec('CONS', 'no console errors over http beyond the refusals and faults the suite provokes', unexpectedErrors.length === 0, unexpectedErrors.slice(0, 4).map((m) => m.text).join(' | '));
    rec('CONS', 'no page errors over http', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
    const realFails = failedReqs.filter((u) => !/ERR_ABORTED/.test(u) && !/__fault/.test(u));
    rec('CONS', 'no failed requests over http beyond reads the console itself abandoned on route change', realFails.length === 0, realFails.slice(0, 4).join(' | '));
    if (server) {
      const audit = server.out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((r) => r && r.stream === 'argus.console.audit').map((r) => r.event);
      rec('CONS', 'the server audited the failed, successful and ended sign-ins',
        audit.includes('auth.login.failed') && audit.includes('auth.login.succeeded') && audit.includes('auth.logout'), audit.slice(0, 12).join(','));
      const leaked = /correct-horse|viewer-horse/.test(server.out + server.err);
      rec('CONS', 'the password never reached the server log', !leaked);
    } else {
      skip('CONS', 'the server audited the failed, successful and ended sign-ins', 'reads the spawned server log');
      skip('CONS', 'the password never reached the server log', 'reads the spawned server log');
    }
  } catch (err) {
    rec('HARNESS', 'the live suite ran to the end', false, String(err && err.stack || err));
  } finally {
    if (browser) await browser.close();
    if (server) {
      server.child.kill();
      try { fs.rmSync(server.dir, { recursive: true, force: true }); } catch (e) { }
    }
  }

  const bySuite = {};
  results.forEach((r) => {
    bySuite[r.suite] = bySuite[r.suite] || { pass: 0, fail: 0 };
    bySuite[r.suite][r.pass ? 'pass' : 'fail']++;
  });
  console.log('\n  Argus Console: live suite against the console API' + (EXTERNAL ? ' at ' + EXTERNAL : ''));
  console.log('  ' + '-'.repeat(64));
  Object.keys(bySuite).forEach((s) => {
    const b = bySuite[s];
    console.log('  ' + s.padEnd(8) + ' ' + String(b.pass).padStart(3) + ' passed  ' + String(b.fail).padStart(3) + ' failed');
  });
  console.log('  ' + '-'.repeat(64));
  if (skipped.length) {
    console.log('\n  Skipped (' + skipped.length + '):\n');
    skipped.forEach((s) => console.log('  [' + s.suite + '] ' + s.id + '\n        ' + s.why));
  }
  const fails = results.filter((r) => !r.pass);
  if (fails.length) {
    console.log('\n  Failures:\n');
    fails.forEach((f) => console.log('  [' + f.suite + '] ' + f.id + '\n        ' + f.detail));
  } else {
    console.log('\n  All checks passed.');
  }
  console.log('\n  ' + (results.length - fails.length) + '/' + results.length + ' passed' + (skipped.length ? ', ' + skipped.length + ' skipped' : '') + '. Screenshots in ' + SHOTS + '\n');
  fs.writeFileSync(path.join(__dirname, 'live-last-run.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fails.length ? 1 : 0);
})();
