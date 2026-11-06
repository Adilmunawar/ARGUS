'use strict';

const FIXTURE_WORDS = ['hv-03', 'sam', 'Secondary region', 'Site B', 'rec-prod-01', 'al-9021', 'Orders Dashboard'];

function firing(name, severity, n, extra) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Object.assign({
      fingerprint: name + '-' + i, name, severity: severity === 'page' ? 'none' : severity,
      labels: { alertname: name, severity, instance: 'node-' + i },
      summary: name + ' summary', startsAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      generatorURL: 'http://prometheus.example.com/graph?g0.expr=up', state: 'active', silencedBy: [], inhibitedBy: []
    }, extra || {}));
  }
  return out;
}

module.exports = async function (ctx) {
  const { page, rec } = ctx;
  await ctx.goto(page, 'overview');
  const settled = await ctx.waitFor(page, () => {
    const main = document.getElementById('main');
    return main && !main.querySelector('.skel') && !main.querySelector('.tile[data-state="loading"]') && main.querySelectorAll('.tile').length >= 4;
  }, null, 8000);
  rec('every live panel settled', settled, settled ? 'no skeleton or placeholder left' : 'a panel never settled');

  const api = await page.evaluate(async () => {
    const read = (p) => window.ARGUS.read(p, { ttlMs: 60000 });
    const [beats, apps, alerts, containers, seal, audit, host] = await Promise.all([
      read('/api/heartbeats'), read('/api/gitops/apps'), read('/api/alerts/active'),
      read('/api/containers'), read('/api/secrets/seal-status'), read('/api/audit/recent?limit=8'), read('/api/host')
    ]);
    return { beats, apps, alerts, containers, seal, audit, host };
  });

  const tiles = await page.evaluate(() => Array.from(document.querySelectorAll('#main .tile')).map((t) => ({
    label: t.querySelector('.tile-label').textContent,
    value: t.querySelector('.tile-value').textContent.trim(),
    note: (t.querySelector('.tile-note') || {}).textContent || '',
    status: (t.querySelector('.tile-status') || {}).textContent || '',
    href: t.getAttribute('href') || '',
    state: t.getAttribute('data-state') || ''
  })));
  const tile = (label) => tiles.filter((t) => t.label === label)[0] || { value: '', note: '', status: '', href: '', state: '' };

  const monitors = (api.beats.data && api.beats.data.monitors) || [];
  const up = monitors.filter((m) => m.status === 1 || m.status === 3).length;
  const services = tile('Services');
  rec('the services tile carries the heartbeat numbers the API returns',
    services.value === up + ' of ' + monitors.length, 'tile ' + services.value + ', API ' + up + ' of ' + monitors.length);

  const appsCount = api.apps.ok ? api.apps.data.count : null;
  const declared = await page.evaluate(() => { const n = document.querySelector('#main [data-panel="platform"] [data-count]'); return n ? n.getAttribute('data-count') : ''; });
  rec('the Platform container carries the gitops count the API returns',
    api.apps.ok && declared === String(appsCount), 'platform ' + declared + ', API ' + appsCount);

  const alertsTile = tile('Open alerts');
  const alertsState = await page.evaluate((env) => window.ARGUS.envelopeState(env), api.alerts);
  if (alertsState === 'notConfigured') {
    rec('the alerts tile says not configured without Alertmanager', alertsTile.status === 'Not configured' && alertsTile.state === 'notConfigured', 'tile ' + alertsTile.status + ' / ' + alertsTile.state);
  } else {
    const open = await page.evaluate((env) => window.ARGUS.openAlerts(env), api.alerts);
    rec('the alerts tile carries the open-alert count from the shared definition', open && alertsTile.value === String(open.total), 'tile ' + alertsTile.value + ', open ' + (open && open.total));
  }

  const containersTile = tile('Containers');
  rec('the containers tile says not configured without the Docker proxy, or counts containers',
    api.containers.ok ? containersTile.value.split(' ')[0] === String(api.containers.data.running) : containersTile.status === 'Not configured', 'tile ' + containersTile.value + ', API ' + (api.containers.ok ? api.containers.data.running : '-'));

  const hostTile = tile('Host CPU');
  rec('the host tiles carry the host read', api.host.ok && /%$/.test(hostTile.value) && hostTile.note.indexOf(api.host.data.hostname) !== -1, hostTile.value + ' / ' + hostTile.note);

  const stamped = tiles.filter((t) => /Read \d\d:\d\d/.test(t.note)).length;
  rec('every tile notes the time it was read', stamped === tiles.length, stamped + ' of ' + tiles.length);

  const text = await page.evaluate(() => document.getElementById('main').textContent);
  const cardText = await page.evaluate(() => {
    const out = {};
    Array.from(document.querySelectorAll('#main .card')).forEach((c) => {
      const h = c.querySelector('.card-title');
      if (h) out[h.textContent] = c.textContent;
    });
    return out;
  });
  const needRows = () => page.evaluate(() => Array.from(document.querySelectorAll('#main [data-panel="needs"] tbody tr[data-key]')).map((tr) => {
    const td = tr.querySelectorAll('td');
    const a = td[0].querySelector('a');
    return { item: td[0].textContent, severity: td[1].textContent, source: td[2].textContent, href: a ? a.getAttribute('href') : '' };
  }));
  const rows = await needRows();
  const hasRow = (list, source, start) => list.some((r) => r.source === source && r.item.indexOf(start) === 0);

  const hero = await page.evaluate(() => { const c = document.querySelector('#main [data-hero]'); return c ? { text: c.textContent, kind: c.getAttribute('data-hero') } : { text: '', kind: '' }; });
  const down = monitors.filter((m) => m.status === 0);
  const openNow = await page.evaluate((env) => window.ARGUS.openAlerts(env), api.alerts);
  const heroWant = openNow && openNow.paging.length ? 'paging' : openNow && openNow.total ? 'firing' : 'ok';
  const heroOk = openNow && openNow.paging.length ? hero.kind === 'paging' && hero.text.indexOf(openNow.paging[0].name) !== -1
    : down.length ? hero.text.indexOf((down[0].label || down[0].id) + ' is down') !== -1
    : (alertsState === 'ok' ? hero.kind === heroWant : hero.kind === 'unchecked' && /alerts were not checked/.test(hero.text));
  rec('the hero names the worst monitor down, or says honestly what it checked', heroOk, hero.kind + ': ' + hero.text.slice(0, 90));

  const needs = cardText['Needs attention'] || '';
  const sealConfigured = api.seal.ok && api.seal.data.configured !== false;
  const sealOk = sealConfigured
    ? (api.seal.data.sandbox && api.seal.data.sandbox.verdict === true ? rows.some((r) => /Sandbox unseal/.test(r.item)) : true)
    : /the OpenBao seal \(not configured\)/.test(needs) && !rows.some((r) => r.source === 'Secrets');
  rec('Needs attention lists the sandbox seal or says the seal was not checked', sealOk, needs.replace(/\s+/g, ' ').slice(0, 160));
  rec('Needs attention lists each monitor down with a link to the stack',
    down.every((m) => rows.some((r) => r.source === 'Service' && r.item.indexOf((m.label || m.id) + ' is down') === 0 && r.href === '#/stack')),
    down.length + ' down');
  if (openNow && openNow.total) {
    const shown = openNow.groups.slice(0, 8).filter((g) => hasRow(rows, 'Alert', g.name)).length;
    rec('Needs attention leads with the worst firing Alertmanager group, by name', hasRow(rows, 'Alert', openNow.groups[0].name) && shown >= 1, shown + ' of ' + openNow.groups.length + ' groups');
  } else {
    rec('Needs attention lists no alert when Alertmanager reports none or is not configured', !rows.some((r) => r.source === 'Alert'), needs.slice(0, 120));
  }

  const activity = cardText['Recent activity'] || '';
  const events = api.audit.ok ? api.audit.data.events.map((e) => e.event) : [];
  const activityRows = await page.evaluate(() => Array.from(document.querySelectorAll('#main [data-panel="activity"] tbody tr[data-key]')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => { const e = td.querySelector('[data-event]'); return e ? e.textContent + '|' + e.getAttribute('data-event') : td.textContent; })));
  rec('Recent activity shows the sign-in the harness produced as a row with operator, a plain event label over the raw name, and source',
    events.indexOf('auth.login.succeeded') !== -1 && activityRows.some((r) => r[1] === ctx.subject && r[2] === 'Signed in|auth.login.succeeded' && /\d/.test(r[3])), events.slice(0, 4).join(','));
  const unsealRows = rows.filter((r) => /sandbox unseal/i.test(r.item)).length;
  rec('Needs attention shows one row per subject, so the sandbox unseal is listed once', unsealRows <= 1, unsealRows + ' unseal rows');
  rec('Recent activity says it is held in memory since the API started', /In memory since the API started/.test(activity) && /View audit log/.test(activity));

  const stamps = await page.evaluate(() => Array.from(document.querySelectorAll('#main .livepanel[data-state="ok"]')).map((b) => {
    const s = b.querySelectorAll('.readstamp');
    return { n: s.length, last: b.lastElementChild && b.lastElementChild.classList.contains('readstamp'), text: s.length ? s[0].textContent : '' };
  }));
  rec('every settled live panel ends with exactly one Read HH:MMZ stamp',
    stamps.length > 0 && stamps.every((s) => s.n === 1 && s.last && /^Read \d\d:\d\dZ$/.test(s.text)), JSON.stringify(stamps));

  const health = cardText['Service health'] || '';
  const bars = await page.evaluate(() => document.querySelectorAll('#main [data-panel="health"] tbody svg.hbbar').length);
  rec('Service health draws one heartbeat bar per monitor', bars === monitors.length && monitors.every((m) => health.indexOf(m.label) !== -1), bars + ' bars, ' + monitors.length + ' monitors');
  const firstRow = await page.evaluate(() => { const r = document.querySelector('#main [data-panel="health"] tbody tr .rlink'); return r ? r.textContent : ''; });
  const rank = (m) => (m.status === 0 ? 0 : m.status === 2 ? 1 : m.status === null ? 2 : m.status === 3 ? 3 : 4);
  const worst = monitors.slice().sort((a, b) => rank(a) - rank(b))[0];
  rec('the worst monitor is at the top of Service health', !worst || rank(monitors.filter((m) => (m.label || m.id) === firstRow)[0] || worst) === rank(worst), firstRow);

  const absent = await page.evaluate(() => { const n = document.querySelector('#main .nis-strip'); return n ? { list: n.getAttribute('data-not-in-stack'), text: n.textContent } : { list: '', text: '' }; });
  rec('one Not in this stack alert says the two-site topology is absent', /Sites/.test(absent.list) && /one machine/.test(absent.text) && /Not in this stack/.test(absent.text), absent.list);
  rec('Traffic and Reconciler are listed in the same Not in this stack alert', /Traffic/.test(absent.list) && /Reconciler/.test(absent.list), absent.list);

  const leaked = FIXTURE_WORDS.filter((w) => text.indexOf(w) !== -1);
  rec('no fixture host or person appears on the live overview', leaked.length === 0, leaked.join(', ') || 'none');
  const sampleNotices = await page.evaluate(() => document.querySelectorAll('#main [data-sample-notice]').length);
  rec('no sample notice is needed on the live overview', sampleNotices === 0, sampleNotices + ' notices');

  const errors = await page.evaluate(() => document.querySelectorAll('#main .empty.is-error, #main [data-state="failed"], #main [data-state="unreachable"], #main [data-state="timeout"]').length);
  rec('no panel is in an error state', errors === 0, errors + ' error panels');

  const links = tiles.map((t) => t.href).filter(Boolean);
  const appsLink = await page.evaluate(() => !!document.querySelector('#main [data-panel="platform"] a[href="#/apps"]'));
  rec('the tiles deep-link to their screens and Platform links to Applications', links.indexOf('#/security/alerts') !== -1 && appsLink && links.indexOf('#/stack') !== -1 && links.indexOf('#/system') !== -1, links.join(' '));
  await page.evaluate(() => { window.location.hash = '#/security/alerts'; });
  const resolved = await ctx.waitFor(page, () => window.ARGUS.state.route === 'security' && window.ARGUS.state.rest[0] === 'alerts');
  rec('the alerts deep link from a tile still resolves', resolved);

  const paging = { alerts: firing('NodeDown', 'page', 3).concat(firing('DiskFilling', 'warning', 2)), count: 5, critical: 0 };
  await page.route('**/api/alerts/active', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(paging) }));
  await page.evaluate(() => window.ARGUS.forget('/api/alerts/active'));
  await ctx.goto(page, 'overview');
  const pagedHero = await page.evaluate(() => {
    const c = document.querySelector('#main [data-hero]');
    return c ? { kind: c.getAttribute('data-hero'), tone: c.classList.contains('bad') ? 'bad' : c.classList.contains('warn') ? 'warn' : 'ok', text: c.textContent } : null;
  });
  rec('a firing alert with severity page turns the hero red and names it with its count',
    pagedHero && pagedHero.kind === 'paging' && pagedHero.tone === 'bad' && /NodeDown \(3 firing\)/.test(pagedHero.text) && !/Nothing is failing/.test(pagedHero.text), JSON.stringify(pagedHero));
  const pagedTile = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#main .tile')).filter((n) => n.querySelector('.tile-label').textContent === 'Open alerts')[0];
    return t ? { value: t.querySelector('.tile-value').textContent.trim(), status: (t.querySelector('.tile-status') || {}).textContent || '', note: t.querySelector('.tile-note').textContent } : null;
  });
  rec('the alerts tile counts every firing alert and names the worst group', pagedTile && pagedTile.value === '5' && /3 paging/.test(pagedTile.status) && /NodeDown/.test(pagedTile.note), JSON.stringify(pagedTile));
  const pagedRows = await needRows();
  rec('Needs attention groups alerts by name with a count', hasRow(pagedRows, 'Alert', 'NodeDown (3 firing)') && hasRow(pagedRows, 'Alert', 'DiskFilling (2 firing)'), JSON.stringify(pagedRows.slice(0, 3)));

  const warnOnly = { alerts: firing('DiskFilling', 'warning', 2), count: 2, critical: 0 };
  await page.unroute('**/api/alerts/active');
  await page.route('**/api/alerts/active', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(warnOnly) }));
  await page.evaluate(() => window.ARGUS.forget('/api/alerts/active'));
  await ctx.goto(page, 'overview');
  const warnHero = await page.evaluate(() => {
    const c = document.querySelector('#main [data-hero]');
    return c ? { kind: c.getAttribute('data-hero'), amber: c.classList.contains('warn'), text: c.textContent } : null;
  });
  const beatsDown = monitors.some((m) => m.status === 0);
  rec('a firing alert that does not page turns the hero amber and names it, never "Nothing is failing"',
    beatsDown || (warnHero && warnHero.kind === 'firing' && warnHero.amber && /DiskFilling \(2 firing\)/.test(warnHero.text) && !/Nothing is failing/.test(warnHero.text)), JSON.stringify(warnHero));
  await page.unroute('**/api/alerts/active');
  await page.evaluate(() => window.ARGUS.forget('/api/alerts/active'));
  await ctx.goto(page, 'overview');
};
