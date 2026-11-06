'use strict';

const FIXTURE_STRINGS = ['hv-01-drain-node', 'sql-02-ag-failover', 'alm-1', 'Maps p95 above 500 ms', 'Monthly restore drill for orders_db', 'billing_db', 'AWS baseline'];

function mainText(page) {
  return page.evaluate(() => document.getElementById('main').textContent);
}

function settled(page) {
  return page.waitForFunction(() => {
    const main = document.getElementById('main');
    if (!main || main.querySelector('.skel') || main.querySelector('[data-state="loading"]')) return false;
    return !!main.querySelector('.livepanel[data-state], .notfound, [data-state="notInStack"], .stateblock');
  }, null, { timeout: 8000 }).then(() => true, () => false);
}

module.exports = async function (ctx) {
  const { page, rec, goto } = ctx;

  const listing = await page.evaluate(() => window.ARGUS.read('/api/runbooks', { ttlMs: 0 }));
  const runbooks = (listing.ok && listing.data && listing.data.runbooks) || [];
  rec('the API lists runbooks from docs/runbooks', listing.ok && runbooks.length > 0, 'count ' + runbooks.length);

  await goto(page, 'ops');
  await settled(page);
  const table = await page.evaluate(() => Array.from(document.querySelectorAll('#main tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim())));
  const ids = table.map((r) => r[0]);
  const apiIds = runbooks.map((r) => r.id);
  rec('the Runbooks table lists exactly the runbooks /api/runbooks returns',
    ids.length === apiIds.length && apiIds.every((id) => ids.includes(id)), 'table ' + ids.join(',') + ' api ' + apiIds.join(','));
  const boot = table.find((r) => r[0] === 'boot-01-day-one');
  rec('boot-01-day-one shows its title and tier from the file front matter',
    !!boot && boot[1] === 'Day one, from zero to a validated decision, on hardware you already have' && boot[2] === 'Tier 1',
    boot ? boot.slice(0, 3).join(' | ') : 'row missing');
  const indexRows = table.map((r, i) => ({ i, isIndex: /index/.test(r[1]) }));
  const firstIndex = indexRows.filter((r) => r.isIndex).map((r) => r.i);
  const lastNonIndex = indexRows.filter((r) => !r.isIndex).map((r) => r.i);
  rec('the README index files sort after the runbooks',
    firstIndex.length > 0 && lastNonIndex.length > 0 && Math.min.apply(null, firstIndex) > Math.max.apply(null, lastNonIndex),
    'index rows at ' + firstIndex.join(',') + ', runbooks at ' + lastNonIndex.join(','));
  const listText = await mainText(page);
  rec('the runbooks tab says they cannot be run and carries the read time',
    /cannot be run|not scripts the console can run/.test(listText)
      && (await page.evaluate(() => !!document.querySelector('#main .livepanel[data-path="/api/runbooks"][data-state="ok"] .readstamp[data-read-at]')))
      && !(await page.evaluate(() => Array.from(document.querySelectorAll('#main button')).some((b) => /^Run /.test(b.textContent)))),
    listText.slice(0, 100));

  await goto(page, 'ops/runbook/boot-01-day-one');
  await settled(page);
  const detail = await page.evaluate(() => ({
    h1: (document.querySelector('#main h1') || {}).textContent,
    headings: Array.from(document.querySelectorAll('#main h2, #main h3, #main h4')).map((h) => h.textContent.trim()),
    steps: Array.from(document.querySelectorAll('#main ol li')).map((li) => li.textContent.trim()).slice(0, 3),
    numberedHeadings: Array.from(document.querySelectorAll('#main h3, #main h4')).filter((h) => /^\d+\.\s/.test(h.textContent.trim())).length,
    runButtons: Array.from(document.querySelectorAll('#main button')).filter((b) => /^Run /.test(b.textContent)).length,
    html: document.querySelectorAll('#main .prose script, #main .prose iframe').length,
    route: window.ARGUS.state.route
  }));
  rec('the deep link ops/runbook/boot-01-day-one resolves to the runbook title',
    detail.route === 'ops' && detail.h1 === 'Day one, from zero to a validated decision, on hardware you already have', String(detail.h1));
  rec('the body renders the When and Preconditions headings as text',
    detail.headings.includes('When') && detail.headings.includes('Preconditions'), detail.headings.slice(0, 8).join(' | '));
  rec('at least one numbered step renders as text',
    detail.steps.length > 0 || detail.numberedHeadings > 0, 'list items ' + detail.steps.length + ', numbered headings ' + detail.numberedHeadings + (detail.steps[0] ? ': ' + detail.steps[0].slice(0, 60) : ''));
  const detailText = await mainText(page);
  rec('the detail says the runbook cannot be run and offers no Run button',
    detail.runButtons === 0 && /cannot be run from the console/.test(detailText) && detail.html === 0, 'run buttons ' + detail.runButtons);

  await goto(page, 'ops/runbook/sql-01-restore-drill');
  await settled(page);
  const missing = await page.evaluate(() => {
    const n = document.querySelector('#main .notfound');
    return {
      h1: (document.querySelector('#main h1') || {}).textContent,
      h1s: document.querySelectorAll('#main h1').length,
      state: n ? n.getAttribute('data-state') + ':' + n.getAttribute('data-reason') : null,
      retry: Array.from(document.querySelectorAll('#main button')).some((b) => /Try again/.test(b.textContent)),
      links: Array.from(document.querySelectorAll('#main a')).map((a) => a.textContent.trim())
    };
  });
  rec('the fixture deep link sql-01-restore-drill renders the one not-found block and lists the real runbooks',
    missing.state === 'notFound:unknown-id' && missing.h1 === 'No such runbook' && missing.h1s === 1 && !missing.retry && missing.links.includes('boot-01-day-one'),
    JSON.stringify(missing).slice(0, 200));

  await goto(page, 'ops/alarms');
  await settled(page);
  const alarms = await page.evaluate(() => {
    const st = (p) => { const n = document.querySelector('#main .livepanel[data-path="' + p + '"]'); return n ? n.getAttribute('data-state') + ' ' + n.textContent : 'missing'; };
    return {
      rules: st('/api/metrics/rules'),
      silences: st('/api/alerts/silences'),
      active: st('/api/alerts/active'),
      create: Array.from(document.querySelectorAll('#main button')).filter((b) => /Create alarm|Edit alm|Delete alm/.test(b.textContent)).length
    };
  });
  const alarmApi = await page.evaluate(async () => {
    const A = window.ARGUS;
    const out = {};
    for (const p of ['/api/metrics/rules', '/api/alerts/silences', '/api/alerts/active']) out[p] = A.envelopeState(await A.read(p));
    const open = A.openAlerts(await A.read('/api/alerts/active'));
    const tile = Array.from(document.querySelectorAll('#main .livepanel[data-path="/api/alerts/active"] .tile')).find((t) => /^Open alerts/.test(t.textContent));
    out.openTotal = open ? open.total : null;
    out.tileValue = tile && tile.querySelector('.tile-value') ? tile.querySelector('.tile-value').textContent.trim() : null;
    out.stamped = !!document.querySelector('#main .livepanel[data-path="/api/alerts/active"] p.readstamp[data-read-at]');
    return out;
  });
  const stateOf = (s) => s.split(' ')[0];
  if (alarmApi['/api/metrics/rules'] === 'notConfigured') {
    rec('the Alarms tab marks the rules panel notConfigured and names Prometheus rather than evaluating fixture alarms',
      /^notConfigured /.test(alarms.rules) && /Prometheus is not configured/.test(alarms.rules), alarms.rules.slice(0, 120));
  } else {
    rec('the Alarms tab rules panel takes the state of the Prometheus rules read and counts real rule groups',
      stateOf(alarms.rules) === alarmApi['/api/metrics/rules'] && (alarmApi['/api/metrics/rules'] !== 'ok' || /rule groups? loaded by Prometheus/.test(alarms.rules)), alarms.rules.slice(0, 120));
  }
  if (alarmApi['/api/alerts/silences'] === 'notConfigured') {
    rec('the Alarms tab marks silences notConfigured and names Alertmanager', /^notConfigured /.test(alarms.silences) && /Alertmanager is not configured/.test(alarms.silences), alarms.silences.slice(0, 120));
  } else {
    rec('the Alarms tab silences panel takes the state of the Alertmanager silences read', stateOf(alarms.silences) === alarmApi['/api/alerts/silences'], alarms.silences.slice(0, 120));
  }
  if (alarmApi['/api/alerts/active'] === 'ok') {
    rec('the Alarms tab open-alert count is A.openAlerts of /api/alerts/active, with a read stamp',
      stateOf(alarms.active) === 'ok' && alarmApi.openTotal !== null && alarmApi.tileValue === String(alarmApi.openTotal) && alarmApi.stamped, JSON.stringify(alarmApi));
  } else {
    rec('the Alarms tab reads open alerts from /api/alerts/active', stateOf(alarms.active) === alarmApi['/api/alerts/active'], alarms.active.slice(0, 120));
  }
  rec('the alarm editor is not offered in live mode', alarms.create === 0, 'buttons ' + alarms.create);

  await goto(page, 'ops/maintenance');
  await settled(page);
  const maint = await page.evaluate(() => ({
    marks: Array.from(document.querySelectorAll('#main [data-not-in-stack-item]')).map((n) => n.getAttribute('data-not-in-stack-item')),
    strips: document.querySelectorAll('#main [data-state="notInStack"]').length,
    buttons: Array.from(document.querySelectorAll('#main button')).filter((b) => /freeze/i.test(b.textContent)).length,
    calendar: document.querySelectorAll('#main .calendar').length
  }));
  rec('Maintenance marks change freezes and windows in one not-in-stack strip with no declare or lift button',
    maint.marks.includes('Change freezes') && maint.marks.includes('Maintenance windows') && maint.strips === 1 && maint.buttons === 0 && maint.calendar === 0, JSON.stringify(maint));

  await goto(page, 'ops/backups');
  await settled(page);
  const backups = await page.evaluate(() => ({
    marks: Array.from(document.querySelectorAll('#main [data-not-in-stack]')).map((n) => n.getAttribute('data-not-in-stack')),
    text: document.getElementById('main').textContent,
    tiles: document.querySelectorAll('#main .tile').length,
    panel: (() => { const p = document.querySelector('#main .livepanel[data-path="/api/storage/buckets"]'); return p ? { state: p.getAttribute('data-state'), tables: p.querySelectorAll('table').length, storage: Array.from(p.querySelectorAll('a')).some((a) => /storage$/.test(a.getAttribute('href') || '')) } : null; })()
  }));
  rec('Backups and drills is marked not in this stack and shows no fixture tiles',
    backups.marks.includes('Backups and restore drills') && backups.tiles === 0 && !/Drills passed|Worst RPO/.test(backups.text), JSON.stringify(backups.marks));
  rec('the backup buckets panel settles and never shows a fixture store',
    !!backups.panel && backups.panel.state !== 'loading' && !/billing_db|2026-08-14-sql-01-restore-drill/.test(backups.text), JSON.stringify(backups.panel));
  rec('the backup buckets panel is a summary that defers to Storage, not a second bucket table',
    !!backups.panel && backups.panel.tables === 0 && (backups.panel.state !== 'ok' || backups.panel.storage), JSON.stringify(backups.panel));

  await goto(page, 'ops/cost');
  await settled(page);
  const cost = await page.evaluate(() => ({
    marks: Array.from(document.querySelectorAll('#main [data-not-in-stack]')).map((n) => n.getAttribute('data-not-in-stack')),
    text: document.getElementById('main').textContent
  }));
  rec('Capacity and cost is marked not in this stack with no dollar figure',
    cost.marks.includes('Capacity and cost') && !/\$\s?[\d,]+/.test(cost.text) && !/AWS baseline/.test(cost.text), JSON.stringify(cost.marks));

  const leaks = [];
  for (const route of ['ops', 'ops/alarms', 'ops/backups', 'ops/cost', 'ops/maintenance', 'ops/runbook/sql-01-restore-drill']) {
    await goto(page, route);
    await settled(page);
    const text = await page.evaluate(() => {
      const main = document.getElementById('main').cloneNode(true);
      main.querySelectorAll('[data-sample-notice]').forEach((n) => n.remove());
      return main.textContent;
    });
    FIXTURE_STRINGS.forEach((s) => { if (text.indexOf(s) !== -1) leaks.push(route + ':' + s); });
  }
  rec('no fixture runbook id, alarm or cost figure from js/data.js appears on the live screen', leaks.length === 0, leaks.join(' | ') || 'none');

  await goto(page, 'ops');
  await settled(page);
  const errors = await page.evaluate(() => document.querySelectorAll('#main [data-state="failed"],#main [data-state="unreachable"],#main [data-state="timeout"]').length);
  rec('the Runbooks tab renders without an error state', errors === 0, 'error states ' + errors);

  await page.route('**/api/runbooks', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'unreachable', message: 'The runbooks reader did not answer.' }) }));
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'ops/runbooks');
  await settled(page);
  const fault = await page.evaluate(() => {
    const p = document.querySelector('#main .livepanel[data-path="/api/runbooks"]');
    return p ? { state: p.getAttribute('data-state'), reason: p.getAttribute('data-reason'), retry: Array.from(p.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent)), rows: p.querySelectorAll('tbody tr').length } : null;
  });
  rec('a runbooks reader fault renders the unreachable state with a retry and no rows',
    !!fault && fault.state === 'unreachable' && fault.reason === 'unreachable' && fault.retry && fault.rows === 0, JSON.stringify(fault));
  await goto(page, 'ops/runbook/boot-01-day-one');
  await settled(page);
  const detailFault = await page.evaluate(() => {
    const b = document.querySelector('#main .stateblock');
    return b ? b.getAttribute('data-state') : null;
  });
  rec('a runbooks reader fault on a runbook deep link renders the same unreachable state', detailFault === 'unreachable', String(detailFault));
  await page.unroute('**/api/runbooks');
  await page.evaluate(() => window.ARGUS.forget());
};
