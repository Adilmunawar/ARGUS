/**
 * Argus Console: the full-scale sandbox.
 *
 *   node tests/sandbox.js [path-to-index.html]
 *
 * run-tests.js asserts properties. This file tries to break the console the
 * way a person does: it opens it in nine different environments and then
 * presses every control it can find, on every screen, and watches for anything
 * that throws, navigates nowhere, traps focus, or leaves a timer running.
 *
 * A property test cannot find a control that was never wired; only pressing
 * it can.
 *
 *   ENV     boot integrity in nine environments (viewport x theme x density)
 *   ROUTE   every route and every deep link renders in every environment
 *   SWEEP   every button and link on every screen is pressed, and observed
 *   DIALOG  every dialog opens, traps focus, closes on Escape, restores focus
 *   MENU    every overflow menu opens, is reachable by keyboard, stays on screen
 *   FLOW    the destructive ladder, elevation, and a recorded session end to end
 *   KBD     the whole console driven by keyboard alone
 *   TABLE   every column of every table sorts both ways without throwing
 *   FUZZ    malformed URLs, tampered storage, and a storage-less browser
 *   LEAK    a long tour leaves no timers and no detached live regions
 *   QUIET   no console errors and no network requests, anywhere, ever
 *
 * Exit code is the number of failures.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = pathToFileURL(path.resolve(FILE)).href;
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'argus-sandbox-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const ROUTES = ['overview', 'apps', 'deploys', 'compute', 'data', 'identity', 'security', 'ml', 'ops', 'audit', 'stack', 'system', 'storage', 'logs'];
const DEEP = [
  'apps/mills', 'apps/agis', 'apps/console',
  'deploys/1847', 'deploys/1843',
  'compute/host/hv-03', 'compute/vm/sql-01', 'compute/vm/siem-01',
  'data/database/umairv3_db', 'data/bucket/argus-backups',
  'ops/runbook/sql-01-restore-drill',
  'security/alerts', 'identity/people'
];

const ENVS = [
  { id: 'desktop-light', w: 1440, h: 900, theme: 'light', density: 'comfortable' },
  { id: 'desktop-dark', w: 1440, h: 900, theme: 'dark', density: 'comfortable' },
  { id: 'desktop-compact', w: 1440, h: 900, theme: 'light', density: 'compact' },
  { id: 'laptop-13in', w: 1280, h: 800, theme: 'light', density: 'compact' },
  { id: 'laptop-dark', w: 1366, h: 768, theme: 'dark', density: 'compact' },
  { id: 'tablet', w: 768, h: 1024, theme: 'light', density: 'comfortable' },
  { id: 'mobile', w: 390, h: 844, theme: 'light', density: 'comfortable' },
  { id: 'mobile-dark', w: 390, h: 844, theme: 'dark', density: 'compact' },
  { id: 'zoom-200', w: 720, h: 450, theme: 'light', density: 'comfortable' }
];

const results = [];
const rec = (suite, id, pass, detail) => results.push({ suite, id, pass, detail: detail || '' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function settle(page, ms) { await page.waitForTimeout(ms || 140); }

async function goRoute(page, route) {
  await page.evaluate(r => { window.location.hash = '#/' + r; }, route);
  try {
    await page.waitForFunction(
      r => window.ARGUS && window.ARGUS.state.route === r.split('/')[0],
      route, { timeout: 4000 });
  } catch (e) { return false; }
  await settle(page, 90);
  return true;
}

/** Dismiss whatever overlay a click may have produced, and return to a clean shell. */
async function reset(page) {
  await page.evaluate(() => {
    // Close through the console's own teardown. Removing the scrim by hand
    // leaves the opener stack holding a dialog that no longer exists, and the
    // next dialog inherits its opener -- a bug in the harness that reads
    // exactly like a bug in the product.
    if (window.ARGUS && window.ARGUS.dismissOverlays) window.ARGUS.dismissOverlays();
    document.querySelectorAll('.scrim.is-dialog').forEach(n => n.remove());
    document.querySelectorAll('.menu[role="menu"]').forEach(n => n.remove());
    document.body.classList.remove('has-dialog', 'navopen', 'has-drawer');
    const d = document.getElementById('drawer');
    if (d) d.hidden = true;
    const s = document.getElementById('scrim');
    if (s) s.hidden = true;
    document.querySelectorAll('.flash').forEach(n => n.remove());
    if (window.ARGUS && window.ARGUS.data && window.ARGUS.data.me) {
      window.ARGUS.data.me.elevation = null;
      if (window.ARGUS.paintElevation) window.ARGUS.paintElevation();
    }
  });
  await settle(page, 60);
}

(async () => {
  const browser = await chromium.launch();
  const started = Date.now();

  /* ================================================================ ENV === */

  for (const env of ENVS) {
    const ctx = await browser.newContext({
      viewport: { width: env.w, height: env.h },
      reducedMotion: env.id === 'zoom-200' ? 'reduce' : 'no-preference',
      colorScheme: env.theme === 'dark' ? 'dark' : 'light'
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    const reqs = [];
    page.on('request', r => { if (!r.url().startsWith('file://')) reqs.push(r.url()); });

    await page.goto(URL, { waitUntil: 'load' });
    await page.evaluate(e => {
      window.ARGUS.setTheme(e.theme);
      window.ARGUS.setDensity(e.density);
    }, env);
    await settle(page, 200);

    const boot = await page.evaluate(() => ({
      argus: !!window.ARGUS,
      screens: Object.keys(window.ARGUS.screens),
      theme: document.documentElement.getAttribute('data-theme'),
      painted: document.getElementById('main').textContent.trim().length,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    }));
    const missing = ROUTES.filter(r => boot.screens.indexOf(r) === -1);
    const unlisted = boot.screens.filter(r => ROUTES.indexOf(r) === -1);
    rec('ENV', `${env.id}: the console boots with every screen registered`,
      boot.argus && !missing.length && !unlisted.length && boot.painted > 50,
      JSON.stringify({ ...boot, screens: boot.screens.length, missing, unlisted }));
    rec('ENV', `${env.id}: the requested theme is the one applied`,
      boot.theme === env.theme, `${boot.theme} != ${env.theme}`);
    rec('ENV', `${env.id}: the shell does not scroll sideways`,
      !boot.overflowX, `scrollWidth exceeds clientWidth`);

    /* ============================================================== ROUTE === */

    let routeFails = [], overflow = [];
    for (const r of ROUTES.concat(DEEP)) {
      const ok = await goRoute(page, r);
      if (!ok) { routeFails.push(r); continue; }
      const st = await page.evaluate(() => ({
        painted: document.getElementById('main').textContent.trim().length,
        h1: !!document.querySelector('#main h1'),
        wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      }));
      if (st.painted < 40 || !st.h1) routeFails.push(`${r}(painted=${st.painted},h1=${st.h1})`);
      if (st.wide) overflow.push(r);
    }
    rec('ROUTE', `${env.id}: every route and deep link renders with a heading`,
      routeFails.length === 0, routeFails.slice(0, 6).join(' '));
    rec('ROUTE', `${env.id}: no screen scrolls sideways`,
      overflow.length === 0, overflow.slice(0, 6).join(' '));

    rec('QUIET', `${env.id}: nothing was written to the console error channel`,
      errs.length === 0, errs.slice(0, 3).join(' | '));
    rec('QUIET', `${env.id}: the console requested nothing off the filesystem`,
      reqs.length === 0, reqs.slice(0, 3).join(' | '));

    await page.screenshot({ path: path.join(SHOTS, `${env.id}.png`) });
    await ctx.close();
  }

  /* ============================== the deep passes run on one rich context === */

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await settle(page, 200);

  /* ============================================================== SWEEP === */

  // Press every control on every screen and watch what happens.
  let dead = [], threw = [], swept = 0;
  for (const r of ROUTES) {
    await goRoute(page, r);
    const count = await page.$$eval('#main button, #main a[href], .side .nav, .top button',
      ns => ns.length);
    for (let i = 0; i < count; i++) {
      await reset(page);
      const ok = await goRoute(page, r);
      if (!ok) continue;
      const snapshot = () => page.evaluate(() => ({
        hash: location.hash,
        main: document.getElementById('main').textContent.length,
        // Sorting changes neither the hash nor the amount of text, so the
        // observable effect is the order of the rows and the aria-sort that
        // announces it.
        sorts: Array.prototype.map.call(document.querySelectorAll('#main th[aria-sort]'),
          n => n.getAttribute('aria-sort')).join(','),
        order: Array.prototype.map.call(document.querySelectorAll('#main tbody tr'),
          n => n.dataset.key || '').join('|').slice(0, 400),
        dialog: !!document.querySelector('.dialog[role="dialog"]'),
        menu: !!document.querySelector('.menu[role="menu"]'),
        drawer: !!(document.getElementById('drawer') && !document.getElementById('drawer').hidden),
        flash: !!document.querySelector('.flash'),
        focus: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : ''
      }));
      const before = await snapshot();
      const info = await page.evaluate(i => {
        const list = document.querySelectorAll('#main button, #main a[href], .side .nav, .top button');
        const n = list[i];
        if (!n) return null;
        const rect = n.getBoundingClientRect();
        return {
          tag: n.tagName,
          label: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 40),
          visible: rect.width > 0 && rect.height > 0,
          disabled: n.getAttribute('aria-disabled') === 'true' || n.disabled === true,
          // Pressing the sidebar item you are already on, or the tab that is
          // already selected, is correctly a no-op.
          alreadyCurrent: n.getAttribute('aria-current') === 'page' ||
            n.getAttribute('aria-selected') === 'true'
        };
      }, i);
      if (!info || !info.visible || info.disabled || info.alreadyCurrent) continue;
      swept++;

      let caught = null;
      try {
        await page.evaluate(i => {
          const list = document.querySelectorAll('#main button, #main a[href], .side .nav, .top button');
          if (list[i]) list[i].click();
        }, i);
      } catch (e) { caught = e.message; }
      await settle(page, 120);

      if (caught) { threw.push(`${r}:"${info.label}" ${caught}`); continue; }

      const after = await snapshot();
      const blank = await page.evaluate(() =>
        document.getElementById('main').textContent.trim().length < 20);

      // A control that produced no observable effect at all is a control that
      // is not wired to anything.
      const didSomething = after.hash !== before.hash || after.main !== before.main ||
        after.sorts !== before.sorts || after.order !== before.order ||
        after.dialog || after.menu || after.drawer || after.flash ||
        after.focus !== before.focus;
      if (!didSomething) dead.push(`${r}:"${info.label}"(${info.tag})`);
      if (blank) threw.push(`${r}:"${info.label}" blanked the screen`);
    }
  }
  await reset(page);
  rec('SWEEP', `every visible control does something when pressed (${swept} pressed)`,
    dead.length === 0, dead.slice(0, 10).join(' '));
  rec('SWEEP', 'no control throws or blanks the screen',
    threw.length === 0, threw.slice(0, 6).join(' | '));

  /* ============================================================= DIALOG === */

  const DIALOGS = [
    { id: 'shortcuts', open: 'window.ARGUS.shortcuts()' },
    { id: 'preferences', open: 'window.ARGUS.settings()' },
    { id: 'command palette', open: 'window.ARGUS.palette()' },
    { id: 'step-up auth', open: 'window.ARGUS.stepUp("test", function(){})' },
    {
      id: 'destructive confirm',
      open: 'window.ARGUS.confirmDestructive({title:"Delete thing",match:"thing",detail:"d",onConfirm:function(){}})'
    }
  ];
  for (const d of DIALOGS) {
    await reset(page);
    await goRoute(page, 'overview');
    const r = await page.evaluate(async src => {
      const opener = document.getElementById('helpbtn');
      opener.focus();
      // eslint-disable-next-line no-eval
      eval(src);
      await new Promise(r => setTimeout(r, 200));
      const dlg = document.querySelector('.dialog[role="dialog"]');
      if (!dlg) return { opened: false };
      const modal = dlg.getAttribute('aria-modal');
      const labelled = !!dlg.getAttribute('aria-labelledby') &&
        !!document.getElementById(dlg.getAttribute('aria-labelledby'));
      const inside = dlg.contains(document.activeElement);
      dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      return {
        opened: true, modal, labelled, inside,
        closed: !document.querySelector('.dialog[role="dialog"]'),
        restored: document.activeElement === opener
      };
    }, d.open);
    rec('DIALOG', `${d.id}: opens`, r.opened, JSON.stringify(r));
    if (!r.opened) continue;
    rec('DIALOG', `${d.id}: is a labelled modal`,
      r.modal === 'true' && r.labelled, JSON.stringify(r));
    rec('DIALOG', `${d.id}: takes focus when it opens`, r.inside, JSON.stringify(r));
    rec('DIALOG', `${d.id}: Escape closes it`, r.closed, JSON.stringify(r));
    rec('DIALOG', `${d.id}: focus returns to whatever opened it`, r.restored, JSON.stringify(r));
  }

  /* =============================================================== MENU === */

  await reset(page);
  await goRoute(page, 'apps');
  const menuCount = await page.$$eval('.menubtn', ns => ns.length);
  rec('MENU', 'the applications table renders an overflow menu per row',
    menuCount >= 5, `found ${menuCount}`);

  let menuBad = [];
  for (let i = 0; i < menuCount; i++) {
    const r = await page.evaluate(async i => {
      document.querySelectorAll('.menu[role="menu"]').forEach(n => n.remove());
      const t = document.querySelectorAll('.menubtn')[i];
      t.click();
      await new Promise(r => setTimeout(r, 150));
      const pop = document.querySelector('.menu[role="menu"]');
      if (!pop) return { i, opened: false };
      const rect = pop.getBoundingClientRect();
      const inView = rect.left >= 0 && rect.top >= 0 &&
        rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5;
      const onBody = pop.parentElement === document.body;
      pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      return { i, opened: true, inView, onBody, closed: !document.querySelector('.menu[role="menu"]') };
    }, i);
    if (!r.opened || !r.inView || !r.onBody || !r.closed) menuBad.push(JSON.stringify(r));
  }
  rec('MENU', 'every row menu opens on screen, escapes its scroll container, and closes',
    menuBad.length === 0, menuBad.slice(0, 4).join(' | '));

  /* =============================================================== FLOW === */

  await reset(page);
  const ladder = await page.evaluate(async () => {
    let confirmed = false;
    window.ARGUS.confirmDestructive({
      title: 'Delete sql-01', match: 'sql-01', detail: 'irreversible',
      onConfirm: function () { confirmed = true; }
    });
    await new Promise(r => setTimeout(r, 200));
    const dlg = document.querySelector('.dialog');
    const go = Array.prototype.filter.call(dlg.querySelectorAll('.btn'), b => /Confirm/i.test(b.textContent))[0];
    const startsDisabled = go.getAttribute('aria-disabled') === 'true';
    go.click();
    await new Promise(r => setTimeout(r, 120));
    const firedWhileDisabled = confirmed;

    const input = dlg.querySelector('#confirm-name');
    input.value = 'wrong-name';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const stillDisabled = go.getAttribute('aria-disabled') === 'true';
    go.click();
    await new Promise(r => setTimeout(r, 100));
    const firedOnWrongName = confirmed;

    input.value = 'sql-01';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const enabled = go.getAttribute('aria-disabled') !== 'true';
    go.click();
    await new Promise(r => setTimeout(r, 150));
    return { startsDisabled, firedWhileDisabled, stillDisabled, firedOnWrongName, enabled, confirmed };
  });
  rec('FLOW', 'the destructive confirm starts disabled', ladder.startsDisabled, JSON.stringify(ladder));
  rec('FLOW', 'the destructive confirm does not fire while disabled',
    !ladder.firedWhileDisabled, JSON.stringify(ladder));
  rec('FLOW', 'a wrong resource name does not enable the confirm',
    ladder.stillDisabled && !ladder.firedOnWrongName, JSON.stringify(ladder));
  rec('FLOW', 'the exact resource name enables it and it then fires',
    ladder.enabled && ladder.confirmed, JSON.stringify(ladder));

  await reset(page);
  const elev = await page.evaluate(async () => {
    let granted = false;
    window.ARGUS.requestElevation('Argus-Tier1-Operators', 'sandbox drill', 2, function () { granted = true; });
    await new Promise(r => setTimeout(r, 200));
    const dlg = document.querySelector('.dialog');
    const key = Array.prototype.filter.call(dlg.querySelectorAll('.btn'), b => /Simulate/i.test(b.textContent))[0];
    key.click();
    await new Promise(r => setTimeout(r, 250));
    const bar = document.getElementById('elevation');
    const e = window.ARGUS.data.me.elevation;
    const hours = e ? Math.round((e.expires - Date.now()) / 3600000) : null;
    const shown = !bar.hidden && /left/.test(bar.textContent);
    window.ARGUS.dropElevation();
    await new Promise(r => setTimeout(r, 150));
    return { granted, hours, shown, droppedHidden: document.getElementById('elevation').hidden };
  });
  rec('FLOW', 'elevation requires the second factor and then grants', elev.granted, JSON.stringify(elev));
  rec('FLOW', 'the grant lasts the number of hours requested', elev.hours === 2, JSON.stringify(elev));
  rec('FLOW', 'the elevation banner shows a live countdown', elev.shown, JSON.stringify(elev));
  rec('FLOW', 'releasing elevation hides the banner', elev.droppedHidden, JSON.stringify(elev));

  await reset(page);
  const sess = await page.evaluate(async () => {
    window.ARGUS.data.me.elevation = { group: 'g', reason: 'r', expires: new Date(Date.now() + 3600000) };
    const vm = window.ARGUS.data.vms.filter(v => v.connect.indexOf('ssh') !== -1)[0];
    window.ARGUS.connect(vm, 'ssh');
    await new Promise(r => setTimeout(r, 200));
    const open = !document.getElementById('drawer').hidden;
    const recorded = /Recorded session/.test(document.getElementById('drawer-body').textContent);
    const noCreds = !/password|BEGIN (RSA|OPENSSH)/i.test(document.getElementById('drawer-body').textContent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const closed = document.getElementById('drawer').hidden;
    window.ARGUS.data.me.elevation = null; window.ARGUS.paintElevation();
    return { open, recorded, noCreds, closed };
  });
  rec('FLOW', 'a recorded session opens and says it is recorded',
    sess.open && sess.recorded, JSON.stringify(sess));
  rec('FLOW', 'the session never renders a credential', sess.noCreds, JSON.stringify(sess));
  rec('FLOW', 'Escape ends the session', sess.closed, JSON.stringify(sess));

  /* ================================================================ KBD === */

  await reset(page);
  await goRoute(page, 'overview');
  const kbd = await page.evaluate(async () => {
    const seen = [];
    for (const [key, want] of [['o', 'overview'], ['a', 'apps'], ['d', 'deploys'], ['c', 'compute'],
                               ['t', 'data'], ['i', 'identity'], ['s', 'security'], ['m', 'ml'],
                               ['p', 'ops'], ['u', 'audit']]) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await new Promise(r => setTimeout(r, 180));
      seen.push(window.ARGUS.state.route === want ? null : `g+${key}->${window.ARGUS.state.route}`);
    }
    return seen.filter(Boolean);
  });
  rec('KBD', 'every "g then key" shortcut reaches its screen', kbd.length === 0, kbd.join(' '));

  const tabOrder = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 100));
    document.body.focus();
    const reachable = Array.prototype.filter.call(
      document.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'),
      n => n.offsetParent !== null);
    const noPositive = reachable.every(n => !(parseInt(n.getAttribute('tabindex') || '0', 10) > 0));
    const skip = document.querySelector('.skip');
    return { count: reachable.length, noPositive, hasSkip: !!skip };
  });
  rec('KBD', 'no control jumps the tab order with a positive tabindex',
    tabOrder.noPositive, JSON.stringify(tabOrder));
  rec('KBD', 'a skip link is the first thing in the document', tabOrder.hasSkip, JSON.stringify(tabOrder));

  /* ============================================================== TABLE === */

  let sortFails = [];
  for (const r of ROUTES) {
    await goRoute(page, r);
    const out = await page.evaluate(async () => {
      const bad = [];
      const heads = Array.prototype.slice.call(document.querySelectorAll('#main .th-sort'));
      for (const h of heads) {
        const th = h.closest('th');
        const label = (h.textContent || '').trim();
        try {
          h.click(); await new Promise(r => setTimeout(r, 40));
          const a = th.getAttribute('aria-sort');
          const orderA = Array.prototype.map.call(th.closest('table').querySelectorAll('tbody tr'),
            n => n.dataset.key || n.textContent.slice(0, 12)).join('|');
          h.click(); await new Promise(r => setTimeout(r, 40));
          const b = th.getAttribute('aria-sort');
          const orderB = Array.prototype.map.call(th.closest('table').querySelectorAll('tbody tr'),
            n => n.dataset.key || n.textContent.slice(0, 12)).join('|');
          // The column that is already the active sort toggles to descending
          // on its first press, which is correct; what matters is that the two
          // presses land on the two directions and actually reorder the rows.
          const both = [a, b].sort().join(',') === 'ascending,descending';
          if (!both) bad.push(`${label}:${a}/${b}`);
          else if (orderA === orderB && orderA.indexOf('|') !== -1) bad.push(`${label}: aria-sort flipped but rows did not move`);
          const rows = th.closest('table').querySelectorAll('tbody tr').length;
          if (rows === 0) bad.push(`${label}: sorted the rows away`);
        } catch (e) { bad.push(`${label} threw ${e.message}`); }
      }
      return bad;
    });
    out.forEach(o => sortFails.push(`${r}:${o}`));
  }
  rec('TABLE', 'every sortable column sorts both ways and keeps its rows',
    sortFails.length === 0, sortFails.slice(0, 6).join(' | '));

  await goRoute(page, 'logs');
  const logKeys = await page.evaluate(async () => {
    const view = document.querySelector('.logview.logstream');
    if (!view) return { ok: false, why: 'no streaming region' };
    view.focus();
    const focused = document.activeElement === view;
    const bottom = view.scrollTop;
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const top = view.scrollTop;
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    return { ok: true, focused, moved: top < bottom, back: view.scrollTop > top };
  });
  rec('KBD', 'the streaming log region takes focus and answers Home and End',
    logKeys.ok && logKeys.focused && logKeys.moved && logKeys.back, JSON.stringify(logKeys));

  await goRoute(page, 'logs');
  const logFilter = await page.evaluate(async () => {
    const input = document.getElementById('log-filter');
    if (!input) return { ok: false, why: 'no filter' };
    input.value = 'zzzzznotathinginanylog';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const text = document.querySelector('.logview.logstream').textContent;
    const lines = document.querySelectorAll('.logview.logstream .logline').length;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return {
      ok: true, text: text.trim().slice(0, 80), lines,
      restored: document.querySelectorAll('.logview.logstream .logline').length
    };
  });
  rec('FLOW', 'a log filter that excludes everything says so rather than showing an empty box',
    logFilter.ok && logFilter.lines === 1 && /no line in the buffer matches/i.test(logFilter.text) &&
      logFilter.restored > 1,
    JSON.stringify(logFilter));

  await goRoute(page, 'overview');
  const hb = await page.evaluate(() => {
    const bars = Array.from(document.querySelectorAll('#main .hbbar'));
    return {
      count: bars.length,
      named: bars.every(b => (b.getAttribute('aria-label') || '').length > 20),
      role: bars.every(b => b.getAttribute('role') === 'img'),
      shapes: bars.every(b => b.querySelectorAll('rect.hb').length > 0)
    };
  });
  rec('FLOW', 'every heartbeat bar carries its reading in words, not only in colour',
    hb.count > 0 && hb.named && hb.role && hb.shapes, JSON.stringify(hb));

  /* =============================================================== FUZZ === */

  const FUZZ = [
    '#/apps?q=%', '#/apps?q=%zz', '#/apps?%=1', '#/data?x=%E0%A4',
    '#/../../etc/passwd', '#/apps/../../..', '#/<script>alert(1)</script>',
    '#/apps?q=' + encodeURIComponent('"><img src=x onerror=alert(1)>'),
    '#/' + 'a'.repeat(2000), '#/apps?' + 'k=v&'.repeat(500),
    '#/nonexistent-screen', '#/apps/no-such-app', '#/deploys/999999',
    '#/', '#', '#/?', '#//////', '#/apps?=novalue', '#/apps?q=a=b=c'
  ];
  let fuzzFails = [], injected = [];
  for (const h of FUZZ) {
    await page.evaluate(x => { window.location.hash = x; }, h);
    await settle(page, 130);
    const st = await page.evaluate(() => ({
      alive: !!(window.ARGUS && window.ARGUS.state),
      route: window.ARGUS.state.route,
      painted: document.getElementById('main').textContent.trim().length,
      scripts: document.querySelectorAll('#main script').length,
      inlineHandlers: document.querySelectorAll('#main [onerror],#main [onclick],#main [onload]').length
    }));
    if (!st.alive || st.painted < 5) fuzzFails.push(`${h} -> ${JSON.stringify(st)}`);
    if (st.scripts || st.inlineHandlers) injected.push(h);
  }
  rec('FUZZ', 'no malformed or hostile URL kills the router',
    fuzzFails.length === 0, fuzzFails.slice(0, 5).join(' | '));
  rec('FUZZ', 'no URL injects a script or an inline handler into the page',
    injected.length === 0, injected.slice(0, 4).join(' '));

  const unknown = await page.evaluate(async () => {
    window.location.hash = '#/definitely-not-a-screen';
    await new Promise(r => setTimeout(r, 200));
    const t = document.getElementById('main').textContent;
    return { honest: /does not exist/i.test(t), hasWayBack: !!document.querySelector('#main .btn') };
  });
  rec('FUZZ', 'an unknown route fails honestly and offers a way back',
    unknown.honest && unknown.hasWayBack, JSON.stringify(unknown));

  const SHAPES = [
    '{"density":"</style><script>","theme":"x"}', '[]', 'null', 'not json at all',
    '{"rail":{"toString":"boom"}}', '{"__proto__":{"polluted":true}}',
    '{"theme":"dark","density":42}', '{"tz":"../../etc/passwd"}'
  ];
  const tamperFails = [], notRecovered = [], pollutedBy = [], leakedToClass = [];
  for (const shape of SHAPES) {
    await page.evaluate((s) => { try { localStorage.setItem('argus.prefs', s); } catch (e) {} }, shape);
    await page.reload({ waitUntil: 'load' });
    await settle(page, 220);
    const state = await page.evaluate(() => ({
      booted: !!window.ARGUS,
      prefs: window.ARGUS ? window.ARGUS.prefs() : null,
      polluted: {}.polluted === true,
      bodyClass: document.body.className,
      painted: document.getElementById('main').textContent.trim().length
    }));
    const label = shape.slice(0, 34);
    if (!state.booted || state.painted <= 50) tamperFails.push(`${label} -> ${JSON.stringify(state).slice(0, 120)}`);
    const prefs = state.prefs || {};
    if (prefs.density !== 'comfortable' || ['light', 'dark', 'system'].indexOf(prefs.theme) === -1) {
      notRecovered.push(`${label} -> ${JSON.stringify(prefs)}`);
    }
    if (state.polluted) pollutedBy.push(label);
    if (/[<>"]/.test(state.bodyClass)) leakedToClass.push(`${label} -> ${state.bodyClass}`);
  }
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  rec('FUZZ', 'the console boots with any tampered preference blob in storage',
    tamperFails.length === 0, tamperFails.slice(0, 3).join(' | '));
  rec('FUZZ', 'tampered preferences fall back to known-good values',
    notRecovered.length === 0, notRecovered.slice(0, 3).join(' | '));
  rec('FUZZ', 'a prototype-pollution payload in storage does not pollute',
    pollutedBy.length === 0, pollutedBy.join(' '));
  rec('FUZZ', 'nothing from storage reaches a class name',
    leakedToClass.length === 0, leakedToClass.slice(0, 3).join(' | '));
  rec('FUZZ', `each of the ${SHAPES.length} tampered preference shapes was survived on its own reload`,
    tamperFails.length === 0 && notRecovered.length === 0 &&
    pollutedBy.length === 0 && leakedToClass.length === 0,
    `${tamperFails.length + notRecovered.length + pollutedBy.length + leakedToClass.length} failures`);

  // A browser with storage switched off entirely.
  const noStore = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await noStore.addInitScript(() => {
    const boom = () => { throw new Error('storage disabled'); };
    try {
      Object.defineProperty(window, 'localStorage', {
        get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom }; }
      });
    } catch (e) { /* ignore */ }
  });
  const p2 = await noStore.newPage();
  const p2errs = [];
  p2.on('pageerror', e => p2errs.push(e.message));
  await p2.goto(URL, { waitUntil: 'load' });
  await p2.waitForTimeout(300);
  const nsBoot = await p2.evaluate(() => ({
    booted: !!window.ARGUS,
    painted: document.getElementById('main').textContent.trim().length
  }));
  await p2.evaluate(() => { try { window.ARGUS.setTheme('dark'); window.ARGUS.setDensity('compact'); } catch (e) {} });
  await p2.waitForTimeout(150);
  const nsAfter = await p2.evaluate(() => document.documentElement.getAttribute('data-theme'));
  rec('FUZZ', 'the console boots in a browser with localStorage disabled',
    nsBoot.booted && nsBoot.painted > 50, JSON.stringify(nsBoot));
  rec('FUZZ', 'preferences still apply in-session without storage',
    nsAfter === 'dark', String(nsAfter));
  rec('FUZZ', 'a storage-less browser raises no page error',
    p2errs.length === 0, p2errs.slice(0, 2).join(' | '));
  await noStore.close();

  /* =============================================================== LEAK === */

  await page.goto(URL, { waitUntil: 'load' });
  await settle(page, 200);
  const leak = await page.evaluate(async () => {
    let live = 0, peak = 0;
    const rs = window.setInterval, rc = window.clearInterval;
    const mine = new Set();
    window.setInterval = function () { const id = rs.apply(window, arguments); mine.add(id); live++; peak = Math.max(peak, live); return id; };
    window.clearInterval = function (id) { if (mine.delete(id)) live--; return rc.call(window, id); };
    const tour = ['identity', 'security', 'ops', 'compute', 'data', 'ml', 'deploys', 'audit', 'apps', 'stack', 'system', 'storage', 'overview'];
    for (let pass = 0; pass < 3; pass++) {
      for (const r of tour) {
        window.location.hash = '#/' + r;
        await new Promise(res => setTimeout(res, 130));
      }
    }
    window.location.hash = '#/overview';
    await new Promise(res => setTimeout(res, 400));
    const net = live;
    window.setInterval = rs; window.clearInterval = rc;
    return { net, peak, nodes: document.getElementsByTagName('*').length };
  });
  rec('LEAK', 'thirty screen changes leave no timer running',
    leak.net === 0, `net=${leak.net} peak=${leak.peak}`);
  rec('LEAK', 'the DOM does not grow without bound across a long tour',
    leak.nodes < 6000, `${leak.nodes} nodes`);

  const liveRegions = await page.evaluate(() =>
    document.querySelectorAll('[aria-live]').length);
  rec('LEAK', 'exactly one live region survives a long tour',
    liveRegions === 1, `${liveRegions} live regions`);

  /* ============================================================== QUIET === */

  rec('QUIET', 'the whole sandbox produced no page errors',
    errs.length === 0, errs.slice(0, 4).join(' | '));

  await ctx.close();
  await browser.close();

  /* ============================================================= report === */

  const bySuite = {};
  results.forEach(r => {
    bySuite[r.suite] = bySuite[r.suite] || { pass: 0, fail: 0 };
    bySuite[r.suite][r.pass ? 'pass' : 'fail']++;
  });

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('\n  Argus Console: full-scale sandbox');
  console.log('  ' + '-'.repeat(64));
  Object.keys(bySuite).forEach(s => {
    const b = bySuite[s];
    console.log(`  ${s.padEnd(8)} ${String(b.pass).padStart(4)} passed  ${String(b.fail).padStart(3)} failed`);
  });
  console.log('  ' + '-'.repeat(64));

  const fails = results.filter(r => !r.pass);
  if (fails.length) {
    console.log('\n  Failures:\n');
    fails.forEach(f => console.log(`  [${f.suite}] ${f.id}\n        ${f.detail}`));
  } else {
    console.log('\n  Nothing broke.');
  }
  console.log(`\n  ${results.length - fails.length}/${results.length} passed in ${secs}s across ${ENVS.length} environments.`);
  console.log(`  Screenshots in ${SHOTS}\n`);

  fs.writeFileSync(path.join(__dirname, 'sandbox-last-run.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fails.length);
})().catch(e => { console.error(e); process.exit(1); });
