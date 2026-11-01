'use strict';

module.exports = async function compute(ctx) {
  const { page, rec, goto, waitFor } = ctx;

  const settled = (route) => async () => {
    await goto(page, route);
    await waitFor(page, () => {
      const main = document.getElementById('main');
      return main && !main.querySelector('.skel') && main.textContent.length > 120;
    }, null, 8000);
    await page.waitForTimeout(150);
  };
  const mainText = () => page.evaluate(() => document.getElementById('main').textContent);

  const host = await page.evaluate(async () => (await window.ARGUS.read('/api/host', { ttlMs: 0 })).data);

  await settled('compute')();
  let text = await mainText();

  rec('hosts tab shows the hostname /api/host returns', text.indexOf(host.hostname) !== -1, host.hostname);
  rec('hosts tab shows the core count /api/host returns',
    await page.evaluate((cores) => {
      const rows = Array.from(document.querySelectorAll('#main table tbody tr'));
      return rows.some((r) => Array.from(r.children).some((c) => c.textContent.trim() === String(cores)));
    }, host.cpu.cores), String(host.cpu.cores) + ' cores');
  rec('hosts tab lists exactly one host row',
    (await page.evaluate(() => document.querySelectorAll('#main table tbody tr').length)) === 1);

  const series = await page.evaluate(() => Array.from(document.querySelectorAll('#main .card')).filter((c) => /Host CPU busy|Host memory used/.test(c.textContent)).map((c) => c.textContent));
  rec('the series tiles show the not-configured state for Prometheus',
    series.length === 2 && series.every((t) => /Prometheus is not configured/.test(t)), series.length + ' tiles');

  rec('the hosts tab marks patching and Storage Spaces Direct as not in this stack',
    (await page.evaluate(() => document.querySelectorAll('#main [data-not-in-stack]').length)) >= 1);

  const fixtures = ['hv-01', 'hv-02', 'hv-03', 'gpu-01', 'sql-01', 'siem-01'];

  await page.click('[role="tab"]:has-text("Instances")');
  await waitFor(page, () => !document.querySelector('#main .skel'), null, 8000);
  await page.waitForTimeout(150);
  text = await mainText();
  rec('the instances panel says containers are not configured in the harness',
    /Containers are not configured/.test(text) && /socket proxy is not reachable/.test(text));
  rec('no instances table is drawn when the socket proxy is missing',
    (await page.evaluate(() => document.querySelectorAll('#main table').length)) === 0);

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
    await waitFor(page, () => !document.querySelector('#main .skel'), null, 8000);
    await page.waitForTimeout(100);
    everything.push(await mainText());
  }
  const joined = everything.join(' ');
  const leaked = fixtures.filter((f) => joined.indexOf(f) !== -1);
  rec('no fixture host or VM name appears on any tab', leaked.length === 0, leaked.join(', ') || 'none');
  rec('no action buttons for patch, drain or quarantine are rendered',
    !(await page.evaluate(() => /Patch now|Drain|Quarantine/.test(Array.from(document.querySelectorAll('#main button')).map((b) => b.textContent).join(' ')))));
  rec('no panel is in an error state', (await page.evaluate(() => document.querySelectorAll('#main .empty.is-error').length)) === 0);

  await settled('compute/host/hv-03')();
  text = await mainText();
  rec('compute/host/hv-03 says there is no such host', /No such host in this stack/.test(text));
  rec('compute/host/hv-03 shows no fixture figures', !/hv-01|hv-02|S2D health|WDAC mode|Patch age/.test(text) && !/Patch now/.test(text));

  await settled('compute/host/' + encodeURIComponent(host.hostname))();
  text = await mainText();
  rec('compute/host/<this host> resolves and shows its volumes',
    text.indexOf(host.hostname) !== -1 && /Volumes/.test(text) && !/No such host/.test(text), host.hostname);
  rec('the host detail marks drain, patch and quarantine as not in this stack',
    (await page.evaluate(() => document.querySelectorAll('#main [data-not-in-stack]').length)) >= 1);

  await settled('compute/vm/sql-01')();
  text = await mainText();
  rec('compute/vm/sql-01 in live mode shows the not-configured state, not the fixture VM',
    /Containers are not configured/.test(text) && !/Windows Server|hv-0|Site B/.test(text));
};
