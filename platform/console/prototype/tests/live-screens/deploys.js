module.exports = async function (ctx) {
  const { page, rec, goto, waitFor } = ctx;
  const parse = async (p) => page.evaluate(async (path) => { const e = await window.ARGUS.read(path); return e.data || {}; }, p);
  const apiEnv = await parse('/api/gitops/environments');
  const apiApps = await parse('/api/gitops/apps');
  const expected = [];
  ((apiEnv && apiEnv.environments) || []).forEach((e) => (e.apps || []).forEach((a) => expected.push({ env: e.name, app: a.app, version: a.version, sha: a.sha256, pinned: a.pinned })));

  const settle = () => waitFor(page, () => document.querySelectorAll('#main .skel').length === 0 && (document.querySelectorAll('#main table').length >= 1 || !!document.querySelector('#main .notfound')), null, 8000).catch(() => {});
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
      errors: document.querySelectorAll('#main [data-state="failed"],#main [data-state="unreachable"],#main [data-state="timeout"]').length,
      panels: Array.prototype.map.call(document.querySelectorAll('#main .livepanel'), (p) => p.getAttribute('data-path') + ':' + p.getAttribute('data-state')),
      notFound: (() => { const n = document.querySelector('#main .notfound'); return n ? n.getAttribute('data-state') + ':' + n.getAttribute('data-reason') : null; })(),
      outside: (() => { const c = main.cloneNode(true); c.querySelectorAll('.notfound').forEach((n) => n.remove()); return c.textContent; })(),
      h1: Array.prototype.map.call(document.querySelectorAll('#main h1'), (h) => h.textContent),
      appLinks: Array.prototype.map.call(main.querySelectorAll('a[href*="apps/"]'), (a) => a.getAttribute('href'))
    };
  });

  await goto(page, 'deploys');
  await settle();
  const s = await snap();

  rec('DEPLOYS live: the not-in-stack callout names the reconciler', s.notInStack.indexOf('The GitOps reconciler') !== -1, s.notInStack.join(','));
  const fs = require('fs');
  const path = require('path');
  const envDir = path.resolve(__dirname, '..', '..', '..', '..', 'gitops', 'environments');
  const onDisk = [];
  fs.readdirSync(envDir).filter((n) => /\.ya?ml$/.test(n)).forEach((n) => {
    let inApps = false;
    fs.readFileSync(path.join(envDir, n), 'utf8').split(/\r?\n/).forEach((line) => {
      if (/^apps:\s*$/.test(line)) { inApps = true; return; }
      if (/^\S/.test(line)) { inApps = false; return; }
      const m = inApps && /^\s+([a-z0-9-]+):/.exec(line);
      if (m) onDisk.push(m[1]);
    });
  });
  rec('DEPLOYS live: the API declares exactly the environment apps the GitOps files list', !!(apiEnv && apiEnv.ok) && onDisk.length > 0 && onDisk.slice().sort().join(',') === expected.map((e) => e.app).sort().join(','), onDisk.join(',') + ' on disk, ' + expected.length + ' declared');
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
  rec('DEPLOYS live: both declaration panels settle in the ok state', s.panels.indexOf('/api/gitops/environments:ok') !== -1 && s.panels.indexOf('/api/gitops/apps:ok') !== -1, s.panels.join(','));

  await page.evaluate(() => { window.location.hash = '#/deploys/1847'; });
  await page.waitForTimeout(300);
  await settle();
  const d = await snap();
  rec('DEPLOYS live: deep link deploys/1847 is not found, with the reconciler callout saying why', d.notFound === 'notFound:unknown-id' && d.h1.length === 1 && d.h1[0] === 'No such deployment' && d.notInStack.indexOf('The GitOps reconciler') !== -1, JSON.stringify({ nf: d.notFound, h1: d.h1 }));
  rec('DEPLOYS live: the not-found page links back to the declared versions', /deploys$/.test(await page.evaluate(() => { const a = document.querySelector('#main .notfound a'); return a ? a.getAttribute('href') : ''; })));
  rec('DEPLOYS live: deep link shows no fixture deployment id or author', !/1847|Opened by|Blast radius/i.test(d.outside) && !d.buttons.some((b) => /approve|reject|roll back/i.test(b)), d.text.slice(0, 60).replace(/\s+/g, ' '));
};
