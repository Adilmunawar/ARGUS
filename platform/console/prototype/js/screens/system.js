(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    document.addEventListener('DOMContentLoaded', function () { A.screen(id, def); });
  }

  function bytes(n) {
    if (n === null || n === undefined) return '-';
    var gb = n / 1073741824;
    if (gb >= 1024) return fmt.num(gb / 1024, 2) + ' TB';
    if (gb >= 1) return fmt.num(gb, 1) + ' GB';
    return fmt.num(n / 1048576, 0) + ' MB';
  }

  function ratioTone(r) { return r >= 0.9 ? 'bad' : r >= 0.75 ? 'warn' : null; }

  function livePanel(title, path, render, opts) {
    opts = opts || {};
    var body = el('div');
    var card = ui.card(title, body);
    var alive = true;
    A.onLeave(function () { alive = false; });

    ui.clear(body);
    body.appendChild(el('div.skel', [
      el('div.skel-row', { style: { width: '70%' } }),
      el('div.skel-row', { style: { width: '45%' } }),
      el('div.skel-row', { style: { width: '60%' } })
    ]));

    A.read(path, opts).then(function (env) {
      if (!alive) return;
      ui.clear(body);

      if (env.mode === A.MODE.SAMPLE) {
        body.appendChild(ui.emptyState(
          'Not available on sample data',
          'This panel reads the machine and the cloud account through the console API. Start it with `npm start` in platform/console/server and reload.'));
        return;
      }
      if (!env.ok) {
        var e = env.error || {};
        body.appendChild(ui.errorState(
          opts.errorTitle || 'This could not be read',
          e.message || 'The request failed.',
          function () { A.forget(path); A.go(A.state.route); }));
        return;
      }

      if (env.stale) {
        body.appendChild(el('div.callout.warn', [
          el('strong', { text: 'Showing the last value that could be read.' }),
          el('p', {
            text: 'A fresh read failed' + (env.error && env.error.message ? ': ' + env.error.message : '.') +
              ' The figures below are from ' + new Date(env.at).toISOString().replace('T', ' ').slice(0, 19) + 'Z.'
          })
        ]));
      }

      render(body, env.data, env);
    });

    return card;
  }

  function renderHost(body, h) {
    body.appendChild(el('div.tiles', [
      ui.statTile('CPU', fmt.pct(h.cpu.usageRatio * 100, 1), {
        note: fmt.num(h.cpu.cores) + ' cores, sampled over ' + fmt.num(h.cpu.sampledOverMs) + ' ms'
      }),
      ui.statTile('Memory', fmt.pct(h.memory.usageRatio * 100, 0), {
        note: bytes(h.memory.usedBytes) + ' of ' + bytes(h.memory.totalBytes)
      }),
      ui.statTile('Uptime', fmt.dur(h.uptimeSeconds), { note: 'Booted ' + h.bootedAt.slice(0, 16).replace('T', ' ') + 'Z' }),
      ui.statTile('Console process', fmt.dur(h.process.uptimeSeconds), {
        note: 'Node ' + h.process.nodeVersion + ', ' + bytes(h.process.rssBytes) + ' resident'
      })
    ]));

    body.appendChild(ui.dl([
      ['Hostname', el('code.mono', { text: h.hostname })],
      ['Platform', h.platform + ' ' + h.release + ' (' + h.arch + ')'],
      ['CPU', h.cpu.model]
    ]));

    body.appendChild(el('div.sectiontitle', { text: 'Volumes' }));
    body.appendChild(ui.table([
      { key: 'mount', label: 'Mount', render: function (d) { return el('code.mono', { text: d.mount }); } },
      {
        key: 'usageRatio', label: 'Used', align: 'right',
        render: function (d) {
          if (d.error) return ui.pill(d.error, 'idle');
          return el('div.row', [
            ui.bar(d.usageRatio, {
              tone: ratioTone(d.usageRatio),
              label: d.mount + ' is ' + fmt.pct(d.usageRatio * 100, 0) + ' full'
            }),
            el('span.num', { text: fmt.pct(d.usageRatio * 100, 0) })
          ]);
        }
      },
      { key: 'usedBytes', label: 'Used', align: 'right', render: function (d) { return d.error ? '-' : bytes(d.usedBytes); } },
      { key: 'freeBytes', label: 'Free', align: 'right', render: function (d) { return d.error ? '-' : bytes(d.freeBytes); } },
      { key: 'totalBytes', label: 'Size', align: 'right', render: function (d) { return d.error ? '-' : bytes(d.totalBytes); } }
    ], h.disks, {
      caption: 'Volumes on this host, with used, free and total capacity',
      sortKey: 'mount',
      rowKey: function (d) { return d.mount; },
      empty: 'No volume could be read on this host.'
    }));

    body.appendChild(el('div.sectiontitle', { text: 'Network interfaces' }));
    body.appendChild(ui.table([
      { key: 'interface', label: 'Interface' },
      { key: 'family', label: 'Family' },
      { key: 'address', label: 'Address', render: function (n) { return el('code.mono', { text: n.address }); } }
    ], h.network, {
      caption: 'Non-loopback network interfaces on this host',
      sortKey: 'interface',
      empty: 'This host has no non-loopback interface.'
    }));
  }

  function renderAws(body, d) {
    if (!d.ok) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'This console is not connected to AWS.' }),
        el('p', { text: d.message || 'No reason was given.' })
      ]));
      return;
    }
    body.appendChild(ui.dl([
      ['Account', el('code.mono', { text: d.account })],
      ['Region', el('code.mono', { text: d.region })],
      ['Signed in as', el('code.mono', { text: d.arn })]
    ]));
  }

  function countPanel(body, d, key, noun) {
    if (!d.ok) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Unavailable' }),
        el('p', { text: d.message || 'No reason was given.' })
      ]));
      return;
    }
    var rows = d[key] || [];
    if (!rows.length) {
      body.appendChild(ui.emptyState('No ' + noun,
        'This account has no ' + noun + ' in this region. That is a real answer, not a failure to load.'));
      return;
    }
    body.appendChild(el('p.hint', { text: fmt.num(rows.length) + ' ' + noun + ' in this region.' }));
  }

  var SERIES = [
    { name: 'hostCpuBusyRatio', title: 'Host CPU busy', reading: 'busy now' },
    { name: 'hostMemoryUsedRatio', title: 'Host memory used', reading: 'used now' },
    { name: 'pgConnectionsUsedRatio', title: 'PostgreSQL connections used', reading: 'of max_connections' },
    { name: 'cacheHitRatio', title: 'Cache hit ratio', reading: 'hits now' }
  ];

  var SERIES_WINDOW = '6h';
  var SERIES_POINTS = 220;

  function renderSeries(spec) {
    return function (body, payload) {
      if (!payload || payload.ok === false) {
        body.appendChild(el('div.callout.warn', [
          el('strong', { text: 'This series could not be read.' }),
          el('p', { text: (payload && payload.message) || 'The metrics reader gave no reason.' })
        ]));
        return;
      }

      var values = A.seriesValues(payload);
      var present = values.filter(function (v) { return v !== null; });

      if (!present.length) {
        body.appendChild(ui.emptyState(
          'No sample in this window',
          'Prometheus answered and had nothing to return for the last ' + SERIES_WINDOW +
            '. That is a real answer: the target may not have been scraped yet.'));
        return;
      }

      var latest = present[present.length - 1];
      body.appendChild(el('div.row', [
        el('span.num', { text: fmt.ratioPct(latest, 1) }),
        el('span.muted', { text: spec.reading }),
        el('span.spacer'),
        ui.sparkline(values, {
          min: 0, max: 1, width: 220, height: 34,
          label: spec.title + ' over the last ' + SERIES_WINDOW + ', on a fixed zero to one hundred per cent scale, ' +
            'now ' + fmt.ratioPct(latest, 1)
        })
      ]));

      var missing = values.length - present.length;
      body.appendChild(el('p.hint', {
        text: fmt.num(values.length) + ' samples over the last ' + SERIES_WINDOW + '.' +
          (missing
            ? ' ' + fmt.num(missing) + ' of them were not scraped, so the line is broken there rather than drawn through the gap.'
            : ' Every point in the window was scraped.')
      }));
    };
  }

  function seriesPanel(spec) {
    return livePanel(spec.title,
      '/api/metrics/series?name=' + encodeURIComponent(spec.name) +
        '&window=' + encodeURIComponent(SERIES_WINDOW) + '&points=' + SERIES_POINTS,
      renderSeries(spec),
      { ttlMs: 15000, errorTitle: spec.title + ' could not be read' });
  }

  registerScreen('system', {
    title: 'System',
    crumb: 'System',
    render: function (mount) {
      var alive = true;
      var body = el('div');

      function repaint() {
        body.textContent = '';
        A.probe().then(function () { if (alive) build(body); });
      }

      mount.appendChild(ui.pageHeader(
        'System',
        'The machine this console runs on, and the cloud account it can see. Everything here is read live.',
        [ui.btn('Refresh', {
          onClick: function () {
            A.forget();
            repaint();
            if (A.storeMode() !== A.MODE.LIVE) {
              A.flash('info', 'There is nothing to re-read',
                'The console API is not answering, so this screen has no source to refresh from.');
            }
          }
        })]));

      mount.appendChild(body);
      A.onLeave(function () { alive = false; });
      repaint();
    }
  });

  function build(mount) {
      var mode = A.storeMode();

      if (mode !== A.MODE.LIVE) {
        mount.appendChild(el('div.callout.warn', [
          el('strong', { text: 'The console API is not running, so this screen has nothing to read.' }),
          el('p', {
            text: 'Every other screen is showing bundled sample data. Start the API with `npm start` in ' +
              'platform/console/server and reload to see this machine and your AWS account.'
          })
        ]));
        return;
      }

      var caps = A.capabilities() || {};
      mount.appendChild(el('div.callout.info', [
        el('strong', { text: 'Live data.' }),
        el('p', {
          text: 'Region ' + (caps.region || 'unknown') + '. ' +
            (caps.writesAllowed
              ? 'This console is permitted to make changes.'
              : 'This console is read-only: it will refuse any request that changes anything.') +
            (caps.aws && caps.aws.connected
              ? ' Connected to AWS account ' + caps.aws.account + '.'
              : ' Not connected to AWS.')
        })
      ]));

      mount.appendChild(el('div.grid.grid-2', [
        livePanel('AWS account', '/api/aws/identity', renderAws, { errorTitle: 'The AWS identity could not be read' }),
        livePanel('EC2 instances', '/api/aws/instances', function (b, d) { countPanel(b, d, 'instances', 'instances'); })
      ]));

      mount.appendChild(el('div.grid.grid-2', [
        livePanel('S3 buckets', '/api/aws/buckets', function (b, d) { countPanel(b, d, 'buckets', 'buckets'); }),
        livePanel('RDS databases', '/api/aws/databases', function (b, d) { countPanel(b, d, 'databases', 'databases'); })
      ]));

      mount.appendChild(el('div.grid.grid-2', [seriesPanel(SERIES[0]), seriesPanel(SERIES[1])]));
      mount.appendChild(el('div.grid.grid-2', [seriesPanel(SERIES[2]), seriesPanel(SERIES[3])]));

      mount.appendChild(livePanel('This host', '/api/host', renderHost, {
        ttlMs: 2000,
        errorTitle: 'Host telemetry could not be read'
      }));
  }
})();
