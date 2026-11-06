'use strict';

module.exports = async (ctx) => {
  const { page, rec, goto, waitFor } = ctx;

  await goto(page, 'ml');
  const settled = await waitFor(page, () => {
    const cards = document.querySelectorAll('#main .card');
    return cards.length >= 2 && !document.querySelector('#main .skel') && !document.querySelector('#main [data-state="loading"]');
  }, null, 6000);
  rec('panels settle', settled, settled ? 'no skeleton left' : 'still loading');

  const text = await page.evaluate(() => document.getElementById('main').innerText);

  const nis = await page.evaluate(() => {
    const n = document.querySelector('[data-not-in-stack]');
    return n ? n.innerText : '';
  });
  rec('not-in-stack callout names the ML platform', /ML platform/.test(nis) && /Not in this stack/.test(nis), nis.slice(0, 60));

  const buckets = await page.evaluate(() => window.ARGUS.read('/api/storage/buckets'));
  const bk = (buckets && buckets.data) || {};
  const declared = (bk.buckets || []).filter((b) => /ml|raster|sentinel/i.test(b.name)).map((b) => b.name);
  const unconfigured = (buckets && buckets.ok === false && buckets.error && buckets.error.reason === 'not-configured') || bk.topologyOk === false;
  if (ctx.external) {
    rec('the full stack has an object store behind the buckets, and the API lists them', !unconfigured && !!(buckets && buckets.ok) && (bk.buckets || []).length > 0, 'ok=' + (buckets && buckets.ok) + ' topologyOk=' + bk.topologyOk + ' buckets=' + (bk.buckets || []).length);
  } else {
    rec('the harness has no object store behind the buckets', unconfigured, 'ok=' + (buckets && buckets.ok) + ' topologyOk=' + bk.topologyOk);
  }

  const bp = await page.evaluate(() => {
    const p = document.querySelector('#main .livepanel[data-path="/api/storage/buckets"]');
    if (!p) return null;
    return {
      state: p.getAttribute('data-state'),
      tables: p.querySelectorAll('table').length,
      text: p.innerText,
      links: Array.from(p.querySelectorAll('a')).map((a) => a.getAttribute('href') || '')
    };
  });
  rec('buckets panel is a live panel that settled', !!bp && ['ok', 'stale', 'notConfigured', 'unreachable'].indexOf(bp.state) !== -1, JSON.stringify(bp && bp.state));
  rec('buckets panel is a one-line summary that defers to Storage rather than a second bucket table',
    !!bp && bp.tables === 0 && (bp.state !== 'ok' || bp.links.some((h) => /storage$/.test(h))), JSON.stringify(bp && bp.links));
  rec('buckets panel links each API bucket that matches ml, raster or sentinel to Storage',
    !!bp && (bp.state !== 'ok' || declared.every((n) => bp.links.some((h) => h.indexOf('bucket=' + encodeURIComponent(n)) !== -1))), declared.join(', ') || 'none declared');
  rec('buckets panel shows no size figure', !!bp && !/\d\s?(TiB|GiB|MiB|TB|GB|MB)\b/.test(bp.text), 'no byte figure');

  const apiEnv = await page.evaluate(() => window.ARGUS.read('/api/gitops/service-accounts'));
  const accounts = (apiEnv && apiEnv.data && apiEnv.data.accounts) || [];
  const svc = accounts.filter((a) => a.name === 'svc-ml')[0];
  const accText = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#main .card')).filter((x) => /Declared applications/.test(x.innerText))[0];
    return c ? c.innerText : '';
  });
  const host = svc && svc.hosts && svc.hosts[0];
  rec('API declares svc-ml on gpu-01', !!svc && host === 'gpu-01', String(host));
  const row = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#main tbody tr')).filter((r) => /svc-ml/.test(r.innerText));
    return rows[0] ? rows[0].innerText : '';
  });
  rec('accounts panel lists svc-ml with the host read from the API', /svc-ml/.test(row) && !!host && row.indexOf(host) !== -1, row.replace(/\s+/g, ' ').slice(0, 80));
  rec('accounts panel lists the geo accounts too', /gmsa-geo\$/.test(accText) && /gmsa-maps\$/.test(accText), 'gmsa-geo$ and gmsa-maps$');
  rec('accounts panel excludes accounts with no ML grant', !/gmsa-backup\$/.test(accText) && !/gmsa-orders\$/.test(accText), 'backup and orders absent');
  rec('accounts panel carries its read time',
    await page.evaluate(() => !!document.querySelector('#main .livepanel[data-path="/api/gitops/service-accounts"] .readstamp[data-read-at]')), 'read stamp present');

  const fixtures = ['Orders dashboard', 'ray-serve', 'Materialise', 'Dagster asset', 'NVIDIA', 'Sentinel-2 scenes'];
  const pipelines = await page.evaluate(() => {
    const d = window.ARGUS.data;
    const names = [];
    (d.pipelines || []).forEach((p) => names.push(p.asset));
    (d.models || []).forEach((m) => names.push(m.run));
    (d.endpoints || []).forEach((e) => names.push(e.name));
    return names;
  });
  const leaked = pipelines.filter((n) => text.indexOf(n) !== -1);
  rec('no fixture pipeline, model or endpoint name appears', pipelines.length > 0 && leaked.length === 0, leaked.join(', ') || (pipelines.length + ' names checked'));
  const leakedWords = fixtures.filter((n) => text.indexOf(n) !== -1);
  rec('no fixture phrase appears', leakedWords.length === 0, leakedWords.join(', ') || 'clean');

  const btns = await page.evaluate(() => Array.from(document.querySelectorAll('#main button')).map((b) => b.textContent));
  const bad = btns.filter((t) => /promote|canary|materialise/i.test(t));
  rec('no promote, canary or materialise button exists', bad.length === 0, bad.join(', ') || (btns.length + ' buttons'));

  const tabs = await page.evaluate(() => document.querySelectorAll('#main [role=tab]').length);
  rec('no fixture tabs are rendered', tabs === 0, String(tabs));

  const errs = await page.evaluate(() => document.querySelectorAll('#main [data-state="failed"],#main [data-state="timeout"]').length);
  rec('no panel is in a failed or timeout state', errs === 0, String(errs));

  await page.evaluate(() => { window.location.hash = '#/ml/models'; });
  await page.waitForTimeout(300);
  await waitFor(page, () => !document.querySelector('#main .skel'), null, 4000);
  const deep = await page.evaluate(() => ({ route: window.ARGUS.state.route, notIn: !!document.querySelector('[data-not-in-stack]'), tabs: document.querySelectorAll('#main [role=tab]').length }));
  rec('deep link ml/models resolves to the same live screen', deep.route === 'ml' && deep.notIn && deep.tabs === 0, JSON.stringify(deep));
};
