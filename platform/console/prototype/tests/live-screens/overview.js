'use strict';

const FIXTURE_WORDS = ['hv-03', 'umair', 'Karachi', 'Site B', 'rec-prod-01'];

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
    href: t.getAttribute('href') || ''
  })));
  const tile = (label) => tiles.filter((t) => t.label === label)[0] || { value: '', note: '', href: '' };

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
  rec('the alerts tile says not configured without Alertmanager',
    !api.alerts.ok && (api.alerts.error || {}).reason === 'not-configured' && alertsTile.value === 'not configured',
    'tile ' + alertsTile.value + ', API ' + ((api.alerts.error || {}).reason || 'ok'));

  const containersTile = tile('Containers running');
  rec('the containers tile says not configured without the Docker proxy',
    !api.containers.ok && containersTile.value === 'not configured', 'tile ' + containersTile.value);

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

  const hero = await page.evaluate(() => { const c = document.querySelector('#main .callout'); return c ? c.textContent : ''; });
  const down = monitors.filter((m) => m.status === 0);
  const heroOk = down.length ? hero.indexOf((down[0].label || down[0].id) + ' is down') !== -1 : /Nothing is failing/.test(hero);
  rec('the hero names the worst monitor down or says nothing is failing', heroOk, hero.slice(0, 90));

  const needs = cardText['Needs you'] || '';
  const sealConfigured = api.seal.ok && api.seal.data.configured !== false;
  const sealOk = sealConfigured
    ? (api.seal.data.sandbox && api.seal.data.sandbox.verdict === true ? /Sandbox unseal/.test(needs) : true)
    : /the OpenBao seal \(not configured\)/.test(needs) && !/Secrets:/.test(needs);
  rec('Needs you lists the sandbox seal or says the seal was not checked', sealOk, needs.replace(/\s+/g, ' ').slice(0, 160));
  rec('Needs you lists each monitor down with a link to the stack',
    down.every((m) => needs.indexOf('Service: ' + (m.label || m.id) + ' is down') !== -1) && (down.length === 0 || /Open the stack/.test(needs)),
    down.length + ' down');

  const activity = cardText['Recent activity'] || '';
  const events = api.audit.ok ? api.audit.data.events.map((e) => e.event) : [];
  rec('Recent activity shows the sign-in the harness produced as a sentence',
    events.indexOf('auth.login.succeeded') !== -1 && /adil signed in from/.test(activity), events.slice(0, 4).join(','));
  rec('Recent activity says it is held in memory since the API started', /Held in memory since the API started/.test(activity) && /All audit events/.test(activity));

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

  const errors = await page.evaluate(() => document.querySelectorAll('#main .empty.is-error').length);
  rec('no panel is in an error state', errors === 0, errors + ' error panels');

  const links = tiles.map((t) => t.href).filter(Boolean);
  rec('the tiles deep-link to their screens', links.indexOf('#/security/alerts') !== -1 && links.indexOf('#/apps') !== -1 && links.indexOf('#/stack') !== -1 && links.indexOf('#/system') !== -1, links.join(' '));
  await page.evaluate(() => { window.location.hash = '#/security/alerts'; });
  const resolved = await ctx.waitFor(page, () => window.ARGUS.state.route === 'security' && window.ARGUS.state.rest[0] === 'alerts');
  rec('the alerts deep link from a tile still resolves', resolved);
  await ctx.goto(page, 'overview');
};
