'use strict';

const FIXTURE_STRINGS = ['hv-01-drain-node', 'sql-02-ag-failover', 'alm-1', 'Maps p95 above 500 ms', 'Monthly restore drill for orders_db', 'billing_db', 'AWS baseline'];

function mainText(page) {
  return page.evaluate(() => document.getElementById('main').textContent);
}

function settled(page) {
  return page.waitForFunction(() => {
    const main = document.getElementById('main');
    if (!main || main.querySelector('.skel')) return false;
    const text = main.textContent;
    return /Read from the console API at|is not configured|could not be read|Not in this stack|Runbook not found|Sign in to read this/.test(text);
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
    /cannot be run|not scripts the console can run/.test(listText) && /Read from the console API at \d{4}-\d{2}-\d{2}/.test(listText)
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
  const missing = await page.evaluate(() => ({
    h1: (document.querySelector('#main h1') || {}).textContent,
    text: document.getElementById('main').textContent,
    links: Array.from(document.querySelectorAll('#main a')).map((a) => a.textContent.trim())
  }));
  rec('the fixture deep link sql-01-restore-drill says the runbook was not found and lists the real ones',
    missing.h1 === 'Runbook not found' && /none is called sql-01-restore-drill/.test(missing.text) && missing.links.includes('boot-01-day-one'),
    String(missing.h1) + ' / links ' + missing.links.join(','));

  await goto(page, 'ops/alarms');
  await settled(page);
  const alarms = await page.evaluate(() => ({
    text: document.getElementById('main').textContent,
    create: Array.from(document.querySelectorAll('#main button')).filter((b) => /Create alarm|Edit alm|Delete alm/.test(b.textContent)).length
  }));
  rec('the Alarms tab says Prometheus is not configured rather than evaluating fixture alarms',
    /Prometheus is not configured/.test(alarms.text), alarms.text.replace(/\s+/g, ' ').slice(0, 120));
  rec('the Alarms tab says Alertmanager is not configured for silences', /Alertmanager is not configured/.test(alarms.text));
  rec('the alarm editor is not offered in live mode', alarms.create === 0, 'buttons ' + alarms.create);

  await goto(page, 'ops/maintenance');
  await settled(page);
  const maint = await page.evaluate(() => ({
    marks: Array.from(document.querySelectorAll('#main [data-not-in-stack]')).map((n) => n.getAttribute('data-not-in-stack')),
    buttons: Array.from(document.querySelectorAll('#main button')).filter((b) => /freeze/i.test(b.textContent)).length,
    calendar: document.querySelectorAll('#main .calendar').length
  }));
  rec('Maintenance marks change freezes as not in this stack with no declare or lift button',
    maint.marks.includes('Change freezes') && maint.buttons === 0 && maint.calendar === 0, JSON.stringify(maint));

  await goto(page, 'ops/backups');
  await settled(page);
  const backups = await page.evaluate(() => ({
    marks: Array.from(document.querySelectorAll('#main [data-not-in-stack]')).map((n) => n.getAttribute('data-not-in-stack')),
    text: document.getElementById('main').textContent,
    tiles: document.querySelectorAll('#main .tile').length
  }));
  rec('Backups and drills is marked not in this stack and shows no fixture tiles',
    backups.marks.includes('Backups and restore drills') && backups.tiles === 0 && !/Drills passed|Worst RPO/.test(backups.text), JSON.stringify(backups.marks));
  rec('the backup buckets panel shows a not-configured or error state without SeaweedFS, never a fixture store',
    /is not configured|could not be read|Try again/.test(backups.text) && !/billing_db|2026-08-14-sql-01-restore-drill/.test(backups.text),
    backups.text.replace(/\s+/g, ' ').slice(-160));

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
  const errors = await page.evaluate(() => document.querySelectorAll('#main .empty.is-error').length);
  rec('the Runbooks tab renders without an error state', errors === 0, 'error states ' + errors);
};
