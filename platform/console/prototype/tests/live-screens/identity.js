module.exports = async function (ctx) {
  const { page, rec, goto, waitFor, origin, get } = ctx;

  const fetchJson = async (p) => {
    try {
      const r = await get(origin + p);
      const j = JSON.parse(typeof r === 'string' ? r : (r.body || '{}'));
      if (j && j.ok === true) return j;
    } catch (e) {}
    return page.evaluate(async (path) => { const env = await window.ARGUS.read(path, { ttlMs: 0 }); return env.data; }, p);
  };

  const apiPrincipals = await fetchJson('/api/identity/principals');
  const apiAccounts = await fetchJson('/api/gitops/service-accounts');
  const apiSeal = await fetchJson('/api/secrets/seal-status');

  const tab = async (id) => { await page.evaluate((i) => { window.location.hash = '#/identity/' + i; }, id); await page.waitForTimeout(150); };
  const settle = () => waitFor(page, () => document.querySelectorAll('.skeleton').length === 0 && document.querySelectorAll('.tabpanels .card').length >= 1, null, 8000).catch(() => {});
  const snap = () => page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const cards = {};
    Array.prototype.forEach.call(main.querySelectorAll('.card'), (c) => {
      const h = c.querySelector('h2, h3');
      if (h) cards[h.textContent.trim()] = c;
    });
    const out = { cards: {} };
    Object.keys(cards).forEach((k) => {
      const t = cards[k].querySelector('table');
      out.cards[k] = {
        text: cards[k].innerText,
        rows: t ? Array.prototype.map.call(t.querySelectorAll('tbody tr'), (tr) => Array.prototype.map.call(tr.children, (c) => c.textContent.trim())) : []
      };
    });
    out.text = main.innerText;
    out.tabs = Array.prototype.map.call(main.querySelectorAll('[role="tab"]'), (b) => b.textContent.trim());
    out.notInStack = Array.prototype.map.call(document.querySelectorAll('[data-not-in-stack]'), (n) => n.getAttribute('data-not-in-stack'));
    out.sample = document.querySelectorAll('[data-sample-notice]').length;
    out.buttons = Array.prototype.map.call(main.querySelectorAll('button'), (b) => b.textContent.trim());
    out.errors = document.querySelectorAll('.empty.is-error').length;
    return out;
  });

  const FIXTURE = /sam|contractor|Offboard|Argus-Tier0-Admins|Awaiting approval/i;

  await goto(page, 'identity');
  await settle();
  const p = await snap();
  const ops = p.cards['Console operators'] || { text: '', rows: [] };
  const pg = p.cards['PostgreSQL roles'] || { text: '' };
  const os = p.cards['Object store identities'] || { text: '' };
  const sa = p.cards['Declared service accounts'] || { text: '', rows: [] };

  rec('IDENTITY live: the first tab is named Principals', p.tabs[0] === 'Principals', p.tabs.join('|'));
  const apiOps = (apiPrincipals.console && apiPrincipals.console.operators) || [];
  rec('IDENTITY live: console operators panel lists the harness operator adil with role operator',
    apiOps.some((o) => o.subject === 'adil') && ops.rows.some((r) => r[0].indexOf('adil') === 0 && /operator/.test(r[2])), ops.rows.map((r) => r[0] + ':' + r[2]).join(';'));
  rec('IDENTITY live: the signed-in operator is marked', ops.rows.some((r) => /adil/.test(r[0]) && /you/.test(r[0])), ops.rows.length + ' rows');
  rec('IDENTITY live: the PostgreSQL panel says not configured', apiPrincipals.postgres && apiPrincipals.postgres.reason === 'not-configured' && /not configured/i.test(pg.text), pg.text.slice(0, 60).replace(/\s+/g, ' '));
  rec('IDENTITY live: the object store panel says not configured', apiPrincipals.objectStore && apiPrincipals.objectStore.reason === 'not-configured' && /not configured/i.test(os.text), os.text.slice(0, 60).replace(/\s+/g, ' '));
  const accts = (apiPrincipals.serviceAccounts && apiPrincipals.serviceAccounts.accounts) || [];
  rec('IDENTITY live: the declared accounts panel lists every account from the API',
    accts.length > 0 && sa.rows.length === accts.length && accts.every((a) => sa.rows.some((r) => r[0] === a.name)), sa.rows.length + ' of ' + accts.length);
  rec('IDENTITY live: every panel carries the time it was read', ['Console operators', 'PostgreSQL roles', 'Object store identities', 'Declared service accounts'].every((k) => /Read at/.test((p.cards[k] || {}).text || '')), 'read-at hints');
  rec('IDENTITY live: no fixture person and no offboard control on the principals tab', !FIXTURE.test(p.text) && !p.buttons.some((b) => /offboard|request elevation/i.test(b)) && p.sample === 0, (p.text.match(FIXTURE) || [''])[0] + ' / ' + p.buttons.join('|'));
  rec('IDENTITY live: no error state on the principals tab', p.errors === 0, String(p.errors));

  await tab('gmsas');
  await settle();
  const g = await snap();
  const table = (g.cards['Service accounts'] || { rows: [], text: '' });
  const orders = table.rows.filter((r) => r[0] === 'gmsa-orders$')[0];
  const apiOrders = (apiAccounts.accounts || []).filter((a) => a.name === 'gmsa-orders$')[0];
  rec('IDENTITY live: the service accounts table lists the API accounts', (apiAccounts.accounts || []).length > 0 && table.rows.length === apiAccounts.accounts.length, table.rows.length + ' rows');
  rec('IDENTITY live: gmsa-orders$ shows its declared SQL databases', !!orders && !!apiOrders && apiOrders.sql.length > 0 && apiOrders.sql.every((d) => orders[4].indexOf(d) !== -1), orders ? orders[4] : 'no row');
  rec('IDENTITY live: the table carries a declared-at stamp and the rotation note', /Declared at|Declaration time unknown/.test(table.text) && /Rotation age is not known/.test(g.text) && !/Password age/.test(g.text), 'stamp and note');
  rec('IDENTITY live: no fixture password ages or fixture accounts', !/rotation interval|Password age/.test(g.text) && g.sample === 0, 'no ages');

  await tab('grants');
  await settle();
  await waitFor(page, () => document.querySelectorAll('[data-not-in-stack]').length >= 1, null, 6000).catch(() => {});
  const gr = await snap();
  rec('IDENTITY live: the grants tab is not-in-stack', gr.notInStack.indexOf('Just-in-time group membership') !== -1, gr.notInStack.join(','));
  rec('IDENTITY live: no approve, deny or revoke buttons and no fixture grants', !gr.buttons.some((b) => /approve|deny|revoke|request/i.test(b)) && !FIXTURE.test(gr.text), gr.buttons.join('|'));

  await tab('secrets');
  await settle();
  await waitFor(page, () => /OpenBao is not configured|seal/i.test(document.body.innerText), null, 6000).catch(() => {});
  const s = await snap();
  rec('IDENTITY live: the secrets tab says OpenBao is not configured', apiSeal.state === 'not-configured' && /OpenBao is not configured/.test(s.text), (apiSeal.state || '') + ' / ' + (/OpenBao is not configured/.test(s.text)));
  rec('IDENTITY live: lease counts and rotation ages are not-in-stack', s.notInStack.indexOf('Secret lease counts and rotation ages') !== -1, s.notInStack.join(','));
  rec('IDENTITY live: no rotate or revoke buttons and no fixture secret paths', !s.buttons.some((b) => /rotate|revoke|who read|request value/i.test(b)) && !/secret\/orders|reads, 24/i.test(s.text) && s.sample === 0, s.buttons.join('|'));
  rec('IDENTITY live: the seal panel carries its read time', /Read at/.test(s.text), 'read-at hint');

  await page.evaluate(() => { window.location.hash = '#/identity/people'; });
  await page.waitForTimeout(150);
  await settle();
  const d = await snap();
  rec('IDENTITY live: the deep link identity/people still resolves to the principals tab', Object.keys(d.cards).indexOf('Console operators') !== -1 && d.errors === 0, Object.keys(d.cards).join(','));
};
