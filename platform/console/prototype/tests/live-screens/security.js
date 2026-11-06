'use strict';

const FIXTURE_WORDS = ['al-9021', 'al-9020', 'inc-31', 'hv-03', 'WDAC block', 'Console alert history', 'Values shown are live as of', 'LegacyAppPool', 's-2291'];
const ACTION_WORDS = /Quarantine|Acknowledge|Silence|Unsilence|Open incident|Generate pack|Add waiver/;

function alert(name, severity, i) {
  return {
    fingerprint: name + '-' + i, name, severity: severity === 'page' ? 'none' : severity,
    labels: { alertname: name, severity, instance: 'node-' + i },
    summary: name + ' summary', startsAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
    generatorURL: 'http://prometheus.example.com/graph?g0.expr=up', state: 'active', silencedBy: [], inhibitedBy: []
  };
}

module.exports = async function (ctx) {
  const { page, rec } = ctx;

  await ctx.goto(page, 'security');
  const base = await page.evaluate(() => {
    const main = document.getElementById('main');
    const panel = main.querySelector('.livepanel[data-path="/api/alerts/active"]');
    return {
      text: main.textContent,
      h1: main.querySelectorAll('h1').length,
      tabs: main.querySelectorAll('[role=tab]').length,
      panelState: panel ? panel.getAttribute('data-state') : null,
      strip: (main.querySelector('[data-state="notInStack"]') || {}).textContent || '',
      items: Array.from(main.querySelectorAll('[data-not-in-stack-item]')).map((n) => n.getAttribute('data-not-in-stack-item')),
      strips: main.querySelectorAll('.nis-strip').length,
      buttons: Array.from(main.querySelectorAll('button')).map((b) => b.textContent.trim())
    };
  });
  rec('SECURITY live: one h1 and no fixture tabs', base.h1 === 1 && base.tabs === 0, base.h1 + ' h1, ' + base.tabs + ' tabs');
  rec('SECURITY live: the Alertmanager panel is a live panel with a state', !!base.panelState && base.panelState !== 'loading', String(base.panelState));
  rec('SECURITY live: posture, incidents, vulnerabilities, sessions and evidence are one not-in-stack strip',
    base.strips === 1 && ['Posture', 'Incidents', 'Vulnerabilities', 'Sessions', 'Evidence'].every((w) => base.items.indexOf(w) !== -1),
    base.items.join(','));
  rec('SECURITY live: the strip names what would feed each', /Wazuh/.test(base.strip) && /incident store/.test(base.strip) && /vulnerability scanner/.test(base.strip) && /Guacamole/.test(base.strip) && /evidence generator/.test(base.strip),
    base.strip.slice(0, 160));
  const leaked = FIXTURE_WORDS.filter((w) => base.text.indexOf(w) !== -1);
  rec('SECURITY live: no fixture alert, incident, session or evidence value appears', leaked.length === 0, leaked.join(', ') || 'none');
  const actions = base.buttons.filter((b) => ACTION_WORDS.test(b));
  rec('SECURITY live: no action button is offered while writes are off', actions.length === 0, actions.join(', ') || 'none');

  const real = await page.evaluate(async () => {
    const A = window.ARGUS;
    const env = await A.read('/api/alerts/active', { ttlMs: 60000 });
    const open = A.openAlerts(env);
    const panel = document.querySelector('#main .livepanel[data-path="/api/alerts/active"]');
    return {
      state: A.envelopeState(env),
      groups: open ? open.groups.map((g) => ({ name: g.name, count: g.count })) : null,
      panel: panel.getAttribute('data-state'),
      keys: Array.from(panel.querySelectorAll('tbody tr[data-key]')).map((tr) => tr.getAttribute('data-key')),
      retry: Array.from(panel.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent)),
      stamp: (panel.querySelector('.readstamp') || {}).textContent || ''
    };
  });
  if (real.state === 'ok') {
    const want = real.groups.map((g) => g.name);
    rec('SECURITY live: the panel lists every firing Alertmanager group the API returns, worst first',
      real.panel === 'ok' && real.keys.length === want.length && (want.length === 0 || real.keys[0] === want[0]) && want.every((n) => real.keys.indexOf(n) !== -1),
      JSON.stringify({ keys: real.keys.slice(0, 6), want: want.slice(0, 6) }));
    rec('SECURITY live: the real reading ends with a read stamp', /^Read \d\d:\d\dZ$/.test(real.stamp), real.stamp);
  } else {
    rec('SECURITY live: without Alertmanager the panel says ' + real.state + ' and offers no retry unless the state is transient',
      real.panel === real.state && real.keys.length === 0 && real.retry === ['unreachable', 'timeout', 'failed'].indexOf(real.state) !== -1, JSON.stringify(real));
  }

  const body = { alerts: [alert('NodeDown', 'page', 0), alert('NodeDown', 'page', 1), alert('NodeDown', 'page', 2), alert('DiskFilling', 'warning', 0)], count: 4, critical: 0 };
  await page.route('**/api/alerts/active', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.evaluate(() => window.ARGUS.forget('/api/alerts/active'));
  await ctx.goto(page, 'security/alerts?alert=NodeDown');
  const live = await page.evaluate(() => {
    const panel = document.querySelector('#main .livepanel[data-path="/api/alerts/active"]');
    const rows = Array.from(panel.querySelectorAll('tbody tr[data-key]')).map((tr) => ({
      key: tr.getAttribute('data-key'),
      cells: Array.from(tr.children).map((td) => td.textContent.trim()),
      rule: (tr.querySelector('a[href^="http"]') || {}).href || '',
      stack: !!tr.querySelector('a[href="#/stack"]')
    }));
    return { state: panel.getAttribute('data-state'), rows, buttons: Array.from(document.querySelectorAll('#main button')).map((b) => b.textContent.trim()), stamp: (panel.querySelector('.readstamp') || {}).textContent || '' };
  });
  rec('SECURITY live: firing alerts are grouped by alert name with a count', live.rows.length === 2 && live.rows[0].key === 'NodeDown' && live.rows[0].cells.indexOf('3') !== -1 && live.rows[1].key === 'DiskFilling',
    JSON.stringify(live.rows.map((r) => [r.key, r.cells.slice(0, 3)])));
  rec('SECURITY live: the worst severity sorts first and is shown', /page/.test(live.rows[0] ? live.rows[0].cells[0] : ''), live.rows[0] ? live.rows[0].cells[0] : '');
  rec('SECURITY live: each group links to its Prometheus rule and to the stack', live.rows.every((r) => /^http:\/\/prometheus\.example\.com\//.test(r.rule) && r.stack), JSON.stringify(live.rows.map((r) => [r.rule, r.stack])));
  rec('SECURITY live: still no action button with alerts firing', live.buttons.filter((b) => ACTION_WORDS.test(b)).length === 0, live.buttons.join(', '));
  rec('SECURITY live: the panel ends with a read stamp', /^Read \d\d:\d\dZ$/.test(live.stamp), live.stamp);

  await page.unroute('**/api/alerts/active');
  await page.route('**/api/alerts/active', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ alerts: [alert('Unsafe', 'warning', 0)].map((a) => Object.assign(a, { generatorURL: 'javascript:alert(1)' })), count: 1 }) }));
  await page.evaluate(() => window.ARGUS.forget('/api/alerts/active'));
  await ctx.goto(page, 'security');
  const unsafe = await page.evaluate(() => Array.from(document.querySelectorAll('#main a')).filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length);
  rec('SECURITY live: a rule link that is not http or https is not rendered as a link', unsafe === 0, unsafe + ' unsafe links');
  await page.unroute('**/api/alerts/active');
  await page.evaluate(() => window.ARGUS.forget('/api/alerts/active'));

  await ctx.goto(page, 'security/incidents');
  const deep = await page.evaluate(() => ({ route: window.ARGUS.state.route, strip: !!document.querySelector('#main .nis-strip'), fixture: /inc-31|Audit family/.test(document.getElementById('main').textContent) }));
  rec('SECURITY live: an old incidents deep link lands on the strip, not on fixtures', deep.route === 'security' && deep.strip && !deep.fixture, JSON.stringify(deep));
};
