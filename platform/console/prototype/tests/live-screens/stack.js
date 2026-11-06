'use strict';

const KNOWN = ['ok', 'stale', 'sample', 'signedOut', 'notConfigured', 'forbidden', 'notFound', 'unreachable', 'timeout', 'failed'];
const PATHS = ['/api/storage/health', '/api/pg/health', '/api/queues/health', '/api/secrets/health'];

function settled(page) {
  return page.waitForFunction(() => {
    const main = document.getElementById('main');
    if (!main || window.ARGUS.state.pendingPanels > 0) return false;
    if (main.querySelector('.livepanel[data-state="loading"]')) return false;
    return !!main.querySelector('.livepanel[data-path="summary"][data-state="ok"], .notfound');
  }, null, { timeout: 12000 }).then(() => true, () => false);
}

function stub(path, body) {
  return [(url) => new URL(url).pathname === path, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })];
}

module.exports = async function (ctx) {
  const { page, rec, goto } = ctx;

  const snap = () => page.evaluate((paths) => {
    const main = document.getElementById('main');
    const panel = (p) => main.querySelector('.livepanel[data-path="' + p + '"]');
    return {
      title: document.title,
      h1: (main.querySelector('h1') || {}).textContent,
      cards: paths.map((p) => {
        const n = panel(p);
        return n ? {
          path: p, state: n.getAttribute('data-state'), reason: n.getAttribute('data-reason'),
          verdict: n.getAttribute('data-verdict'), details: !!n.querySelector('details.disclosure'),
          retry: Array.from(n.querySelectorAll('button')).some((b) => /Try again/.test(b.textContent)),
          stamp: !!n.querySelector('p.readstamp[data-read-at]')
        } : { path: p, state: null };
      }),
      summary: (() => {
        const n = panel('summary');
        return n ? { state: n.getAttribute('data-state'), rows: Array.from(n.querySelectorAll('tbody tr')).map((tr) => tr.textContent) } : null;
      })(),
      beats: (panel('/api/heartbeats') || { getAttribute: () => null }).getAttribute('data-state'),
      unseal: (main.querySelector('#unseal-posture') || { getAttribute: () => null }).getAttribute('data-unseal'),
      writes: (main.querySelector('[data-writes]') || { getAttribute: () => null }).getAttribute('data-writes')
    };
  }, PATHS);

  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'stack');
  await settled(page);
  let s = await snap();
  rec('the screen is titled Services', /^Services - /.test(s.title) && s.h1 === 'Services', s.title + ' / ' + s.h1);

  const api = await page.evaluate(async (paths) => {
    const out = [];
    for (const p of paths) out.push(window.ARGUS.envelopeState(await window.ARGUS.read(p, { ttlMs: 5000 })));
    out.push(window.ARGUS.envelopeState(await window.ARGUS.read('/api/heartbeats', { ttlMs: 5000 })));
    return out;
  }, PATHS);
  rec('each service card is in the state the API answer maps to',
    s.cards.every((c, i) => KNOWN.indexOf(c.state) !== -1 && c.state === api[i]),
    s.cards.map((c) => c.state + (c.reason ? ':' + c.reason : '')).join(',') + ' api ' + api.slice(0, 4).join(','));
  rec('a card that read its service gives a verdict, its details behind a disclosure and a read stamp',
    s.cards.filter((c) => c.state === 'ok' || c.state === 'stale').every((c) => !!c.verdict && c.details && c.stamp),
    JSON.stringify(s.cards));
  rec('the summary has one row per service once every card has settled',
    !!s.summary && s.summary.state === 'ok' && s.summary.rows.length === 4, JSON.stringify(s.summary && s.summary.rows.length));
  rec('the heartbeat panel is in the state its API answer maps to', s.beats === api[4], s.beats + ' api ' + api[4]);
  const caps = await page.evaluate(() => window.ARGUS.capabilities() || {});
  rec('the unseal posture banner carries its anchor, and the writes banner says read-only when it is',
    !!s.unseal && (caps.writesAllowed === false ? s.writes === 'refused' : !!s.writes), s.unseal + ' / ' + s.writes);

  const routes = [
    stub('/api/pg/health', { ok: false, reason: 'unreachable', message: 'PostgreSQL did not answer (stubbed by the live suite).' }),
    stub('/api/queues/health', { ok: false, reason: 'not-deployed', message: 'NATS is not running (stubbed by the live suite).' })
  ];
  for (const r of routes) await page.route(r[0], r[1]);
  await page.evaluate(() => window.ARGUS.forget());
  await goto(page, 'overview');
  await goto(page, 'stack');
  await settled(page);
  s = await snap();
  const pg = s.cards[1];
  const nats = s.cards[2];
  rec('a service reader that cannot reach its service shows the unreachable state with a retry',
    pg.state === 'unreachable' && pg.reason === 'unreachable' && pg.retry, JSON.stringify(pg));
  rec('a service that is not deployed shows not configured, without a retry',
    nats.state === 'notConfigured' && nats.reason === 'not-deployed' && !nats.retry, JSON.stringify(nats));
  rec('the summary carries the same two verdicts',
    !!s.summary && /PostgreSQL.*unreachable/.test(s.summary.rows.join('|')) && /Queues.*not deployed/.test(s.summary.rows.join('|')),
    s.summary ? s.summary.rows.join(' | ').slice(0, 300) : 'no summary');
  await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
  await page.evaluate(() => window.ARGUS.forget());

  await goto(page, 'stack/nope');
  await page.waitForTimeout(150);
  const nf = await page.evaluate(() => ({
    nf: !!document.querySelector('#main .notfound[data-state="notFound"][data-reason="unknown-id"]'),
    h1: document.querySelectorAll('#main h1').length,
    back: !!document.querySelector('#main .notfound a[href="#/stack"]'),
    cards: document.querySelectorAll('#main .livepanel').length
  }));
  rec('an unknown Services deep link is the one not-found page and reads nothing', nf.nf && nf.h1 === 1 && nf.back && nf.cards === 0, JSON.stringify(nf));
};
