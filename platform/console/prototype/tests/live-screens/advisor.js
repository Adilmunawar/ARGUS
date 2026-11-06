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
    const sources = [...main.querySelectorAll('[data-source]')].map((r) => ({ id: r.getAttribute('data-source'), state: r.getAttribute('data-state'), text: r.parentNode.parentNode.textContent }));
    return {
      ids: findings.map((f) => f.id),
      severities: findings.map((f) => f.severity),
      rowKeys: rows.map((r) => r.getAttribute('data-key')),
      tiles,
      byCategory: findings.reduce((acc, f) => { acc[f.category] = (acc[f.category] || 0) + 1; return acc; }, {}),
      operators: principals.ok && principals.data.console && Array.isArray(principals.data.console.operators) ? principals.data.console.operators.length : null,
      operatorSubject: principals.ok && principals.data.console && Array.isArray(principals.data.console.operators) && principals.data.console.operators[0] ? principals.data.console.operators[0].subject : null,
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
      errors: main.querySelectorAll('.stateblock[data-state="failed"], .stateblock[data-state="unreachable"], .stateblock[data-state="timeout"]').length,
      header,
      hint: /no write path/.test(text),
      badge: document.getElementById('nav-advisor-badge').textContent,
      urgent: findings.filter((f) => !f.suppressed && (f.severity === 'critical' || f.severity === 'high')).length,
      sources
    };
  });

  rec('the single-operator finding fires exactly when the API lists one console operator',
    state.operators !== null && state.ids.includes('operators-single') === (state.operators === 1),
    'operators=' + state.operators + ' subject=' + state.operatorSubject);
  rec('the operator finding, when present, links to the people tab of Identity',
    state.operators !== 1 ? state.operatorLink === null : state.operatorLink === '#/identity/people', String(state.operatorLink));

  const srcApi = await page.evaluate(async () => {
    const A = window.ARGUS;
    const SOURCES = { seal: ['/api/secrets/seal-status', 'openbao'], lock: ['/api/storage/lock-status', 'seaweedfs'], buckets: ['/api/storage/buckets', 'seaweedfs'],
      pg: ['/api/pg/health', 'postgres'], targets: ['/api/metrics/targets', 'prometheus'], alerts: ['/api/alerts/active', 'alertmanager'], containers: ['/api/containers', 'docker'] };
    const STREAMS = { logs: 'loki', metrics: 'prometheus', alerts: 'alertmanager', containers: 'docker' };
    const status = (env) => {
      const s = A.envelopeState(env);
      if (s !== 'ok' && s !== 'stale') return s;
      const d = env.data || {};
      return d.configured === false || d.state === 'not-configured' ? 'notConfigured' : 'ok';
    };
    const states = {};
    const nc = {};
    for (const id of Object.keys(SOURCES)) {
      states[id] = status(await A.read(SOURCES[id][0]));
      if (states[id] === 'notConfigured') nc['nc-' + SOURCES[id][1]] = true;
    }
    const caps = await A.read('/api/capabilities');
    const streams = (caps.ok && caps.data.streams) || {};
    Object.keys(STREAMS).forEach((k) => { if (streams[k] === false) nc['nc-' + STREAMS[k]] = true; });
    return { states, nc: Object.keys(nc).sort() };
  });
  const ncIds = state.ids.filter((id) => /^nc-/.test(id)).sort();
  rec('the not-configured info lines are exactly the readers the API reports not configured',
    ncIds.join(',') === srcApi.nc.join(','), 'lines=' + ncIds.join(',') + ' api=' + srcApi.nc.join(','));
  if (ctx.external) {
    rec('on the full stack the PostgreSQL and OpenBao readers answer, so neither has a not-configured line',
      state.pgReason === 'ok' && !/not-configured/.test(String(state.sealState)) && !ncIds.includes('nc-postgres') && !ncIds.includes('nc-openbao'),
      'pg=' + state.pgReason + ' seal=' + state.sealState);
  } else {
    const unconfigured = ['nc-loki', 'nc-prometheus', 'nc-alertmanager', 'nc-docker', 'nc-postgres', 'nc-openbao'];
    rec('every reader the harness left unconfigured is an info line, not a finding',
      unconfigured.every((id) => ncIds.includes(id)) && state.streams && state.streams.logs === false && state.pgReason === 'not-configured' && /not-configured/.test(String(state.sealState)),
      'present=' + ncIds.join(',') + ' pg=' + state.pgReason + ' seal=' + state.sealState);
  }
  if (ncIds.length) {
    rec('the not-configured lines carry info severity and link to the stack screen',
      ncIds.every((id) => state.severities[state.ids.indexOf(id)] === 'info') && state.ncLink === '#/stack',
      'link=' + state.ncLink);
  } else {
    ctx.skip('the not-configured lines carry info severity and link to the stack screen', 'every reader is configured on this stack, so there is no not-configured line to inspect');
  }
  const NEEDS = { 'pg-': 'pg', 'target-': 'targets', 'container-': 'containers', 'alert-': 'alerts', 'seal-': 'seal', 'lock-': 'lock' };
  const orphans = state.ids.filter((id) => Object.keys(NEEDS).some((p) => id.indexOf(p) === 0 && srcApi.states[NEEDS[p]] !== 'ok'));
  rec('no rule that needs an unconfigured or unreadable source produced a finding',
    orphans.length === 0, 'orphans=' + orphans.join(',') + ' states=' + JSON.stringify(srcApi.states));
  const hostExpect = await page.evaluate(async () => {
    const h = await window.ARGUS.read('/api/host');
    if (!h.ok || !h.data) return null;
    const out = [];
    if (h.data.memory && h.data.memory.usageRatio > 0.85) out.push('host-memory');
    (h.data.disks || []).forEach((d) => {
      if (d.error || !d.totalBytes) return;
      const ratio = d.usageRatio !== undefined ? d.usageRatio : (d.totalBytes - d.freeBytes) / d.totalBytes;
      if (ratio > 0.8) out.push('disk-' + d.mount);
    });
    return out.sort();
  });
  const hostIds = state.ids.filter((id) => /^(host-|disk-)/.test(id)).sort();
  rec('host and volume findings are exactly the ones the /api/host answer crosses a threshold for',
    hostExpect !== null && hostIds.join(',') === hostExpect.join(','), 'findings=' + hostIds.join(',') + ' api=' + (hostExpect || []).join(','));
  const heartbeatIds = state.ids.filter((id) => /^heartbeat-/.test(id)).sort();
  rec('every heartbeat finding names a monitor the API reports down or pending',
    state.monitorsFailing !== null && (ctx.external || heartbeatIds.length > 0) && heartbeatIds.every((id) => state.monitorsFailing.includes(id)),
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
    state.sources.length === 13 && state.sources.every((s) => !!s.state) &&
      (ctx.external || state.sources.some((s) => s.state === 'notConfigured' && /not configured/.test(s.text))) &&
      state.sources.some((s) => s.id === 'capabilities' && s.state === 'ok' && /^Console capabilities.*read/.test(s.text)),
    state.sources.map((s) => s.id + '=' + s.state).join(','));
  const srcIds = { pg: 'pg', seal: 'seal', lock: 'lock', buckets: 'buckets', targets: 'targets', alerts: 'alerts', containers: 'containers' };
  rec('each source row on the card carries the state its read maps to',
    Object.keys(srcIds).every((id) => { const row = state.sources.find((s) => s.id === id); return row && row.state === srcApi.states[id]; }),
    Object.keys(srcIds).map((id) => { const row = state.sources.find((s) => s.id === id); return id + '=' + (row && row.state) + '/' + srcApi.states[id]; }).join(','));

  const accept = await page.evaluate(async () => {
    const before = document.querySelectorAll('#main tbody tr[data-key]').length;
    const badgeBefore = document.getElementById('nav-advisor-badge').textContent;
    const button = [...document.querySelectorAll('#main button')].find((b) => /^Accept risk on /.test(b.getAttribute('aria-label') || ''));
    if (!button) return { missing: true };
    const id = button.getAttribute('aria-label').replace(/^Accept risk on /, '');
    button.click();
    await new Promise((r) => setTimeout(r, 150));
    const dialog = document.querySelector('.dialog');
    const clientSide = dialog ? dialog.querySelector('[data-client-side]') : null;
    const dialogText = clientSide ? clientSide.textContent : '';
    const why = document.getElementById('suppress-why');
    why.value = 'accepted for the live suite';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.dialog-foot button')].find((b) => /^Accept for/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 400));
    const after = document.querySelectorAll('#main tbody tr[data-key]').length;
    const gone = !window.ARGUS.advisorFindings().some((f) => f.id === id && !f.suppressed);
    const stillThere = window.ARGUS.advisorFindings().some((f) => f.id === id && f.suppressed);
    const suppressed = window.ARGUS.data.advisorSuppressed.slice();
    const flash = [...document.querySelectorAll('.flash')].map((f) => f.textContent).join(' | ');
    window.ARGUS.data.advisorSuppressed = [];
    window.ARGUS.data.audit = window.ARGUS.data.audit.filter((r) => !(r.action === 'advisor.accept' && String(r.target).indexOf(id) !== -1));
    window.ARGUS.refreshBadges();
    return { id, before, after, badgeBefore, dialogText, gone, stillThere, suppressed, flash, badgeAfter: document.getElementById('nav-advisor-badge').textContent };
  });
  rec('the accept dialog says the acceptance stays in this browser because the console has no write path',
    !accept.missing && /stays in this browser/.test(accept.dialogText) && /no write path/.test(accept.dialogText), (accept.dialogText || '').slice(0, 80));
  rec('accepting a risk removes the finding from the table and keeps it client-side',
    !accept.missing && accept.after === accept.before - 1 && accept.gone && accept.stillThere && accept.suppressed.length === 1 && accept.suppressed[0].id === accept.id && /in this browser/.test(accept.flash),
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

  const encoding = await page.evaluate(() => [...document.querySelectorAll('#main .tiles a.tile')].map((t) => t.getAttribute('href')));
  const faultHref = encoding.find((h) => /Fault/.test(h)) || '';
  rec('the category tiles encode the filter once, with no double-encoded space or colon',
    encoding.length === 5 && faultHref === '#/advisor?f=category%3AFault%20tolerance' && encoding.every((h) => !/%25/.test(h)),
    encoding.join(' '));
  await page.evaluate((h) => { window.location.hash = h; }, faultHref);
  await page.waitForTimeout(300);
  await waitFor(page, () => !document.querySelector('#main .skel') && !!document.querySelector('#main .pf-tokens'), null, 6000);
  const faultFilter = await page.evaluate(() => {
    const main = document.getElementById('main');
    const rows = [...main.querySelectorAll('tbody tr[data-key]')];
    const expected = window.ARGUS.advisorFindings().filter((f) => f.category === 'resilience' && !f.suppressed).length;
    return {
      tokens: [...main.querySelectorAll('.pf-tokens > *')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
      rows: rows.length,
      everyFault: rows.every((r) => /Fault tolerance/.test(r.children[1].textContent)),
      expected,
      empty: !!main.querySelector('tbody td[colspan]')
    };
  });
  rec('opening the Fault tolerance tile applies the category filter with the space decoded',
    faultFilter.tokens.length === 1 && /Fault tolerance/.test(faultFilter.tokens[0]) && faultFilter.everyFault && faultFilter.rows === faultFilter.expected,
    JSON.stringify(faultFilter));

  const PG = '**/api/pg/health*';
  await page.route(PG, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, reason: 'unreachable', message: 'PostgreSQL did not answer (injected by the live suite).' })
  }));
  await page.evaluate(() => { window.location.hash = '#/advisor'; });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#main button')].find((x) => /^Re-evaluate$/.test(x.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(300);
  await waitFor(page, () => !document.querySelector('#main .skel') && document.querySelectorAll('#main [data-source]').length === 13, null, 8000);
  const fault = await page.evaluate(() => {
    const src = document.querySelector('#main [data-source="pg"]');
    return {
      state: src ? src.getAttribute('data-state') : null,
      text: src ? src.textContent : '',
      finding: window.ARGUS.advisorFindings().some((f) => f.id === 'pg-health' && f.category === 'resilience'),
      notConfigured: window.ARGUS.advisorFindings().some((f) => f.id === 'nc-postgres')
    };
  });
  await page.unroute(PG);
  await page.evaluate(() => { window.ARGUS.forget('/api/pg/health'); });
  rec('a source that does not answer is marked unreachable on the sources card and raises the health finding',
    fault.state === 'unreachable' && /unreachable/.test(fault.text) && fault.finding && !fault.notConfigured,
    JSON.stringify(fault));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#main button')].find((x) => /^Re-evaluate$/.test(x.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.location.hash = '#/advisor'; });
  await page.waitForTimeout(200);
  await waitFor(page, () => !document.querySelector('#main .skel') && document.querySelectorAll('#main [data-source]').length === 13, null, 8000);

  await page.evaluate(() => {
    const A = window.ARGUS;
    const real = A.read;
    const spoiled = { '/api/pg/health': 'cancelled', '/api/heartbeats': 'unauthenticated' };
    window.__advisorReads = {};
    A.read = function (p, o) {
      window.__advisorReads[p] = (window.__advisorReads[p] || 0) + 1;
      if (spoiled[p]) {
        const reason = spoiled[p];
        delete spoiled[p];
        return Promise.resolve({ ok: false, data: null, mode: 'live', at: Date.now(), stale: false, error: { reason, status: reason === 'unauthenticated' ? 401 : undefined, message: 'Spoiled by the live suite.' } });
      }
      return real.call(A, p, o);
    };
    window.__advisorRealRead = real;
    const b = [...document.querySelectorAll('#main button')].find((x) => /^Re-evaluate$/.test(x.textContent.trim()));
    if (b) b.click();
  });
  const repainted = await waitFor(page, () => !document.querySelector('#main .skel') && document.querySelectorAll('#main [data-source]').length === 13, null, 10000);
  const spoiledRun = await page.evaluate(() => {
    const A = window.ARGUS;
    A.read = window.__advisorRealRead;
    const sources = [...document.querySelectorAll('#main [data-source]')].map((n) => n.getAttribute('data-state'));
    const header = (document.querySelector('#main .pagehead-desc') || {}).textContent || '';
    const findings = A.advisorFindings().filter((f) => !f.suppressed).length;
    return {
      reads: window.__advisorReads,
      sources,
      header,
      findings,
      rows: document.querySelectorAll('#main tbody tr[data-key]').length,
      incomplete: !!document.querySelector('#main [data-advisor-incomplete]')
    };
  });
  rec('an evaluation with a cancelled or signed-out read is not painted: the Advisor re-evaluates and paints a complete one',
    repainted && !spoiledRun.incomplete && spoiledRun.reads['/api/pg/health'] >= 2 && spoiledRun.reads['/api/heartbeats'] >= 2 &&
      spoiledRun.sources.every((s) => s !== 'cancelled' && s !== 'signedOut') && spoiledRun.findings > 0 &&
      new RegExp('^' + spoiledRun.findings + ' findings? ').test(spoiledRun.header),
    JSON.stringify({ pg: spoiledRun.reads['/api/pg/health'], hb: spoiledRun.reads['/api/heartbeats'], sources: spoiledRun.sources.join(','), findings: spoiledRun.findings, header: spoiledRun.header.slice(0, 60) }));
};
