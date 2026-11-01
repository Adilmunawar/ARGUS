'use strict';

const FIXTURE_ONLY = ['AGIS', 'agis.zaraatdost.pk', 'Farmer Loan API', 'Mills Dashboard', 'sf-04'];

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
  rec('the API answers the three reads the screen makes, read through the signed-in store', !!(apps && apps.ok && envs && envs.ok && containers && containers.ok === false),
    JSON.stringify({ apps: apps && apps.count, envs: envs && envs.count, containers: containers && containers.reason }));

  await ctx.goto(page, 'apps');
  await settled(ctx);

  const expectedNames = (apps.apps || []).map((a) => a.name).sort();
  const rowKeys = await page.evaluate(() => [...document.querySelectorAll('#main tbody tr[data-key]')].map((r) => r.dataset.key).sort());
  rec('the live list has exactly the applications /api/gitops/apps declares',
    rowKeys.join(',') === expectedNames.join(',') && expectedNames.indexOf('mills') !== -1 && expectedNames.indexOf('agis') === -1,
    'page ' + rowKeys.join(',') + ' / api ' + expectedNames.join(','));

  const mills = (apps.apps || []).find((a) => a.name === 'mills');
  const prod = (envs.environments || []).find((e) => e.name === 'production');
  const millsVersion = prod && (prod.apps || []).find((a) => a.app === 'mills');
  const millsCells = await page.evaluate(() => {
    const tr = document.querySelector('#main tbody tr[data-key="mills"]');
    return tr ? [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()) : [];
  });
  const millsRow = millsCells.join(' | ');
  rec('the mills row shows the declared instances and service count from the spec',
    !!mills && millsCells.indexOf(String(mills.instances)) !== -1 && millsCells.indexOf(String(mills.services.length)) !== -1,
    'instances ' + (mills && mills.instances) + ', services ' + (mills && mills.services.length) + ': ' + millsRow.slice(0, 140));
  rec('the mills row shows the production version from the environments answer',
    !!millsVersion && !!millsVersion.version && millsCells.indexOf(millsVersion.version) !== -1,
    'version ' + (millsVersion && millsVersion.version) + ': ' + millsRow.slice(0, 140));
  rec('the mills row shows the ingress host and the secret reference count',
    !!mills && millsCells.indexOf(mills.ingress.host) !== -1 && millsCells.indexOf(String(mills.secretRefs.length)) !== -1,
    (mills && mills.ingress.host) + ', ' + (mills && mills.secretRefs.length) + ' refs: ' + millsRow.slice(0, 140));

  const listText = await mainText(page);
  const consoleProblem = (apps.problems || []).find((p) => p.directory === 'console');
  rec('the problems list names the console directory, which has a README but no spec',
    !!consoleProblem && /console\s+has no app\.yaml/.test(listText.replace(/\s+/g, ' ')),
    consoleProblem ? consoleProblem.message : 'no console problem in the API answer');
  rec('the list says when it was read and that no reconciler has applied the declarations',
    /Read at \d{4}-\d{2}-\d{2}/.test(listText) && /No reconciler runs in this stack/.test(listText),
    listText.match(/Read at [^.]+/) ? listText.match(/Read at [^.]+/)[0] : 'no stamp');

  const outsideList = await textOutsideNotices(page);
  const leakedList = FIXTURE_ONLY.filter((s) => outsideList.indexOf(s) !== -1);
  rec('no fixture-only application, host or node name appears on the live list', leakedList.length === 0, leakedList.join(', '));
  rec('the live list has no drift card, Promote button or Restart action from the fixture',
    await page.evaluate(() => ![...document.querySelectorAll('#main button')].some((b) => /^(Promote |Restart)/.test(b.textContent)) && !/Staging and production agree/.test(document.getElementById('main').textContent)));
  rec('the live list rendered without an error state',
    await page.evaluate(() => document.querySelectorAll('#main .empty.is-error').length === 0));

  const filtered = await page.evaluate(async () => {
    const inp = document.querySelector('#main .pf-input');
    const field = document.querySelector('#main .pf-field');
    if (!inp || !field) return { why: 'no property filter' };
    field.value = 'owner';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    inp.value = 'zayan';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    return { rows: [...document.querySelectorAll('#main tbody tr[data-key]')].map((r) => r.dataset.key).sort().join(','), hash: location.hash };
  });
  const zayan = (apps.apps || []).filter((a) => /zayan/.test(String(a.owner))).map((a) => a.name).sort().join(',');
  rec('the property filter narrows the live rows by the owner the spec declares', filtered.rows === zayan && /f=/.test(filtered.hash), JSON.stringify(filtered));

  await ctx.goto(page, 'apps/mills');
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
    notInStack: [...document.querySelectorAll('#main [data-not-in-stack]')].map((n) => n.getAttribute('data-not-in-stack')),
    errors: document.querySelectorAll('#main .empty.is-error').length,
    captions: [...document.querySelectorAll('#main caption')].map((c) => c.textContent)
  }));
  rec('the deep link apps/mills resolves to the live detail of mills',
    detail.route === 'apps' && detail.rest === 'mills' && detail.h1 === 'mills' && /mills/.test(detail.crumb), JSON.stringify({ h1: detail.h1, crumb: detail.crumb }));

  const serviceNames = mills ? mills.services.map((s) => s.name) : [];
  const serviceExes = mills ? mills.services.map((s) => s.exe) : [];
  rec('the detail lists every service from the spec with its executable',
    serviceNames.length > 0 && serviceNames.every((n) => detailText.indexOf(n) !== -1) && serviceExes.every((x) => detailText.indexOf(x) !== -1),
    serviceNames.join(', '));
  rec('the detail shows the package bucket, key, signature and identity from the spec',
    !!mills && [mills.package.bucket, mills.package.key, mills.package.signature, mills.identity].every((v) => detailText.indexOf(v) !== -1),
    mills ? mills.package.key + ' ' + mills.identity : '');
  rec('the detail shows the ingress host, probe path and egress allow-list',
    !!mills && [mills.ingress.host, mills.health.path].concat(mills.egress).every((v) => detailText.indexOf(v) !== -1),
    mills ? mills.health.path + ' ' + mills.egress.join(' ') : '');

  const refs = mills ? mills.secretRefs : [];
  rec('the detail lists every secret reference path and never a value or fragment',
    refs.length > 0 && refs.every((p) => detailText.indexOf(p) !== -1) && detailText.indexOf('#value') === -1 && !/openbao:/.test(detailText),
    refs.join(', '));

  const rules = mills ? mills.alertRules : [];
  const sevs = rules.map((r) => r.severity).filter(Boolean);
  rec('the detail lists the alert rules with their severity',
    rules.length > 0 && rules.every((r) => detailText.indexOf(r.name) !== -1) && sevs.every((s) => detailText.indexOf(s) !== -1),
    rules.map((r) => r.name + ':' + r.severity).join(', '));

  rec('the detail shows the declared version per environment from the environments answer',
    !!millsVersion && detailText.indexOf(millsVersion.version) !== -1 && /production/.test(detailText) && detail.heads.indexOf('Declared versions') !== -1,
    millsVersion ? millsVersion.version : 'none');

  rec('instances, metrics, deploy history and restart are not-in-stack callouts, not fixture tabs',
    detail.tabs === 0 && detail.notInStack.length === 4 && detail.notInStack.every((w) => /mills/.test(w))
      && /instances/i.test(detail.notInStack[0]) && /metrics/i.test(detail.notInStack[1]) && /Deployment history/i.test(detail.notInStack[2]) && /Restarting/i.test(detail.notInStack[3]),
    JSON.stringify(detail.notInStack));
  rec('the live detail offers no Deploy or Restart action, since nothing here could receive it',
    detail.headActions.length === 0 && !/Open pull request|Roll back to this/.test(detailText), JSON.stringify(detail.headActions));

  const running = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#main .card')].find((c) => /^Running here/.test((c.querySelector('.card-title') || {}).textContent || ''));
    return card ? card.textContent : '';
  });
  rec('the Running here panel says the container runtime is not configured and shows no container',
    /Container runtime not configured/.test(running) && /not configured/.test(containers.message || '') && !/running/.test(running.replace('Running here', '')),
    running.replace(/\s+/g, ' ').slice(0, 120));

  const outsideDetail = await textOutsideNotices(page);
  const leakedDetail = FIXTURE_ONLY.filter((s) => outsideDetail.indexOf(s) !== -1);
  rec('no fixture-only value appears on the live detail', leakedDetail.length === 0 && !/p95|Error budget|SLO this month/.test(outsideDetail), leakedDetail.join(', '));
  rec('every panel on the live detail carries the time it was read',
    (detailText.match(/Read at \d{4}-\d{2}-\d{2}/g) || []).length >= 7 && detail.errors === 0,
    (detailText.match(/Read at \d{4}-\d{2}-\d{2}/g) || []).length + ' stamps, ' + detail.errors + ' error states');
  rec('every table on the live detail has a caption naming mills', detail.captions.length >= 3 && detail.captions.every((c) => /mills/.test(c)), detail.captions.join(' | '));

  await ctx.goto(page, 'apps/not-an-app');
  await settled(ctx);
  const missing = await page.evaluate(() => ({
    text: document.getElementById('main').textContent,
    panels: document.querySelectorAll('#main .card').length,
    errors: document.querySelectorAll('#main .empty.is-error').length
  }));
  rec('an application the repository does not declare gets one plain empty state and no panels',
    /No such application/.test(missing.text) && /not-an-app/.test(missing.text) && missing.panels === 0 && missing.errors === 0,
    JSON.stringify({ panels: missing.panels, errors: missing.errors }));

  await ctx.goto(page, 'apps/mills/logs');
  await settled(ctx);
  rec('the fixture-era deep link apps/mills/logs still resolves to the live detail of mills',
    await page.evaluate(() => window.ARGUS.state.route === 'apps' && window.ARGUS.state.rest[0] === 'mills' && document.querySelectorAll('#main .logview').length === 0 && document.querySelectorAll('#main [data-not-in-stack]').length === 4));
};
