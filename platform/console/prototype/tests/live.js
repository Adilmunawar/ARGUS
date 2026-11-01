'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ARGUS_AUTH_SCRYPT_COST = '16384';
process.env.ARGUS_AUTH_SCRYPT_PARALLELISM = '1';
process.env.ARGUS_AUTH_SCRYPT_MAXMEM = String(64 * 1024 * 1024);

const SERVER_DIR = path.resolve(__dirname, '..', '..', 'server');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SCREEN_MODULES_DIR = path.join(__dirname, 'live-screens');
const SERVER = path.join(SERVER_DIR, 'src', 'index.js');
const hash = require(path.join(SERVER_DIR, 'src', 'auth', 'hash.js'));

const PORT = Number(process.env.LIVE_TEST_PORT || 8977);
const ORIGIN = 'http://127.0.0.1:' + PORT;
const SUBJECT = 'adil';
const DISPLAY = 'Adil Munawar';
const PASSWORD = 'correct-horse-battery-staple-7761';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'argus-live-shots');

const ROUTES = ['overview', 'apps', 'deploys', 'compute', 'data', 'identity', 'security', 'ml', 'ops', 'audit', 'stack', 'system', 'storage', 'logs', 'advisor'];
const LIVE_ONLY = ['data', 'storage', 'stack', 'system'];

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (suite, id, pass, detail) => results.push({ suite, id, pass, detail: detail || '' });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
    if (server.exitCode !== null) throw new Error('server exited early:\n' + server.err + server.out);
    try {
      const r = await get(ORIGIN + '/api/health');
      if (r.status === 200) return;
    } catch (e) { }
    await sleep(100);
  }
  throw new Error('server did not answer /api/health within 15 s:\n' + server.err);
}

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-live-'));
  const record = await hash.hash(PASSWORD, { cost: 16384, blockSize: 8, parallelism: 1, maxmem: 64 * 1024 * 1024 });
  const operators = path.join(dir, 'operators.json');
  fs.writeFileSync(operators, JSON.stringify({
    operators: [{ subject: SUBJECT, displayName: DISPLAY, roles: ['operator', 'tier-1'], password: record }]
  }));
  const child = spawn(process.execPath, [SERVER], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
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
    },
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

async function goto(page, route) {
  await page.evaluate((r) => { window.location.hash = '#/' + r; }, route);
  await page.waitForFunction((r) => window.ARGUS && window.ARGUS.state.route === r.split('/')[0], route, { timeout: 4000 });
  await page.waitForTimeout(60);
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

(async () => {
  let server;
  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];
  try {
    server = await launch();

    const head = await get(ORIGIN + '/');
    rec('SERVE', 'the API serves the console shell at /', head.status === 200 && /Argus Console/.test(head.body), 'status ' + head.status);
    rec('SERVE', 'the shell carries a content security policy header', /default-src 'none'/.test(String(head.headers['content-security-policy'] || '')), String(head.headers['content-security-policy'] || '').slice(0, 60));
    const anon = await get(ORIGIN + '/api/storage/buckets');
    rec('SERVE', 'a protected read without a session is refused with 401', anon.status === 401, 'status ' + anon.status);

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('requestfailed', (r) => failedReqs.push(r.url() + ' : ' + ((r.failure() || {}).errorText || '')));

    await page.goto(ORIGIN + '/#/overview');
    await page.waitForFunction(() => window.ARGUS && window.ARGUS.state.route === 'overview');

    const askedToSignIn = await waitFor(page, () => {
      const h = document.querySelector('.dialog h2');
      return h && h.textContent === 'Sign in to the console';
    });
    rec('AUTH', 'a signed-out browser is asked to sign in as soon as the API is probed', askedToSignIn);
    rec('AUTH', 'the data source pill says Signed out', await page.evaluate(pillText) === 'Signed out', await page.evaluate(pillText));
    rec('AUTH', 'the sign-in dialog is locked: Escape does not dismiss it', await (async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
      return (await page.evaluate(dialogTitle)) === 'Sign in to the console';
    })());
    const refused = await page.evaluate(async () => {
      const r = await window.ARGUS.read('/api/storage/buckets', { ttlMs: 0 });
      return r.ok === false && r.error && r.error.reason === 'unauthenticated';
    });
    rec('AUTH', 'a live read while signed out is refused locally without a request', refused);
    await page.screenshot({ path: path.join(SHOTS, 'signin.png') });

    await page.fill('#signin-subject', SUBJECT);
    await page.fill('#signin-password', 'not-the-password-at-all-0000');
    await page.keyboard.press('Enter');
    const wrongShown = await waitFor(page, () => {
      const e = document.getElementById('signin-error');
      return e && !e.hidden && /Sign-in failed/.test(e.textContent);
    });
    rec('AUTH', 'a wrong password is reported in the dialog and the dialog stays', wrongShown && (await page.evaluate(dialogTitle)) === 'Sign in to the console');
    rec('AUTH', 'the wrong password was cleared from the field', (await page.inputValue('#signin-password')) === '');

    await page.fill('#signin-password', PASSWORD);
    await page.click('.dialog .btn.primary');
    const signedIn = await waitFor(page, () => !document.querySelector('.dialog') && document.getElementById('modepill').textContent.trim() === 'Live');
    rec('AUTH', 'the right password closes the dialog and the pill turns Live', signedIn, await page.evaluate(pillText));
    const who = await page.evaluate(() => ({
      name: document.querySelector('#whobtn .who-text b').textContent,
      role: document.querySelector('#whobtn .who-text span').textContent,
      avatar: document.querySelector('#whobtn .avatar').textContent,
      me: window.ARGUS.data.me.upn
    }));
    rec('AUTH', 'the operator pill shows the signed-in principal from the API', who.name === DISPLAY && /operator/.test(who.role) && who.avatar === 'AM' && who.me === SUBJECT, JSON.stringify(who));
    const flashed = await page.evaluate(() => Array.from(document.querySelectorAll('.flash')).some((f) => /Signed in/.test(f.textContent)));
    rec('AUTH', 'a flash confirms the sign-in', flashed);
    const caps = await page.evaluate(() => window.ARGUS.capabilities());
    rec('AUTH', 'capabilities now carry the principal', caps && caps.auth && caps.auth.authenticated === true && caps.auth.subject === SUBJECT, JSON.stringify(caps && caps.auth));

    for (const route of ROUTES) {
      await goto(page, route);
      await page.waitForTimeout(250);
      const probe = await page.evaluate(() => {
        const main = document.getElementById('main');
        return { chars: main.textContent.trim().length, headings: main.querySelectorAll('h1,h2').length, dialog: !!document.querySelector('.dialog') };
      });
      rec('LIVE', route + ' renders over http while signed in', probe.chars > 80 && probe.headings > 0 && !probe.dialog, JSON.stringify(probe));
      await page.screenshot({ path: path.join(SHOTS, route + '.png') });
    }

    for (const route of LIVE_ONLY) {
      await goto(page, route);
      await page.waitForTimeout(400);
      const text = await page.evaluate(() => document.getElementById('main').textContent);
      const sampleWarning = /sample data|console API is not running/i.test(text);
      rec('LIVE', route + ' reads the API rather than showing the sample-mode notice', !sampleWarning, text.slice(0, 120));
    }

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
        await mod({ page, rec: (id, pass, detail) => rec(suite, id, pass, detail), goto, waitFor, origin: ORIGIN, server, get, sleep });
      } catch (err) {
        rec(suite, 'module ' + file + ' ran to the end', false, String(err && err.stack || err));
      }
    }

    const stranded = [];
    for (const route of ROUTES) {
      const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const pg = await fresh.newPage();
      pg.on('pageerror', (e) => pageErrors.push(route + ': ' + e));
      await pg.goto(ORIGIN + '/#/' + route, { waitUntil: 'domcontentloaded' });
      const asked = await waitFor(pg, () => {
        const h = document.querySelector('.dialog h2');
        return h && h.textContent === 'Sign in to the console';
      }, null, 6000);
      if (!asked) stranded.push(route);
      await fresh.close();
    }
    rec('AUTH', 'a signed-out browser opening any screen directly reaches the sign-in dialog', stranded.length === 0, stranded.join(','));

    const expiring = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
    const returned = painted && await waitFor(ep, () => {
      const h = document.querySelector('.dialog h2');
      return h && h.textContent === 'Sign in to the console';
    }, null, 6000);
    rec('AUTH', 'a session ending while on the Advisor brings the dialog back and the page stays responsive', !!returned);
    await expiring.close();

    const health = await page.evaluate(() => window.ARGUS.storeHealth());
    rec('LIVE', 'the store counted real reads and the last one succeeded', health.reads > 0 && health.lastOkAt && !health.signedOut, JSON.stringify({ reads: health.reads, failures: health.failures }));

    await page.reload();
    await page.waitForFunction(() => window.ARGUS && window.ARGUS.storeMode() === 'live');
    await page.waitForTimeout(100);
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

    await page.fill('#signin-subject', SUBJECT);
    await page.fill('#signin-password', PASSWORD);
    await page.keyboard.press('Enter');
    await waitFor(page, () => !document.querySelector('.dialog'));
    await page.evaluate(() => window.ARGUS.signOutNow());
    const signedOut = await waitFor(page, () => {
      const h = document.querySelector('.dialog h2');
      return h && h.textContent === 'Sign in to the console';
    });
    rec('AUTH', 'signing out from the console ends the session and asks again', signedOut);
    const whoAfter = await page.evaluate(() => document.querySelector('#whobtn .who-text b').textContent);
    rec('AUTH', 'the operator pill falls back after sign-out', whoAfter === 'Adil Munawar', whoAfter);
    const cookieGone = (await ctx.cookies(ORIGIN)).filter((c) => /argus_sid/.test(c.name)).length === 0;
    rec('AUTH', 'the session cookie is cleared on sign-out', cookieGone);

    await page.click('.dialog .btn.ghost');
    const sample = await waitFor(page, () => !document.querySelector('.dialog') && document.getElementById('modepill').textContent.trim() === 'Sample data');
    rec('AUTH', 'choosing sample data instead closes the dialog and switches the pill', sample, await page.evaluate(pillText));
    await goto(page, 'storage');
    await page.waitForTimeout(150);
    const sampleNotice = await page.evaluate(() => /sample|console API/i.test(document.getElementById('main').textContent));
    rec('AUTH', 'a live-only screen explains itself in sample mode', sampleNotice);

    const unexpectedErrors = consoleErrors.filter((m) => !/status of 401/.test(m));
    rec('CONS', 'no console errors over http beyond the 401 the suite provokes', unexpectedErrors.length === 0, unexpectedErrors.slice(0, 4).join(' | '));
    rec('CONS', 'no page errors over http', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
    const realFails = failedReqs.filter((u) => !/ERR_ABORTED/.test(u));
    rec('CONS', 'no failed requests over http beyond reads the console itself abandoned on route change', realFails.length === 0, realFails.slice(0, 4).join(' | '));
    const audit = server.out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((r) => r && r.stream === 'argus.console.audit').map((r) => r.event);
    rec('CONS', 'the server audited the failed, successful and ended sign-ins',
      audit.includes('auth.login.failed') && audit.includes('auth.login.succeeded') && audit.includes('auth.logout'), audit.join(','));
    const leaked = /correct-horse/.test(server.out + server.err);
    rec('CONS', 'the password never reached the server log', !leaked);
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
  console.log('\n  Argus Console: live suite against the console API');
  console.log('  ' + '-'.repeat(64));
  Object.keys(bySuite).forEach((s) => {
    const b = bySuite[s];
    console.log('  ' + s.padEnd(8) + ' ' + String(b.pass).padStart(3) + ' passed  ' + String(b.fail).padStart(3) + ' failed');
  });
  console.log('  ' + '-'.repeat(64));
  const fails = results.filter((r) => !r.pass);
  if (fails.length) {
    console.log('\n  Failures:\n');
    fails.forEach((f) => console.log('  [' + f.suite + '] ' + f.id + '\n        ' + f.detail));
  } else {
    console.log('\n  All checks passed.');
  }
  console.log('\n  ' + (results.length - fails.length) + '/' + results.length + ' passed. Screenshots in ' + SHOTS + '\n');
  fs.writeFileSync(path.join(__dirname, 'live-last-run.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fails.length);
})();
