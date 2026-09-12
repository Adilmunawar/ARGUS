/**
 * Argus Console: the stress and performance harness.
 *
 *   node tests/stress.js [path-to-index.html]
 *
 * run-tests.js asserts properties. sandbox.js presses every control. This
 * file inflates the dataset in the page, drives the console the way a person
 * drives it, and reads counters out of the DevTools protocol -- live DOM
 * nodes, registered event listeners, JS heap after a forced collection,
 * layout and style-recalc counts, script time.
 *
 *   SCALE   render cost per route at 1x, 10x and 50x the dataset, and the
 *           scaling exponent for each. An exponent near 1 is linear and fine;
 *           above ~1.3 something is quadratic and will not survive real data.
 *   LEAK    a long navigation tour, sampling nodes, listeners and heap. The
 *           slope per navigation is the leak rate. A console left open all
 *           night makes several thousand navigations.
 *   INTER   interaction latency at the largest scale: sorting a column,
 *           applying a filter token, switching a tab, opening the palette and
 *           typing, flipping theme and density. These are the actions that
 *           feel slow long before a page load does.
 *   PAINT   layout and style-recalc counts per route, and long tasks. A screen
 *           that recalculates style a thousand times is thrashing.
 *   PARA    the SCALE suite again in parallel contexts, to show the numbers
 *           hold when the machine is busy and are not an artefact of an idle
 *           laptop.
 *
 * Thresholds live in BUDGET below and are deliberately generous: this is a
 * regression gate, not a benchmark contest. Exit code is the failure count.
 *
 * Environment:
 *   STRESS_CYCLES   navigations in the LEAK tour        (default 240)
 *   STRESS_SCALES   dataset multipliers for SCALE       (default 1,10,50)
 *   STRESS_WORKERS  parallel contexts for PARA          (default 4)
 *   STRESS_JSON     where to write the report           (default tests/stress-last-run.json)
 */
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = pathToFileURL(path.resolve(FILE)).href;

const CYCLES = Number(process.env.STRESS_CYCLES || 240);
const SCALES = (process.env.STRESS_SCALES || '1,10,50').split(',').map(Number).filter(n => n > 0);
const WORKERS = Number(process.env.STRESS_WORKERS || 4);
const JSON_OUT = process.env.STRESS_JSON || path.join(__dirname, 'stress-last-run.json');

const ROUTES = ['overview', 'apps', 'deploys', 'compute', 'data', 'identity', 'security', 'ml', 'ops', 'audit', 'stack', 'system', 'storage'];

/**
 * The views that actually cost something.
 *
 * `security`'s default tab is Posture, which reads a fixed 7x7 object and no
 * row collection at all. The tables that would carry thousands of rows in
 * production all live one segment deeper, so they are named here explicitly.
 */
const VIEWS = [
  'overview', 'apps', 'deploys', 'audit',
  'security/alerts', 'security/vulns', 'security/sessions', 'security/posture',
  'identity/people', 'identity/gmsas', 'identity/grants', 'identity/secrets',
  'data/databases', 'data/buckets', 'data/queues', 'data/cache',
  'compute', 'compute/host/hv-03', 'compute/vm/sql-01', 'apps/mills',
  'ops/runbooks', 'ops/backups', 'ops/maintenance', 'ops/cost',
  'ml/pipelines', 'ml/models', 'ml/endpoints', 'ml/imagery'
];

/* Budgets. Each is the point past which a human notices, with headroom for a
   loaded CI box. They are asserted, not printed and ignored. */
const BUDGET = {
  renderMs1x: 120,        // a screen at fixture scale, on a cold route
  renderMs50x: 1200,      // the same screen at 50x data
  scalingExponent: 1.35,  // >1 is superlinear; 1.35 allows for measurement noise
  nodesPerNav: 6,         // live DOM nodes retained per navigation
  listenersPerNav: 1.0,   // registered listeners retained per navigation
  heapKbPerNav: 40,       // JS heap retained per navigation, after collection
  interactionMs: 220,     // any single interaction at the largest scale
  recalcPerRoute: 400     // style recalculations to paint one screen
};

const results = [];
const rec = (suite, id, pass, detail) => results.push({ suite, id, pass, detail: String(detail == null ? '' : detail) });
const skip = (suite, id, detail) => results.push({ suite, id, pass: true, skipped: true, detail: String(detail == null ? '' : detail) });

const round = (n, dp) => Math.round(n * Math.pow(10, dp || 1)) / Math.pow(10, dp || 1);
const median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Least-squares slope of y against x. The leak rate, in units per navigation. */
function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
  return den === 0 ? 0 : num / den;
}

/* ------------------------------------------------------------------ page --- */

/**
 * Dataset inflation, run inside the page.
 *
 * Cloning rows is not enough on its own: several collections are looked up by
 * name, and duplicate names would make the lookups pick the first match every
 * time and quietly hide the very cost we are measuring. Every cloned row that
 * carries an identity gets a distinct one.
 */
const INFLATE = function (factor) {
  var d = window.ARGUS.data;
  if (!window.__argusOriginal) {
    window.__argusOriginal = {};
    Object.keys(d).forEach(function (k) { if (Array.isArray(d[k])) window.__argusOriginal[k] = d[k]; });
  }
  var orig = window.__argusOriginal;

  // The row-heavy collections, with the field that carries each row's identity.
  var KEYED = {
    apps: 'name', vms: 'name', hosts: 'name', sfNodes: 'name',
    deployments: 'id', alerts: 'id', sessions: 'id', grants: 'id',
    people: 'upn', gmsas: 'name', secrets: 'path',
    buckets: 'name', databases: 'name', queues: 'stream',
    vulns: 'id', drills: 'id', backups: 'store', runbooks: 'id',
    audit: null, models: 'name', endpoints: 'name', pipelines: 'name'
  };

  Object.keys(KEYED).forEach(function (coll) {
    var base = orig[coll];
    if (!base || !base.length) return;
    var key = KEYED[coll];
    var out = [];
    for (var i = 0; i < factor; i++) {
      for (var j = 0; j < base.length; j++) {
        var row = base[j];
        if (i === 0) { out.push(row); continue; }
        var copy = {};
        for (var f in row) if (Object.prototype.hasOwnProperty.call(row, f)) copy[f] = row[f];
        if (key && copy[key] !== undefined && copy[key] !== null) {
          copy[key] = typeof copy[key] === 'number' ? copy[key] + i * 100000 : String(copy[key]) + '-c' + i;
        }
        out.push(copy);
      }
    }
    d[coll] = out;
  });

  var counts = {};
  Object.keys(KEYED).forEach(function (c) { if (d[c]) counts[c] = d[c].length; });
  return counts;
};

/**
 * Navigate, and return the time the console spent building the screen.
 *
 * Assigning location.hash fires hashchange on a later task, so timing it
 * against a frame callback measures the frame clock and not the work.
 * history.replaceState changes the hash WITHOUT firing the event, so the
 * synthetic dispatch below runs the shell's own `render` synchronously on
 * this stack and the two clock reads bracket exactly the script work.
 *
 * Layout and style are not on this stack -- they are charged separately, from
 * the protocol's own LayoutDuration and RecalcStyleDuration counters.
 */
const NAVIGATE = function (route) {
  history.replaceState(null, '', '#/' + route);
  var ev;
  try { ev = new HashChangeEvent('hashchange'); } catch (e) { ev = new Event('hashchange'); }
  var t0 = performance.now();
  window.dispatchEvent(ev);
  return performance.now() - t0;
};

/* ------------------------------------------------------------- protocol --- */

async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  const out = {};
  m.forEach(x => { out[x.name] = x.value; });
  return out;
}

async function collectGarbage(cdp) {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch (e) { /* not fatal */ }
}

async function newPage(browser, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message ? e.message : e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(URL);
  await page.waitForFunction((n) => window.ARGUS && window.ARGUS.data && Object.keys(window.ARGUS.screens || {}).length >= n, ROUTES.length, { timeout: 15000 });
  return { ctx, page, cdp, errors };
}

/* ---------------------------------------------------------------- SCALE --- */

/**
 * Render cost per route at each multiplier, plus the scaling exponent.
 *
 * The exponent is fitted in log space across the multipliers actually used, so
 * it does not assume a particular set. Linear work gives ~1.0; a filter inside
 * a map over the same collection gives ~2.0.
 */
async function suiteScale(browser, label) {
  const table = {};

  for (const scale of SCALES) {
    const { ctx, page, cdp, errors } = await newPage(browser);
    const counts = await page.evaluate(INFLATE, scale);

    for (const route of VIEWS) {
      // A view that does not resolve is a harness bug, not a fast screen.
      await page.evaluate(NAVIGATE, route);
      const ok = await page.evaluate(() => !!document.querySelector('#main h1'));
      if (!ok) { rec('SCALE', `${label}${route} resolves to a screen`, false, 'no heading rendered'); continue; }

      // Warm the route once; the first visit pays for lazy one-off work that
      // is not what we are measuring.
      await page.evaluate(NAVIGATE, route);
      await page.evaluate(NAVIGATE, 'overview');

      const N = 7;
      const samples = [];
      const before = await metrics(cdp);
      for (let i = 0; i < N; i++) {
        samples.push(await page.evaluate(NAVIGATE, route));
        await page.evaluate(NAVIGATE, 'overview');
      }
      // Force the layout and style work the script queued to be flushed and
      // charged before the counters are read, or it lands on the next route.
      await page.evaluate(() => document.body.getBoundingClientRect().height);
      const after = await metrics(cdp);

      // Each iteration is two navigations, so the protocol deltas cover 2N.
      const per = 2 * N;
      table[route] = table[route] || {};
      table[route][scale] = {
        ms: round(median(samples), 2),
        layoutMs: round(((after.LayoutDuration - before.LayoutDuration) * 1000) / per, 2),
        styleMs: round(((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000) / per, 2),
        recalc: Math.round((after.RecalcStyleCount - before.RecalcStyleCount) / per),
        layout: Math.round((after.LayoutCount - before.LayoutCount) / per),
        nodes: Math.round(after.Nodes)
      };
    }

    rec('SCALE', `${label}${scale}x: the dataset inflated without error`, errors.length === 0,
      errors.length ? errors.slice(0, 2).join(' | ') : `rows ${JSON.stringify(counts).slice(0, 160)}`);
    await ctx.close();
  }

  // Assertions, per view.
  for (const route of VIEWS) {
    const row = table[route];
    // A view that failed to resolve was already recorded as a failure above;
    // it has no timings.
    if (!row) continue;
    const small = SCALES[0], large = SCALES[SCALES.length - 1];

    if (row[small]) {
      rec('SCALE', `${label}${route} renders inside ${BUDGET.renderMs1x} ms at ${small}x`,
        row[small].ms <= BUDGET.renderMs1x, `${row[small].ms} ms`);
    }
    if (row[large]) {
      rec('SCALE', `${label}${route} renders inside ${BUDGET.renderMs50x} ms at ${large}x`,
        row[large].ms <= BUDGET.renderMs50x, `${row[large].ms} ms at ${large}x`);
    }

    // Fit ms = k * scale^e over the multipliers measured.
    const pts = SCALES.filter(s => row[s] && row[s].ms > 0);
    if (pts.length >= 2) {
      const xs = pts.map(s => Math.log(s));
      const ys = pts.map(s => Math.log(row[s].ms));
      const e = slope(xs, ys);
      rec('SCALE', `${label}${route} scales no worse than linearly`,
        e <= BUDGET.scalingExponent,
        `exponent ${round(e, 2)} (${pts.map(s => `${s}x=${row[s].ms}ms`).join(', ')})`);
    }

    if (row[large]) {
      rec('PAINT', `${label}${route} does not thrash style recalculation at ${large}x`,
        row[large].recalc <= BUDGET.recalcPerRoute, `${row[large].recalc} recalcs per render`);
    }
  }

  return table;
}

/* ----------------------------------------------------------------- LEAK --- */

/**
 * The long tour. Nodes, listeners and heap are sampled every 20 navigations
 * after a forced collection, and the slope of each against navigation count is
 * the retention rate.
 */
async function suiteLeak(browser) {
  const { ctx, page, cdp, errors } = await newPage(browser);
  await page.evaluate(INFLATE, 4);

  const xs = [], nodes = [], listeners = [], heap = [];
  const SAMPLE_EVERY = 20;

  // Settle first: the first pass over each route allocates one-off structures.
  for (const r of ROUTES) await page.evaluate(NAVIGATE, r);
  await collectGarbage(cdp);

  for (let i = 0; i < CYCLES; i++) {
    const route = ROUTES[i % ROUTES.length];
    await page.evaluate(NAVIGATE, route);

    // Exercise the things that register listeners and timers, not just routes.
    if (i % 7 === 3) {
      await page.keyboard.press('Control+K');
      await page.waitForTimeout(30);
      await page.keyboard.press('Escape');
    }
    if (i % 11 === 5) {
      await page.evaluate(() => { const b = document.querySelector('#railbtn'); if (b) b.click(); });
    }

    if (i > 0 && i % SAMPLE_EVERY === 0) {
      await collectGarbage(cdp);
      await page.waitForTimeout(40);
      const m = await metrics(cdp);
      xs.push(i); nodes.push(m.Nodes); listeners.push(m.JSEventListeners); heap.push(m.JSHeapUsedSize / 1024);
    }
  }

  const nodeSlope = slope(xs, nodes);
  const listenerSlope = slope(xs, listeners);
  const heapSlope = slope(xs, heap);

  rec('LEAK', `live DOM nodes do not accumulate across ${CYCLES} navigations`,
    nodeSlope <= BUDGET.nodesPerNav,
    `${round(nodeSlope, 2)} nodes/nav (${nodes[0]} -> ${nodes[nodes.length - 1]})`);

  rec('LEAK', `registered event listeners do not accumulate across ${CYCLES} navigations`,
    listenerSlope <= BUDGET.listenersPerNav,
    `${round(listenerSlope, 3)} listeners/nav (${listeners[0]} -> ${listeners[listeners.length - 1]})`);

  rec('LEAK', `the JS heap does not grow without bound across ${CYCLES} navigations`,
    heapSlope <= BUDGET.heapKbPerNav,
    `${round(heapSlope, 2)} KB/nav (${Math.round(heap[0])} -> ${Math.round(heap[heap.length - 1])} KB)`);

  // Timers are the other thing that survives a navigation. The console's own
  // teardown hook is meant to clear every one.
  const stray = await page.evaluate(() => {
    return new Promise(resolve => {
      let fired = 0;
      const t0 = Date.now();
      const probe = window.setInterval(() => {
        if (Date.now() - t0 > 900) { window.clearInterval(probe); resolve(fired); }
      }, 100);
      // Count DOM mutations outside the mount while nothing should be happening.
      const obs = new MutationObserver(muts => {
        muts.forEach(m => {
          const t = m.target;
          if (t && t.closest && !t.closest('#main') && !t.closest('#live')) fired++;
        });
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      window.setTimeout(() => { obs.disconnect(); }, 900);
    });
  });

  rec('LEAK', 'nothing outside the mount mutates once a screen has been left',
    stray === 0, `${stray} mutations from timers that outlived their screen`);

  rec('QUIET', 'the long tour produced no page errors', errors.length === 0,
    errors.slice(0, 3).join(' | '));

  const series = { xs, nodes, listeners, heapKb: heap.map(h => Math.round(h)) };
  await ctx.close();
  return series;
}

/* ---------------------------------------------------------------- INTER --- */

/**
 * Interaction latency at the largest multiplier. A navigation happens once;
 * sorting a column happens twenty times in a row while somebody hunts for a
 * number, so this is the budget people actually feel.
 */
async function suiteInteraction(browser) {
  const scale = SCALES[SCALES.length - 1];
  const { ctx, page, cdp, errors } = await newPage(browser);
  await page.evaluate(INFLATE, scale);

  const timed = async (id, route, fn) => {
    await page.evaluate(NAVIGATE, route);
    await page.waitForTimeout(60);
    const ms = await fn();
    if (ms === null) { skip('INTER', `${id} (at ${scale}x)`, 'control not present'); return; }
    rec('INTER', `${id} responds inside ${BUDGET.interactionMs} ms at ${scale}x`,
      ms <= BUDGET.interactionMs, `${round(ms, 1)} ms`);
  };

  // Sorting the audit table: the largest collection in the console.
  await timed('sorting a column of the audit table', 'audit', () => page.evaluate(() => {
    const btn = document.querySelector('.th-sort');
    if (!btn) return null;
    const t0 = performance.now();
    btn.click();
    return performance.now() - t0;
  }));

  // Applying a property-filter token.
  await timed('applying a property filter token', 'audit', () => page.evaluate(() => {
    const input = document.querySelector('.pf-input');
    if (!input) return null;
    const t0 = performance.now();
    input.value = 'adil';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return performance.now() - t0;
  }));

  // Switching a tab on a detail screen.
  await timed('switching a tab', 'security', () => page.evaluate(() => {
    const tabs = document.querySelectorAll('.tab');
    if (tabs.length < 2) return null;
    const t0 = performance.now();
    tabs[1].click();
    return performance.now() - t0;
  }));

  // The command palette, which rebuilds its index from the whole dataset.
  await timed('opening the command palette and typing', 'overview', async () => {
    const t0 = Date.now();
    await page.keyboard.press('Control+K');
    await page.waitForTimeout(10);
    await page.keyboard.type('mil');
    await page.waitForTimeout(10);
    const ms = Date.now() - t0 - 20;
    await page.keyboard.press('Escape');
    return ms;
  });

  // Preference flips, which re-render every screen.
  await timed('switching theme', 'apps', () => page.evaluate(() => {
    if (!window.ARGUS.setTheme) return null;
    const t0 = performance.now();
    window.ARGUS.setTheme(window.ARGUS.resolvedTheme() === 'dark' ? 'light' : 'dark');
    return performance.now() - t0;
  }));

  /*
   * Timestamps are formatted at build time, so changing the clock genuinely has
   * to rebuild the screen. Holding that to the same flat budget as a click is
   * measuring the wrong thing -- the honest invariant is that it costs about
   * what navigating to the same screen costs, and no more.
   */
  {
    await page.evaluate(NAVIGATE, 'audit');
    const navSamples = [];
    for (let i = 0; i < 5; i++) {
      navSamples.push(await page.evaluate(NAVIGATE, 'audit'));
      await page.evaluate(NAVIGATE, 'overview');
    }
    await page.evaluate(NAVIGATE, 'audit');
    const tz = await page.evaluate(() => {
      if (!window.ARGUS.setTimezone) return null;
      const t0 = performance.now();
      window.ARGUS.setTimezone(window.ARGUS.prefs().timezone === 'utc' ? 'local' : 'utc');
      return performance.now() - t0;
    });
    const navCost = median(navSamples);
    rec('INTER', `switching timezone costs no more than rebuilding the screen (at ${scale}x)`,
      tz !== null && tz <= navCost * 1.6 + 20,
      `${round(tz, 1)} ms against a ${round(navCost, 1)} ms navigation of the same screen`);
  }

  rec('QUIET', 'interaction pass produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

/* -------------------------------------------------------------- SUSTAIN --- */

/**
 * The same screen, used hard, without navigating away.
 *
 * Navigation is the path the teardown hook covers. But an operator triaging
 * an incident does not navigate -- they sit on one table and sort it, filter
 * it, and sort it again, for twenty minutes. If a repaint rebuilds more than
 * it replaces, or leaves the old rows attached, that is where it shows.
 *
 * The finding is the DRIFT: the last few interactions against the first few.
 * A flat line is correct behaviour.
 */
async function suiteSustain(browser) {
  const scale = SCALES[SCALES.length - 1];
  const TARGETS = ['audit', 'security/alerts', 'identity/people', 'data/buckets'];
  const REPS = 40;
  const out = {};

  const { ctx, page, cdp, errors } = await newPage(browser);
  await page.evaluate(INFLATE, scale);

  for (const view of TARGETS) {
    await page.evaluate(NAVIGATE, view);
    const hasSort = await page.evaluate(() => !!document.querySelector('.th-sort'));
    if (!hasSort) { skip('SUSTAIN', `${view} exposes a sortable column`, 'no sortable header'); continue; }

    await collectGarbage(cdp);
    const start = await metrics(cdp);

    const times = await page.evaluate((reps) => {
      const btn = document.querySelector('.th-sort');
      const xs = [];
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now();
        btn.click();
        xs.push(performance.now() - t0);
      }
      return xs;
    }, REPS);

    await collectGarbage(cdp);
    await page.waitForTimeout(40);
    const end = await metrics(cdp);

    const head = median(times.slice(0, 8));
    const tail = median(times.slice(-8));
    const drift = head > 0 ? tail / head : 1;
    const nodeGrowth = end.Nodes - start.Nodes;
    const listenerGrowth = end.JSEventListeners - start.JSEventListeners;

    out[view] = { head: round(head, 2), tail: round(tail, 2), drift: round(drift, 2), nodeGrowth, listenerGrowth };

    rec('SUSTAIN', `${view}: sorting does not get slower the more it is used`,
      drift <= 1.5, `${REPS} sorts: first ${round(head, 2)} ms -> last ${round(tail, 2)} ms (${round(drift, 2)}x)`);

    rec('SUSTAIN', `${view}: repeated sorting retains no DOM`,
      Math.abs(nodeGrowth) <= 40, `${nodeGrowth >= 0 ? '+' : ''}${nodeGrowth} live nodes over ${REPS} sorts`);

    rec('SUSTAIN', `${view}: repeated sorting retains no listeners`,
      listenerGrowth <= 2, `${listenerGrowth >= 0 ? '+' : ''}${listenerGrowth} listeners over ${REPS} sorts`);
  }

  // Tab ping-pong. Switching a tab does not go through the router, so the
  // shell's teardown hooks are never drained between switches: anything a tab
  // panel starts on render accumulates until the next real navigation.
  for (const view of ['identity/grants', 'security/posture']) {
    await page.evaluate(NAVIGATE, view);
    const tabs = await page.evaluate(() => document.querySelectorAll('.tab').length);
    if (tabs < 2) { skip('SUSTAIN', `${view} has tabs to switch between`, 'single panel'); continue; }

    /*
     * End on the tab we started on, so the "after" reading is taken with the
     * same panel on screen as the "before" and only retention is measured.
     */
    await page.evaluate(() => { document.querySelectorAll('.tab')[0].click(); });
    await collectGarbage(cdp);
    await page.waitForTimeout(60);
    const start = await metrics(cdp);
    await page.evaluate(() => {
      const t = document.querySelectorAll('.tab');
      for (let i = 0; i < 60; i++) t[i % 2].click();
      t[0].click();                      // finish where we began
    });
    await collectGarbage(cdp);
    await page.waitForTimeout(60);
    const end = await metrics(cdp);

    rec('SUSTAIN', `${view}: 60 tab switches retain no DOM`,
      (end.Nodes - start.Nodes) <= 40, `${end.Nodes - start.Nodes} live nodes retained`);
    rec('SUSTAIN', `${view}: 60 tab switches retain no listeners`,
      (end.JSEventListeners - start.JSEventListeners) <= 4,
      `${end.JSEventListeners - start.JSEventListeners} listeners retained`);
    out[view + ' (tabs)'] = {
      nodeGrowth: end.Nodes - start.Nodes,
      listenerGrowth: end.JSEventListeners - start.JSEventListeners
    };
  }

  rec('QUIET', 'sustained use produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  return out;
}

/* ---------------------------------------------------------------- FLASH --- */

/**
 * The flash bar, across a working session.
 *
 * `render()` clears the mount and the breadcrumb on every navigation but never
 * touches the flash host, and almost every caller of A.flash omits the optional
 * timeout. This suite fires one flash per navigation and watches the host.
 */
async function suiteFlash(browser) {
  const REPS = 60;
  const { ctx, page, cdp, errors } = await newPage(browser);

  const wired = await page.evaluate(() => typeof window.ARGUS.flash === 'function');
  if (!wired) { rec('FLASH', 'the console exposes a flash bar', false, 'ARGUS.flash missing'); await ctx.close(); return null; }

  await collectGarbage(cdp);
  const start = await metrics(cdp);

  const growth = await page.evaluate((reps) => {
    const samples = [];
    const host = document.getElementById('flashes');
    for (let i = 0; i < reps; i++) {
      // Exactly what a screen does after a destructive action succeeds.
      window.ARGUS.flash('ok', 'Restart requested', 'MillsApi on sf-0' + (i % 5 + 1) + '.');
      history.replaceState(null, '', '#/' + ['overview', 'apps', 'audit', 'deploys'][i % 4]);
      window.dispatchEvent(new Event('hashchange'));
      if (i % 10 === 9) samples.push({ i: i + 1, inBar: host ? host.childElementCount : -1, docNodes: document.getElementsByTagName('*').length });
    }
    // Finish on the screen we started on, or the node count difference is
    // partly just a different screen. Only the notifications should be left
    // to account for.
    history.replaceState(null, '', '#/overview');
    window.dispatchEvent(new Event('hashchange'));
    return samples;
  }, REPS);

  await collectGarbage(cdp);
  await page.waitForTimeout(60);
  const end = await metrics(cdp);

  const last = growth[growth.length - 1] || { inBar: -1, docNodes: 0 };
  const barSlope = slope(growth.map(g => g.i), growth.map(g => g.inBar));

  rec('FLASH', `notifications do not accumulate across ${REPS} navigations`,
    barSlope <= 0.1,
    `${round(barSlope, 2)} kept per navigation; ${last.inBar} still on screen after ${REPS}`);

  /* The right question is whether the document GROWS, not what it weighs: the
     ceiling deliberately keeps the last few notifications on screen, so a raw
     before/after difference counts the feature as if it were the defect. The
     slope across the run is the thing that must be flat. */
  const docSlope = slope(growth.map(g => g.i), growth.map(g => g.docNodes));
  rec('FLASH', 'the document does not grow across a working session',
    Math.abs(docSlope) <= 0.5,
    `${round(docSlope, 3)} nodes per navigation; ${last.inBar} notifications on screen, ` +
    `${end.Nodes - start.Nodes} nodes above the empty shell`);

  rec('QUIET', 'the flash pass produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  return { growth, retainedNodes: end.Nodes - start.Nodes, keptPerNav: round(barSlope, 2) };
}

/* ----------------------------------------------------------------- SOAK --- */

/**
 * Sitting still.
 *
 * Some screens start a timer: an elevation countdown, a session player, a log
 * tail. A console is left open on one of those all day. Nothing else in the
 * suite waits long enough to see what a timer does over minutes, so this dwells
 * on each of them and watches the same three counters. Anything that appends
 * on a tick without a cap shows up here as a slope and nowhere else.
 */
async function suiteSoak(browser) {
  const DWELL_MS = Number(process.env.STRESS_SOAK_MS || 12000);
  const TARGETS = ['identity/grants', 'security/sessions', 'ops/runbooks', 'overview'];
  const out = {};

  const { ctx, page, cdp, errors } = await newPage(browser);
  await page.evaluate(INFLATE, 4);

  for (const view of TARGETS) {
    await page.evaluate(NAVIGATE, view);
    await page.waitForTimeout(300);
    await collectGarbage(cdp);
    const start = await metrics(cdp);

    const samples = [];
    const step = Math.max(1000, Math.round(DWELL_MS / 6));
    for (let t = step; t <= DWELL_MS; t += step) {
      await page.waitForTimeout(step);
      // Collect before each sample. Without this the slope measures allocation
      // churn between collections rather than retention.
      await collectGarbage(cdp);
      const m = await metrics(cdp);
      samples.push({ t, nodes: m.Nodes, listeners: m.JSEventListeners, heapKb: m.JSHeapUsedSize / 1024 });
    }

    await collectGarbage(cdp);
    await page.waitForTimeout(60);
    const end = await metrics(cdp);

    const xs = samples.map(s => s.t / 1000);
    const nodeSlope = slope(xs, samples.map(s => s.nodes));
    const heapSlope = slope(xs, samples.map(s => s.heapKb));

    out[view] = {
      nodesPerSec: round(nodeSlope, 2),
      heapKbPerSec: round(heapSlope, 2),
      retainedNodes: end.Nodes - start.Nodes,
      retainedListeners: end.JSEventListeners - start.JSEventListeners
    };

    rec('SOAK', `${view}: dwelling ${Math.round(DWELL_MS / 1000)} s adds no unbounded DOM`,
      nodeSlope <= 2 && (end.Nodes - start.Nodes) <= 40,
      `${round(nodeSlope, 2)} nodes/s, ${end.Nodes - start.Nodes} retained after collection`);

    rec('SOAK', `${view}: dwelling ${Math.round(DWELL_MS / 1000)} s does not grow the heap without bound`,
      heapSlope <= 60, `${round(heapSlope, 2)} KB/s while idle on the screen`);
  }

  rec('QUIET', 'the soak produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  return out;
}

/* --------------------------------------------------------------- SEARCH --- */

/**
 * The command palette, at inventory scale.
 *
 * The palette indexes every screen, application, virtual machine, host, bucket,
 * database and runbook, and it rescores on every keystroke. Typing latency is
 * the most unforgiving budget in the console, because it is judged against the
 * keyboard rather than against a page load.
 */
async function suiteSearch(browser) {
  const { ctx, page, errors } = await newPage(browser);
  await page.evaluate(INFLATE, 200);

  const perKey = await page.evaluate(async () => {
    window.ARGUS.palette();
    await new Promise(r => setTimeout(r, 60));
    const input = document.querySelector('.pal-input');
    if (!input) return null;
    const times = [];
    for (const ch of 'millsdash') {
      input.value += ch;
      const t0 = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      times.push(performance.now() - t0);
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return times;
  });

  if (!perKey) {
    rec('SEARCH', 'the palette accepts typed input', false, 'no input field found');
  } else {
    const worst = Math.max.apply(null, perKey);
    rec('SEARCH', 'a keystroke in the palette stays under 60 ms at 200x inventory',
      worst <= 60, `worst ${round(worst, 2)} ms, median ${round(median(perKey), 2)} ms over ${perKey.length} keys`);

    // Later keystrokes narrow the result set, so they must not cost more than
    // early ones. A rising curve means the work is proportional to the whole
    // inventory rather than to the matches.
    const early = median(perKey.slice(0, 3)), late = median(perKey.slice(-3));
    rec('SEARCH', 'typing does not get more expensive as the query grows',
      late <= early * 1.8 + 4, `first keys ${round(early, 2)} ms, last keys ${round(late, 2)} ms`);
  }

  rec('QUIET', 'the palette pass produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  return perKey;
}

/* --------------------------------------------------------------- PLAYER --- */

/**
 * The recorded-session player.
 *
 * The fixture keystroke tracks are six entries long. A real 28-minute
 * Guacamole recording is hundreds to thousands, and the player repaints its
 * whole log on every tick of playback and on every pointer move while
 * scrubbing -- so this is the screen where the fixture size hides the cost
 * most completely. It also checks the geometry of the scrubber markers.
 */
async function suitePlayer(browser) {
  const { ctx, page, errors } = await newPage(browser);

  await page.evaluate(NAVIGATE, 'security/sessions');
  await page.waitForTimeout(150);

  // The player mounts when a session is selected, which is a row click on the
  // sessions table rather than a button with a predictable label.
  const opened = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('#main button')]
      .find(b => /replay|watch|open recording/i.test(b.textContent));
    if (btn) btn.click();
    else {
      const row = document.querySelector('#main .tablewrap tbody tr.is-clickable');
      if (!row) return false;
      row.click();
    }
    await new Promise(r => setTimeout(r, 300));
    return !!document.querySelector('.scrubber input[type="range"]');
  });

  if (!opened) {
    skip('PLAYER', 'the session player opens', 'no replay control on this screen');
    rec('QUIET', 'the player pass produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
    return null;
  }

  const geometry = await page.evaluate(() => {
    const track = document.querySelector('.scrubber-track');
    const marks = [...document.querySelectorAll('.scrubber-marker')];
    const range = document.querySelector('.scrubber input[type="range"]');
    if (!track || !range) return null;
    const t = track.getBoundingClientRect();
    const r = range.getBoundingClientRect();
    const outside = marks.filter(m => {
      const b = m.getBoundingClientRect();
      return b.left < t.left - 2 || b.right > t.right + 2;
    }).length;
    return {
      markers: marks.length, outside,
      trackWidth: Math.round(t.width), rangeHeight: Math.round(r.height)
    };
  });

  if (geometry) {
    rec('PLAYER', 'every keystroke marker lands inside the scrubber track',
      geometry.outside === 0,
      `${geometry.outside} of ${geometry.markers} outside a ${geometry.trackWidth}px track`);
    rec('PLAYER', 'the playhead meets the 24 px target floor',
      geometry.rangeHeight >= 24, `${geometry.rangeHeight}px tall`);
  }

  // Scrub the way a pointer does, and time the repaints.
  const scrub = await page.evaluate(async () => {
    const range = document.querySelector('.scrubber input[type="range"]');
    const max = Number(range.max) || 100;
    const times = [];
    for (let i = 0; i <= 40; i++) {
      range.value = String(Math.round((i / 40) * max));
      const t0 = performance.now();
      range.dispatchEvent(new Event('input', { bubbles: true }));
      times.push(performance.now() - t0);
    }
    return times;
  });

  const worst = Math.max.apply(null, scrub);
  rec('PLAYER', 'a scrubber repaint stays inside one frame budget',
    worst <= 16, `worst ${round(worst, 2)} ms, median ${round(median(scrub), 2)} ms over 41 positions`);

  rec('QUIET', 'the player pass produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  return { geometry, worst: round(worst, 2) };
}

/* --------------------------------------------------------------- SCROLL --- */

/**
 * Scrolling a long table.
 *
 * A viewport-anchored gradient the browser cannot fast-path, or a blur on the
 * sticky top bar that has to be re-sampled whenever anything moves behind it,
 * would make every scroll frame more expensive independent of row count.
 * Both are asserted directly as well as measured.
 */
async function suiteScroll(browser) {
  const { ctx, page, errors } = await newPage(browser);
  await page.evaluate(INFLATE, 50);
  await page.evaluate(NAVIGATE, 'audit');
  await page.waitForTimeout(250);

  const frames = await page.evaluate(async () => {
    const marks = [];
    let last = performance.now();
    let running = true;
    function tick(now) {
      marks.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    for (let i = 0; i < 40; i++) {
      window.scrollBy(0, 60);
      await new Promise(r => requestAnimationFrame(r));
    }
    running = false;
    return marks.slice(2);          // drop the first two, which include setup
  });

  let p95 = null;
  if (!frames.length) {
    rec('SCROLL', 'frame timings were captured', false, 'no frames recorded');
  } else {
    const sorted = frames.slice().sort((a, b) => a - b);
    p95 = round(sorted[Math.floor(sorted.length * 0.95)], 1);
    const long = frames.filter(f => f > 50).length;
    rec('SCROLL', 'scrolling a 50x table drops no long frames',
      long === 0, `${long} frames over 50 ms; p95 ${p95} ms over ${frames.length} frames`);
  }

  const css = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const top = document.querySelector('.top');
    const t = top ? getComputedStyle(top) : null;
    return {
      attachment: body.backgroundAttachment,
      backdrop: t ? (t.backdropFilter || t.webkitBackdropFilter || 'none') : 'none'
    };
  });
  rec('SCROLL', 'the page background is not viewport-anchored',
    css.attachment !== 'fixed', `background-attachment: ${css.attachment}`);
  rec('SCROLL', 'the sticky top bar does not blur its backdrop',
    !css.backdrop || css.backdrop === 'none', `backdrop-filter: ${css.backdrop}`);

  rec('QUIET', 'the scroll pass produced no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  return { p95 };
}

/* ----------------------------------------------------------------- PARA --- */

/**
 * The same measurement in parallel contexts. A number that only holds on an
 * idle machine is not a number you can gate a pull request on.
 */
async function suiteParallel(browser) {
  const scale = SCALES[Math.min(1, SCALES.length - 1)];
  const jobs = [];

  for (let w = 0; w < WORKERS; w++) {
    jobs.push((async () => {
      const { ctx, page, errors } = await newPage(browser);
      await page.evaluate(INFLATE, scale);
      const times = {};
      for (const route of ROUTES) {
        await page.evaluate(NAVIGATE, route);
        const s = [];
        for (let i = 0; i < 3; i++) {
          s.push(await page.evaluate(NAVIGATE, route));
          await page.evaluate(NAVIGATE, 'overview');
        }
        times[route] = round(median(s), 1);
      }
      await ctx.close();
      return { worker: w, times, errors };
    })());
  }

  const all = await Promise.all(jobs);

  const clean = all.filter(r => r.errors.length === 0).length;
  rec('PARA', `${WORKERS} consoles driven at once all stayed error-free`, clean === WORKERS,
    `${clean}/${WORKERS} clean`);

  // Under contention, no route should collapse: compare the worst worker to
  // the best and flag a route whose spread is wild, which usually means it is
  // contending for the main thread rather than doing bounded work.
  for (const route of ROUTES) {
    const xs = all.map(r => r.times[route]).filter(n => typeof n === 'number' && n > 0);
    if (xs.length < 2) continue;
    const lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
    rec('PARA', `${route} stays within 6x of itself under ${WORKERS}-way contention`,
      hi <= Math.max(lo * 6, 60), `${lo}-${hi} ms across workers`);
  }

  return all;
}

/* ----------------------------------------------------------------- main --- */

function report(scaleTable, leakSeries, sustain, soak, flash, search, player, scroll) {
  ['INTER', 'SUSTAIN', 'PLAYER'].forEach(suite => {
    const mine = results.filter(r => r.suite === suite);
    if (mine.length && mine.every(r => r.skipped)) {
      rec(suite, `${suite} found a control to measure`, false,
        'every check in this suite skipped, so the suite proves nothing');
    }
  });

  const suites = {};
  results.forEach(r => {
    suites[r.suite] = suites[r.suite] || { pass: 0, fail: 0, skip: 0 };
    if (r.skipped) suites[r.suite].skip++;
    else if (r.pass) suites[r.suite].pass++;
    else suites[r.suite].fail++;
  });

  console.log('');
  console.log('  Argus Console: stress and performance');
  console.log('  ' + URL);
  console.log('  cycles=' + CYCLES + '  scales=' + SCALES.join(',') + '  workers=' + WORKERS);
  console.log('');

  // The scale table, because the shape of the numbers is the finding.
  if (scaleTable) {
    const big = SCALES[SCALES.length - 1];
    console.log('  script ms to build a screen, by dataset multiplier' +
      '   |  at ' + big + 'x: layout+style ms, exponent');
    console.log('  ' + 'view'.padEnd(20) + SCALES.map(s => (s + 'x').padStart(9)).join('') +
      '   |' + 'layout'.padStart(9) + 'style'.padStart(8) + 'exp'.padStart(7));
    VIEWS.forEach(r => {
      const row = scaleTable[r] || {};
      const pts = SCALES.filter(s => row[s] && row[s].ms > 0);
      let exp = '-';
      if (pts.length >= 2) {
        exp = round(slope(pts.map(s => Math.log(s)), pts.map(s => Math.log(row[s].ms))), 2).toFixed(2);
      }
      const b = row[big] || {};
      console.log('  ' + r.padEnd(20) +
        SCALES.map(s => String(row[s] ? row[s].ms.toFixed(2) : '-').padStart(9)).join('') +
        '   |' + String(b.layoutMs == null ? '-' : b.layoutMs.toFixed(2)).padStart(9) +
        String(b.styleMs == null ? '-' : b.styleMs.toFixed(2)).padStart(8) +
        String(exp).padStart(7));
    });
    console.log('');
  }

  Object.keys(suites).sort().forEach(s => {
    const v = suites[s];
    console.log('  ' + s.padEnd(8) + String(v.pass).padStart(4) + ' passed  ' + String(v.fail).padStart(4) + ' failed' +
      (v.skip ? String(v.skip).padStart(5) + ' skipped' : ''));
  });

  const failures = results.filter(r => !r.pass);
  if (failures.length) {
    console.log('');
    failures.forEach(f => console.log('  FAIL  [' + f.suite + '] ' + f.id + (f.detail ? '\n        ' + f.detail : '')));
  }

  console.log('');
  console.log(failures.length ? '  ' + failures.length + ' budget(s) exceeded.' : '  Every budget held.');
  console.log('');

  fs.writeFileSync(JSON_OUT, JSON.stringify({
    url: URL, cycles: CYCLES, scales: SCALES, workers: WORKERS,
    budget: BUDGET, scaleTable, leakSeries, sustain, soak, flash, search, player, scroll, results
  }, null, 2));

  return failures.length;
}

(async () => {
  if (!fs.existsSync(path.resolve(FILE))) {
    console.error('no such file: ' + FILE);
    process.exit(1);
  }

  const browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
  let scaleTable = null, leakSeries = null, sustain = null, soak = null, flash = null;
  let search = null, player = null, scroll = null;

  try {
    scaleTable = await suiteScale(browser, '');
    leakSeries = await suiteLeak(browser);
    await suiteInteraction(browser);
    sustain = await suiteSustain(browser);
    flash = await suiteFlash(browser);
    search = await suiteSearch(browser);
    player = await suitePlayer(browser);
    scroll = await suiteScroll(browser);
    soak = await suiteSoak(browser);
    await suiteParallel(browser);
  } catch (e) {
    rec('HARNESS', 'the harness itself ran to completion', false, String(e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
  }

  process.exit(report(scaleTable, leakSeries, sustain, soak, flash, search, player, scroll));
})();
