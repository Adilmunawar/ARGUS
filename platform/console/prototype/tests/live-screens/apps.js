'use strict';

const FIXTURE_ONLY = ['Maps', 'maps.example.com', 'Billing API', 'Orders Dashboard', 'sf-04'];

function readAs(page, path) {
  return page.evaluate(async (p) => {
    const env = await window.ARGUS.read(p, { ttlMs: 0 });
    return env.ok ? env.data : (env.data || { ok: false, reason: env.error && env.error.reason, message: env.error && env.error.message });
  }, path);
}

async function settled(ctx) {
  await ctx.waitFor(ctx.page, () => !document.querySelector('#main .skel'), null, 6000);
  await ctx.page.waitForTimeout(150);
}

function mainText(page) {
  return page.evaluate(() => document.getElementById('main').textContent);
}

function textOutsideNotices(page) {
  return page.evaluate(() => {
    const main = document.getElementById('main').cloneNode(true);
    main.querySelectorAll('[data-sample-notice]').forEach((n) => n.remove());
    return main.textContent;
  });
}

module.exports = async (ctx) => {
  const { page, rec } = ctx;
  const apps = await readAs(page, '/api/gitops/apps');
  const envs = await readAs(page, '/api/gitops/environments');
  const containers = await readAs(page, '/api/containers');
  rec('the API answers the three reads the screen makes, read through the signed-in store',
    !!(apps && apps.ok && envs && envs.ok && containers && (ctx.external ? containers.ok === true && Array.isArray(containers.containers) : containers.ok === false)),
    JSON.stringify({ apps: apps && apps.count, envs: envs && envs.count, containers: containers && (containers.ok ? containers.count : containers.reason) }));

  await ctx.goto(page, 'apps');
  await settled(ctx);

  const expectedNames = (apps.apps || []).map((a) => a.name).sort();
  const rowKeys = await page.evaluate(() => [...document.querySelectorAll('#main tbody tr[data-key]')].map((r) => r.dataset.key).sort());
  rec('the live list has exactly the applications /api/gitops/apps declares',
    rowKeys.join(',') === expectedNames.join(',') && expectedNames.indexOf('orders') !== -1 && expectedNames.indexOf('maps') === -1,
    'page ' + rowKeys.join(',') + ' / api ' + expectedNames.join(','));

  const orders = (apps.apps || []).find((a) => a.name === 'orders');
  const prod = (envs.environments || []).find((e) => e.name === 'production');
  const ordersVersion = prod && (prod.apps || []).find((a) => a.app === 'orders');
  const ordersCells = await page.evaluate(() => {
    const tr = document.querySelector('#main tbody tr[data-key="orders"]');
    return tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()) : [];
  });
  const ordersRow = ordersCells.join(' | ');
  rec('the orders row shows the declared instances and service count from the spec',
    !!orders && ordersCells.indexOf(String(orders.instances)) !== -1 && ordersCells.indexOf(String(orders.services.length)) !== -1,
    'instances ' + (orders && orders.instances) + ', services ' + (orders && orders.services.length) + ': ' + ordersRow.slice(0, 140));
  rec('the orders row shows the production version from the environments answer',
    !!ordersVersion && !!ordersVersion.version && ordersCells.indexOf(ordersVersion.version) !== -1,
    'version ' + (ordersVersion && ordersVersion.version) + ': ' + ordersRow.slice(0, 140));
  rec('the orders row shows the ingress host and the secret reference count',
    !!orders && ordersCells.indexOf(orders.ingress.host) !== -1 && ordersCells.indexOf(String(orders.secretRefs.length)) !== -1,
    (orders && orders.ingress.host) + ', ' + (orders && orders.secretRefs.length) + ' refs: ' + ordersRow.slice(0, 140));

  const listText = await mainText(page);
  const consoleProblem = (apps.problems || []).find((p) => p.directory === 'console');
  rec('the problems list names the console directory, which has a README but no spec',
    !!consoleProblem && /console\s+has no app\.yaml/.test(listText.replace(/\s+/g, ' ')),
    consoleProblem ? consoleProblem.message : 'no console problem in the API answer');
  const listStamps = await page.evaluate(() => document.querySelectorAll('#main .livepanel[data-state="ok"] p.readstamp[data-read-at]').length);
  rec('the list says when it was read and that no reconciler has applied the declarations',
    listStamps === 1 && /No reconciler runs in this stack/.test(listText),
    listStamps + ' read stamps');

  const outsideList = await textOutsideNotices(page);
  const leakedList = FIXTURE_ONLY.filter((s) => outsideList.indexOf(s) !== -1);
  rec('no fixture-only application, host or node name appears on the live list', leakedList.length === 0, leakedList.join(', '));
  rec('the live list has no drift card, Promote button or Restart action from the fixture',
    await page.evaluate(() => ![...document.querySelectorAll('#main button')].some((b) => /^(Promote |Restart)/.test(b.textContent)) && !/Staging and production agree/.test(document.getElementById('main').textContent)));
  rec('the live list rendered without an error state',
    await page.evaluate(() => document.querySelectorAll('#main [data-state="failed"], #main [data-state="unreachable"], #main [data-state="timeout"]').length === 0 && document.querySelectorAll('#main .livepanel[data-state="ok"]').length === 1));

  const filtered = await page.evaluate(async () => {
    const inp = document.querySelector('#main .pf-input');
    const field = document.querySelector('#main .pf-field');
    if (!inp || !field) return { why: 'no property filter' };
    field.value = 'owner';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    inp.value = 'riley';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    return { rows: [...document.querySelectorAll('#main tbody tr[data-key]')].map((r) => r.dataset.key).sort().join(','), hash: location.hash };
  });
  const riley = (apps.apps || []).filter((a) => /riley/.test(String(a.owner))).map((a) => a.name).sort().join(',');
  rec('the property filter narrows the live rows by the owner the spec declares', filtered.rows === riley && /f=/.test(filtered.hash), JSON.stringify(filtered));

  await ctx.goto(page, 'apps/orders');
  await settled(ctx);
  const detailText = await mainText(page);
  const detail = await page.evaluate(() => ({
    route: window.ARGUS.state.route,
    rest: window.ARGUS.state.rest.join('/'),
    h1: (document.querySelector('#main h1') || {}).textContent || '',
    crumb: document.getElementById('crumb') ? document.getElementById('crumb').textContent : '',
    heads: [...document.querySelectorAll('#main h2')].map((h) => h.textContent),
    tabs: document.querySelectorAll('#main .tab').length,
    headActions: [...document.querySelectorAll('#main .pagehead-actions button')].map((b) => b.textContent.trim()),
    notInStack: [...document.querySelectorAll('#main [data-not-in-stack-item]')].map((n) => n.getAttribute('data-not-in-stack-item')),
    strips: document.querySelectorAll('#main [data-state="notInStack"]').length,
    stamps: document.querySelectorAll('#main p.readstamp[data-read-at]').length,
    okPanels: document.querySelectorAll('#main .livepanel[data-state="ok"]').length,
    errors: document.querySelectorAll('#main [data-state="failed"], #main [data-state="unreachable"], #main [data-state="timeout"]').length,
    captions: [...document.querySelectorAll('#main caption')].map((c) => c.textContent)
  }));
  rec('the deep link apps/orders resolves to the live detail of orders',
    detail.route === 'apps' && detail.rest === 'orders' && detail.h1 === 'orders' && /orders/.test(detail.crumb), JSON.stringify({ h1: detail.h1, crumb: detail.crumb }));

  const serviceNames = orders ? orders.services.map((s) => s.name) : [];
  const serviceExes = orders ? orders.services.map((s) => s.exe) : [];
  rec('the detail lists every service from the spec with its executable',
    serviceNames.length > 0 && serviceNames.every((n) => detailText.indexOf(n) !== -1) && serviceExes.every((x) => detailText.indexOf(x) !== -1),
    serviceNames.join(', '));
  rec('the detail shows the package bucket, key, signature and identity from the spec',
    !!orders && [orders.package.bucket, orders.package.key, orders.package.signature, orders.identity].every((v) => detailText.indexOf(v) !== -1),
    orders ? orders.package.key + ' ' + orders.identity : '');
  rec('the detail shows the ingress host, probe path and egress allow-list',
    !!orders && [orders.ingress.host, orders.health.path].concat(orders.egress).every((v) => detailText.indexOf(v) !== -1),
    orders ? orders.health.path + ' ' + orders.egress.join(' ') : '');

  const refs = orders ? orders.secretRefs : [];
  rec('the detail lists every secret reference path and never a value or fragment',
    refs.length > 0 && refs.every((p) => detailText.indexOf(p) !== -1) && detailText.indexOf('#value') === -1 && !/openbao:/.test(detailText),
    refs.join(', '));

  const rules = orders ? orders.alertRules : [];
  const sevs = rules.map((r) => r.severity).filter(Boolean);
  rec('the detail lists the alert rules with their severity',
    rules.length > 0 && rules.every((r) => detailText.indexOf(r.name) !== -1) && sevs.every((s) => detailText.indexOf(s) !== -1),
    rules.map((r) => r.name + ':' + r.severity).join(', '));

  rec('the detail shows the declared version per environment from the environments answer',
    !!ordersVersion && detailText.indexOf(ordersVersion.version) !== -1 && /production/.test(detailText) && detail.heads.indexOf('Declared versions') !== -1,
    ordersVersion ? ordersVersion.version : 'none');

  rec('instances, metrics, deploy history and restart are one not-in-stack strip, not fixture tabs',
    detail.tabs === 0 && detail.strips === 1 && detail.notInStack.length === 4 && detail.notInStack.every((w) => /orders/.test(w))
      && /instances/i.test(detail.notInStack[0]) && /metrics/i.test(detail.notInStack[1]) && /Deployment history/i.test(detail.notInStack[2]) && /Restarting/i.test(detail.notInStack[3]),
    JSON.stringify(detail.notInStack));
  rec('the live detail offers no Deploy or Restart action, since nothing here could receive it',
    detail.headActions.length === 0 && !/Open pull request|Roll back to this/.test(detailText), JSON.stringify(detail.headActions));

  const running = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#main .card')].find((c) => /^Running here/.test((c.querySelector('.card-title') || {}).textContent || ''));
    return card ? card.textContent : '';
  });
  const runningState = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#main .card')].find((c) => /^Running here/.test((c.querySelector('.card-title') || {}).textContent || ''));
    const body = card ? card.querySelector('.livepanel') : null;
    return body ? { state: body.getAttribute('data-state'), reason: body.getAttribute('data-reason'), retry: !!body.querySelector('button') } : null;
  });
  if (containers && containers.ok) {
    const want = (containers.containers || []).filter((c) => (c.names || []).some((n) => String(n).indexOf('orders') !== -1));
    const runningRows = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#main .card')].find((c) => /^Running here/.test((c.querySelector('.card-title') || {}).textContent || ''));
      return card ? { rows: card.querySelectorAll('tbody tr[data-key]').length, stamp: !!card.querySelector('p.readstamp[data-read-at]') } : null;
    });
    rec('the Running here panel reads the container runtime, is ok, and lists the containers named for the app',
      !!runningState && runningState.state === 'ok' && !!runningRows && runningRows.stamp && runningRows.rows === want.length,
      JSON.stringify(runningState) + ' rows=' + (runningRows && runningRows.rows) + ' want=' + want.length);
  } else {
    rec('the Running here panel is in the not-configured state, offers no retry and shows no container',
      !!runningState && runningState.state === 'notConfigured' && runningState.reason === containers.reason && !runningState.retry
        && /not configured/.test(containers.message || '') && !/running/.test(running.replace('Running here', '')),
      JSON.stringify(runningState) + ' ' + running.replace(/\s+/g, ' ').slice(0, 100));
  }

  const outsideDetail = await textOutsideNotices(page);
  const leakedDetail = FIXTURE_ONLY.filter((s) => outsideDetail.indexOf(s) !== -1);
  rec('no fixture-only value appears on the live detail', leakedDetail.length === 0 && !/p95|Error budget|SLO this month/.test(outsideDetail), leakedDetail.join(', '));
  rec('every panel on the live detail that answered carries the time it was read',
    detail.stamps >= 7 && detail.stamps === detail.okPanels && detail.errors === 0,
    detail.stamps + ' stamps on ' + detail.okPanels + ' answered panels, ' + detail.errors + ' error states');
  rec('every table on the live detail has a caption naming orders', detail.captions.length >= 3 && detail.captions.every((c) => /orders/.test(c)), detail.captions.join(' | '));

  await ctx.goto(page, 'apps/nope');
  await settled(ctx);
  const missing = await page.evaluate(() => {
    const nf = document.querySelector('#main .notfound');
    return {
      state: nf ? nf.getAttribute('data-state') : null,
      reason: nf ? nf.getAttribute('data-reason') : null,
      h1: (document.querySelector('#main h1') || {}).textContent || '',
      h1s: document.querySelectorAll('#main h1').length,
      back: nf && nf.querySelector('a[href]') ? nf.querySelector('a[href]').getAttribute('href') : null,
      text: document.getElementById('main').textContent,
      panels: document.querySelectorAll('#main .card').length,
      retry: [...document.querySelectorAll('#main button')].filter((b) => /Try again/.test(b.textContent)).length
    };
  });
  rec('an application the repository does not declare gets the shared not-found state and no panels',
    missing.state === 'notFound' && missing.reason === 'unknown-id' && missing.h1 === 'No such application' && missing.h1s === 1
      && /nope/.test(missing.text) && missing.panels === 0 && missing.retry === 0 && /#\/apps$/.test(String(missing.back)),
    JSON.stringify({ state: missing.state, h1: missing.h1, h1s: missing.h1s, panels: missing.panels, back: missing.back }));

  await ctx.goto(page, 'apps/orders/logs');
  await settled(ctx);
  rec('the fixture-era deep link apps/orders/logs still resolves to the live detail of orders',
    await page.evaluate(() => window.ARGUS.state.route === 'apps' && window.ARGUS.state.rest[0] === 'orders' && document.querySelectorAll('#main .logview').length === 0 && document.querySelectorAll('#main [data-not-in-stack-item]').length === 4));

  const ENVS = '**/api/gitops/environments*';
  await page.route(ENVS, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, reason: 'unreachable', message: 'The GitOps reader did not answer (injected by the live suite).' })
  }));
  await page.evaluate(() => { window.ARGUS.forget(); });
  await ctx.goto(page, 'overview');
  await ctx.goto(page, 'apps/orders');
  await settled(ctx);
  const fault = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#main .card')].find((c) => ((c.querySelector('.card-title') || {}).textContent || '') === 'Declared versions');
    const body = card ? card.querySelector('.livepanel') : null;
    return {
      state: body ? body.getAttribute('data-state') : null,
      reason: body ? body.getAttribute('data-reason') : null,
      retry: body ? [...body.querySelectorAll('button')].some((b) => /Try again/.test(b.textContent)) : false,
      stamp: body ? !!body.querySelector('p.readstamp') : null,
      others: [...document.querySelectorAll('#main .livepanel[data-state="ok"]')].length
    };
  });
  await page.unroute(ENVS);
  await page.evaluate(() => { window.ARGUS.forget(); });
  rec('a reader that does not answer puts only its own panel in the unreachable state, with a retry and no read stamp',
    fault.state === 'unreachable' && fault.reason === 'unreachable' && fault.retry && fault.stamp === false && fault.others >= 6,
    JSON.stringify(fault));
};
