'use strict';

module.exports = async function compute(ctx) {
  const { page, rec, goto, waitFor } = ctx;

  const settle = async () => {
    await waitFor(page, () => {
      const main = document.getElementById('main');
      return main && !main.querySelector('.skel') && !main.querySelector('[data-state="loading"]') && main.textContent.length > 60;
    }, null, 8000);
    await page.waitForTimeout(120);
  };
  const open = async (route) => { await goto(page, route); await settle(); };
  const mainText = () => page.evaluate(() => document.getElementById('main').textContent);
  const panels = () => page.evaluate(() => Array.from(document.querySelectorAll('#main .livepanel')).map((p) => ({
    path: p.getAttribute('data-path'), state: p.getAttribute('data-state'), reason: p.getAttribute('data-reason')
  })));
  const notFound = () => page.evaluate(() => {
    const n = document.querySelector('#main .notfound');
    return n ? { state: n.getAttribute('data-state'), reason: n.getAttribute('data-reason'), h1: (n.querySelector('h1') || {}).textContent, retry: Array.from(document.querySelectorAll('#main button')).some((b) => /Try again/.test(b.textContent)), h1s: document.querySelectorAll('#main h1').length } : null;
  });

  const host = await page.evaluate(async () => (await window.ARGUS.read('/api/host', { ttlMs: 0 })).data);

  await open('compute');
  let text = await mainText();
  let p = await panels();

  rec('hosts tab shows the hostname /api/host returns', text.indexOf(host.hostname) !== -1, host.hostname);
  rec('hosts tab shows the core count /api/host returns',
    await page.evaluate((cores) => {
      const rows = Array.from(document.querySelectorAll('#main table tbody tr'));
      return rows.some((r) => Array.from(r.children).some((c) => c.textContent.trim() === String(cores)));
    }, host.cpu.cores), String(host.cpu.cores) + ' cores');
  rec('hosts tab lists exactly one host row',
    (await page.evaluate(() => document.querySelectorAll('#main table tbody tr').length)) === 1);
  rec('the hosts panel is a live panel in the ok state', p.some((x) => x.path === '/api/host' && x.state === 'ok'), JSON.stringify(p));
  rec('the hosts tab defers CPU, memory and history to the System screen',
    await page.evaluate(() => Array.from(document.querySelectorAll('#main a')).some((a) => /#\/system$/.test(a.getAttribute('href') || ''))) &&
      !p.some((x) => /\/api\/metrics\/series/.test(x.path || '')) && !/CPU busy|Memory used/.test(text),
    JSON.stringify(p.map((x) => x.path)));
  rec('the hosts tab marks patching and Storage Spaces Direct as not in this stack',
    (await page.evaluate(() => document.querySelectorAll('#main [data-not-in-stack]').length)) === 1);

  const fixtures = ['hv-01', 'hv-02', 'hv-03', 'gpu-01', 'sql-01', 'siem-01'];

  await page.click('[role="tab"]:has-text("Instances")');
  await settle();
  p = await panels();
  const inst = p.filter((x) => /^\/api\/containers/.test(x.path || ''));
  rec('the instances panel reads the batched summary route, once',
    inst.length === 1 && inst[0].path === '/api/containers/summary', JSON.stringify(inst));
  const summary = await page.evaluate(async () => {
    const env = await window.ARGUS.read('/api/containers/summary');
    return { state: window.ARGUS.envelopeState(env), count: env.ok && env.data && Array.isArray(env.data.containers) ? env.data.containers.length : null };
  });
  if (summary.state === 'ok') {
    const drawn = await page.evaluate(() => {
      const n = document.querySelector('#main .livepanel[data-path="/api/containers/summary"]');
      return n ? { rows: n.querySelectorAll('tbody tr[data-key]').length, stamp: !!n.querySelector('p.readstamp[data-read-at]') } : null;
    });
    rec('the instances panel is ok and lists every container the summary returns, with its read stamp',
      inst.length === 1 && inst[0].state === 'ok' && !!drawn && drawn.stamp && drawn.rows === summary.count, JSON.stringify({ inst, drawn, summary }));
    rec('the instances list is read once, with no per-row inspect',
      (await page.evaluate(() => document.querySelectorAll('#main .livepanel[data-path^="/api/containers/inspect"]').length)) === 0);
  } else {
    rec('the instances panel is in the notConfigured state without a socket proxy',
      inst.length === 1 && inst[0].state === 'notConfigured' && summary.state === 'notConfigured' && /socket proxy is not configured/.test(await mainText()), JSON.stringify(inst));
    rec('no instances table and no retry is drawn when the socket proxy is missing',
      (await page.evaluate(() => document.querySelectorAll('#main table').length === 0 && !Array.from(document.querySelectorAll('#main button')).some((b) => /Try again/.test(b.textContent)))));
  }

  await page.click('[role="tab"]:has-text("Service Fabric")');
  await page.waitForTimeout(100);
  const fabric = await page.evaluate(() => {
    const n = document.querySelector('#main [data-not-in-stack]');
    return n ? n.getAttribute('data-not-in-stack') : '';
  });
  rec('the Service Fabric panel is a not-in-stack callout', /Service Fabric/.test(fabric), fabric.slice(0, 60));

  await page.click('[role="tab"]:has-text("GPU")');
  await page.waitForTimeout(100);
  const gpu = await page.evaluate(() => {
    const n = document.querySelector('#main [data-not-in-stack]');
    return n ? n.getAttribute('data-not-in-stack') : '';
  });
  rec('the GPU panel is a not-in-stack callout', /GPU/.test(gpu), gpu.slice(0, 60));

  const everything = [];
  for (const tab of ['Hosts', 'Instances', 'Service Fabric', 'GPU']) {
    await page.click('[role="tab"]:has-text("' + tab + '")');
    await settle();
    everything.push(await mainText());
  }
  const joined = everything.join(' ');
  const leaked = fixtures.filter((f) => joined.indexOf(f) !== -1);
  rec('no fixture host or VM name appears on any tab', leaked.length === 0, leaked.join(', ') || 'none');
  rec('no action buttons for patch, drain or quarantine are rendered',
    !(await page.evaluate(() => /Patch now|Drain|Quarantine/.test(Array.from(document.querySelectorAll('#main button')).map((b) => b.textContent).join(' ')))));
  rec('no panel is in a failed, unreachable or timeout state',
    (await page.evaluate(() => document.querySelectorAll('#main [data-state="failed"],#main [data-state="unreachable"],#main [data-state="timeout"]').length)) === 0);

  await open('compute/host/hv-03');
  let nf = await notFound();
  rec('compute/host/hv-03 renders the one not-found block with no retry',
    !!nf && nf.state === 'notFound' && nf.reason === 'unknown-id' && nf.h1 === 'No such host' && !nf.retry && nf.h1s === 1, JSON.stringify(nf));
  text = await mainText();
  rec('compute/host/hv-03 shows no fixture figures', !/hv-01|hv-02|S2D health|WDAC mode|Patch age/.test(text) && !/Patch now/.test(text));

  await open('compute/host/' + encodeURIComponent(host.hostname));
  text = await mainText();
  rec('compute/host/<this host> resolves and links to System for its telemetry',
    text.indexOf(host.hostname) !== -1 && !(await notFound()) &&
      (await page.evaluate(() => Array.from(document.querySelectorAll('#main a')).some((a) => /#\/system$/.test(a.getAttribute('href') || '')))), host.hostname);
  rec('the host detail marks drain, patch and quarantine as not in this stack',
    (await page.evaluate(() => document.querySelectorAll('#main [data-not-in-stack]').length)) >= 1);

  await open('compute/vm/sql-01');
  p = await panels();
  text = await mainText();
  if (summary.state === 'ok') {
    nf = await notFound();
    rec('compute/vm/sql-01 in live mode, where the runtime has no such container, shows the not-found block, not the fixture VM',
      !!nf && nf.state === 'notFound' && nf.h1 === 'No such container' && !nf.retry && !/Windows Server|hv-0|Site B/.test(text), JSON.stringify(nf || p));
  } else {
    rec('compute/vm/sql-01 in live mode shows the not-configured state, not the fixture VM',
      p.some((x) => /^\/api\/containers\/inspect/.test(x.path) && x.state === 'notConfigured') && !/Windows Server|hv-0|Site B/.test(text), JSON.stringify(p));
  }

  const notFoundBody = JSON.stringify({ ok: false, reason: 'not-found', message: 'the Docker socket proxy has no such resource.' });
  await page.route('**/api/containers/inspect?id=nope*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: notFoundBody }));
  await page.route('**/api/containers/stats?id=nope*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: notFoundBody }));
  await page.evaluate(() => window.ARGUS.forget());
  await open('compute/vm/nope');
  nf = await notFound();
  rec('compute/vm/nope with a definitive not-found answer renders the not-found block, no raw JSON and no retry',
    !!nf && nf.h1 === 'No such container' && !nf.retry && nf.h1s === 1 && !/"reason"|\{"/.test(await mainText()), JSON.stringify(nf));
  await page.unroute('**/api/containers/inspect?id=nope*');
  await page.unroute('**/api/containers/stats?id=nope*');

  await page.route('**/api/host', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'unreachable', message: 'The host reader did not answer.' }) }));
  await page.evaluate(() => window.ARGUS.forget());
  await open('compute/hosts');
  p = await panels();
  const fault = p.filter((x) => x.path === '/api/host')[0];
  const retry = await page.evaluate(() => Array.from(document.querySelectorAll('#main .livepanel[data-path="/api/host"] button')).some((b) => /Try again/.test(b.textContent)));
  rec('a host reader fault renders the unreachable state with a retry', !!fault && fault.state === 'unreachable' && fault.reason === 'unreachable' && retry, JSON.stringify(fault));
  await page.unroute('**/api/host');
  await page.evaluate(() => window.ARGUS.forget());
};
