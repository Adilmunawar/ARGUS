module.exports = async function (ctx) {
  const { page, rec, goto, waitFor } = ctx;

  const PATHS = ['/api/storage/buckets', '/api/storage/capacity', '/api/storage/lock-status', '/api/storage/health'];
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const inventory = (names) => ({
    ok: true,
    buckets: names.map((n) => ({
      name: n, diskBytes: 1048576, reclaimableBytes: 0, liveBytes: 1048576, needles: 4, liveNeedles: 4,
      unknownSize: false, volumes: 1, versioning: false, lock: null, lockDays: null, lockDeclared: null,
      lockEnforced: null, owner: 'ops', lifecycleDays: null, backup: null, replication: 'not configured'
    })),
    count: names.length, inventorySource: 'storage-init', countsFrom: 'the master', drift: { declaredButMissing: [], existsButUndeclared: [] },
    topologyOk: true, at: new Date().toISOString()
  });

  const settled = () => waitFor(page, () => {
    const main = document.getElementById('main');
    return main.querySelectorAll('.livepanel').length > 0 && main.querySelectorAll('.livepanel[data-state="loading"]').length === 0;
  }, null, 12000);

  const panels = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#main .livepanel'), (p) => ({
    path: p.getAttribute('data-path'),
    state: p.getAttribute('data-state'),
    reason: p.getAttribute('data-reason'),
    stamp: !!p.querySelector('p.readstamp[data-read-at]'),
    block: (p.querySelector('.stateblock[data-state]') || { getAttribute: () => null }).getAttribute('data-state'),
    retry: Array.prototype.some.call(p.querySelectorAll('button'), (b) => /Try again/.test(b.textContent)),
    detail: (p.querySelector('.state-detail') || {}).textContent || ''
  })));

  const openHash = async (hash) => {
    if (await page.evaluate((h) => window.location.hash === h, hash)) {
      await page.evaluate(() => { window.location.hash = '#/overview'; });
      await page.waitForFunction(() => window.ARGUS.state.route === 'overview', null, { timeout: 4000 });
    }
    await page.evaluate((h) => { window.ARGUS.forget(); window.location.hash = h; }, hash);
    await page.waitForFunction(() => window.ARGUS.state.route === 'storage', null, { timeout: 4000 });
    await page.waitForTimeout(80);
  };

  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'storage');
  await settled();
  const real = await page.evaluate(async (paths) => {
    const out = {};
    for (const p of paths) out[p] = window.ARGUS.envelopeState(await window.ARGUS.read(p));
    return out;
  }, PATHS);
  const seen = await panels();
  rec('the overview draws one live panel per storage read', PATHS.every((p) => seen.filter((x) => x.path === p).length === 1), seen.map((x) => x.path).join(','));
  rec('every panel settles in the state the API answer maps to', PATHS.every((p) => { const x = seen.find((y) => y.path === p); return x && x.state === real[p]; }), JSON.stringify(seen.map((x) => [x.path, x.state, real[x.path]])));
  rec('an answered panel ends with a read stamp, and a refused one with a state block of the same state',
    seen.every((x) => (x.state === 'ok' || x.state === 'stale') ? x.stamp : x.block === x.state), JSON.stringify(seen.map((x) => [x.state, x.stamp, x.block])));
  const h1s = await page.evaluate(() => document.querySelectorAll('#main h1').length);
  rec('the overview has exactly one heading', h1s === 1, String(h1s));

  await page.route('**/api/storage/capacity', (r) => r.fulfill(json({ ok: false, reason: 'unreachable', message: 'The object store did not answer.' })));
  await openHash('#/storage');
  await settled();
  const fault = await panels();
  const cap = fault.find((x) => x.path === '/api/storage/capacity') || {};
  rec('a capacity read that fails shows data-state unreachable with its reason and a retry', cap.state === 'unreachable' && cap.reason === 'unreachable' && cap.block === 'unreachable' && cap.retry, JSON.stringify(cap));
  const others = fault.filter((x) => x.path !== '/api/storage/capacity');
  rec('the other storage panels still render while capacity fails', others.length === 3 && others.every((x) => x.state === real[x.path]), JSON.stringify(others.map((x) => [x.path, x.state])));
  await page.unroute('**/api/storage/capacity');

  await page.route('**/api/storage/buckets', (r) => r.fulfill(json(inventory(['argus-backups', 'argus-parity']))));
  await page.route('**/api/identity/principals', (r) => r.fulfill(json({
    ok: true,
    objectStore: { ok: true, identities: [{ name: 'argus-console', accessKeys: ['argus-console'], actions: ['Read:argus-backups', 'List:argus-backups'] }] }
  })));
  await page.route('**/api/storage/objects?*', (r) => {
    const u = new URL(r.request().url());
    const b = u.searchParams.get('bucket');
    if (b === 'argus-parity') return r.fulfill(json({ ok: false, reason: 'denied', message: 'The S3 gateway refused this credential or this action.' }));
    if (b === 'argus-backups') return r.fulfill(json({ ok: true, folders: ['daily/'], objects: [{ key: 'manifest.json', sizeBytes: 2048, modifiedAt: new Date().toISOString(), storageClass: 'STANDARD' }], at: new Date().toISOString() }));
    return r.fulfill(json({ ok: false, reason: 'no-such-bucket', message: 'That bucket does not exist.' }));
  });

  await openHash('#/storage');
  await settled();
  const links = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#main a[href*="bucket="]'), (a) => a.getAttribute('href')));
  const canPrincipals = await page.evaluate(() => {
    const auth = (window.ARGUS.capabilities() || {}).auth || {};
    const roles = auth.roles || [];
    return auth.tier === 'security' || auth.tier === 'admin' || roles.indexOf('security') !== -1 || roles.indexOf('admin') !== -1;
  });
  rec('a bucket the console identity can list links to its browser', links.some((h) => h.indexOf('bucket=argus-backups') !== -1), links.join(' '));
  rec('a bucket the console identity cannot list is not linked for browsing, when the grants can be read',
    canPrincipals ? !links.some((h) => h.indexOf('bucket=argus-parity') !== -1) : links.some((h) => h.indexOf('bucket=argus-parity') !== -1), 'principals readable=' + canPrincipals + ' ' + links.join(' '));

  await openHash('#/storage?bucket=argus-backups');
  await settled();
  const ok = await panels();
  const list = ok.find((x) => /\/api\/storage\/objects/.test(x.path || '')) || {};
  const rows = await page.evaluate(() => document.querySelectorAll('#main tbody tr[data-key]').length);
  rec('browsing a granted bucket lists its folders and objects', list.state === 'ok' && rows === 2, JSON.stringify({ state: list.state, rows }));
  const size = await page.evaluate(() => { const r = document.querySelector('#main tbody tr[data-key="manifest.json"]'); return r ? r.textContent : ''; });
  rec('an object row shows the size the listing returned', /2\.00 KiB/.test(size), size.slice(0, 80));

  await openHash('#/storage?bucket=argus-parity');
  await settled();
  const denied = (await panels()).find((x) => /\/api\/storage\/objects/.test(x.path || '')) || {};
  rec('a bucket the console identity cannot list shows data-state forbidden, without a retry', denied.state === 'forbidden' && denied.reason === (canPrincipals ? 'no-list-grant' : 'denied') && denied.block === 'forbidden' && !denied.retry, JSON.stringify(denied));
  rec('the forbidden state names the bucket whose grant is missing', /argus-parity/.test(denied.detail), denied.detail.slice(0, 120));

  await openHash('#/storage?bucket=nope');
  await waitFor(page, () => !!document.querySelector('#main .notfound'), null, 8000);
  const nf = await page.evaluate(() => {
    const n = document.querySelector('#main .notfound');
    const back = n ? n.querySelector('a') : null;
    return {
      state: n ? n.getAttribute('data-state') : null,
      reason: n ? n.getAttribute('data-reason') : null,
      h1: Array.prototype.map.call(document.querySelectorAll('#main h1'), (h) => h.textContent),
      back: back ? back.getAttribute('href') : null,
      browsing: /Browsing nope/.test(document.getElementById('main').textContent),
      panels: document.querySelectorAll('#main .livepanel').length
    };
  });
  rec('an unknown bucket deep link shows the not-found state and nothing else', nf.state === 'notFound' && nf.reason === 'unknown-id' && nf.h1.length === 1 && nf.panels === 0 && !nf.browsing, JSON.stringify(nf));
  rec('the not-found state links back to all buckets', nf.back === '#/storage', String(nf.back));

  await page.unroute('**/api/storage/buckets');
  await page.unroute('**/api/storage/objects?*');
  await page.unroute('**/api/identity/principals');
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
};
