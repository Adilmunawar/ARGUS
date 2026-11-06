module.exports = async function (ctx) {
  const { page, rec, goto, waitFor } = ctx;

  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const databases = {
    ok: true, count: 1, sizesComplete: true, totalSizeBytes: 8388608, measuredSizeBytes: 8388608, measuredCount: 1,
    ioTimingMeasured: false,
    databases: [{
      name: 'orders_db', owner: 'orders', sizeBytes: 8388608, connections: { total: 2, active: 1, idle: 1, idleInTransaction: 0, other: 0 },
      backends: 2, cache: { hitRatio: 0.99, window: 'since the statistics were reset' }, deadlocks: 0, tempBytes: 0,
      consoleCanConnect: true, allowsConnections: true, encoding: 'UTF8', collate: 'C', connectionLimit: null, transactionIdAge: 10
    }],
    at: new Date().toISOString()
  };
  const buckets = { ok: true, count: 1, buckets: [{ name: 'argus-backups', diskBytes: 1048576, unknownSize: false, lock: null, versioning: true }], drift: {}, at: new Date().toISOString() };

  const settled = () => waitFor(page, () => {
    const main = document.getElementById('main');
    return main.querySelectorAll('.livepanel').length > 0 && main.querySelectorAll('.livepanel[data-state="loading"]').length === 0;
  }, null, 12000);

  const panels = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#main .livepanel'), (p) => ({
    path: p.getAttribute('data-path'),
    state: p.getAttribute('data-state'),
    reason: p.getAttribute('data-reason'),
    retry: Array.prototype.some.call(p.querySelectorAll('button'), (b) => /Try again/.test(b.textContent))
  })));

  const expected = (list) => page.evaluate(async (paths) => {
    const out = {};
    for (const p of paths) out[p] = window.ARGUS.envelopeState(await window.ARGUS.read(p));
    return out;
  }, list.map((x) => x.path));

  const matches = (list, want) => list.length > 0 && list.every((x) => x.state === want[x.path]);

  await page.evaluate(() => window.ARGUS.forget());
  for (const tab of ['databases', 'cache', 'queues']) {
    await goto(page, 'data/' + tab);
    await settled();
    const seen = await panels();
    const want = await expected(seen);
    rec('the ' + tab + ' tab settles every panel in the state its API answer maps to', matches(seen, want), JSON.stringify(seen.map((x) => [x.path, x.state, want[x.path]])));
  }

  await goto(page, 'data/buckets');
  await settled();
  const store = await page.evaluate(() => ({
    paths: Array.prototype.map.call(document.querySelectorAll('#main .livepanel'), (p) => p.getAttribute('data-path')),
    storageLink: !!document.querySelector('#main a[href="#/storage"]'),
    bucketLinks: document.querySelectorAll('#main a[href*="data/bucket/"]').length
  }));
  rec('the object storage tab is one summary of the bucket read with a link to the Storage screen', store.paths.length === 1 && store.paths[0] === '/api/storage/buckets' && store.storageLink && store.bucketLinks === 0, JSON.stringify(store));

  await page.route('**/api/pg/health', (r) => r.fulfill(json({ ok: false, reason: 'timeout', message: 'PostgreSQL did not answer in time.' })));
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
  await goto(page, 'data/databases');
  await settled();
  const timed = (await panels()).find((x) => x.path === '/api/pg/health') || {};
  rec('a health read that times out shows data-state timeout with a retry', timed.state === 'timeout' && timed.reason === 'timeout' && timed.retry, JSON.stringify(timed));
  await page.unroute('**/api/pg/health');
  const healthState = await page.evaluate(async () => { window.ARGUS.forget('/api/pg/health'); return window.ARGUS.envelopeState(await window.ARGUS.read('/api/pg/health', { ttlMs: 0 })); });
  await page.evaluate(() => {
    const p = document.querySelector('#main .livepanel[data-path="/api/pg/health"]');
    const b = p && Array.prototype.find.call(p.querySelectorAll('button'), (x) => /Try again/.test(x.textContent));
    if (b) b.click();
  });
  const retried = await waitFor(page, (want) => {
    const p = document.querySelector('#main .livepanel[data-path="/api/pg/health"]');
    return !!p && p.getAttribute('data-state') === want;
  }, healthState, 8000);
  rec('retry re-reads that panel and it takes the state of the fresh answer', retried, healthState);

  const now = new Date().toISOString();
  const realDb = (name, owner, size) => ({
    name, owner, encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', isTemplate: false, allowsConnections: true,
    connectionLimit: null, comment: null, sizeBytes: size, sizeUnknownReason: null,
    connections: { total: 1, active: 0, idle: 1, idleInTransaction: 0, other: 0 }, backends: 1,
    transactions: { committed: 466, rolledBack: 0 },
    cache: { blocksHit: 108323, blocksRead: 475, hitRatio: 0.9956, window: 'since the statistics system was last initialised' },
    tuples: { returned: 56683, fetched: 12374, inserted: 13253, updated: 148, deleted: 265 },
    deadlocks: 0, conflicts: 0, tempFiles: 0, tempBytes: 0, blockReadMs: 6.967, blockWriteMs: 450.821, ioTimingMeasured: true,
    statsResetAt: null, transactionIdAge: 1163, consoleCanConnect: true, connectPrivilegeGranted: true
  });
  const realDatabases = {
    ok: true, databases: [realDb('argus_geo', 'argus_app', 15953043), realDb('argus_ml', 'argus_app', 8130195), realDb('postgres', 'postgres', 7745699)],
    count: 3, ioTimingMeasured: true, ioTimingNote: null, totalSizeBytes: 31828937, measuredSizeBytes: 31828937, measuredCount: 3,
    sizesComplete: true, sizeError: null, at: now, cachedAt: now, stale: false
  };
  const session = (pid, database, role, state, query) => ({
    pid, database, role, applicationName: null, clientAddr: '172.28.0.19', clientPort: 34508, backendType: 'client backend', state,
    waitEventType: state === 'idle' ? 'Client' : null, waitEvent: state === 'idle' ? 'ClientRead' : null,
    backendStartedAt: now, transactionStartedAt: null, queryStartedAt: now, stateChangedAt: now, querySeconds: 966.563,
    transactionSeconds: null, stateSeconds: 966.563, backendXid: null, backendXmin: null, leaderPid: null, blockedBy: null,
    query, queryTruncatedForTransport: false, queryTruncatedByServer: false, queryVisible: true, isThisSession: false, isConsole: false
  });
  const realActivity = {
    ok: true,
    sessions: [session(38, 'argus_geo', 'argus_app', 'idle', 'SELECT tablename FROM pg_tables'), session(41, 'argus_ml', 'argus_exporter', 'active', 'SELECT 1'),
      { pid: 12, database: null, role: null, backendType: 'checkpointer', state: null, waitEventType: 'Activity', waitEvent: 'CheckpointerMain', querySeconds: null, blockedBy: null, query: null, queryVisible: true }],
    listLimit: 200, listTruncated: false,
    summary: { backendsTotal: 18, clientBackends: 13, active: 2, idle: 11, idleInTransaction: 0, waitingOnLock: 0, longestActiveSeconds: 0.001,
      longestTransactionSeconds: 0.001, excludesConsoleOwnSession: true, maxConnections: 120, superuserReserved: 3, connectionsUsedRatio: 0.1083 },
    countsCoverWholeCluster: true, redactedSessions: 0, trackActivityQuerySize: 1024, at: now, cachedAt: now, stale: false
  };
  await page.route('**/api/pg/databases', (r) => r.fulfill(json(realDatabases)));
  await page.route('**/api/pg/activity', (r) => r.fulfill(json(realActivity)));
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
  const drawnOn = async (tab, p) => {
    await goto(page, 'data/' + tab);
    await settled();
    return page.evaluate((path) => {
      const n = document.querySelector('#main .livepanel[data-path="' + path + '"]');
      return { path, state: n ? n.getAttribute('data-state') : null, reason: n ? n.getAttribute('data-reason') : null, rows: n ? n.querySelectorAll('tbody tr[data-key]').length : 0 };
    }, p);
  };
  const drawn = [await drawnOn('databases', '/api/pg/databases'), await drawnOn('sessions', '/api/pg/activity')];
  rec('a full PostgreSQL answer with nothing to footnote draws the databases and sessions panels instead of failing to render',
    drawn[0].state === 'ok' && drawn[0].rows === 3 && drawn[1].state === 'ok' && drawn[1].rows === 3, JSON.stringify(drawn));
  await page.unroute('**/api/pg/databases');
  await page.unroute('**/api/pg/activity');

  await page.route('**/api/pg/databases', (r) => r.fulfill(json(databases)));
  await page.route('**/api/storage/buckets', (r) => r.fulfill(json(buckets)));
  await page.evaluate(() => window.ARGUS.forget());

  const notFound = async (route) => {
    await goto(page, route);
    await waitFor(page, () => !!document.querySelector('#main .notfound'), null, 8000);
    return page.evaluate(() => {
      const n = document.querySelector('#main .notfound');
      return {
        state: n ? n.getAttribute('data-state') : null,
        reason: n ? n.getAttribute('data-reason') : null,
        h1: document.querySelectorAll('#main h1').length,
        back: n && n.querySelector('a') ? n.querySelector('a').getAttribute('href') : null,
        editor: !!document.querySelector('#main textarea'),
        panels: document.querySelectorAll('#main .livepanel').length
      };
    });
  };

  const db = await notFound('data/database/nope');
  rec('an unknown database deep link shows the not-found state, one heading and no editor', db.state === 'notFound' && db.reason === 'unknown-id' && db.h1 === 1 && !db.editor && db.panels === 0, JSON.stringify(db));
  rec('the not-found state links back to Data', db.back === '#/data', String(db.back));

  const bk = await notFound('data/bucket/nope');
  rec('an unknown bucket deep link on Data shows the not-found state', bk.state === 'notFound' && bk.reason === 'unknown-id' && bk.h1 === 1 && bk.panels === 0, JSON.stringify(bk));

  await goto(page, 'data/database/orders_db');
  await settled();
  const known = await page.evaluate(() => ({
    h1: Array.prototype.map.call(document.querySelectorAll('#main h1'), (h) => h.textContent),
    notFound: !!document.querySelector('#main .notfound'),
    editor: !!document.querySelector('#main textarea'),
    first: (document.querySelector('#main .livepanel') || { getAttribute: () => null }).getAttribute('data-state')
  }));
  rec('a database the API lists opens its detail with the read-only editor', known.h1.length === 1 && known.h1[0] === 'orders_db' && !known.notFound && known.editor && known.first === 'ok', JSON.stringify(known));

  await goto(page, 'data/bucket/argus-backups');
  await settled();
  const bucket = await page.evaluate(() => ({
    link: !!document.querySelector('#main a[href="#/storage?bucket=argus-backups"]'),
    state: (document.querySelector('#main .livepanel') || { getAttribute: () => null }).getAttribute('data-state')
  }));
  rec('a known bucket on Data hands browsing to the Storage screen', bucket.link && bucket.state === 'ok', JSON.stringify(bucket));

  await page.unroute('**/api/pg/databases');
  await page.unroute('**/api/storage/buckets');
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
};
