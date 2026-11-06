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
    return main && !main.querySelector('.skel') && !/…/.test(main.textContent) && main.querySelectorAll('.tile').length >= 7;
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
    href: t.getAttribute('href') || '',
    state: t.getAttribute('data-state') || ''
  })));
  const tile = (label) => tiles.filter((t) => t.label === label)[0] || { value: '', note: '', href: '', state: '' };

  const monitors = (api.beats.data && api.beats.data.monitors) || [];
  const up = monitors.filter((m) => m.status === 1 || m.status === 3).length;
  const services = tile('Services working');
  rec('the services tile carries the heartbeat numbers the API returns',
    services.value === up + ' of ' + monitors.length, 'tile ' + services.value + ', API ' + up + ' of ' + monitors.length);

  const appsCount = api.apps.ok ? api.apps.data.count : null;
  const declared = tile('Declared applications');
  rec('the applications tile carries the gitops count the API returns',
    api.apps.ok && declared.value === String(appsCount), 'tile ' + declared.value + ', API ' + appsCount);

  const alertsTile = tile('Open alerts');
  const alertsState = await page.evaluate((env) => window.ARGUS.envelopeState(env), api.alerts);
  if (alertsState === 'notConfigured') {
    rec('the alerts tile says not configured without Alertmanager', alertsTile.value === 'not configured' && alertsTile.state === 'notConfigured', 'tile ' + alertsTile.value + ' / ' + alertsTile.state);
  } else {
    const open = await page.evaluate((env) => window.ARGUS.openAlerts(env), api.alerts);
    rec('the alerts tile carries the open-alert count from the shared definition', open && alertsTile.value === String(open.total), 'tile ' + alertsTile.value + ', open ' + (open && open.total));
  }

  const containersTile = tile('Containers running');
  rec('the containers tile says not configured without the Docker proxy, or counts containers',
    api.containers.ok ? /\d+ of \d+/.test(containersTile.value) : containersTile.value === 'not configured', 'tile ' + containersTile.value);

  const hostTile = tile('Host CPU now');
  rec('the host tiles carry the host read', api.host.ok && /%$/.test(hostTile.value) && hostTile.note.indexOf(api.host.data.hostname) !== -1, hostTile.value + ' / ' + hostTile.note);

  const stamped = tiles.filter((t) => /read \d\d:\d\d/.test(t.note)).length;
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

  const hero = await page.evaluate(() => { const c = document.querySelector('#main [data-hero]'); return c ? { text: c.textContent, kind: c.getAttribute('data-hero') } : { text: '', kind: '' }; });
  const down = monitors.filter((m) => m.status === 0);
  const openNow = await page.evaluate((env) => window.ARGUS.openAlerts(env), api.alerts);
  const heroWant = openNow && openNow.paging.length ? 'paging' : openNow && openNow.total ? 'firing' : 'ok';
  const heroOk = openNow && openNow.paging.length ? hero.kind === 'paging' && hero.text.indexOf(openNow.paging[0].name) !== -1
    : down.length ? hero.text.indexOf((down[0].label || down[0].id) + ' is down') !== -1
    : (alertsState === 'ok' ? hero.kind === heroWant : hero.kind === 'unchecked' && /alerts were not checked/.test(hero.text));
  rec('the hero names the worst monitor down, or says honestly what it checked', heroOk, hero.kind + ': ' + hero.text.slice(0, 90));

  const needs = cardText['Needs you'] || '';
  const sealConfigured = api.seal.ok && api.seal.data.configured !== false;
  const sealOk = sealConfigured
    ? (api.seal.data.sandbox && api.seal.data.sandbox.verdict === true ? /Sandbox unseal/.test(needs) : true)
    : /the OpenBao seal \(not configured\)/.test(needs) && !/Secrets:/.test(needs);
  rec('Needs you lists the sandbox seal or says the seal was not checked', sealOk, needs.replace(/\s+/g, ' ').slice(0, 160));
  rec('Needs you lists each monitor down with a link to the stack',
    down.every((m) => needs.indexOf('Service: ' + (m.label || m.id) + ' is down') !== -1) && (down.length === 0 || /Open Services/.test(needs)),
    down.length + ' down');
  if (openNow && openNow.total) {
    const shown = openNow.groups.slice(0, 8).filter((g) => needs.indexOf('Alert: ' + g.name) !== -1).length;
    rec('Needs you leads with the worst firing Alertmanager group, by name', needs.indexOf('Alert: ' + openNow.groups[0].name) !== -1 && shown >= 1, shown + ' of ' + openNow.groups.length + ' groups');
  } else {
    rec('Needs you lists no alert when Alertmanager reports none or is not configured', !/Alert: /.test(needs), needs.slice(0, 120));
  }

  const activity = cardText['Recent activity'] || '';
  const events = api.audit.ok ? api.audit.data.events.map((e) => e.event) : [];
  rec('Recent activity shows the sign-in the harness produced as a sentence',
    events.indexOf('auth.login.succeeded') !== -1 && activity.indexOf(ctx.subject + ' signed in from') !== -1, events.slice(0, 4).join(','));
  rec('Recent activity says it is held in memory since the API started', /Held in memory since the API started/.test(activity) && /All audit events/.test(activity));

  const stamps = await page.evaluate(() => Array.from(document.querySelectorAll('#main .livepanel[data-state="ok"]')).map((b) => {
    const s = b.querySelectorAll('.readstamp');
    return { n: s.length, last: b.lastElementChild && b.lastElementChild.classList.contains('readstamp'), text: s.length ? s[0].textContent : '' };
  }));
  rec('every settled live panel ends with exactly one Read HH:MMZ stamp',
    stamps.length > 0 && stamps.every((s) => s.n === 1 && s.last && /^Read \d\d:\d\dZ$/.test(s.text)), JSON.stringify(stamps));

  const health = cardText['Service health'] || '';
  const bars = await page.evaluate(() => document.querySelectorAll('#main .healthrow svg.hbbar').length);
  rec('Service health draws one heartbeat bar per monitor', bars === monitors.length && monitors.every((m) => health.indexOf(m.label) !== -1), bars + ' bars, ' + monitors.length + ' monitors');
  const firstRow = await page.evaluate(() => { const r = document.querySelector('#main .healthrow .rlink'); return r ? r.textContent : ''; });
  const rank = (m) => (m.status === 0 ? 0 : m.status === 2 ? 1 : m.status === null ? 2 : m.status === 3 ? 3 : 4);
  const worst = monitors.slice().sort((a, b) => rank(a) - rank(b))[0];
  rec('the worst monitor is at the top of Service health', !worst || rank(monitors.filter((m) => (m.label || m.id) === firstRow)[0] || worst) === rank(worst), firstRow);

  rec('the Sites card says the two-site topology is not in this stack', /Not in this stack/.test(cardText['Sites'] || '') && /one machine/.test(cardText['Sites'] || ''));
  rec('Traffic and Reconciler say they are not in this stack', /Not in this stack/.test(cardText['Reconciler'] || '') && /Not in this stack/.test(cardText['Traffic, last 24 hours'] || ''));

  const leaked = FIXTURE_WORDS.filter((w) => text.indexOf(w) !== -1);
  rec('no fixture host or person appears on the live overview', leaked.length === 0, leaked.join(', ') || 'none');
  const sampleNotices = await page.evaluate(() => document.querySelectorAll('#main [data-sample-notice]').length);
  rec('no sample notice is needed on the live overview', sampleNotices === 0, sampleNotices + ' notices');

  const errors = await page.evaluate(() => document.querySelectorAll('#main .empty.is-error, #main [data-state="failed"], #main [data-state="unreachable"], #main [data-state="timeout"]').length);
  rec('no panel is in an error state', errors === 0, errors + ' error panels');

  const links = tiles.map((t) => t.href).filter(Boolean);
  rec('the tiles deep-link to their screens', links.indexOf('#/security/alerts') !== -1 && links.indexOf('#/apps') !== -1 && links.indexOf('#/stack') !== -1 && links.indexOf('#/system') !== -1, links.join(' '));
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
    return t ? { value: t.querySelector('.tile-value').textContent.trim(), note: t.querySelector('.tile-note').textContent } : null;
  });
  rec('the alerts tile counts every firing alert and names the worst group', pagedTile && pagedTile.value === '5' && /3 paging/.test(pagedTile.note) && /NodeDown/.test(pagedTile.note), JSON.stringify(pagedTile));
  const pagedNeeds = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('#main .card')).filter((n) => (n.querySelector('.card-title') || {}).textContent === 'Needs you')[0];
    return c ? c.textContent : '';
  });
  rec('Needs you groups alerts by name with a count', /Alert: NodeDown \(3 firing\)/.test(pagedNeeds) && /Alert: DiskFilling \(2 firing\)/.test(pagedNeeds), pagedNeeds.replace(/\s+/g, ' ').slice(0, 200));

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
