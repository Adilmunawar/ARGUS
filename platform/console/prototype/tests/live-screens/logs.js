'use strict';

function at(msAgo) {
  const t = Date.now() - msAgo;
  return { atNs: String(t) + '000000', at: new Date(t).toISOString() };
}

const LINES = [
  Object.assign(at(90000), { level: 'info', line: '2026-11-05T10:00:00.000Z info  GET /api/host 200 3ms', labels: { service_name: 'console' } }),
  Object.assign(at(60000), { level: 'error', line: '2026-11-05T10:00:30.000Z error GET /api/pg/health 503 8ms', labels: { service_name: 'console' } }),
  Object.assign(at(30000), { level: 'info', line: 'orders accepted 41 records', labels: { service_name: 'orders' } })
];

function json(body) {
  return (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function on(path) {
  return (url) => new URL(url).pathname === path;
}

module.exports = async function (ctx) {
  const { page, rec, goto, waitFor } = ctx;
  const asked = [];
  let answer = { query: '', resultType: 'streams', lines: LINES, warnings: [] };

  const snap = () => page.evaluate(() => {
    const main = document.getElementById('main');
    const wrap = main.querySelector('[data-log-view]');
    const q = main.querySelector('.livepanel[data-path="/api/logs/query"]');
    const pressed = (m) => (main.querySelector('button[data-log-mode="' + m + '"]') || { getAttribute: () => null }).getAttribute('aria-pressed');
    return {
      mode: wrap ? wrap.getAttribute('data-log-mode') : null,
      follow: pressed('follow'),
      query: pressed('query'),
      qstate: q && !q.hidden ? q.getAttribute('data-state') : null,
      qreason: q ? q.getAttribute('data-reason') : null,
      qlines: q && q.querySelector('[data-lines]') ? Number(q.querySelector('[data-lines]').getAttribute('data-lines')) : null,
      retry: q ? Array.from(q.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent)) : false,
      shown: Array.from(main.querySelectorAll('.logview.logstream .logline:not(.logempty)')).map((n) => n.textContent),
      polling: (document.getElementById('log-polling') || { getAttribute: () => null }).getAttribute('aria-pressed'),
      slot: Array.from(main.querySelectorAll('[data-log-view] > div > .stateblock, [data-log-view] .stateblock')).map((n) => n.getAttribute('data-state') + ':' + (n.getAttribute('data-reason') || '')),
      hash: window.location.hash,
      notFound: !!main.querySelector('.notfound[data-state="notFound"][data-reason="unknown-id"]'),
      h1: main.querySelectorAll('h1').length
    };
  });

  const caps = await page.evaluate(() => window.ARGUS.capabilities() || {});
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'logs');
  await waitFor(page, () => !!document.querySelector('#main [data-log-view] .stateblock, #main .logview .logline'), null, 6000);
  let s = await snap();
  rec('Follow live is the default mode', s.mode === 'follow' && s.follow === 'true' && s.query === 'false', JSON.stringify({ mode: s.mode, follow: s.follow }));
  if (caps.streams && caps.streams.logs) {
    const refusals = s.slot.filter((x) => /^(notConfigured|forbidden|signedOut|failed|unreachable|timeout):/.test(x));
    rec('with Loki configured the tail opens with no refusal or failure state', refusals.length === 0, s.slot.join(',') || 'no state block');
  } else {
    rec('without Loki the tail says not configured rather than retrying at the operator',
      s.slot.indexOf('notConfigured:not-configured') !== -1, s.slot.join(','));
  }

  await page.route(on('/api/logs/labels'), json({ labels: ['service_name', 'level'] }));
  await page.route(on('/api/logs/label-values'), json({ name: 'service_name', values: ['console', 'orders'] }));
  await page.route(on('/api/logs/query'), (route) => { asked.push(route.request().url()); return json(answer)(route); });
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
  await goto(page, 'logs');
  await page.waitForTimeout(300);
  await page.click('#main button[data-log-mode="query"]');
  await waitFor(page, () => {
    const q = document.querySelector('#main .livepanel[data-path="/api/logs/query"]');
    return q && q.getAttribute('data-state') === 'ok';
  }, null, 6000);
  await page.waitForTimeout(350);
  s = await snap();
  const firstAsk = asked.length ? new URL(asked[asked.length - 1]) : null;
  rec('Query a range asks /api/logs/query for the last hour with a LogQL selector',
    !!firstAsk && firstAsk.searchParams.get('since') === '1h' && /^\{service_name=~".\+"\}$/.test(firstAsk.searchParams.get('query') || '') &&
      s.mode === 'query' && s.query === 'true' && /mode=query/.test(s.hash),
    firstAsk ? firstAsk.search : 'no request');
  rec('the range answer lands in the log view with the console polling line hidden',
    s.qstate === 'ok' && s.qlines === 3 && s.shown.length === 2 && !s.shown.some((t) => /GET \/api\/host 200/.test(t)) &&
      s.shown.some((t) => /503/.test(t)) && s.polling === 'false',
    JSON.stringify({ q: s.qstate, lines: s.qlines, shown: s.shown.length }));

  await page.click('#log-polling');
  await page.waitForTimeout(350);
  s = await snap();
  rec('pressing the polling toggle shows the console\'s own reads too', s.polling === 'true' && s.shown.length === 3 && /polling=1/.test(s.hash), s.shown.length + ' ' + s.hash);

  await page.selectOption('#log-range', '15m');
  await waitFor(page, () => {
    const q = document.querySelector('#main .livepanel[data-path="/api/logs/query"]');
    return q && q.getAttribute('data-state') === 'ok';
  }, null, 6000);
  const lastAsk = asked.length ? new URL(asked[asked.length - 1]) : null;
  rec('the range picker re-asks for fifteen minutes', !!lastAsk && lastAsk.searchParams.get('since') === '15m', lastAsk ? lastAsk.search : 'none');

  answer = { ok: false, reason: 'unreachable', message: 'Loki did not answer (stubbed by the live suite).' };
  await page.click('#main [data-log-querybar] button');
  await waitFor(page, () => {
    const q = document.querySelector('#main .livepanel[data-path="/api/logs/query"]');
    return q && q.getAttribute('data-state') === 'unreachable';
  }, null, 6000);
  s = await snap();
  rec('a query Loki does not answer shows the unreachable state with a retry', s.qstate === 'unreachable' && s.qreason === 'unreachable' && s.retry, JSON.stringify({ q: s.qstate, r: s.qreason, retry: s.retry }));

  answer = { ok: false, reason: 'invalid-request', message: 'parse error at line 1 (stubbed by the live suite).' };
  await page.fill('#log-query', '{service_name="console"');
  await page.press('#log-query', 'Enter');
  await waitFor(page, () => {
    const q = document.querySelector('#main .livepanel[data-path="/api/logs/query"]');
    return q && q.getAttribute('data-reason') === 'invalid-request';
  }, null, 6000);
  s = await snap();
  rec('a query Loki rejects fails without offering a retry', s.qstate === 'failed' && s.qreason === 'invalid-request' && !s.retry, JSON.stringify({ q: s.qstate, r: s.qreason, retry: s.retry }));

  await page.click('#main button[data-log-mode="follow"]');
  await page.waitForTimeout(200);
  s = await snap();
  rec('Follow live switches the view back to the tail', s.mode === 'follow' && s.follow === 'true' && s.qstate === null && !/mode=query/.test(s.hash), JSON.stringify({ mode: s.mode, q: s.qstate, hash: s.hash }));

  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'logs/nope');
  await waitFor(page, () => !!document.querySelector('#main .notfound'), null, 6000);
  s = await snap();
  rec('a deep link to a stream Loki does not have is the one not-found page', s.notFound && s.h1 === 1, JSON.stringify({ nf: s.notFound, h1: s.h1 }));

  await goto(page, 'logs/orders');
  await waitFor(page, () => !document.querySelector('#main .notfound') && !!document.getElementById('log-stream') && document.getElementById('log-stream').value === 'orders', null, 8000);
  s = await snap();
  rec('a deep link to a stream Loki does have opens the screen on it', !s.notFound && s.mode === 'follow' &&
    (await page.evaluate(() => document.getElementById('log-stream').value)) === 'orders', JSON.stringify({ nf: s.notFound, mode: s.mode }));

  await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
  await page.evaluate(() => window.ARGUS.forget());
};
