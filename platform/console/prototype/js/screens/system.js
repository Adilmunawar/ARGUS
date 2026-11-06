(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  function ratioTone(r) { return r >= 0.9 ? 'bad' : r >= 0.75 ? 'warn' : null; }

  function sampleWindow(ms) {
    if (ms === null || ms === undefined || !isFinite(Number(ms)) || Number(ms) <= 0) return 'now';
    var s = Number(ms) / 1000;
    return 'now, ' + (s < 10 ? fmt.num(s, 1) : fmt.num(Math.round(s))) + ' s sample';
  }

  function renderHost(body, h) {
    var cpu = h.cpu || {};
    var mem = h.memory || {};
    var proc = h.process || {};
    body.appendChild(el('div.tiles', [
      ui.statTile('CPU', fmt.pct(cpu.usageRatio * 100, 1), {
        note: sampleWindow(cpu.sampledOverMs) + ', ' + fmt.num(cpu.cores) + ' cores'
      }),
      ui.statTile('Memory', fmt.pct(mem.usageRatio * 100, 0), {
        note: 'now, ' + fmt.bytes(mem.usedBytes) + ' of ' + fmt.bytes(mem.totalBytes)
      }),
      ui.statTile('Uptime', fmt.dur(h.uptimeSeconds), {
        note: h.bootedAt ? 'booted ' + String(h.bootedAt).slice(0, 16).replace('T', ' ') + 'Z' : 'boot time not reported'
      }),
      ui.statTile('Console process', fmt.dur(proc.uptimeSeconds), {
        note: 'Node ' + (proc.nodeVersion || 'unknown') + ', ' + fmt.bytes(proc.rssBytes) + ' resident now'
      })
    ]));

    body.appendChild(ui.dl([
      ['Hostname', el('code.mono', { text: h.hostname })],
      ['Platform', h.platform + ' ' + h.release + ' (' + h.arch + ')'],
      ['CPU', cpu.model || 'unknown']
    ]));

    body.appendChild(el('div.sectiontitle', { text: 'Volumes, now' }));
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
      { key: 'usedBytes', label: 'Used', align: 'right', render: function (d) { return d.error ? '-' : fmt.bytes(d.usedBytes); } },
      { key: 'freeBytes', label: 'Free', align: 'right', render: function (d) { return d.error ? '-' : fmt.bytes(d.freeBytes); } },
      { key: 'totalBytes', label: 'Size', align: 'right', render: function (d) { return d.error ? '-' : fmt.bytes(d.totalBytes); } }
    ], h.disks || [], {
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
    ], h.network || [], {
      caption: 'Non-loopback network interfaces on this host',
      sortKey: 'interface',
      empty: 'This host has no non-loopback interface.'
    }));
  }

  function renderAws(body, d) {
    body.appendChild(ui.dl([
      ['Account', el('code.mono', { text: d.account || 'not reported' })],
      ['Region', el('code.mono', { text: d.region || 'not reported' })],
      ['Signed in as', el('code.mono', { text: d.arn || 'not reported' })]
    ]));
  }

  function awsExpired(body, env) {
    var e = (env && env.error) || {};
    if (e.reason !== 'expired') {
      body.appendChild(ui.stateBlock('signedOut', { reason: e.reason, detail: 'The console API answers only to a signed-in operator.' }));
      return;
    }
    body.setAttribute('data-state', 'failed');
    body.appendChild(ui.stateBlock('failed', {
      reason: 'expired',
      detail: 'The AWS credentials this console holds have expired. That is the cloud account, not your console session: renew the credentials on the console service.'
    }));
  }

  var AWS_OPTS = { on: { signedOut: awsExpired } };

  function countPanel(body, d, key, noun) {
    var rows = d[key] || [];
    if (!rows.length) {
      body.appendChild(ui.emptyState('No ' + noun, 'This account has no ' + noun + ' in this region.'));
      return;
    }
    body.appendChild(el('p', { text: fmt.num(rows.length) + ' ' + noun + ' in this region.' }));
  }

  var SERIES = [
    { name: 'hostCpuBusyRatio', title: 'Host CPU busy', basis: '5 min average' },
    { name: 'hostMemoryUsedRatio', title: 'Host memory used', basis: 'at the sample' },
    { name: 'pgConnectionsUsedRatio', title: 'PostgreSQL connections used', basis: 'of max_connections, at the sample' },
    { name: 'cacheHitRatio', title: 'Cache hit ratio', basis: '5 min average' }
  ];

  var RANGES = [
    { key: '1h', label: '1 h', words: 'last 1 h', ms: 3600000 },
    { key: '6h', label: '6 h', words: 'last 6 h', ms: 6 * 3600000 },
    { key: '24h', label: '24 h', words: 'last 24 h', ms: 24 * 3600000 }
  ];
  var DEFAULT_RANGE = '6h';
  var SERIES_POINTS = 220;

  function rangeOf(key) {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === key) return RANGES[i];
    return rangeOf(DEFAULT_RANGE);
  }

  function seriesPoints(payload) {
    var s = payload && payload.series && payload.series[0];
    var out = [];
    ((s && s.points) || []).forEach(function (p) {
      var at = Number(p && p.at);
      if (!isFinite(at)) return;
      var v = p.value === null || p.value === undefined ? NaN : Number(p.value);
      out.push({ at: at, value: isFinite(v) ? v : null });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  function mean(points) {
    var n = 0, sum = 0;
    points.forEach(function (p) { if (p.value !== null) { n += 1; sum += p.value; } });
    return n ? sum / n : null;
  }

  function polylines(points, start, span, gapMs, w, h, pad) {
    var runs = [], run = [], last = null;
    points.forEach(function (p) {
      if (p.value === null || (last !== null && p.at - last > gapMs)) {
        if (run.length) runs.push(run);
        run = [];
      }
      if (p.value !== null) {
        var x = pad + Math.max(0, Math.min(1, (p.at - start) / span)) * (w - pad * 2);
        var y = h - pad - Math.max(0, Math.min(1, p.value)) * (h - pad * 2);
        run.push(x.toFixed(1) + ',' + y.toFixed(1));
        last = p.at;
      }
    });
    if (run.length) runs.push(run);
    return runs;
  }

  function overlaySpark(current, previous, range, end, stepMs, label) {
    var w = 220, h = 34, pad = 2;
    var start = end - range.ms;
    var gap = Math.max(stepMs * 2.5, range.ms / 60);
    var nodes = [];
    if (previous) {
      polylines(previous, start - range.ms, range.ms, gap, w, h, pad).forEach(function (pts) {
        nodes.push(ui.svg('polyline', {
          points: pts.join(' '), fill: 'none', stroke: 'var(--muted)', 'stroke-width': '1.4',
          'stroke-dasharray': '3 3', 'stroke-linejoin': 'round', 'data-period': 'previous'
        }));
      });
    }
    polylines(current, start, range.ms, gap, w, h, pad).forEach(function (pts) {
      nodes.push(ui.svg('polyline', {
        points: pts.join(' '), fill: 'none', stroke: 'var(--c1)', 'stroke-width': '1.6',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-period': 'current'
      }));
    });
    return ui.svg('svg', {
      viewBox: '0 0 ' + w + ' ' + h, width: w, height: h, class: 'spark',
      role: 'img', 'aria-label': label, focusable: 'false'
    }, nodes);
  }

  function renderSeries(spec, range, compare) {
    return function (body, payload, env) {
      var all = seriesPoints(payload);
      var stepMs = (Number(payload && payload.stepSeconds) || 60) * 1000;
      var end = all.length ? Math.max(all[all.length - 1].at, (env && env.at) || 0) : ((env && env.at) || Date.now());
      var cutoff = end - range.ms;
      var current = all.filter(function (p) { return p.at > cutoff; });
      var previous = compare ? all.filter(function (p) { return p.at <= cutoff; }) : null;
      var present = current.filter(function (p) { return p.value !== null; });

      if (!present.length) {
        body.appendChild(ui.emptyState(
          'No sample in the ' + range.words,
          'Prometheus answered with nothing for this window. The target may not have been scraped yet.'));
        return;
      }

      var latest = present[present.length - 1].value;
      var prevMean = previous ? mean(previous) : null;
      var curMean = mean(current);
      var label = spec.title + ', ' + range.words + ', on a fixed zero to one hundred per cent scale, now ' +
        fmt.ratioPct(latest, 1) + (previous ? '. The dashed line is the previous ' + range.label +
          (prevMean === null ? ', which has no sample' : ', averaging ' + fmt.ratioPct(prevMean, 1)) : '');

      body.appendChild(el('div.row', [
        el('span.num', { text: fmt.ratioPct(latest, 1) }),
        el('span.muted', { text: 'latest, ' + spec.basis }),
        el('span.spacer'),
        overlaySpark(current, previous, range, end, stepMs, label)
      ]));

      var line = 'Line: ' + range.words + ', ' + fmt.num(current.length) + ' samples, average ' +
        fmt.ratioPct(curMean, 1) + '.';
      if (previous) {
        line += ' Previous ' + range.label + ' (dashed): ' + (prevMean === null
          ? 'no sample.'
          : 'average ' + fmt.ratioPct(prevMean, 1) + ', ' + fmt.num(previous.length) + ' samples.');
      }
      body.appendChild(el('p.hint', { text: line }));
    };
  }

  function seriesPanel(spec, range, compare) {
    var span = compare ? range.ms * 2 : range.ms;
    var points = compare ? SERIES_POINTS * 2 : SERIES_POINTS;
    return A.livePanel(spec.title + ', ' + range.words,
      '/api/metrics/series?name=' + encodeURIComponent(spec.name) + '&window=' + span + '&points=' + points,
      renderSeries(spec, range, compare),
      { ttlMs: 15000 });
  }

  function rangeControls(range, compare, onChange) {
    var bar = el('div.rangebar', { role: 'group', 'aria-label': 'Metrics window' });
    RANGES.forEach(function (r) {
      var b = ui.btn(r.label, { variant: 'ghost', onClick: function () { onChange(r.key, compare); } });
      b.setAttribute('aria-pressed', r.key === range.key ? 'true' : 'false');
      b.setAttribute('data-range', r.key);
      b.title = 'Show the ' + r.words;
      bar.appendChild(b);
    });
    var cmp = ui.btn('Compare with the previous period', {
      variant: 'ghost',
      onClick: function () { onChange(range.key, !compare); }
    });
    cmp.setAttribute('aria-pressed', compare ? 'true' : 'false');
    cmp.setAttribute('data-compare', '');
    return el('div.row', { 'data-metrics-controls': '' }, [el('span.fieldlabel', { text: 'Window' }), bar, cmp]);
  }

  function metricsSection(mount, params) {
    var host = el('div', { 'data-metrics': '' });
    mount.appendChild(host);
    var dispose = null;
    A.onLeave(function () { if (dispose) { dispose(); dispose = null; } });

    function paint(rangeKey, compare) {
      if (dispose) { dispose(); dispose = null; }
      ui.clear(host);
      var range = rangeOf(rangeKey);
      host.setAttribute('data-range', range.key);
      host.setAttribute('data-compare', compare ? 'true' : 'false');
      dispose = A.scopeLeaveHooks(function () {
        host.appendChild(rangeControls(range, compare, function (k, c) {
          if (A.replaceHash) {
            A.replaceHash(A.href('system', [], { range: k === DEFAULT_RANGE ? null : k, compare: c ? '1' : null }));
          }
          paint(k, c);
          if (A.announce) A.announce('Metrics now show the ' + rangeOf(k).words + (c ? ', with the previous period dashed.' : '.'));
        }));
        host.appendChild(el('div.grid.grid-2', [seriesPanel(SERIES[0], range, compare), seriesPanel(SERIES[1], range, compare)]));
        host.appendChild(el('div.grid.grid-2', [seriesPanel(SERIES[2], range, compare), seriesPanel(SERIES[3], range, compare)]));
      });
    }

    paint(params.range || DEFAULT_RANGE, params.compare === '1');
  }

  A.screen('system', {
    title: 'System',
    crumb: 'System',
    render: function (mount, ctx) {
      var rest = (ctx && ctx.rest) || [];
      var params = (ctx && ctx.params) || {};
      if (rest.length) {
        mount.appendChild(ui.notFound('section of System', rest.join('/'), 'system', 'Back to System'));
        return;
      }

      var alive = true;
      var body = el('div');

      function repaint() {
        ui.clear(body);
        A.probe().then(function () { if (alive) build(body, params); });
      }

      mount.appendChild(ui.pageHeader(
        'System',
        'The machine this console runs on, and the cloud account it can see.',
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

  function build(mount, params) {
    if (A.storeMode() !== A.MODE.LIVE) {
      mount.appendChild(ui.stateBlock('sample', {
        detail: 'This screen reads the machine and the cloud account through the console API, and has no ' +
          'fixtures. Start the API with `npm start` in platform/console/server and open the console it serves.'
      }));
      return;
    }

    var caps = A.capabilities() || {};
    mount.appendChild(el('p.hint', {
      text: 'Region ' + (caps.region || 'unknown') + '. ' +
        (caps.writesAllowed ? 'This console may make changes.' : 'This console is read-only.') +
        (caps.aws && caps.aws.configured
          ? ' AWS credentials are present; the AWS account panel says whether AWS accepts them.'
          : ' No AWS credentials are configured.')
    }));

    mount.appendChild(A.livePanel('This host', '/api/host', renderHost, { ttlMs: 2000 }));

    metricsSection(mount, params);

    mount.appendChild(el('div.grid.grid-2', [
      A.livePanel('AWS account', '/api/aws/identity', renderAws, AWS_OPTS),
      A.livePanel('EC2 instances', '/api/aws/instances', function (b, d) { countPanel(b, d, 'instances', 'instances'); }, AWS_OPTS)
    ]));

    mount.appendChild(el('div.grid.grid-2', [
      A.livePanel('S3 buckets', '/api/aws/buckets', function (b, d) { countPanel(b, d, 'buckets', 'buckets'); }, AWS_OPTS),
      A.livePanel('RDS databases', '/api/aws/databases', function (b, d) { countPanel(b, d, 'databases', 'databases'); }, AWS_OPTS)
    ]));
  }
})();
