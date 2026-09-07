/**
 * Argus Console prototype: the automated test suite.
 *
 *   node tests/run-tests.js [path-to-index.html]
 *
 * Runs in headless Chromium against the real rendered DOM:
 *   A11Y   axe-core WCAG 2.1 A/AA on every screen
 *   NAV    every nav target resolves; exactly one page visible at a time
 *   KBD    every interactive element is reachable and has a visible focus ring
 *   RESP   no horizontal overflow at 1440 / 1024 / 768 / 390 px
 *   TAP    touch targets >= 24px on mobile (WCAG 2.5.8)
 *   TXT    no text smaller than 11px; no clipped/overflowing text nodes
 *   CON    contrast ratios computed from rendered colours, not from tokens
 *   MOTION reduced-motion is respected
 *   CONS   no console errors or failed requests
 *
 * Exit code is the number of failures, so CI can gate on it.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

// axe-core ships its bundle next to its entry point; resolve it rather than
// hardcoding a path, so this runs on a developer machine and on CI alike.
const AXE = fs.readFileSync(path.join(path.dirname(require.resolve('axe-core')), 'axe.min.js'), 'utf8');
const FILE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + path.resolve(FILE);
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'argus-console-shots');

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (suite, id, pass, detail) => results.push({ suite, id, pass, detail });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  const failedReqs = [];
  page.on('requestfailed', r => failedReqs.push(r.url() + ', ' + (r.failure() || {}).errorText));

  await page.goto(URL, { waitUntil: 'load' });
  await page.addScriptTag({ content: AXE });

  const screens = await page.$$eval('.page', ns => ns.map(n => n.id));

  // ---------- NAV ----------
  const navTargets = await page.$$eval('[data-go]', ns => [...new Set(ns.map(n => n.dataset.go))]);
  for (const t of navTargets) {
    rec('NAV', `target "${t}" has a page`, screens.includes(t), screens.includes(t) ? '' : 'no <section id> matches');
  }
  for (const s of screens) {
    const nav = await page.$(`.nav[data-go="${s}"]`);
    if (nav) {
      await nav.click();
      const visible = await page.$$eval('.page', ns => ns.filter(n => !n.hidden).map(n => n.id));
      rec('NAV', `"${s}" shows exactly one page`, visible.length === 1 && visible[0] === s, `visible: ${visible.join(',') || 'none'}`);
      const crumb = await page.$eval('#crumb', n => n.textContent.trim());
      rec('NAV', `"${s}" updates the breadcrumb`, crumb.length > 0 && crumb.toLowerCase() !== 'overview' || s === 'overview', `crumb="${crumb}"`);
    }
  }

  // ---------- A11Y (axe) per screen ----------
  for (const s of screens) {
    await page.evaluate(id => {
      document.querySelectorAll('.page').forEach(p => { p.hidden = (p.id !== id); });
    }, s);
    const r = await page.evaluate(async () => await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations']
    }));
    if (!r.violations.length) rec('A11Y', `${s}: no WCAG A/AA violations`, true, '');
    for (const v of r.violations) {
      rec('A11Y', `${s}: ${v.id}`, false,
        `${v.impact}, ${v.help} (${v.nodes.length}×) e.g. ${(v.nodes[0].target || []).join(' ')}`);
    }
  }

  // ---------- KBD ----------
  await page.evaluate(() => document.querySelectorAll('.page').forEach(p => { p.hidden = (p.id !== 'overview'); }));
  const focusable = await page.$$eval(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ns => ns.filter(n => n.offsetParent !== null).length);
  rec('KBD', 'focusable elements exist on Overview', focusable > 0, `${focusable} found`);

  const clickableNotFocusable = await page.$$eval('[data-go], .link, .kbar, .tbtn', ns =>
    ns.filter(n => {
      if (n.offsetParent === null) return false;
      const tag = n.tagName.toLowerCase();
      const focusable = tag === 'button' || tag === 'a' && n.hasAttribute('href') || n.hasAttribute('tabindex');
      return !focusable;
    }).map(n => (n.className || n.tagName) + ' :: ' + n.textContent.trim().slice(0, 40)));
  rec('KBD', 'no click handler on a non-focusable element', clickableNotFocusable.length === 0,
    clickableNotFocusable.length ? clickableNotFocusable.slice(0, 8).join(' | ') : '');

  // Real keyboard traversal; :focus-visible only matches keyboard focus, never el.focus().
  const noFocusStyle = [];
  const seen = new Set();
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
      return { ring, id: (el.className || el.tagName) + ' :: ' + (el.textContent || '').trim().slice(0, 32) };
    });
    if (!info) break;
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    if (!info.ring) noFocusStyle.push(info.id);
  }
  rec('KBD', 'every tab stop shows a focus indicator', noFocusStyle.length === 0,
    noFocusStyle.length ? `${noFocusStyle.length} without: ` + noFocusStyle.slice(0, 6).join(' | ') : `${seen.size} tab stops checked`);

  // ---------- CON (contrast from rendered pixels' colours) ----------
  const contrast = await page.evaluate(() => {
    const lum = c => { const s = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * s[0] + .7152 * s[1] + .0722 * s[2]; };
    const parse = s => { const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
    // A gradient is a background-image, not a background-color: take its first colour stop.
    const gradOf = s => { const m = s.match(/rgba?\([^)]+\)/); return m ? parse(m[0]) : null; };
    const bgOf = el => {
      let n = el;
      while (n && n !== document.documentElement) {
        const st = getComputedStyle(n);
        const c = parse(st.backgroundColor);
        if (c && c[3] > .5) return c;
        if (st.backgroundImage && st.backgroundImage.includes('gradient')) {
          const g = gradOf(st.backgroundImage);
          if (g) return g;
        }
        n = n.parentElement;
      }
      return [245, 243, 233];
    };
    const hidden = el => el.closest('.sr') !== null || getComputedStyle(el).clip === 'rect(0px, 0px, 0px, 0px)';
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.offsetParent === null || hidden(el)) continue;
      const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join('');
      if (!txt) continue;
      const st = getComputedStyle(el);
      const fg = parse(st.color); if (!fg) continue;
      const bg = bgOf(el);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      const px = parseFloat(st.fontSize), bold = parseInt(st.fontWeight) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (ratio < need) out.push({ text: txt.slice(0, 34), ratio: +ratio.toFixed(2), need, px, sel: el.className || el.tagName });
    }
    return out;
  });
  rec('CON', 'all text meets WCAG AA contrast', contrast.length === 0,
    contrast.length ? contrast.slice(0, 10).map(c => `"${c.text}" ${c.ratio}:1 (need ${c.need}) ${c.sel}`).join(' | ') : '');

  // ---------- TXT ----------
  const tiny = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.offsetParent === null) continue;
      const txt = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).length;
      if (!txt) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 11) out.push(`${el.className || el.tagName} ${px}px "${el.textContent.trim().slice(0, 26)}"`);
    }
    return out;
  });
  rec('TXT', 'no text below 11px', tiny.length === 0, tiny.slice(0, 8).join(' | '));

  const clipped = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('td, th, .val, .lbl, .node b, .pill, .btn')) {
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 2) out.push(`${el.className || el.tagName} "${el.textContent.trim().slice(0, 26)}"`);
    }
    return out;
  });
  rec('TXT', 'no clipped text', clipped.length === 0, clipped.slice(0, 8).join(' | '));

  // ---------- MOTION ----------
  const motionCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const mp = await motionCtx.newPage();
  await mp.goto(URL, { waitUntil: 'load' });
  const stillAnimating = await mp.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.offsetParent === null) continue;
      const a = getComputedStyle(el).animationName;
      if (a && a !== 'none') out.push(el.className || el.tagName);
    }
    return [...new Set(out)];
  });
  rec('MOTION', 'reduced-motion stops all animation', stillAnimating.length === 0, stillAnimating.join(', '));
  await motionCtx.close();

  // ---------- RESP + TAP + screenshots ----------
  for (const [w, h, name] of [[1440, 900, 'desktop'], [1366, 768, 'laptop-1366'], [1280, 800, 'laptop-1280'], [1024, 768, 'small-laptop'], [768, 1024, 'tablet'], [390, 844, 'phone']]) {
    const c = await browser.newContext({ viewport: { width: w, height: h } });
    const p2 = await c.newPage();
    await p2.goto(URL, { waitUntil: 'load' });

    const overflow = await p2.evaluate(() => {
      const d = document.documentElement;
      const wide = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.offsetParent === null) continue;
        if (el.closest('.sr') || getComputedStyle(el).clip === 'rect(0px, 0px, 0px, 0px)') continue;
        const r = el.getBoundingClientRect();
        if (r.right > d.clientWidth + 1) wide.push(`${el.className || el.tagName} → ${Math.round(r.right)}px`);
      }
      return { doc: d.scrollWidth, view: d.clientWidth, wide: [...new Set(wide)].slice(0, 6) };
    });
    rec('RESP', `${name} (${w}px) no horizontal overflow`, overflow.doc <= overflow.view + 1,
      `scrollWidth ${overflow.doc} vs ${overflow.view}${overflow.wide.length ? '; ' + overflow.wide.join(' | ') : ''}`);

    // DENSITY: the constraint on a small laptop is vertical. Chrome plus the
    // page header must not eat the screen before the first card of content.
    if (h <= 800) {
      const d = await p2.evaluate(() => {
        const vh = window.innerHeight;
        const card = document.querySelector('#overview .card');
        const tiles = [...document.querySelectorAll('#overview .tile')];
        return {
          vh,
          firstCardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
          lastTileBottom: tiles.length ? Math.round(tiles[tiles.length - 1].getBoundingClientRect().bottom) : null,
          pageHeight: document.documentElement.scrollHeight
        };
      });
      const budget = Math.round(d.vh * 0.55);
      rec('DENS', `${name} first card clears the fold`, d.firstCardTop !== null && d.firstCardTop < d.vh,
        `card at ${d.firstCardTop}px of ${d.vh}px`);
      rec('DENS', `${name} chrome + header under 55% of the screen`, d.firstCardTop <= budget,
        `${d.firstCardTop}px used, budget ${budget}px`);
      rec('DENS', `${name} all stat tiles above the fold`, d.lastTileBottom <= d.vh,
        `tiles end at ${d.lastTileBottom}px of ${d.vh}px`);
      rec('DENS', `${name} overview under 2 screens tall`, d.pageHeight <= d.vh * 2,
        `${d.pageHeight}px = ${(d.pageHeight / d.vh).toFixed(1)} screens`);
    }

    if (w <= 768) {
      const small = await p2.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a[href], .link, .nav, .tbtn')) {
          if (el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (r.height < 24 || r.width < 24) out.push(`${el.className || el.tagName} ${Math.round(r.width)}×${Math.round(r.height)} "${el.textContent.trim().slice(0, 20)}"`);
        }
        return out;
      });
      rec('TAP', `${name} touch targets >= 24px`, small.length === 0, `${small.length} too small: ` + small.slice(0, 5).join(' | '));
    }

    for (const s of ['overview', 'deploys', 'compute']) {
      // Click the nav rather than toggling hidden, so chrome (breadcrumb, aria-current) matches the screen.
      if (w <= 900) { await p2.click('#burger'); }
      await p2.click(`.nav[data-go="${s}"]`);
      await p2.screenshot({ path: `${SHOTS}/${name}-${s}.png`, fullPage: name === 'desktop' });
    }
    await c.close();
  }

  // ---------- CONS ----------
  rec('CONS', 'no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  const realFails = failedReqs.filter(u => !/fonts\.(googleapis|gstatic)/.test(u));
  rec('CONS', 'no failed requests (fonts excluded: offline sandbox)', realFails.length === 0, realFails.slice(0, 5).join(' | '));

  await browser.close();

  // ---------- report ----------
  const fails = results.filter(r => !r.pass);
  const bySuite = {};
  for (const r of results) { (bySuite[r.suite] ||= { p: 0, f: 0 })[r.pass ? 'p' : 'f']++; }
  console.log('\n  Argus Console: prototype test run');
  console.log('  ' + '─'.repeat(66));
  for (const [s, v] of Object.entries(bySuite)) {
    console.log(`  ${s.padEnd(7)} ${String(v.p).padStart(3)} passed   ${v.f ? String(v.f).padStart(3) + ' FAILED' : '  0 failed'}`);
  }
  console.log('  ' + '─'.repeat(66));
  if (fails.length) {
    console.log('\n  FAILURES\n');
    fails.forEach((f, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. [${f.suite}] ${f.id}`);
      if (f.detail) console.log(`      ${f.detail}`);
    });
  } else {
    console.log('\n  All checks passed.');
  }
  console.log(`\n  ${results.length - fails.length}/${results.length} passed. Screenshots in ${SHOTS}\n`);
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(255); });
