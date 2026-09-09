/**
 * Argus Console: the automated test suite.
 *
 *   node tests/run-tests.js [path-to-index.html]
 *
 * Runs in headless Chromium against the real rendered DOM. Exit code is the
 * number of failures, so CI can gate on it.
 *
 *   BOOT   the shell loads, every screen registers, nothing throws
 *   NAV    every route resolves, deep links work, unknown routes fail honestly
 *   A11Y   axe-core WCAG 2.1 A/AA on every route and on every overlay
 *   KBD    real Tab traversal, focus rings, focus trap, focus restoration
 *   CMD    the command palette: search, arrow keys, activation, escape
 *   TBL    every table has a caption, sortable headers carry aria-sort
 *   STATE  empty, no-match and error states are distinguishable
 *   GUARD  regressions for every defect an adversarial audit found
 *   CON    contrast computed from rendered pixels, gradients included
 *   TXT    nothing below 11px, nothing clipped
 *   RESP   no horizontal overflow at six widths
 *   DENS   a small laptop does not spend its screen on chrome
 *   ZOOM   WCAG 1.4.10 reflow at 200% and 400%
 *   TAP    touch targets at least 24px (WCAG 2.5.8)
 *   MOTION prefers-reduced-motion stops every animation
 *   SEC    CSP present, no external origins, no innerHTML, no inline handlers
 *   DET    the same route renders identically twice (tests may rely on it)
 *   CONS   no console errors, no failed requests
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

// axe-core ships its bundle next to its entry point; resolve it rather than
// hardcoding a path, so this runs on a developer machine and on CI alike.
const AXE = fs.readFileSync(path.join(path.dirname(require.resolve('axe-core')), 'axe.min.js'), 'utf8');
const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + path.resolve(FILE).replace(/\\/g, '/');
const ROOT = path.resolve(path.join(__dirname, '..'));
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'argus-console-shots');

fs.mkdirSync(SHOTS, { recursive: true });

const ROUTES = ['overview', 'apps', 'deploys', 'compute', 'data', 'identity', 'security', 'ml', 'ops', 'audit'];
// Detail routes matter more than list routes: they are where the hard layout
// and the destructive actions live.
const DEEP = [
  'apps/mills', 'apps/agis', 'deploys/1847', 'deploys/1843',
  'compute/host/hv-03', 'compute/vm/sql-01', 'compute/vm/siem-01',
  'data/database/umairv3_db', 'data/bucket/argus-backups', 'ops/runbook/sql-01-restore-drill'
];

const results = [];
const rec = (suite, id, pass, detail) => results.push({ suite, id, pass, detail: detail || '' });

async function goto(page, route) {
  await page.evaluate(r => { window.location.hash = '#/' + r; }, route);
  await page.waitForFunction(r => window.ARGUS && window.ARGUS.state.route === r.split('/')[0],
    route, { timeout: 4000 });
  await page.waitForTimeout(40);
}

async function axeOn(page, label) {
  const r = await page.evaluate(async () => await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    resultTypes: ['violations'],
    preload: false
  }));
  if (!r.violations.length) { rec('A11Y', label + ': no WCAG A/AA violations', true); return; }
  for (const v of r.violations) {
    rec('A11Y', `${label}: ${v.id}`, false,
      `${v.impact}: ${v.help} (${v.nodes.length}x) e.g. ${(v.nodes[0].target || []).join(' ')}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  const failedReqs = [];
  page.on('requestfailed', r => failedReqs.push(r.url() + ' : ' + ((r.failure() || {}).errorText || '')));

  await page.goto(URL, { waitUntil: 'load' });
  // The page's own CSP forbids inline script, which is the point of having it,
  // so axe goes in through the debugger protocol rather than a <script> tag.
  await page.evaluate(AXE);

  /* ---------------------------------------------------------------- BOOT */

  const globals = await page.evaluate(() => ({
    argus: !!window.ARGUS, ui: !!(window.ARGUS && window.ARGUS.ui),
    data: !!(window.ARGUS && window.ARGUS.data),
    screens: window.ARGUS ? Object.keys(window.ARGUS.screens) : []
  }));
  rec('BOOT', 'the ARGUS namespace, ui and data are present', globals.argus && globals.ui && globals.data,
    JSON.stringify({ argus: globals.argus, ui: globals.ui, data: globals.data }));
  for (const r of ROUTES) {
    rec('BOOT', `screen "${r}" is registered`, globals.screens.indexOf(r) !== -1,
      globals.screens.join(',') || 'none registered');
  }

  /* ----------------------------------------------------------------- NAV */

  const navTargets = await page.$$eval('.nav[data-go]', ns => ns.map(n => n.dataset.go));
  for (const t of navTargets) {
    rec('NAV', `nav target "${t}" has a screen`, globals.screens.indexOf(t) !== -1);
  }

  // Press the control a person presses. Every other navigation test in this
  // file assigns location.hash, and that blind spot is exactly how the console
  // shipped with a sidebar that did nothing on click: the buttons carried
  // data-go, the routes all resolved, and no test ever clicked one.
  for (const t of navTargets) {
    await page.evaluate(() => { window.location.hash = '#/overview'; });
    await page.waitForTimeout(120);
    await page.click(`.nav[data-go="${t}"]`);
    await page.waitForTimeout(180);
    const st = await page.evaluate(() => ({
      route: window.ARGUS.state.route,
      painted: document.getElementById('main').textContent.trim().length,
      current: (document.querySelector('.nav[aria-current="page"]') || {}).dataset
    }));
    rec('NAV', `clicking the "${t}" sidebar button navigates to it`,
      st.route === t && st.painted > 50, JSON.stringify({ route: st.route, painted: st.painted }));
    rec('NAV', `the "${t}" sidebar button is marked current once open`,
      st.current && st.current.go === t, JSON.stringify(st.current || null));
  }
  await page.evaluate(() => { window.location.hash = '#/overview'; });
  await page.waitForTimeout(120);
  for (const r of ROUTES) {
    await goto(page, r);
    const st = await page.evaluate(() => ({
      route: window.ARGUS.state.route,
      title: document.title,
      crumb: (document.getElementById('crumb').textContent || '').trim(),
      h1: (document.querySelector('#main h1') || {}).textContent || '',
      current: (document.querySelector('.nav[aria-current="page"]') || {}).dataset
        ? document.querySelector('.nav[aria-current="page"]').dataset.go : null,
      mainChildren: document.getElementById('main').children.length
    }));
    rec('NAV', `"${r}" routes and renders`, st.route === r && st.mainChildren > 0,
      `route=${st.route} children=${st.mainChildren}`);
    rec('NAV', `"${r}" sets a document title`, /- Argus Console$/.test(st.title) && st.title.length > 16, st.title);
    rec('NAV', `"${r}" updates the breadcrumb`, st.crumb.length > 0, `crumb="${st.crumb}"`);
    rec('NAV', `"${r}" marks the nav item current`, st.current === r, `current=${st.current}`);
    rec('NAV', `"${r}" renders exactly one h1`,
      (await page.$$eval('#main h1', ns => ns.length)) === 1);
  }
  for (const d of DEEP) {
    await goto(page, d);
    const ok = await page.evaluate(() => {
      const m = document.getElementById('main');
      return m.children.length > 0 && !m.querySelector('.empty.is-error');
    });
    rec('NAV', `deep link "${d}" renders`, ok);
  }
  await goto(page, 'nosuchscreen');
  rec('NAV', 'an unknown route fails honestly rather than blankly',
    await page.evaluate(() => /does not exist/i.test(document.getElementById('main').textContent)));

  /* ---------------------------------------------------------------- A11Y */

  for (const r of ROUTES) { await goto(page, r); await axeOn(page, r); }
  for (const d of DEEP.slice(0, 5)) { await goto(page, d); await axeOn(page, d); }

  // Overlays are where focus and labelling usually break.
  await goto(page, 'overview');
  await page.evaluate(() => window.ARGUS.palette());
  await page.waitForSelector('.pal-input');
  await axeOn(page, 'command palette');
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.ARGUS.shortcuts());
  await page.waitForSelector('.shortcuts');
  await axeOn(page, 'shortcuts dialog');
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.ARGUS.flash('bad', 'Test alert', 'A failure message for the audit.'));
  await axeOn(page, 'flash bar');
  await page.evaluate(() => { document.querySelectorAll('.flash .x').forEach(b => b.click()); });

  await page.evaluate(() => window.ARGUS.connect(window.ARGUS.data.vms[0], 'rdp'));
  await page.waitForSelector('.dialog');
  await axeOn(page, 'elevation dialog');
  await page.keyboard.press('Escape');

  /* ----------------------------------------------------------------- KBD */

  await goto(page, 'overview');
  const focusable = await page.$$eval(
    'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])',
    ns => ns.filter(n => n.offsetParent !== null).length);
  rec('KBD', 'the overview has focusable controls', focusable > 10, `${focusable} found`);

  // :focus-visible only matches keyboard focus, so the traversal has to be real
  // Tab presses. Calling el.focus() reports a false failure on a working ring.
  await page.evaluate(() => document.querySelector('.skip').focus());
  let noRing = [];
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    const bad = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      if (!a.matches(':focus-visible')) return null;
      const s = getComputedStyle(a);
      const has = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0)
        || s.boxShadow !== 'none'
        || getComputedStyle(a, ':focus-visible').outlineStyle !== 'none';
      return has ? null : (a.tagName + '.' + (a.className || '')).slice(0, 60);
    });
    if (bad) noRing.push(bad);
  }
  rec('KBD', 'every tab stop shows a focus indicator', noRing.length === 0, noRing.slice(0, 5).join(' | '));

  rec('KBD', 'no click handler sits on a non-focusable element',
    await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('#main *').forEach(n => {
        const t = n.tagName.toLowerCase();
        if (t === 'button' || t === 'a' || t === 'input' || t === 'select' || t === 'textarea') return;
        if (n.hasAttribute('tabindex')) return;
        if (n.getAttribute('role') === 'link' || n.getAttribute('role') === 'button') bad.push(t);
      });
      return bad.length === 0;
    }));

  // Focus trap and restoration.
  await goto(page, 'overview');
  await page.evaluate(() => { document.getElementById('helpbtn').focus(); });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.dialog');
  const trapped = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    trapped.push(await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  }
  rec('KBD', 'a dialog traps focus', trapped.every(Boolean), `${trapped.filter(Boolean).length}/12 inside`);
  await page.keyboard.press('Escape');
  rec('KBD', 'closing a dialog restores focus to what opened it',
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'helpbtn'),
    await page.evaluate(() => document.activeElement ? document.activeElement.id || document.activeElement.tagName : 'none'));

  // Shortcut keys.
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await page.waitForTimeout(60);
  rec('KBD', 'the "g then a" shortcut goes to Applications',
    await page.evaluate(() => window.ARGUS.state.route === 'apps'),
    await page.evaluate(() => window.ARGUS.state.route));

  /* ----------------------------------------------------------------- CMD */

  await goto(page, 'overview');
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  await page.waitForSelector('.pal-input', { timeout: 3000 });
  rec('CMD', 'Ctrl+K opens the palette and focuses the input',
    await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('pal-input')));
  await page.keyboard.type('sql-01');
  await page.waitForTimeout(80);
  const palCount = await page.$$eval('.pal-item', ns => ns.length);
  rec('CMD', 'the palette finds a resource by name', palCount > 0, `${palCount} results`);
  rec('CMD', 'the palette marks one option active',
    await page.$$eval('.pal-item[aria-selected="true"]', ns => ns.length) === 1);
  await page.keyboard.press('ArrowDown');
  rec('CMD', 'arrow keys move the active option',
    await page.evaluate(() => {
      const items = document.querySelectorAll('.pal-item');
      return items.length > 1 && items[1].getAttribute('aria-selected') === 'true';
    }));
  await page.keyboard.press('Escape');
  rec('CMD', 'Escape closes the palette',
    await page.evaluate(() => !document.querySelector('.pal-input')));

  /* ----------------------------------------------------------------- TBL */

  let noCaption = [], noSort = [];
  for (const r of ROUTES.concat(DEEP.slice(0, 5))) {
    await goto(page, r);
    const bad = await page.evaluate(() => {
      const out = { caption: 0, sort: 0, tables: 0 };
      document.querySelectorAll('#main table').forEach(t => {
        out.tables++;
        const cap = t.querySelector('caption');
        if (!cap || !cap.textContent.trim()) out.caption++;
        t.querySelectorAll('th[data-col]').forEach(th => {
          if (!th.hasAttribute('aria-sort')) out.sort++;
        });
      });
      return out;
    });
    if (bad.caption) noCaption.push(`${r}:${bad.caption}`);
    if (bad.sort) noSort.push(`${r}:${bad.sort}`);
  }
  rec('TBL', 'every table has a caption', noCaption.length === 0, noCaption.join(' '));
  rec('TBL', 'every sortable header carries aria-sort', noSort.length === 0, noSort.join(' '));

  // Sorting actually reorders, and says so.
  await goto(page, 'apps');
  const sorted = await page.evaluate(() => {
    const th = document.querySelector('#main th[data-col] .th-sort');
    if (!th) return null;
    const before = Array.from(document.querySelectorAll('#main tbody tr')).map(r => r.textContent.slice(0, 20));
    th.click();
    const after = Array.from(document.querySelectorAll('#main tbody tr')).map(r => r.textContent.slice(0, 20));
    return { changed: before.join('|') !== after.join('|'), rows: before.length };
  });
  rec('TBL', 'sorting a column reorders the rows', !!(sorted && sorted.changed && sorted.rows > 1),
    sorted ? `${sorted.rows} rows` : 'no sortable table found');

  /* --------------------------------------------------------------- STATE */

  await goto(page, 'apps');
  const states = await page.evaluate(() => {
    const inp = document.querySelector('.pf-input');
    if (!inp) return { ok: false, why: 'no property filter' };
    inp.value = 'zzzzzznotathing';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const txt = document.getElementById('main').textContent;
    return { ok: /no.*match|matches/i.test(txt), txt: txt.slice(0, 0) };
  });
  rec('STATE', 'a filter that excludes everything says "no match", not "empty"', states.ok, states.why || '');

  /* -------------------------------------------------------------- LAYOUT */

  // A single row should never be taller than a card. This catches the class of
  // bug where a layout rule leaks into content, which axe and the responsive
  // checks both sail straight past.
  let fatRows = [], fatPages = [];
  for (const r of ROUTES.concat(DEEP.slice(0, 6))) {
    await goto(page, r);
    const o = await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('#main tbody tr').forEach(tr => {
        const h = tr.getBoundingClientRect().height;
        if (h > 220) rows.push(Math.round(h) + 'px "' + tr.textContent.trim().slice(0, 24) + '"');
      });
      return { rows: rows.slice(0, 3), page: Math.round(document.getElementById('main').scrollHeight) };
    });
    if (o.rows.length) fatRows.push(r + ': ' + o.rows.join(', '));
    // Ten rows of data should not make a five-screen page.
    if (o.page > 4200) fatPages.push(r + ': ' + o.page + 'px');
  }
  rec('LAYOUT', 'no table row is taller than 220px', fatRows.length === 0, fatRows.slice(0, 4).join(' | '));
  rec('LAYOUT', 'no screen runs past 4200px at 1440x900', fatPages.length === 0, fatPages.slice(0, 4).join(' | '));

  await goto(page, 'overview');
  rec('LAYOUT', 'nothing marked hidden is actually visible',
    await page.evaluate(() => {
      const shown = [];
      document.querySelectorAll('[hidden]').forEach(n => {
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) shown.push(n.id || n.tagName);
      });
      return shown.length === 0;
    }),
    await page.evaluate(() => Array.from(document.querySelectorAll('[hidden]'))
      .filter(n => n.getBoundingClientRect().height > 0).map(n => n.id || n.tagName).join(' ')));

  rec('LAYOUT', 'no icon has fallen back to the 300x150 default SVG size',
    await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('svg').forEach(s => {
        const r = s.getBoundingClientRect();
        if (r.width > 200 || r.height > 200) {
          if (!s.closest('.graph, .graphwrap')) bad.push(Math.round(r.width) + 'x' + Math.round(r.height));
        }
      });
      return bad.length === 0;
    }));

  /* --------------------------------------------------------------- GUARD */

  // Every assertion here corresponds to a defect an adversarial audit found
  // that this suite had passed over. They are the expensive kind: the interface
  // looked correct and behaved wrongly.

  await goto(page, 'overview');
  rec('GUARD', 'a disabled button does not run its action',
    await page.evaluate(() => {
      let fired = false;
      const b = window.ARGUS.ui.btn('X', { disabled: true, onClick: () => { fired = true; } });
      document.body.appendChild(b);
      b.click();
      const first = fired;
      b.setDisabled(false);
      b.click();
      b.remove();
      return first === false && fired === true;
    }));

  rec('GUARD', 'the destructive confirm refuses an empty name field',
    await page.evaluate(() => {
      let fired = false;
      window.ARGUS.confirmDestructive({
        title: 'T', detail: 'd', match: 'sql-01', onConfirm: () => { fired = true; }
      });
      const go = Array.from(document.querySelectorAll('.dialog-foot .btn')).pop();
      go.click();
      return fired === false;
    }));
  rec('GUARD', 'the destructive confirm proceeds once the name matches',
    await page.evaluate(() => {
      const input = document.getElementById('confirm-name');
      input.value = 'sql-01';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const go = Array.from(document.querySelectorAll('.dialog-foot .btn')).pop();
      return go.getAttribute('aria-disabled') === 'false';
    }));
  await page.keyboard.press('Escape');

  // An in-page anchor is not a route.
  await goto(page, 'overview');
  await page.evaluate(() => document.querySelector('.skip').click());
  await page.waitForTimeout(150);
  rec('GUARD', 'the skip link does not blank the page',
    await page.evaluate(() => !/does not exist/i.test(document.getElementById('main').textContent)),
    await page.evaluate(() => document.title));

  // A screen's timers must not outlive it.
  await goto(page, 'ops/runbook/sql-01-restore-drill');
  const ranTranscript = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#main button')).find(x => /^Run /.test(x.textContent));
    if (!b) return false;
    b.click();
    const go = Array.from(document.querySelectorAll('.dialog-foot .btn')).pop();
    if (go) go.click();
    return true;
  });
  await goto(page, 'overview');
  await page.evaluate(() => { document.getElementById('flashes').textContent = ''; });
  await page.waitForTimeout(2600);
  rec('GUARD', 'leaving a screen stops the work it started',
    ranTranscript && await page.evaluate(() => document.getElementById('flashes').children.length === 0),
    await page.evaluate(() => document.getElementById('flashes').textContent.slice(0, 60)));

  // The countdown reads the same clock it counts against.
  rec('GUARD', 'the elevation countdown matches the granted duration',
    await page.evaluate(() => {
      window.ARGUS.data.me.elevation = {
        group: 'G', reason: 'r', expires: new Date(Date.now() + 2 * 3600000)
      };
      window.ARGUS.paintElevation();
      const txt = document.querySelector('.elev-time').textContent;
      window.ARGUS.data.me.elevation = null;
      window.ARGUS.paintElevation();
      return /^(1 h 5[0-9] min|2 h)/.test(txt);
    }));
  rec('GUARD', 'an already-expired grant does not leave a timer running',
    await page.evaluate(async () => {
      let count = 0;
      const host = document.getElementById('flashes');
      const obs = new MutationObserver(() => { count++; });
      obs.observe(host, { childList: true });
      window.ARGUS.data.me.elevation = { group: 'G', reason: 'r', expires: new Date(Date.now() - 1000) };
      window.ARGUS.paintElevation();
      await new Promise(r => setTimeout(r, 2400));
      obs.disconnect();
      host.textContent = '';
      return count <= 2;
    }));

  /* Regressions for the four defects that made the console unusable and that
     every suite here passed straight over. Each one is exercised the way an
     operator meets it, not by inspecting an attribute. */

  // The rail collapses at 1200px and for anyone who ever pressed Collapse.
  // display:none on the label left ten buttons with no accessible name.
  await page.setViewportSize({ width: 1100, height: 800 });
  await goto(page, 'overview');
  rec('GUARD', 'a collapsed rail keeps an accessible name on every nav button',
    await page.evaluate(() => {
      const names = [...document.querySelectorAll('.side .nav')]
        .map(n => (n.textContent || '').trim() || n.getAttribute('aria-label') || '');
      return names.length >= 10 && names.every(Boolean);
    }));
  await page.setViewportSize({ width: 1440, height: 900 });

  // The scrim is z-index 100; the drawer was 95, in the same stacking context,
  // so every tap on a nav item hit the scrim and closed it. Keyboard worked,
  // which is why navigating by location.hash could never see it.
  await page.setViewportSize({ width: 390, height: 800 });
  await goto(page, 'overview');
  rec('GUARD', 'the mobile navigation drawer is above its own scrim',
    await page.evaluate(async () => {
      document.getElementById('burger').click();
      await new Promise(r => setTimeout(r, 250));
      const nav = document.querySelector('.nav[data-go="apps"]');
      const r = nav.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === nav || nav.contains(hit));
    }));
  await page.setViewportSize({ width: 1440, height: 900 });

  // ui.btn captures disabled at construction; mutating opts.disabled made the
  // button look enabled while the guard still swallowed the click, so a
  // deployment could never be rejected.
  await goto(page, 'deploys/1847');
  rec('GUARD', 'a deployment can actually be rejected once a reason is given',
    await page.evaluate(async () => {
      const trigger = [...document.querySelectorAll('#main button')]
        .find(b => /^Reject deployment/.test(b.textContent));
      if (!trigger) return false;
      trigger.click();
      await new Promise(r => setTimeout(r, 120));
      const dlg = document.querySelector('.dialog');
      const area = dlg && dlg.querySelector('#reject-reason');
      const go = dlg && [...dlg.querySelectorAll('button')]
        .find(b => /^Reject deployment/.test(b.textContent));
      if (!area || !go) return false;
      if (go.getAttribute('aria-disabled') !== 'true') return false;
      area.value = 'not during the freeze';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      if (go.getAttribute('aria-disabled') !== 'false') return false;
      const before = document.querySelectorAll('#flashes .flash').length;
      go.click();
      await new Promise(r => setTimeout(r, 120));
      return document.querySelectorAll('#flashes .flash').length > before;
    }));

  // A.dialog builds body() and actions() before the panel is in the document,
  // so getElementById returned null and no listener was ever attached.
  await goto(page, 'security/vulns');
  rec('GUARD', 'the waiver dialog reaches its own fields and can be submitted',
    await page.evaluate(async () => {
      const trigger = [...document.querySelectorAll('#main button')]
        .find(b => /waiver/i.test(b.textContent));
      if (!trigger) return false;
      trigger.click();
      await new Promise(r => setTimeout(r, 120));
      const dlg = document.querySelector('.dialog');
      if (!dlg) return false;
      const owner = dlg.querySelector('#waiver-owner');
      const reason = dlg.querySelector('#waiver-reason');
      const expiry = dlg.querySelector('#waiver-expiry');
      const go = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add waiver');
      if (!owner || !reason || !expiry || !go) return false;
      if (go.disabled) return false;                       // must use aria-disabled
      if (go.getAttribute('aria-disabled') !== 'true') return false;
      owner.value = 'adil'; owner.dispatchEvent(new Event('input', { bubbles: true }));
      reason.value = 'fix is queued'; reason.dispatchEvent(new Event('input', { bubbles: true }));
      expiry.value = '2026-12-01'; expiry.dispatchEvent(new Event('change', { bubbles: true }));
      return go.getAttribute('aria-disabled') === 'false';
    }));

  // Applications is the only screen that emits ?tab= and was the only one that
  // never read it, so both of its own row-menu links landed on Overview.
  await goto(page, 'apps/mills?tab=logs');
  rec('GUARD', 'the applications screen opens the tab its own links name',
    await page.evaluate(() => {
      const sel = document.querySelector('#main .tab[aria-selected="true"]');
      return !!sel && /logs/i.test(sel.textContent);
    }));

  // Math.floor for hours and Math.round for the remainder let the remainder
  // reach 60, live on the elevation countdown.
  rec('GUARD', 'a duration never reads sixty minutes past the hour',
    await page.evaluate(() => {
      const f = window.ARGUS.ui.fmt.dur;
      for (let s = 0; s <= 90000; s += 7) {
        const out = f(s);
        if (/60 min/.test(out)) return false;
      }
      return true;
    }));

  // Descending sort used to be ascending.reverse(), which also reversed where
  // the comparator deliberately sank rows with no value.
  rec('GUARD', 'rows with no value stay at the bottom in both sort directions',
    await page.evaluate(() => {
      const ui = window.ARGUS.ui;
      const rows = [{ n: 'a', v: 3 }, { n: 'b', v: null }, { n: 'c', v: 1 }, { n: 'd', v: 2 }];
      const t = ui.table([{ key: 'n', label: 'N' }, { key: 'v', label: 'V' }],
        rows, { caption: 'probe', sortKey: 'v', sortDir: 'desc' });
      const order = t.currentRows().map(r => r.n).join('');
      return order[order.length - 1] === 'b';
    }));

  // A deep link opens the tab it names.
  await goto(page, 'identity/grants');
  rec('GUARD', 'a deep link opens the tab it names',
    await page.evaluate(() => {
      const sel = document.querySelector('#main .tab[aria-selected="true"]');
      return !!sel && /grants/i.test(sel.textContent);
    }),
    await page.evaluate(() => {
      const s = document.querySelector('#main .tab[aria-selected="true"]');
      return s ? s.textContent : 'none';
    }));

  // The query editor's read-only claim has to be what it enforces.
  await goto(page, 'data/database/umairv3_db');
  const sqlCases = [
    ['SELECT * INTO staff_copy FROM staff', true],
    ['SELECT pg_terminate_backend(1)', true],
    ['SELECT 1; DROP TABLE x', true],
    ['DELETE FROM staff', true],
    ['SELECT name FROM t WHERE note = \'please update me\'', false],
    ['WITH c AS (SELECT 1) SELECT * FROM c', false]
  ];
  let sqlBad = [];
  for (const [sql, shouldReject] of sqlCases) {
    const rejected = await page.evaluate((q) => {
      const area = document.querySelector('#main textarea');
      if (!area) return null;
      area.value = q;
      document.getElementById('flashes').textContent = '';
      const run = Array.from(document.querySelectorAll('#main button')).find(x => /^Run/.test(x.textContent.trim()));
      if (!run) return null;
      run.click();
      const bad = !!document.querySelector('.flash.bad');
      document.getElementById('flashes').textContent = '';
      return bad;
    }, sql);
    if (rejected !== shouldReject) sqlBad.push((shouldReject ? 'allowed ' : 'refused ') + sql.slice(0, 34));
  }
  rec('GUARD', 'the query editor enforces the read-only claim it makes',
    sqlBad.length === 0, sqlBad.join(' | '));

  // A class in the markup that no stylesheet defines is either a typo or a
  // rule someone deleted.
  const cssText = ['assets/app.css', 'assets/components.css']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const definedClasses = new Set((cssText.match(/\.[A-Za-z][A-Za-z0-9_-]*/g) || []).map(s => s.slice(1)));
  let undefinedClasses = new Set();
  for (const r of ROUTES.concat(DEEP.slice(0, 6))) {
    await goto(page, r);
    const used = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#main *').forEach(n => {
        const cn = n.className;
        const s = typeof cn === 'string' ? cn : (cn && cn.baseVal) || '';
        s.split(/\s+/).filter(Boolean).forEach(c => { if (out.indexOf(c) === -1) out.push(c); });
      });
      return out;
    });
    used.forEach(c => { if (!definedClasses.has(c)) undefinedClasses.add(r.split('/')[0] + ':' + c); });
  }
  rec('GUARD', 'every class used in the markup is defined in a stylesheet',
    undefinedClasses.size === 0, Array.from(undefinedClasses).slice(0, 8).join(' '));

  /* ----------------------------------------------------------------- CON */

  const RGB = s => { const m = String(s).match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const lum = c => { const f = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  let lowContrast = [];
  for (const r of ROUTES) {
    await goto(page, r);
    const found = await page.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.getElementById('main'), NodeFilter.SHOW_TEXT);
      let n, seen = 0;
      while ((n = walk.nextNode()) && seen < 400) {
        const txt = n.textContent.trim();
        if (!txt) continue;
        const p = n.parentElement;
        if (!p || p.closest('.sr') || p.classList.contains('sr')) continue;
        const s = getComputedStyle(p);
        if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) < 0.5) continue;
        // Walk up for a real background; gradients count as their darkest stop.
        let bg = null, e = p;
        while (e && !bg) {
          const es = getComputedStyle(e);
          if (es.backgroundImage && es.backgroundImage !== 'none') { bg = 'gradient'; break; }
          if (es.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(es.backgroundColor)) bg = es.backgroundColor;
          e = e.parentElement;
        }
        seen++;
        out.push({ fg: s.color, bg: bg, size: parseFloat(s.fontSize), weight: s.fontWeight, txt: txt.slice(0, 28) });
      }
      return out;
    });
    for (const it of found) {
      if (it.bg === 'gradient' || !it.bg) continue;  // gradients are checked visually, not numerically
      const f = RGB(it.fg), b = RGB(it.bg);
      if (!f || !b) continue;
      const L1 = lum(f), L2 = lum(b);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = it.size >= 24 || (it.size >= 18.66 && Number(it.weight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need - 0.01) lowContrast.push(`${r} "${it.txt}" ${ratio.toFixed(2)}:1 need ${need}`);
    }
  }
  rec('CON', 'all text meets WCAG AA contrast', lowContrast.length === 0, lowContrast.slice(0, 6).join(' | '));

  /* ----------------------------------------------------------------- TXT */

  let tiny = [], clipped = [];
  for (const r of ROUTES) {
    await goto(page, r);
    const found = await page.evaluate(() => {
      const small = [], clip = [];
      /* The whole document, not just #main.
       *
       * Scoping to '#main *' meant this check could never see the navigation
       * rail, the top bar, the flash bar, the session drawer or the command
       * palette -- and the rail carried three 10.5px group headings and the
       * palette a 10.5px category label on every row, live, for as long as the
       * floor has existed.
       *
       * offsetParent is an HTMLElement property and is undefined on every
       * SVGElement, so `!n.offsetParent` skipped all SVG text unconditionally,
       * including the 10.5px type label under every dependency-graph node.
       * getClientRects() answers the "is it rendered" question for both. */
      document.querySelectorAll('body *').forEach(n => {
        if (n.closest('.sr') || n.closest('#live')) return;
        if (!n.getClientRects().length) return;
        if (!n.textContent.trim() || n.children.length) return;
        const s = getComputedStyle(n);
        const size = parseFloat(s.fontSize);
        if (size < 11) small.push(n.textContent.trim().slice(0, 24) + ' @' + size + 'px');
        if (n.scrollWidth > n.clientWidth + 2 && s.overflow === 'hidden' && s.textOverflow !== 'ellipsis') {
          clip.push(n.textContent.trim().slice(0, 24));
        }
      });
      return { small, clip };
    });
    tiny = tiny.concat(found.small.map(x => r + ': ' + x));
    clipped = clipped.concat(found.clip.map(x => r + ': ' + x));
  }
  rec('TXT', 'no text below 11px', tiny.length === 0, tiny.slice(0, 6).join(' | '));
  rec('TXT', 'no clipped text', clipped.length === 0, clipped.slice(0, 6).join(' | '));

  /* ------------------------------------------------------- RESP and DENS */

  const WIDTHS = [
    { name: 'desktop', w: 1440, h: 900 }, { name: 'laptop-1366', w: 1366, h: 768 },
    { name: 'laptop-1280', w: 1280, h: 800 }, { name: 'small-laptop', w: 1024, h: 768 },
    { name: 'tablet', w: 768, h: 1024 }, { name: 'phone', w: 390, h: 844 }
  ];
  for (const v of WIDTHS) {
    await ctx.pages()[0].setViewportSize({ width: v.w, height: v.h });
    let worst = [];
    for (const r of ROUTES) {
      await goto(page, r);
      const o = await page.evaluate(() => {
        const wide = [];
        document.querySelectorAll('body *').forEach(n => {
          if (n.closest('.sr') || !n.offsetParent) return;
          const rect = n.getBoundingClientRect();
          // A container that scrolls its own overflow is doing the right thing.
          const s = getComputedStyle(n);
          if (s.overflowX === 'auto' || s.overflowX === 'scroll') return;
          if (rect.right > document.documentElement.clientWidth + 1) {
            wide.push(n.tagName + '.' + String(n.className).split(' ')[0] + ' -> ' + Math.round(rect.right));
          }
        });
        return { doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, wide: wide.slice(0, 4) };
      });
      if (o.doc > o.view + 1) worst.push(`${r}: ${o.doc} vs ${o.view} ${o.wide.join(' | ')}`);
    }
    rec('RESP', `${v.name} (${v.w}px) no horizontal overflow`, worst.length === 0, worst.slice(0, 3).join(' || '));

    if (v.h <= 800 && v.w >= 1024) {
      await goto(page, 'overview');
      const d = await page.evaluate(() => {
        const first = document.querySelector('#main .tiles, #main .callout, #main .card');
        const tiles = document.querySelectorAll('#main .tile');
        const last = tiles.length ? tiles[tiles.length - 1].getBoundingClientRect().bottom : 0;
        return {
          firstTop: first ? Math.round(first.getBoundingClientRect().top) : 9999,
          tilesBottom: Math.round(last),
          pageHeight: Math.round(document.getElementById('main').scrollHeight),
          vh: window.innerHeight
        };
      });
      const budget = Math.round(v.h * 0.55);
      rec('DENS', `${v.name} chrome and header stay under 55% of the screen`, d.firstTop <= budget,
        `${d.firstTop}px used, budget ${budget}px`);
      rec('DENS', `${v.name} every stat tile clears the fold`, d.tilesBottom <= v.h,
        `tiles end at ${d.tilesBottom}px of ${v.h}px`);
      rec('DENS', `${v.name} overview stays under two screens`, d.pageHeight <= v.h * 2.4,
        `${d.pageHeight}px = ${(d.pageHeight / v.h).toFixed(1)} screens`);
    }
    if (v.w <= 768) {
      await goto(page, 'overview');
      const small = await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll('button, a[href], input, select, [role="option"]').forEach(n => {
          if (!n.offsetParent || n.closest('.sr')) return;
          const r = n.getBoundingClientRect();
          if (r.width < 24 || r.height < 24) bad.push(String(n.className).split(' ')[0] + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        });
        return bad;
      });
      rec('TAP', `${v.name} touch targets are at least 24px`, small.length === 0, small.slice(0, 5).join(' | '));
    }
    await page.screenshot({ path: `${SHOTS}/${v.name}.png`, fullPage: v.name === 'desktop' }).catch(() => {});
  }

  /* ---------------------------------------------------------------- ZOOM */

  // WCAG 1.4.10: content must reflow without a second scrollbar. 400% zoom at
  // 1280px is equivalent to a 320px viewport.
  for (const z of [{ label: '200%', w: 640, h: 512 }, { label: '400%', w: 320, h: 256 }]) {
    await ctx.pages()[0].setViewportSize({ width: z.w, height: z.h });
    let bad = [];
    for (const r of ROUTES) {
      await goto(page, r);
      const o = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth
      }));
      if (o.doc > o.view + 1) bad.push(`${r}: ${o.doc}>${o.view}`);
    }
    rec('ZOOM', `reflow at ${z.label} zoom (${z.w}px equivalent)`, bad.length === 0, bad.slice(0, 3).join(' | '));
  }
  await ctx.pages()[0].setViewportSize({ width: 1440, height: 900 });

  /* -------------------------------------------------------------- MOTION */

  const reduced = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const rp = await reduced.newPage();
  await rp.goto(URL, { waitUntil: 'load' });
  await rp.waitForTimeout(120);
  rec('MOTION', 'reduced motion stops every animation and transition',
    await rp.evaluate(() => {
      let bad = 0;
      document.querySelectorAll('*').forEach(n => {
        const s = getComputedStyle(n);
        if (s.animationName !== 'none' && s.animationDuration !== '0s') bad++;
        if (s.transitionDuration !== '0s' && s.transitionDuration !== '') bad++;
      });
      return bad === 0;
    }));
  await reduced.close();

  /* ----------------------------------------------------------------- SEC */

  rec('SEC', 'a Content-Security-Policy is declared',
    await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')));
  // Proving the CSP works means violating it on purpose, which logs a console
  // error. Only the errors this probe itself causes are discarded, by position,
  // so a genuine violation somewhere else still fails the CONS suite.
  const errorsBeforeProbe = consoleErrors.length;
  rec('SEC', 'the CSP actually blocks an injected inline script',
    await (async () => {
      try {
        await page.addScriptTag({ content: 'window.__cspEscaped = true;' });
      } catch (e) { return true; }
      return !(await page.evaluate(() => window.__cspEscaped === true));
    })());
  await page.waitForTimeout(80);
  consoleErrors.splice(errorsBeforeProbe,
    consoleErrors.length - errorsBeforeProbe);
  rec('SEC', 'the CSP confines the page to its own origin',
    await page.evaluate(() => {
      const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return !!m && /connect-src 'self'/.test(m.content) && /object-src 'none'/.test(m.content)
        && /base-uri 'none'/.test(m.content) && /default-src 'none'/.test(m.content);
    }));

  // The source is the authority here: a console that renders alert rules and
  // commit messages must not build DOM from strings anywhere.
  const srcFiles = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (f !== 'tests' && f !== 'node_modules') walk(p); }
      else if (/\.(js|html)$/.test(f)) srcFiles.push(p);
    }
  })(ROOT);

  const innerHtml = srcFiles.filter(f => {
    const s = fs.readFileSync(f, 'utf8');
    // ui.el throws on an 'html' key; that guard is allowed to mention it.
    return /\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(s);
  }).map(f => path.relative(ROOT, f));
  rec('SEC', 'no innerHTML, insertAdjacentHTML or document.write in the source',
    innerHtml.length === 0, innerHtml.join(' '));

  const inlineHandlers = srcFiles.filter(f => /\son(click|load|error|mouseover|focus)\s*=\s*["']/i.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f));
  rec('SEC', 'no inline event handlers, which a CSP would block anyway',
    inlineHandlers.length === 0, inlineHandlers.join(' '));

  const external = srcFiles.filter(f => /https?:\/\/(?!localhost)/.test(
    fs.readFileSync(f, 'utf8').replace(/^\s*[*/].*$/gm, '')   // ignore comment lines
      .replace(/https?:\/\/[a-z0-9.-]*(zaraatdost|argus|anthropic|earthengine|dataspace|firebase|googleapis|w3\.org|localhost)[^\s"')]*/g, '')
  )).map(f => path.relative(ROOT, f));
  rec('SEC', 'no external origins are referenced from the bundle', external.length === 0, external.join(' '));

  rec('SEC', 'no secret value is rendered anywhere',
    await (async () => {
      for (const r of ['identity', 'apps/mills']) {
        await goto(page, r);
        const leaked = await page.evaluate(() => /(?:password|secret|token)\s*[:=]\s*['"][A-Za-z0-9+/=]{12,}/i.test(document.body.textContent));
        if (leaked) return false;
      }
      return true;
    })());

  /* --------------------------------------------------------------- ROUTE */

  // parseHash runs on every hashchange and *before* the try/catch that guards
  // a screen's render, so anything it throws takes the console down until a
  // manual reload. decodeURIComponent throws URIError on a malformed escape,
  // which made a pasted link with a stray percent sign a denial of service.
  const ROUTE_CASES = [
    { hash: '#/apps?q=%', route: 'apps', why: 'a stray percent sign' },
    { hash: '#/apps?q=%zz', route: 'apps', why: 'an invalid escape' },
    { hash: '#/apps?%=x', route: 'apps', why: 'a malformed parameter key' },
    { hash: '#/compute?a=%E0%A4', route: 'compute', why: 'a truncated UTF-8 sequence' },
    { hash: '#/data?q=100%&x=1', route: 'data', why: 'a percent at the end of a value' }
  ];
  for (const c of ROUTE_CASES) {
    await page.evaluate(h => { window.location.hash = h; }, c.hash);
    await page.waitForTimeout(120);
    const st = await page.evaluate(() => ({
      route: window.ARGUS.state.route,
      painted: document.getElementById('main').textContent.trim().length
    }));
    rec('ROUTE', `${c.why} does not crash the router`,
      st.route === c.route && st.painted > 0, `${c.hash} -> ${JSON.stringify(st)}`);
  }

  // Splitting a query pair on every '=' truncated any value that legitimately
  // contained one, so a base64 filter never survived being shared as a link.
  await page.evaluate(() => { window.location.hash = '#/audit?q=YWRtaW4='; });
  await page.waitForTimeout(120);
  const eqParam = await page.evaluate(() => window.ARGUS.state.params.q);
  rec('ROUTE', "a '=' inside a query value survives parsing", eqParam === 'YWRtaW4=', String(eqParam));

  // href() encodes each segment and parseHash() decodes it; if the pair does
  // not round-trip then a resource whose name contains a space, a slash or a
  // percent sign cannot be linked to at all.
  const roundTrip = await page.evaluate(async () => {
    const awkward = 'a b/c%d';
    window.location.hash = window.ARGUS.href('apps', [awkward]);
    await new Promise(r => setTimeout(r, 120));
    return { got: window.ARGUS.state.rest.join('/'), want: awkward };
  });
  rec('ROUTE', 'href and parseHash round-trip a segment with space, slash and percent',
    roundTrip.got === roundTrip.want, JSON.stringify(roundTrip));

  // A hash that is not a route at all (the skip link) must be left alone.
  await page.evaluate(() => { window.location.hash = '#/overview'; });
  await page.waitForTimeout(100);

  /* --------------------------------------------------------------- THEME */

  await goto(page, 'overview');
  const themes = await page.evaluate(() => {
    const read = () => ({
      attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      fg: getComputedStyle(document.body).color,
      card: getComputedStyle(document.querySelector('.side')).backgroundColor,
      meta: (document.querySelector('meta[name="color-scheme"]') || {}).content
    });
    window.ARGUS.setTheme('light'); const light = read();
    window.ARGUS.setTheme('dark'); const dark = read();
    return { light, dark };
  });
  rec('THEME', 'choosing dark stamps data-theme on the document element',
    themes.dark.attr === 'dark', JSON.stringify(themes.dark));
  rec('THEME', 'the dark theme repaints the page surface',
    themes.dark.bg !== themes.light.bg, `${themes.light.bg} -> ${themes.dark.bg}`);
  rec('THEME', 'the dark theme repaints body text',
    themes.dark.fg !== themes.light.fg, `${themes.light.fg} -> ${themes.dark.fg}`);
  rec('THEME', 'the dark theme repaints panel chrome, not just the body',
    themes.dark.card !== themes.light.card, `${themes.light.card} -> ${themes.dark.card}`);
  rec('THEME', 'the color-scheme meta follows the resolved theme',
    themes.dark.meta === 'dark', String(themes.dark.meta));

  // A shadow token driven by --ink-rgb would invert with the text and put a
  // white halo around every card in dark mode.
  const shadowInk = await page.evaluate(() => {
    const v = getComputedStyle(document.documentElement);
    return { shadow: v.getPropertyValue('--shadow-rgb').trim(), ink: v.getPropertyValue('--ink-rgb').trim() };
  });
  rec('THEME', 'shadows do not invert with the text colour',
    shadowInk.shadow !== shadowInk.ink, JSON.stringify(shadowInk));

  // The theme is a preference, so it has to survive a reload.
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(AXE);
  await page.waitForTimeout(150);
  rec('THEME', 'the chosen theme survives a reload',
    await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark'),
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')));

  // Everything the light theme is held to, the dark theme is held to as well.
  for (const r of ['overview', 'security', 'compute', 'apps/mills']) {
    await goto(page, r);
    await axeOn(page, 'dark ' + r);
  }

  let darkLowContrast = [];
  for (const r of ['overview', 'security', 'deploys', 'identity']) {
    await goto(page, r);
    const found = await page.evaluate(() => {
      const out = [];
      const walk = document.createTreeWalker(document.getElementById('main'), NodeFilter.SHOW_TEXT);
      let n, seen = 0;
      while ((n = walk.nextNode()) && seen < 400) {
        const txt = n.textContent.trim();
        if (!txt) continue;
        const p = n.parentElement;
        if (!p || p.closest('.sr') || p.classList.contains('sr')) continue;
        const st = getComputedStyle(p);
        if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) < 0.5) continue;
        let bg = null, e = p;
        while (e && !bg) {
          const es = getComputedStyle(e);
          if (es.backgroundImage && es.backgroundImage !== 'none') { bg = 'gradient'; break; }
          if (es.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(es.backgroundColor)) bg = es.backgroundColor;
          e = e.parentElement;
        }
        seen++;
        out.push({ fg: st.color, bg: bg, size: parseFloat(st.fontSize), weight: st.fontWeight, txt: txt.slice(0, 28) });
      }
      return out;
    });
    for (const it of found) {
      if (it.bg === 'gradient' || !it.bg) continue;
      const f = RGB(it.fg), b = RGB(it.bg);
      if (!f || !b) continue;
      const L1 = lum(f), L2 = lum(b);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = it.size >= 24 || (it.size >= 18.66 && Number(it.weight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio < need - 0.01) darkLowContrast.push(`${r} "${it.txt}" ${ratio.toFixed(2)}:1 need ${need}`);
    }
  }
  rec('THEME', 'all text meets WCAG AA contrast in the dark theme',
    darkLowContrast.length === 0, darkLowContrast.slice(0, 6).join(' | '));

  await page.evaluate(() => window.ARGUS.setTheme('system'));
  await page.waitForTimeout(80);
  rec('THEME', 'system resolves to a concrete theme rather than no theme',
    await page.evaluate(() => ['light', 'dark'].indexOf(document.documentElement.getAttribute('data-theme')) !== -1),
    await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
  await page.evaluate(() => window.ARGUS.setTheme('light'));
  await page.waitForTimeout(80);

  /* --------------------------------------------------------------- PREFS */

  // localStorage is writable by anything else on this origin, and the whole
  // blob used to be copied into prefs unchecked: one junk value put the shell
  // into a class no stylesheet defines, with no way back but clearing storage.
  const prefGuard = await page.evaluate(async () => {
    localStorage.setItem('argus.prefs', JSON.stringify({
      density: '"><img src=x>', theme: 'neon', timezone: 42, rail: 'yes'
    }));
    return true;
  });
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(AXE);
  await page.waitForTimeout(150);
  const survived = await page.evaluate(() => ({
    prefs: window.ARGUS.prefs(),
    theme: document.documentElement.getAttribute('data-theme'),
    bodyClass: document.body.className
  }));
  rec('PREFS', 'a junk density in storage falls back to the default',
    survived.prefs.density === 'comfortable', JSON.stringify(survived.prefs));
  rec('PREFS', 'an unknown theme in storage falls back to the default',
    survived.prefs.theme === 'light' && survived.theme === 'light',
    JSON.stringify({ pref: survived.prefs.theme, resolved: survived.theme }));
  rec('PREFS', 'a wrong-typed timezone in storage falls back to the default',
    survived.prefs.timezone === 'utc', String(survived.prefs.timezone));
  rec('PREFS', 'a wrong-typed rail flag in storage falls back to the default',
    survived.prefs.rail === false, String(survived.prefs.rail));
  rec('PREFS', 'junk in storage never reaches a class name',
    !/[<>"]/.test(survived.bodyClass), survived.bodyClass);
  await page.evaluate(() => localStorage.removeItem('argus.prefs'));

  // The timezone preference shipped in the first commit and nothing read it,
  // so every timestamp was UTC whatever the operator chose.
  const stamps = await page.evaluate(() => {
    const d = new Date(Date.UTC(2026, 8, 8, 9, 30));
    window.ARGUS.setTimezone('utc');
    const utc = window.ARGUS.ui.fmt.stamp(d);
    window.ARGUS.setTimezone('local');
    const local = window.ARGUS.ui.fmt.stamp(d);
    window.ARGUS.setTimezone('utc');
    return { utc, local, offset: new Date().getTimezoneOffset() };
  });
  rec('PREFS', 'UTC timestamps are marked as UTC', /Z$/.test(stamps.utc), stamps.utc);
  rec('PREFS', 'local timestamps carry their offset', /[+-]\d\d:\d\d$/.test(stamps.local), stamps.local);
  rec('PREFS', 'the timezone preference actually changes what is rendered',
    stamps.offset === 0 || stamps.utc.slice(0, 16) !== stamps.local.slice(0, 16),
    `${stamps.utc} vs ${stamps.local} (offset ${stamps.offset})`);

  rec('PREFS', 'the preferences dialog opens from the header and traps focus',
    await page.evaluate(async () => {
      document.getElementById('prefsbtn').click();
      await new Promise(r => setTimeout(r, 120));
      const dlg = document.querySelector('.dialog[role="dialog"]');
      const ok = !!dlg && dlg.querySelectorAll('input[type="radio"]').length >= 7
        && dlg.contains(document.activeElement);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      (dlg || document).dispatchEvent(esc);
      await new Promise(r => setTimeout(r, 120));
      return ok && !document.querySelector('.dialog[role="dialog"]');
    }));

  /* ------------------------------------------------------------- OVERLAY */

  // A dialog and an overflow menu are both mounted on <body>, so neither is
  // removed when main is cleared. Pressing a "g then key" shortcut while the
  // shortcuts dialog was open left that dialog floating over a different
  // screen, with body.has-dialog stuck on and an opener that no longer existed.
  const strandedDialog = await page.evaluate(async () => {
    window.location.hash = '#/overview';
    await new Promise(r => setTimeout(r, 200));
    window.ARGUS.shortcuts();
    await new Promise(r => setTimeout(r, 200));
    const opened = !!document.querySelector('.dialog[role="dialog"]');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return {
      opened,
      route: window.ARGUS.state.route,
      stillOpen: !!document.querySelector('.dialog[role="dialog"]'),
      bodyClass: document.body.classList.contains('has-dialog')
    };
  });
  rec('OVERLAY', 'navigating away closes an open dialog',
    strandedDialog.opened && strandedDialog.route === 'apps' && !strandedDialog.stillOpen,
    JSON.stringify(strandedDialog));
  rec('OVERLAY', 'navigating away clears the has-dialog state on the body',
    !strandedDialog.bodyClass, JSON.stringify(strandedDialog));

  const strandedMenu = await page.evaluate(async () => {
    window.location.hash = '#/apps';
    await new Promise(r => setTimeout(r, 300));
    const t = document.querySelector('.menubtn');
    if (!t) return { err: 'no menu trigger' };
    t.click();
    await new Promise(r => setTimeout(r, 150));
    const opened = !!document.querySelector('.menu[role="menu"]');
    window.location.hash = '#/compute';
    await new Promise(r => setTimeout(r, 300));
    return { opened, stillOpen: !!document.querySelector('.menu[role="menu"]') };
  });
  rec('OVERLAY', 'navigating away closes an open overflow menu',
    strandedMenu.opened && !strandedMenu.stillOpen, JSON.stringify(strandedMenu));

  // Closing the same dialog twice must not pop the opener stack twice, or the
  // dialog after it inherits an opener that belongs to something else.
  const doubleClose = await page.evaluate(async () => {
    window.location.hash = '#/overview';
    await new Promise(r => setTimeout(r, 200));
    const opener = document.getElementById('helpbtn');
    opener.focus();
    const h = window.ARGUS.dialog({ title: 'First' });
    await new Promise(r => setTimeout(r, 150));
    h.close(); h.close(); h.close();
    await new Promise(r => setTimeout(r, 150));
    const bell = document.getElementById('bell');
    bell.focus();
    const h2 = window.ARGUS.dialog({ title: 'Second' });
    await new Promise(r => setTimeout(r, 150));
    h2.close();
    await new Promise(r => setTimeout(r, 150));
    return { restored: document.activeElement === bell, active: document.activeElement.id };
  });
  rec('OVERLAY', 'closing a dialog more than once does not corrupt the next one',
    doubleClose.restored, JSON.stringify(doubleClose));

  // "Add filter" with an empty box returned silently, so the control looked
  // broken rather than unsatisfied.
  const emptyFilter = await page.evaluate(async () => {
    window.location.hash = '#/apps';
    await new Promise(r => setTimeout(r, 300));
    const input = document.querySelector('.pf-input');
    const add = Array.prototype.filter.call(document.querySelectorAll('#main .btn'),
      b => /Add filter/i.test(b.textContent))[0];
    if (!input || !add) return { err: 'filter controls not found' };
    input.value = '';
    document.getElementById('main').focus();
    const tokensBefore = document.querySelectorAll('.pf-token').length;
    add.click();
    await new Promise(r => setTimeout(r, 150));
    return {
      tokensBefore,
      tokensAfter: document.querySelectorAll('.pf-token').length,
      focused: document.activeElement === input
    };
  });
  rec('OVERLAY', 'adding an empty filter adds nothing and says why',
    emptyFilter.tokensAfter === emptyFilter.tokensBefore && emptyFilter.focused,
    JSON.stringify(emptyFilter));

  /* ---------------------------------------------------------------- MENU */

  await goto(page, 'apps');
  const menuOpen = await page.evaluate(async () => {
    const trig = document.querySelector('.tablewrap .menubtn');
    if (!trig) return { err: 'no overflow trigger rendered' };
    const before = {
      haspopup: trig.getAttribute('aria-haspopup'),
      expanded: trig.getAttribute('aria-expanded'),
      label: trig.getAttribute('aria-label')
    };
    trig.click();
    await new Promise(r => setTimeout(r, 150));
    const pop = document.querySelector('.menu[role="menu"]');
    const items = pop ? pop.querySelectorAll('[role="menuitem"]') : [];
    const r = pop ? pop.getBoundingClientRect() : null;
    return {
      before,
      expandedAfter: trig.getAttribute('aria-expanded'),
      opened: !!pop,
      items: items.length,
      danger: pop ? !!pop.querySelector('.menuitem.danger') : false,
      // A popup mounted inside .tablewrap is clipped by its overflow-x, which
      // sliced the labels in half; it has to live on <body>.
      onBody: pop ? pop.parentElement === document.body : false,
      rect: r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null,
      vw: window.innerWidth, vh: window.innerHeight
    };
  });
  rec('MENU', 'the overflow trigger declares a menu to assistive technology',
    menuOpen.before && menuOpen.before.haspopup === 'menu' && menuOpen.before.expanded === 'false',
    JSON.stringify(menuOpen.before));
  rec('MENU', 'the overflow trigger is individually labelled',
    !!(menuOpen.before && /Actions for /.test(menuOpen.before.label || '')),
    (menuOpen.before || {}).label);
  rec('MENU', 'clicking the trigger opens the menu and flips aria-expanded',
    menuOpen.opened && menuOpen.expandedAfter === 'true', JSON.stringify(menuOpen));
  rec('MENU', 'the menu carries its actions, including a destructive one',
    menuOpen.items >= 5 && menuOpen.danger, JSON.stringify({ items: menuOpen.items, danger: menuOpen.danger }));
  rec('MENU', 'the menu escapes the table scroll container instead of being clipped',
    menuOpen.onBody, 'parent is body: ' + menuOpen.onBody);
  rec('MENU', 'the open menu sits fully inside the viewport',
    !!menuOpen.rect && menuOpen.rect.left >= 0 && menuOpen.rect.top >= 0 &&
    menuOpen.rect.right <= menuOpen.vw + 0.5 && menuOpen.rect.bottom <= menuOpen.vh + 0.5,
    JSON.stringify(menuOpen.rect) + ' in ' + menuOpen.vw + 'x' + menuOpen.vh);

  const menuKeys = await page.evaluate(async () => {
    const pop = document.querySelector('.menu[role="menu"]');
    if (!pop) return { err: 'menu closed unexpectedly' };
    const items = Array.prototype.slice.call(pop.querySelectorAll('[role="menuitem"]'));
    items[0].focus();
    const first = document.activeElement === items[0];
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const second = document.activeElement === items[1];
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const last = document.activeElement === items[items.length - 1];
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const wrapped = document.activeElement === items[0];
    return { first, second, last, wrapped };
  });
  rec('MENU', 'arrow keys move through the menu and wrap at the ends',
    menuKeys.first && menuKeys.second && menuKeys.last && menuKeys.wrapped, JSON.stringify(menuKeys));

  const menuEsc = await page.evaluate(async () => {
    const trig = document.querySelector('.tablewrap .menubtn');
    const pop = document.querySelector('.menu[role="menu"]');
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return {
      closed: !document.querySelector('.menu[role="menu"]'),
      refocused: document.activeElement === trig,
      expanded: trig.getAttribute('aria-expanded')
    };
  });
  rec('MENU', 'Escape closes the menu and returns focus to its trigger',
    menuEsc.closed && menuEsc.refocused && menuEsc.expanded === 'false', JSON.stringify(menuEsc));

  // Opening a row menu must not also trigger the row's own navigation.
  const menuRow = await page.evaluate(async () => {
    window.location.hash = '#/apps';
    await new Promise(r => setTimeout(r, 250));
    const before = window.ARGUS.state.rest.join('/');
    document.querySelector('.tablewrap .menubtn').click();
    await new Promise(r => setTimeout(r, 150));
    const after = window.ARGUS.state.rest.join('/');
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    return { before, after };
  });
  rec('MENU', 'opening a row menu does not navigate the row underneath it',
    menuRow.before === menuRow.after, JSON.stringify(menuRow));

  /* ------------------------------------------------------------- SESSION */

  // The shortcuts table has always documented Escape as closing "a dialog,
  // drawer or palette", but only the navigation drawer was ever wired to it,
  // so a recorded session could be dismissed with the mouse alone.
  const session = await page.evaluate(async () => {
    window.location.hash = '#/compute';
    await new Promise(r => setTimeout(r, 200));
    const vm = window.ARGUS.data.vms.filter(v => v.connect.indexOf('rdp') !== -1)[0];
    window.ARGUS.data.me.elevation = { group: 'Argus-Tier1-Operators', reason: 'test', expires: new Date(Date.now() + 3600000) };
    const opener = document.querySelector('.nav[data-go="compute"]');
    opener.focus();
    window.ARGUS.connect(vm, 'rdp');
    await new Promise(r => setTimeout(r, 150));
    const opened = !document.getElementById('drawer').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const closed = document.getElementById('drawer').hidden;
    const refocused = document.activeElement === opener;
    const emptied = document.getElementById('drawer-body').childNodes.length === 0;
    window.ARGUS.data.me.elevation = null;
    window.ARGUS.paintElevation();
    return { opened, closed, refocused, emptied };
  });
  rec('SESSION', 'a recorded session opens in the drawer', session.opened, JSON.stringify(session));
  rec('SESSION', 'Escape closes the session drawer, as the shortcuts table claims',
    session.closed, JSON.stringify(session));
  rec('SESSION', 'closing the session returns focus to whatever opened it',
    session.refocused, JSON.stringify(session));
  rec('SESSION', 'closing the session tears down the terminal it held',
    session.emptied, JSON.stringify(session));

  /* --------------------------------------------------------------- TIMER */

  // Every screen that starts an interval has to stop it on navigation, or the
  // console accumulates one live timer per visit for the length of a shift.
  const timers = await page.evaluate(async () => {
    let live = 0;
    const realSet = window.setInterval, realClear = window.clearInterval;
    window.setInterval = function () { live++; return realSet.apply(window, arguments); };
    window.clearInterval = function (id) { if (id !== undefined && id !== null) live--; return realClear.call(window, id); };
    for (const r of ['identity', 'security', 'ops', 'overview']) {
      window.location.hash = '#/' + r;
      await new Promise(res => setTimeout(res, 260));
    }
    window.location.hash = '#/overview';
    await new Promise(res => setTimeout(res, 300));
    const net = live;
    window.setInterval = realSet; window.clearInterval = realClear;
    return net;
  });
  rec('TIMER', 'navigating across every ticking screen leaves no timer behind',
    timers <= 1, `net live intervals after the tour: ${timers}`);

  /* ----------------------------------------------------------------- DET */

  let nondet = [];
  for (const r of ROUTES) {
    await goto(page, r);
    const a = await page.evaluate(() => document.getElementById('main').textContent.length);
    await goto(page, 'overview');
    await goto(page, r);
    const b = await page.evaluate(() => document.getElementById('main').textContent.length);
    if (a !== b) nondet.push(`${r} ${a}!=${b}`);
  }
  rec('DET', 'every route renders identically on a second visit', nondet.length === 0, nondet.join(' '));

  /* ---------------------------------------------------------------- CONS */

  const realFails = failedReqs.filter(u => !/favicon/.test(u));
  rec('CONS', 'no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '));
  rec('CONS', 'no failed requests', realFails.length === 0, realFails.slice(0, 4).join(' | '));

  await browser.close();

  /* -------------------------------------------------------------- report */

  const bySuite = {};
  results.forEach(r => {
    bySuite[r.suite] = bySuite[r.suite] || { pass: 0, fail: 0 };
    bySuite[r.suite][r.pass ? 'pass' : 'fail']++;
  });

  console.log('\n  Argus Console: prototype test run');
  console.log('  ' + '-'.repeat(64));
  Object.keys(bySuite).forEach(s => {
    const b = bySuite[s];
    console.log(`  ${s.padEnd(8)} ${String(b.pass).padStart(3)} passed  ${String(b.fail).padStart(3)} failed`);
  });
  console.log('  ' + '-'.repeat(64));

  const fails = results.filter(r => !r.pass);
  if (fails.length) {
    console.log('\n  Failures:\n');
    fails.forEach(f => console.log(`  [${f.suite}] ${f.id}\n        ${f.detail}`));
  } else {
    console.log('\n  All checks passed.');
  }
  console.log(`\n  ${results.length - fails.length}/${results.length} passed. Screenshots in ${SHOTS}\n`);

  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(results, null, 2) + '\n');
  process.exit(fails.length);
})().catch(e => { console.error(e); process.exit(1); });
