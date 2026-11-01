module.exports = async function (ctx) {
  const { page, rec, goto, waitFor, origin, get } = ctx;
  const PATH = '/api/audit/recent?limit=500';

  const fromApi = (ttl) => page.evaluate(async (a) => {
    const r = await window.ARGUS.read(a.p, { ttlMs: a.ttl });
    return r.ok ? r.data : null;
  }, { p: PATH, ttl: ttl });

  const settle = () => waitFor(page, () => document.querySelectorAll('.skeleton').length === 0 && document.querySelectorAll('#main table tbody tr[data-key]').length >= 1, null, 8000);
  const snap = () => page.evaluate(() => {
    const t = document.querySelector('#main table');
    const heads = t ? Array.prototype.map.call(t.querySelectorAll('thead th'), (th) => th.textContent.replace(/[↕]/g, '').trim()) : [];
    const rows = t ? Array.prototype.map.call(t.querySelectorAll('tbody tr[data-key]'), (tr) => Array.prototype.map.call(tr.children, (c) => c.textContent.trim())) : [];
    const summary = document.getElementById('audit-live-summary');
    return {
      text: document.getElementById('main').innerText,
      heads,
      rows,
      summary: summary ? summary.textContent : '',
      errors: document.querySelectorAll('#main .empty.is-error').length,
      sample: document.querySelectorAll('[data-sample-notice]').length
    };
  });

  await goto(page, 'audit');
  const settled = await settle();
  const api = await fromApi(60000);
  const fresh = await fromApi(0);
  const s = await snap();
  const events = (api && api.events) || [];

  rec('AUDIT live: the table settles with rows from the API', settled && s.rows.length > 0 && s.errors === 0, s.rows.length + ' rows, ' + events.length + ' events');
  const want = ['when (utc)', 'actor', 'event', 'outcome', 'reason', 'path', 'source address', 'request id'];
  rec('AUDIT live: the columns are when, actor, event, outcome, reason, path, source address, request id',
    s.heads.map((h) => h.toLowerCase()).join('|') === want.join('|'), s.heads.join('|'));

  const failedIx = s.rows.findIndex((r) => r[2] === 'auth.login.failed');
  const okIx = s.rows.findIndex((r) => r[2] === 'auth.login.succeeded');
  rec('AUDIT live: the harness auth.login.failed and auth.login.succeeded events are listed', failedIx !== -1 && okIx !== -1, 'failed row ' + failedIx + ', succeeded row ' + okIx);
  rec('AUDIT live: the table is newest first, so the successful login sits above the failed one', okIx !== -1 && failedIx !== -1 && okIx < failedIx, 'succeeded ' + okIx + ' failed ' + failedIx);
  const seqs = events.map((e) => e.seq);
  rec('AUDIT live: the API itself answers newest first and the table follows its order', seqs.every((v, i) => i === 0 || seqs[i - 1] > v) && s.rows.length === events.length && s.rows[0][2] === events[0].event, 'first event ' + (events[0] && events[0].event));
  rec('AUDIT live: the actor column shows the operator subject for the successful login', okIx !== -1 && s.rows[okIx][1] === 'adil', okIx !== -1 ? s.rows[okIx][1] : 'no row');
  rec('AUDIT live: an event with no subject shows anonymous, not a blank', s.rows.every((r) => r[1] !== '') && events.every((e) => !!e.subject || s.rows.some((r) => r[1] === 'anonymous')), s.rows.slice(0, 3).map((r) => r[1]).join(','));

  const wantSummary = api ? api.total + ' events held, ' + api.dropped + ' dropped' : '';
  rec('AUDIT live: the header reports the same total and dropped count as /api/audit/recent', !!api && s.summary.indexOf(wantSummary) === 0, s.summary);
  rec('AUDIT live: a fresh read agrees with the header, allowing only for events added since', !!api && !!fresh && fresh.total >= api.total && fresh.since === api.since && fresh.persistence === 'memory', fresh ? fresh.total + ' vs ' + (api && api.total) : 'no read');
  rec('AUDIT live: the header says persistence is memory and points to the Logs screen',
    /persistence: memory/.test(s.text) && await page.evaluate(() => !!document.querySelector('#main a[href$="#/logs"], #main a[href*="#/logs"]')), 'persistence line present');

  const chain = await page.evaluate(async () => {
    const btn = () => [...document.querySelectorAll('#main button')].find((b) => /Verify the chain/.test(b.textContent));
    const text = () => document.getElementById('audit-live-chain').textContent;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    btn().click();
    await wait(900);
    const intact = text();
    [...document.querySelectorAll('#main button')].find((b) => /Alter one row/.test(b.textContent)).click();
    btn().click();
    await wait(900);
    const broken = text();
    [...document.querySelectorAll('#main button')].find((b) => /Restore the row/.test(b.textContent)).click();
    btn().click();
    await wait(900);
    return { intact, broken, healed: text(), caveat: /not that the API|does not show the API/.test(document.getElementById('main').innerText) };
  });
  rec('AUDIT live: the chain verifies over the live rows', /^Chain intact: \d+ of \d+ rows verified\.$/.test(chain.intact), chain.intact);
  rec('AUDIT live: altering one row in the page breaks the chain, restoring it heals it', /^Chain broken at row \d+/.test(chain.broken) && /^Chain intact/.test(chain.healed), chain.broken.slice(0, 60));
  rec('AUDIT live: the chain card says it does not prove the API memory was untouched', chain.caveat);

  const narrowed = await page.evaluate(async () => {
    const before = document.querySelectorAll('#main tbody tr[data-key]').length;
    const input = document.querySelector('#main .pf-input');
    const sel = document.querySelector('#main .pf-field');
    sel.value = 'event';
    input.focus();
    input.value = 'login.failed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('#main tbody tr[data-key]')].map((tr) => tr.children[2].textContent.trim());
    const tokens = document.querySelectorAll('#main .pf-tokens > *').length;
    return { before, after: rows.length, events: rows, tokens, hash: window.location.hash };
  });
  rec('AUDIT live: filtering by event text narrows the rows', narrowed.after > 0 && narrowed.after < narrowed.before && narrowed.events.every((e) => e === 'auth.login.failed'), narrowed.before + ' -> ' + narrowed.after);
  rec('AUDIT live: the filter is carried in the address', /f=/.test(narrowed.hash), narrowed.hash);

  const csv = await page.evaluate(async () => {
    [...document.querySelectorAll('#main button')].find((b) => /Export as CSV/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 200));
    const t = document.getElementById('audit-csv');
    const text = t ? t.value : '';
    const title = document.querySelector('.dialog h2');
    const close = [...document.querySelectorAll('.dialog-foot button')].find((b) => /^Close$/.test(b.textContent));
    const out = { head: text.split('\n')[0], lines: text.split('\n').length, title: title ? title.textContent : '' };
    if (close) close.click();
    return out;
  });
  rec('AUDIT live: the CSV export dialog starts with the live column header', csv.head === 'when_utc,actor,event,outcome,reason,path,source_address,request_id', csv.head);
  rec('AUDIT live: the CSV holds the filtered rows only', csv.lines - 1 === narrowed.after, csv.title);

  const detail = await page.evaluate(async () => {
    const tr = document.querySelector('#main tbody tr[data-key]');
    tr.click();
    await new Promise((r) => setTimeout(r, 200));
    const keys = [...document.querySelectorAll('.dialog dl dt')].map((d) => d.textContent);
    const close = [...document.querySelectorAll('.dialog-foot button')].find((b) => /^Close$/.test(b.textContent));
    if (close) close.click();
    return keys;
  });
  rec('AUDIT live: a row opens the whole record as a definition list', detail.indexOf('seq') !== -1 && detail.indexOf('event') !== -1 && detail.indexOf('ts') !== -1, detail.join(','));

  await goto(page, 'audit');
  await settle();
  const t = await snap();
  const fixtureLeak = ['umair', 'contractor', 'reconciler', 'alert.acknowledge', 'deployment.approve', 'elevation.request'].filter((w) => t.text.toLowerCase().indexOf(w) !== -1);
  rec('AUDIT live: no fixture actor or fixture action appears on the live screen', fixtureLeak.length === 0 && t.sample === 0, fixtureLeak.join(',') || 'clean');
  rec('AUDIT live: every panel says when it was read', (t.text.match(/Read from the console API at/g) || []).length >= 3, String((t.text.match(/Read from the console API at/g) || []).length));
  rec('AUDIT live: the page shows no error state', t.errors === 0, String(t.errors));

  const deep = await page.evaluate(async () => {
    window.location.hash = '#/audit?f=' + window.ARGUS.ui.encodeTokens([{ key: 'outcome', value: 'success' }]);
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('#main tbody tr[data-key]')].map((tr) => tr.children[3].textContent.trim());
    return { n: rows.length, ok: rows.every((v) => /success$/.test(v)), vals: rows.join(',') };
  });
  rec('AUDIT live: a deep link with a filter resolves to the filtered rows', deep.n > 0 && deep.ok, deep.n + ' rows ' + deep.vals);
};
