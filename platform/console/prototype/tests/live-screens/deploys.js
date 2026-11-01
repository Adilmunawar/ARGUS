module.exports = async function (ctx) {
  const { page, rec, goto, waitFor, origin, get } = ctx;
  const parse = async (p) => page.evaluate(async (path) => { const e = await window.ARGUS.read(path); return e.data || {}; }, p);
  const apiEnv = await parse('/api/gitops/environments');
  const apiApps = await parse('/api/gitops/apps');
  const expected = [];
  ((apiEnv && apiEnv.environments) || []).forEach((e) => (e.apps || []).forEach((a) => expected.push({ env: e.name, app: a.app, version: a.version, sha: a.sha256, pinned: a.pinned })));

  const settle = () => waitFor(page, () => document.querySelectorAll('.skeleton').length === 0 && document.querySelectorAll('table').length >= 1, null, 8000).catch(() => {});
  const snap = () => page.evaluate(() => {
    const t = document.querySelector('table');
    const rows = t ? Array.prototype.map.call(t.querySelectorAll('tbody tr'), (tr) => Array.prototype.map.call(tr.children, (c) => c.textContent.trim())) : [];
    const main = document.querySelector('main') || document.body;
    return {
      text: main.innerText,
      rows,
      notInStack: Array.prototype.map.call(document.querySelectorAll('[data-not-in-stack]'), (n) => n.getAttribute('data-not-in-stack')),
      sample: document.querySelectorAll('[data-sample-notice]').length,
      buttons: Array.prototype.map.call(main.querySelectorAll('button'), (b) => b.textContent.trim()),
      errors: document.querySelectorAll('.empty.is-error').length,
      appLinks: Array.prototype.map.call(main.querySelectorAll('a[href*="apps/"]'), (a) => a.getAttribute('href'))
    };
  });

  await goto(page, 'deploys');
  await settle();
  const s = await snap();

  rec('DEPLOYS live: the not-in-stack callout names the reconciler', s.notInStack.indexOf('The GitOps reconciler') !== -1, s.notInStack.join(','));
  rec('DEPLOYS live: the API declares the four environment apps', !!(apiEnv && apiEnv.ok) && ['orders', 'billing', 'console', 'caddy'].every((n) => expected.some((e) => e.app === n)), expected.length + ' declared');
  const names = s.rows.map((r) => r[1]).sort().join(',');
  const want = expected.map((e) => e.app).sort().join(',');
  rec('DEPLOYS live: the table lists exactly the apps the API returns', names === want && s.rows.length === expected.length, names);
  rec('DEPLOYS live: every row carries the declared version', expected.every((e) => s.rows.some((r) => r[1] === e.app && r[2] === String(e.version))), expected.map((e) => e.app + ' ' + e.version).join('; '));
  const unpinned = expected.filter((e) => !e.pinned);
  rec('DEPLOYS live: an unpinned row shows the placeholder text', unpinned.length > 0 && unpinned.every((e) => s.rows.some((r) => r[1] === e.app && /Unpinned/.test(r[3]) && r[3].indexOf(e.sha) !== -1)) && /<filled by CI>/.test(s.text), unpinned.length + ' unpinned');
  const caddy = s.rows.filter((r) => r[1] === 'caddy')[0];
  rec('DEPLOYS live: caddy with <catalogued> is marked unpinned', !!caddy && /Unpinned/.test(caddy[3]) && /<catalogued>/.test(caddy[3]), caddy ? caddy[3] : 'no row');
  const pinned = expected.filter((e) => e.pinned);
  rec('DEPLOYS live: a pinned row, if any, is marked pinned', pinned.every((e) => s.rows.some((r) => r[1] === e.app && /^Pinned/.test(r[3]))), pinned.length + ' pinned');
  const apps = apiApps.apps || [];
  rec('DEPLOYS live: declared applications link to apps/<name>', apps.length > 0 && apps.every((a) => s.appLinks.some((h) => h.slice(-('apps/' + a.name).length) === 'apps/' + a.name)), apps.length + ' apps');
  rec('DEPLOYS live: no approve, reject or roll back control', !s.buttons.some((b) => /approve|reject|roll back/i.test(b)), s.buttons.join('|'));
  rec('DEPLOYS live: no fixture queue and no sample notice', !/Awaiting approval|In flight|Service Fabric/i.test(s.text) && s.sample === 0, 'sample notices ' + s.sample);
  rec('DEPLOYS live: no error state', s.errors === 0, String(s.errors));

  await page.evaluate(() => { window.location.hash = '#/deploys/1847'; });
  await page.waitForTimeout(300);
  await settle();
  const d = await snap();
  rec('DEPLOYS live: deep link deploys/1847 shows the callout and the table', d.notInStack.indexOf('The GitOps reconciler') !== -1 && d.rows.length === expected.length, d.rows.length + ' rows');
  rec('DEPLOYS live: deep link shows no fixture deployment id or author', !/1847|Opened by|Blast radius/i.test(d.text) && !d.buttons.some((b) => /approve|reject|roll back/i.test(b)), d.text.slice(0, 60).replace(/\s+/g, ' '));
};
