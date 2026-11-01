'use strict';

module.exports = async function (ctx) {
  const { page, rec, goto, waitFor } = ctx;

  await goto(page, 'advisor');
  const settled = await waitFor(page, () => {
    const main = document.getElementById('main');
    return main && main.querySelectorAll('tbody tr[data-key]').length > 0 && !main.querySelector('.skel');
  }, null, 8000);
  rec('the live Advisor settles into a findings table', settled);

  await page.evaluate(() => {
    const each = document.getElementById('advisor-each');
    if (each && each.getAttribute('aria-pressed') !== 'true') each.click();
  });
  await page.waitForTimeout(60);

  const state = await page.evaluate(async () => {
    const main = document.getElementById('main');
    const findings = window.ARGUS.advisorFindings();
    const rows = [...main.querySelectorAll('tbody tr[data-key]')];
    const tiles = [...main.querySelectorAll('.tiles .tile')].map((t) => ({
      label: t.querySelector('.tile-label').textContent,
      value: Number(t.querySelector('.tile-value').textContent),
      href: t.getAttribute('href')
    }));
    const principals = await window.ARGUS.read('/api/identity/principals', { ttlMs: 0 });
    const caps = await window.ARGUS.read('/api/capabilities', { ttlMs: 0 });
    const pg = await window.ARGUS.read('/api/pg/health', { ttlMs: 0 });
    const seal = await window.ARGUS.read('/api/secrets/seal-status', { ttlMs: 0 });
    const beats = await window.ARGUS.read('/api/heartbeats', { ttlMs: 0 });
    const operatorRow = rows.find((r) => r.getAttribute('data-key') === 'operators-single');
    const operatorLink = operatorRow ? operatorRow.querySelector('a[href]') : null;
    const ncRow = rows.find((r) => r.getAttribute('data-key') === 'nc-loki');
    const ncLink = ncRow ? ncRow.querySelector('a[href]') : null;
    const evidence = [...main.querySelectorAll('[data-evidence]')].map((n) => n.textContent);
    const text = main.textContent;
    const header = main.querySelector('.pagehead-desc').textContent;
    const sources = [...main.querySelectorAll('.deflist-row')].map((r) => r.textContent);
    return {
      ids: findings.map((f) => f.id),
      severities: findings.map((f) => f.severity),
      rowKeys: rows.map((r) => r.getAttribute('data-key')),
      tiles,
      byCategory: findings.reduce((acc, f) => { acc[f.category] = (acc[f.category] || 0) + 1; return acc; }, {}),
      operators: principals.ok && principals.data.console ? principals.data.console.operators.length : null,
      operatorSubject: principals.ok && principals.data.console && principals.data.console.operators[0] ? principals.data.console.operators[0].subject : null,
      streams: caps.ok ? caps.data.streams : null,
      writesAllowed: caps.ok ? caps.data.writesAllowed : null,
      pgReason: pg.ok ? 'ok' : pg.error && pg.error.reason,
      sealState: seal.ok ? seal.data.state : seal.error && seal.error.reason,
      monitorsFailing: beats.ok ? beats.data.monitors.filter((m) => m.statusName === 'down' || m.statusName === 'pending').map((m) => 'heartbeat-' + m.id).sort() : null,
      operatorLink: operatorLink ? operatorLink.getAttribute('href') : null,
      ncLink: ncLink ? ncLink.getAttribute('href') : null,
      evidence,
      evidenceCount: findings.filter((f) => f.evidence && f.evidence.path && f.evidence.at instanceof Date && !isNaN(f.evidence.at.getTime())).length,
      hasFixture: /patch-hv-03|WDAC|hv-03|Tuesday 22:00|argus-uploads|orders_db/.test(text) || findings.some((f) => /^(patch|wdac|mfa|replica|gpu)-/.test(f.id)),
      sampleNotice: !!main.querySelector('[data-sample-notice]'),
      errors: main.querySelectorAll('.empty.is-error').length,
      header,
      hint: /no write path/.test(text),
      badge: document.getElementById('nav-advisor-badge').textContent,
      urgent: findings.filter((f) => !f.suppressed && (f.severity === 'critical' || f.severity === 'high')).length,
      sources
    };
  });

  rec('the rules find the single console operator the harness created',
    state.operators === 1 && state.ids.includes('operators-single'),
    'operators=' + state.operators + ' subject=' + state.operatorSubject);
  rec('the operator finding links to the people tab of Identity',
    state.operatorLink === '#/identity/people', String(state.operatorLink));

  const unconfigured = ['nc-loki', 'nc-prometheus', 'nc-alertmanager', 'nc-docker', 'nc-postgres', 'nc-openbao'];
  const present = unconfigured.filter((id) => state.ids.includes(id));
  rec('every reader the harness left unconfigured is an info line, not a finding',
    present.length === unconfigured.length && state.streams && state.streams.logs === false && state.pgReason === 'not-configured' && /not-configured/.test(String(state.sealState)),
    'present=' + present.join(',') + ' pg=' + state.pgReason + ' seal=' + state.sealState);
  rec('the not-configured lines carry info severity and link to the stack screen',
    present.every((id) => state.severities[state.ids.indexOf(id)] === 'info') && state.ncLink === '#/stack',
    'link=' + state.ncLink);
  rec('no rule that needs an unconfigured source produced a finding',
    !state.ids.some((id) => /^(pg-|target-|container-|alert-|seal-|lock-|host-|disk-)/.test(id)),
    state.ids.join(','));
  const heartbeatIds = state.ids.filter((id) => /^heartbeat-/.test(id)).sort();
  rec('every heartbeat finding names a monitor the API reports down or degraded',
    state.monitorsFailing !== null && heartbeatIds.length > 0 && heartbeatIds.every((id) => state.monitorsFailing.includes(id)),
    'findings=' + heartbeatIds.join(',') + ' api=' + (state.monitorsFailing || []).join(','));
  rec('no fixture finding or fixture host reaches the live screen and no sample notice is shown',
    !state.hasFixture && !state.sampleNotice, state.ids.join(','));
  rec('writes are reported only when the API says they are allowed',
    state.writesAllowed === true ? state.ids.includes('writes-allowed') : !state.ids.includes('writes-allowed'),
    'writesAllowed=' + state.writesAllowed);
  rec('every finding carries evidence naming the read and a timestamp, and the table shows it',
    state.evidenceCount === state.ids.length && state.evidence.length === state.rowKeys.length && state.evidence.every((e) => /^Evidence: GET \/api\/.+ read at \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(e)),
    state.evidenceCount + '/' + state.ids.length + ' sample=' + (state.evidence[0] || ''));
  const tileSum = state.tiles.reduce((n, t) => n + t.value, 0);
  const tileMatch = state.tiles.every((t) => {
    const cat = { Security: 'security', 'Fault tolerance': 'resilience', Cost: 'cost', Performance: 'performance', Operations: 'operations' }[t.label];
    return (state.byCategory[cat] || 0) === t.value;
  });
  rec('the five tiles count the live findings by category and sum to the table',
    state.tiles.length === 5 && tileMatch && tileSum === state.rowKeys.length && state.rowKeys.length === state.ids.length,
    JSON.stringify(state.tiles.map((t) => t.label + '=' + t.value)) + ' rows=' + state.rowKeys.length);
  rec('the header counts the findings and names the API reads with their time',
    new RegExp('^' + state.ids.length + ' findings? across 5 categories, computed from 13 reads of the console API at \\d{4}-').test(state.header), state.header);
  rec('the nav badge matches the urgent live findings',
    state.badge === (state.urgent ? String(state.urgent) : ''), 'badge=' + JSON.stringify(state.badge) + ' urgent=' + state.urgent);
  rec('the screen says acceptance is client-side and shows no error state',
    state.hint && state.errors === 0, 'errors=' + state.errors);
  rec('the sources card lists all thirteen reads with a status each',
    state.sources.length === 13 && state.sources.some((s) => /not configured/.test(s)) && state.sources.some((s) => /^Console capabilities.*read/.test(s)),
    state.sources.length + ' rows');

  const accept = await page.evaluate(async () => {
    const before = document.querySelectorAll('#main tbody tr[data-key]').length;
    const badgeBefore = document.getElementById('nav-advisor-badge').textContent;
    const button = [...document.querySelectorAll('#main button')].find((b) => b.getAttribute('aria-label') === 'Accept risk on operators-single');
    if (!button) return { missing: true };
    button.click();
    await new Promise((r) => setTimeout(r, 150));
    const dialog = document.querySelector('.dialog');
    const clientSide = dialog ? dialog.querySelector('[data-client-side]') : null;
    const dialogText = clientSide ? clientSide.textContent : '';
    const why = document.getElementById('suppress-why');
    why.value = 'second operator is being onboarded';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.dialog-foot button')].find((b) => /^Accept for/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 400));
    const after = document.querySelectorAll('#main tbody tr[data-key]').length;
    const gone = !window.ARGUS.advisorFindings().some((f) => f.id === 'operators-single' && !f.suppressed);
    const stillThere = window.ARGUS.advisorFindings().some((f) => f.id === 'operators-single' && f.suppressed);
    const suppressed = window.ARGUS.data.advisorSuppressed.slice();
    const flash = [...document.querySelectorAll('.flash')].map((f) => f.textContent).join(' | ');
    window.ARGUS.data.advisorSuppressed = [];
    window.ARGUS.data.audit = window.ARGUS.data.audit.filter((r) => !(r.action === 'advisor.accept' && /operators-single/.test(String(r.target))));
    window.ARGUS.refreshBadges();
    return { before, after, badgeBefore, dialogText, gone, stillThere, suppressed, flash, badgeAfter: document.getElementById('nav-advisor-badge').textContent };
  });
  rec('the accept dialog says the acceptance stays in this browser because the console has no write path',
    !accept.missing && /stays in this browser/.test(accept.dialogText) && /no write path/.test(accept.dialogText), (accept.dialogText || '').slice(0, 80));
  rec('accepting a risk removes the finding from the table and keeps it client-side',
    !accept.missing && accept.after === accept.before - 1 && accept.gone && accept.stillThere && accept.suppressed.length === 1 && accept.suppressed[0].id === 'operators-single' && /in this browser/.test(accept.flash),
    JSON.stringify({ before: accept.before, after: accept.after, suppressed: accept.suppressed.length }));

  await page.evaluate(() => {
    const A = window.ARGUS;
    window.location.hash = A.href('advisor', [], { f: A.ui.encodeTokens([{ key: 'category', value: 'Operations' }]) });
  });
  await page.waitForTimeout(300);
  const filtered = await waitFor(page, () => {
    const main = document.getElementById('main');
    const rows = [...main.querySelectorAll('tbody tr[data-key]')];
    return rows.length > 0 && !main.querySelector('.skel') && rows.every((r) => /Operations/.test(r.children[1].textContent));
  }, null, 6000);
  const deep = await page.evaluate(() => {
    const main = document.getElementById('main');
    const rows = [...main.querySelectorAll('tbody tr[data-key]')];
    const findings = window.ARGUS.advisorFindings().filter((f) => f.category === 'operations' && !f.suppressed);
    return { rows: rows.length, expected: findings.length, route: window.ARGUS.state.route };
  });
  rec('a deep link with a category filter resolves against the live findings',
    filtered && deep.route === 'advisor' && deep.rows === deep.expected && deep.rows > 0, JSON.stringify(deep));

  await page.evaluate(() => { window.location.hash = '#/advisor'; });
  await page.waitForTimeout(200);
};
