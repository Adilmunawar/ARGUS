'use strict';

const KNOWN = ['ok', 'stale', 'sample', 'signedOut', 'notConfigured', 'forbidden', 'notFound', 'unreachable', 'timeout', 'failed'];

function settled(page) {
  return page.waitForFunction(() => {
    const main = document.getElementById('main');
    if (!main || window.ARGUS.state.pendingPanels > 0) return false;
    if (main.querySelector('.livepanel[data-state="loading"]')) return false;
    return !!main.querySelector('.livepanel[data-state], .notfound');
  }, null, { timeout: 10000 }).then(() => true, () => false);
}

async function open(page, hash) {
  await page.evaluate((h) => { window.location.hash = '#/' + h; }, hash);
  await page.waitForFunction(() => window.ARGUS && window.ARGUS.state.route === 'system', null, { timeout: 4000 });
  await page.waitForTimeout(60);
}

function isSeries(url) {
  return new URL(url).pathname === '/api/metrics/series';
}

function seriesBody(url) {
  const u = new URL(url);
  const windowMs = Number(u.searchParams.get('window')) || 3600000;
  const end = Date.now();
  const points = [];
  for (let at = end - windowMs; at <= end; at += 60000) points.push({ at, value: 0.25 + 0.2 * Math.sin(at / 600000) });
  return JSON.stringify({ name: u.searchParams.get('name'), stepSeconds: 60, windowMs, isRatio: true, series: [{ labels: {}, points }], warnings: [] });
}

module.exports = async function (ctx) {
  const { page, rec, goto } = ctx;

  const panelStates = () => page.evaluate(() => Array.from(document.querySelectorAll('#main .livepanel[data-path]')).map((n) => ({
    path: n.getAttribute('data-path'), state: n.getAttribute('data-state'), reason: n.getAttribute('data-reason'),
    retry: Array.from(n.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent)),
    stamp: !!n.querySelector('p.readstamp[data-read-at]'),
    previous: n.querySelectorAll('polyline[data-period="previous"]').length,
    current: n.querySelectorAll('polyline[data-period="current"]').length
  })));

  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'system');
  await settled(page);
  let panels = await panelStates();
  const host = panels.find((p) => p.path === '/api/host');
  rec('the host panel reads /api/host and ends with its read stamp', !!host && host.state === 'ok' && host.stamp, JSON.stringify(host));

  const cpuNote = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('#main .livepanel[data-path="/api/host"] .tile')).find((n) => /CPU/.test(n.textContent));
    return t ? t.textContent : '';
  });
  rec('the host CPU figure names its sample window', /now, [\d.,]+ s sample/.test(cpuNote), cpuNote.slice(0, 80));

  const series = panels.filter((p) => p.path.indexOf('/api/metrics/series') === 0);
  const apiState = await page.evaluate(async (p) => window.ARGUS.envelopeState(await window.ARGUS.read(p)), series.length ? series[0].path : '/api/metrics/series');
  rec('four series panels, each in one known state that matches what the API answers',
    series.length === 4 && series.every((p) => KNOWN.indexOf(p.state) !== -1) && series[0].state === apiState &&
      series.every((p) => /window=21600000/.test(p.path)),
    series.map((p) => p.state + (p.reason ? ':' + p.reason : '')).join(',') + ' api ' + apiState);
  rec('no panel on System failed to draw what it was given',
    panels.every((p) => p.reason !== 'render'), panels.filter((p) => p.reason === 'render').map((p) => p.path).join(','));

  await page.click('#main [data-metrics-controls] button[data-range="1h"]');
  await settled(page);
  const oneHour = await page.evaluate(() => ({
    hash: window.location.hash,
    pressed: (document.querySelector('#main button[data-range="1h"]') || {}).getAttribute('aria-pressed'),
    paths: Array.from(document.querySelectorAll('#main .livepanel[data-path^="/api/metrics/series"]')).map((n) => n.getAttribute('data-path'))
  }));
  rec('the range control re-reads every series for one hour and keeps it in the address',
    /range=1h/.test(oneHour.hash) && oneHour.pressed === 'true' && oneHour.paths.length === 4 &&
      oneHour.paths.every((p) => /window=3600000&/.test(p)), JSON.stringify(oneHour));

  await page.click('#main [data-metrics-controls] button[data-compare]');
  await settled(page);
  const compared = await page.evaluate(() => ({
    hash: window.location.hash,
    pressed: document.querySelector('#main button[data-compare]').getAttribute('aria-pressed'),
    paths: Array.from(document.querySelectorAll('#main .livepanel[data-path^="/api/metrics/series"]')).map((n) => n.getAttribute('data-path'))
  }));
  rec('comparing asks for twice the window, so the previous period comes with the current one',
    /compare=1/.test(compared.hash) && compared.pressed === 'true' &&
      compared.paths.every((p) => /window=7200000&points=440/.test(p)), JSON.stringify(compared));

  await page.route((url) => isSeries(url), (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: false, reason: 'unreachable', message: 'Prometheus did not answer (stubbed by the live suite).' })
  }));
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
  await open(page, 'system?range=1h');
  await settled(page);
  panels = await panelStates();
  const faulted = panels.filter((p) => p.path.indexOf('/api/metrics/series') === 0);
  rec('a series reader that cannot reach Prometheus shows the unreachable state with a retry',
    faulted.length === 4 && faulted.every((p) => p.state === 'unreachable' && p.reason === 'unreachable' && p.retry),
    faulted.map((p) => p.state + ':' + p.reason + ':' + p.retry).join(','));
  await page.unrouteAll({ behavior: 'wait' }).catch(() => {});

  await page.route((url) => isSeries(url), (route) => route.fulfill({ status: 200, contentType: 'application/json', body: seriesBody(route.request().url()) }));
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
  await open(page, 'system?range=1h&compare=1');
  await settled(page);
  panels = await panelStates();
  const drawn = panels.filter((p) => p.path.indexOf('/api/metrics/series') === 0);
  rec('a compared series draws the previous period dashed beside the current one, and stamps its read',
    drawn.length === 4 && drawn.every((p) => p.state === 'ok' && p.previous > 0 && p.current > 0 && p.stamp),
    drawn.map((p) => p.state + ' prev ' + p.previous + ' cur ' + p.current).join(','));
  await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
  await page.evaluate(() => window.ARGUS.forget());

  await goto(page, 'system/nope');
  await page.waitForTimeout(150);
  const nf = await page.evaluate(() => ({
    nf: !!document.querySelector('#main .notfound[data-state="notFound"][data-reason="unknown-id"]'),
    h1: document.querySelectorAll('#main h1').length,
    back: !!document.querySelector('#main .notfound a[href="#/system"]')
  }));
  rec('an unknown System deep link is the one not-found page with a way back', nf.nf && nf.h1 === 1 && nf.back, JSON.stringify(nf));
};
