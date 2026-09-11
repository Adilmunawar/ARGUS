/* Argus Console: Applications.
 *
 * A list of every service on the platform, and a detail view that answers the
 * three questions an operator actually has at 03:00: what is it, what does it
 * depend on, and what is it doing right now.
 *
 * Classic script, no modules, no build step, no network (ADR-0027). Every node
 * is built through ui.el, never from an HTML string: this screen renders log
 * lines, commit messages and dependency names that come from outside the
 * product, so one innerHTML here would be a stored XSS in an admin tool.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data, fmt = ui.fmt;

  /* app.js is parsed before the screens and defers its own boot, so A.screen
   * exists by now. The queue below guards against that ordering regressing:
   * registrations are queued and flushed the moment app.js installs the real
   * registry, rather than depending on the order of two <script> tags staying
   * the way it is today. */
  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    var q = (A._screenQueue = A._screenQueue || []);
    q.push([id, def]);
    if (q.length > 1) return;
    Object.defineProperty(A, 'screen', {
      configurable: true,
      get: function () { return undefined; },
      set: function (fn) {
        Object.defineProperty(A, 'screen', { value: fn, writable: true, configurable: true, enumerable: true });
        while (q.length) { var p = q.shift(); fn(p[0], p[1]); }
      }
    });
  }

  /* ------------------------------------------------------------- shared --- */

  function healthPill(health) {
    return ui.pill(health === 'ok' ? 'Healthy' : 'Degraded', health === 'ok' ? 'ok' : 'warn');
  }

  function mono(text) { return el('code.mono', { text: String(text) }); }

  /** A visible label plus a screen-reader suffix, so "Restart" is never just
   *  "Restart" to somebody listening to a page of identical buttons. */
  function named(label, suffix) {
    return [label, el('span.sr', { text: ' ' + suffix })];
  }

  /* --------------------------------------------------------------- list --- */

  var FILTER_FIELDS = [
    { key: 'name', label: 'Name' },
    { key: 'owner', label: 'Owner' },
    { key: 'health', label: 'Health' },
    { key: 'env', label: 'Environment' }
  ];

  var FILTER_ACCESSORS = {
    name: function (a) { return a.display + ' ' + a.name; },
    owner: function (a) { return a.owner; },
    health: function (a) { return a.health; },
    env: function (a) { return a.env; }
  };

  function listColumns() {
    return [
      {
        key: 'name', label: 'Name',
        sort: function (r) { return r.display; },
        render: function (r) {
          return el('div.col', [
            A.link(r.display, 'apps', [r.name]),
            el('div.muted', { text: r.name })
          ]);
        }
      },
      { key: 'owner', label: 'Owner' },
      { key: 'version', label: 'Version', render: function (r) { return mono(r.version); } },
      { key: 'health', label: 'Health', status: true, render: function (r) { return healthPill(r.health); } },
      { key: 'instances', label: 'Instances', align: 'right', render: function (r) { return fmt.num(r.instances); } },
      { key: 'p95', label: 'p95', align: 'right', render: function (r) { return fmt.ms(r.p95); } },
      { key: 'errorRate', label: 'Error rate', align: 'right', render: function (r) { return fmt.ratioPct(r.errorRate, 2); } },
      {
        key: 'deployedAt', label: 'Last deployed',
        sort: function (r) { return r.deployedAt.getTime(); },
        render: function (r) { return fmt.time(r.deployedAt); }
      },
      {
        /* Secondary actions live behind the overflow menu rather than as six
         * more buttons per row. The trigger stops its own click from reaching
         * the row, which is itself a link to the application. */
        key: 'actions', label: 'Actions', align: 'right', sortable: false,
        render: function (r) {
          return ui.menu([
            { label: 'Open application', onSelect: function () { A.go('apps', [r.name]); } },
            { label: 'Deployment history', onSelect: function () { A.go('apps', [r.name], { tab: 'deploys' }); } },
            { label: 'Logs', onSelect: function () { A.go('apps', [r.name], { tab: 'logs' }); } },
            'divider',
            { label: 'Copy link', hint: 'Shareable', onSelect: function () { copyLink(r); } },
            {
              label: 'Restart instances', danger: true,
              title: 'Restarting is a Tier 1 operation and is recorded in the audit',
              onSelect: function () { restartApp(r); }
            }
          ], { label: 'Actions for ' + r.display });
        }
      }
    ];
  }

  /* The console runs from file:// in development and behind a VPN in
   * production, and the async clipboard API is unavailable in the first and
   * blocked without a user gesture in some builds of the second. Neither case
   * should lose the operator the link, so failure falls back to showing it. */
  function copyLink(app) {
    var href = A.href('apps', [app.name]);
    var url = window.location.href.split('#')[0] + href;
    function shown() { A.flash('ok', 'Link copied', url, { timeout: 5000 }); }
    try {
      if (window.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(shown, function () {
          A.flash('info', 'Copy the link', url);
        });
        return;
      }
    } catch (e) { /* fall through */ }
    A.flash('info', 'Copy the link', url);
  }

  function restartApp(app) {
    A.confirmDestructive({
      title: 'Restart ' + app.display,
      match: app.name,
      confirmLabel: 'Restart',
      detail: 'Every instance of ' + app.display + ' is replaced one at a time. In-flight requests on each instance are drained first, so this is not an outage, but it does reset every in-process cache the application holds.',
      blast: app.instances + ' instance' + (app.instances === 1 ? '' : 's') + ' in ' + app.env + '.',
      onConfirm: function () {
        A.flash('ok', 'Restart requested for ' + app.display,
          'The reconciler rolls the instances one at a time. Your identity and the reason are in the audit.');
      }
    });
  }

  function renderList(mount) {
    mount.appendChild(ui.pageHeader(
      'Applications',
      'Every service on the platform, what it depends on, and how it is behaving.'));

    var tokens = [];
    var filterHost = el('div');
    var tableHost = el('div');

    var appTable = null;

    function paint() {
      /* Four table states, and three of them are wrong if they share wording.
       * There is no loading state here because the dataset ships with the
       * console, but "nothing exists yet", "nothing matches your filters" and a
       * populated table ask the operator to do completely different things, so
       * they never reuse a sentence.
       *
       * The host is only cleared when an empty state genuinely replaces the
       * table, so the instance stays connected and the operator's sort survives
       * a token change. */
      if (!d.apps.length) {
        appTable = null;
        ui.clear(tableHost);
        tableHost.appendChild(ui.emptyState(
          'No applications',
          'Nothing is registered in this environment. An application appears here after the reconciler applies its first declaration.'));
        return;
      }
      var rows = ui.applyTokens(d.apps, tokens, FILTER_ACCESSORS);
      if (!rows.length) {
        appTable = null;
        ui.clear(tableHost);
        tableHost.appendChild(ui.emptyState(
          'No application matches these filters',
          'Try removing a filter.',
          ui.btn('Clear filters', { variant: 'primary', onClick: clearFilters })));
        return;
      }
      if (appTable && appTable.isConnected) { appTable.setRows(rows); return; }
      ui.clear(tableHost);
      appTable = ui.table(listColumns(), rows, {
        caption: 'Applications, showing ' + rows.length + ' of ' + d.apps.length,
        sortKey: 'name',
        rowKey: function (r) { return r.name; },
        onRow: function (r) { A.go('apps', [r.name]); }
      });
      tableHost.appendChild(appTable);
    }

    function mountFilter() {
      ui.clear(filterHost);
      filterHost.appendChild(ui.propertyFilter(FILTER_FIELDS, function (t) { tokens = t; paint(); }));
    }

    // propertyFilter owns its own token state, so clearing means replacing the
    // widget as well as the row set; otherwise the tokens stay on screen.
    function clearFilters() {
      tokens = [];
      mountFilter();
      paint();
      A.announce('Filters cleared, ' + d.apps.length + ' applications shown');
      var input = filterHost.querySelector('.pf-input');
      if (input) input.focus();
    }

    mountFilter();
    mount.appendChild(filterHost);
    mount.appendChild(tableHost);
    paint();
  }

  /* ------------------------------------------------------------ actions --- */

  function openDeployDialog(app) {
    var versions = [];
    if (app.staging) versions.push(app.staging);
    if (versions.indexOf(app.version) === -1) versions.push(app.version);

    var versionSel, envSel;

    A.dialog({
      title: 'Deploy ' + app.display,
      body: function () {
        versionSel = el('select.field', { id: 'deploy-version' }, versions.map(function (v, i) {
          return el('option', {
            value: v, selected: i === 0 ? true : null,
            text: v + (v === app.version ? ' (running now)' : ' (built, not released)')
          });
        }));
        envSel = el('select.field', { id: 'deploy-env' }, [
          el('option', { value: 'staging', text: 'Staging' }),
          el('option', { value: 'production', text: 'Production' })
        ]);
        envSel.value = A.state.env;
        return [
          el('p', { text: 'The console does not deploy anything itself. It opens a pull request against the declaration the reconciler applies, so the change is reviewed, signed and auditable before it runs.' }),
          el('label.fieldlabel', { for: 'deploy-version', text: 'Version' }),
          versionSel,
          el('label.fieldlabel', { for: 'deploy-env', text: 'Environment' }),
          envSel,
          el('p.hint', { text: 'The rollout is one upgrade domain at a time, and rolls back on its own if the health policy fails.' })
        ];
      },
      actions: function (close) {
        return [
          ui.btn('Cancel', { variant: 'ghost', onClick: close }),
          ui.btn('Open pull request', {
            variant: 'primary',
            onClick: function () {
              close();
              A.flash('ok', 'Pull request opened',
                'The console never writes to a server. #1848 is open for review.');
            }
          })
        ];
      }
    });
  }

  function confirmRestart(app, ctx) {
    A.confirmDestructive({
      title: 'Restart ' + app.display,
      detail: 'Every instance is stopped and started again, one upgrade domain at a time. In-flight requests are drained first, but anything long-running is cut.',
      match: app.name,
      environment: ctx.env,
      blast: fmt.num(app.instances) + ' instances across ' + fmt.num(app.services.length) +
        ' services, currently serving ' + fmt.num(app.rps) + ' requests per second.',
      confirmLabel: 'Restart ' + app.name,
      onConfirm: function () {
        A.flash('warn', 'Restart requested for ' + app.display,
          'Queued for review. This prototype has restarted nothing.');
      }
    });
  }

  /* ------------------------------------------------------------ overview --- */

  var DEP_KINDS = [
    ['databases', 'database'],
    ['buckets', 'bucket'],
    ['caches', 'cache'],
    ['queues', 'queue'],
    ['external', 'external']
  ];

  function dependencyGraph(app) {
    var nodes = [{ id: 'app', label: app.display, kind: 'app' }];
    var edges = [];
    DEP_KINDS.forEach(function (pair) {
      (app.depends[pair[0]] || []).forEach(function (name, i) {
        var id = pair[1] + '-' + i;
        nodes.push({ id: id, label: name, kind: pair[1] });
        edges.push(['app', id]);
      });
    });
    if (edges.length === 0) {
      return ui.emptyState('No declared dependencies',
        app.display + ' declares nothing but the edge in front of it.');
    }
    return ui.graph(nodes, edges, { label: 'What ' + app.display + ' depends on' });
  }

  function overviewTab(app) {
    return el('div.stack', [
      ui.card('Declaration', ui.dl([
        ['Version', mono(app.version)],
        ['Staging version', mono(app.staging)],
        ['Owner', app.owner],
        ['Tier', 'Tier ' + app.tier],
        ['Identity', mono(app.identity)],
        ['Host', mono(app.host)],
        ['Last deployed', fmt.time(app.deployedAt)]
      ])),
      ui.card('Dependencies', [
        el('p.hint', { text: 'This graph is generated from the same declaration file the reconciler applies, so it cannot drift from what is actually running.' }),
        dependencyGraph(app)
      ])
    ]);
  }

  /* ----------------------------------------------------------- instances --- */

  /** Prefer a Service Fabric node that actually lists the service; otherwise
   *  round-robin the cluster. Placement has to be plausible and identical on
   *  every run, because the tests compare rendered output. */
  var poolCache = null, poolCacheFor = null;
  function nodeForService(serviceName, index) {
    // Memoised per service, so the pool is computed once rather than once per
    // instance on every render of the Instances tab.
    if (poolCacheFor !== d.sfNodes) { poolCacheFor = d.sfNodes; poolCache = Object.create(null); }
    var pool = poolCache[serviceName];
    if (!pool) {
      var hosting = d.sfNodes.filter(function (n) { return n.apps.indexOf(serviceName) !== -1; });
      pool = poolCache[serviceName] = hosting.length ? hosting : d.sfNodes;
    }
    return pool[index % pool.length];
  }

  function instanceRows(app) {
    var rows = [];
    app.services.forEach(function (svc, si) {
      for (var i = 0; i < svc.instances; i++) {
        var node = nodeForService(svc.name, i);
        rows.push({
          service: svc.name,
          exe: svc.exe,
          index: i,
          node: node.name,
          nodeHost: node.host,
          port: svc.port,
          // Derived from the indices, never from Math.random: a random number
          // here would make every screenshot and every assertion flake.
          uptimeS: Math.max(60, app.uptimeDays * 86400 - si * 3600 - i * 1800),
          restarts: (svc.port + si * 7 + i) % 4
        });
      }
    });
    return rows;
  }

  function instancesTab(app) {
    var rows = instanceRows(app);
    var cols = [
      {
        key: 'service', label: 'Service',
        render: function (r) { return el('div.col', [el('strong', { text: r.service }), el('div.muted', { text: r.exe })]); }
      },
      { key: 'index', label: 'Instance', align: 'right', render: function (r) { return fmt.num(r.index); } },
      {
        key: 'node', label: 'Node',
        render: function (r) { return el('div.col', [mono(r.node), el('div.muted', { text: 'on ' + r.nodeHost })]); }
      },
      { key: 'port', label: 'Port', align: 'right', render: function (r) { return fmt.num(r.port); } },
      { key: 'uptimeS', label: 'Uptime', align: 'right', render: function (r) { return fmt.dur(r.uptimeS); } },
      { key: 'restarts', label: 'Restarts', align: 'right', render: function (r) { return fmt.num(r.restarts); } },
      {
        label: 'Actions', sortable: false,
        render: function (r) {
          return ui.btn(named('Restart', r.service + ' instance ' + r.index + ' on ' + r.node), {
            variant: 'ghost',
            title: 'Restart ' + r.service + ' instance ' + r.index + ' on ' + r.node,
            onClick: function () {
              A.flash('warn', 'Restart requested',
                r.service + ' instance ' + r.index + ' on ' + r.node + '. The other instances keep serving.');
            }
          });
        }
      }
    ];
    return ui.card('Instances', ui.table(cols, rows, {
      caption: 'Running instances of ' + app.display + ', by service and node',
      sortKey: 'service',
      rowKey: function (r) { return r.service + '-' + r.index; }
    }), { flush: true });
  }

  /* ---------------------------------------------------------------- logs --- */

  function logEntries(app) {
    var first = app.services[0];
    var upstream = (app.services[1] || first).name;
    var db = app.depends.databases[0] || 'the local store';
    var bucket = app.depends.buckets[0] || 'no bucket';
    var secret = app.depends.secrets[0] || 'kv/platform/none';

    var texts = [
      'listening on ' + app.host + ':' + first.port + ' as ' + app.identity,
      first.name + ' health probe ok, ' + fmt.num(app.instances) + ' instances registered',
      'GET /api/health 200 in 3 ms',
      'GET /api/summary 200 in ' + fmt.num(app.p95) + ' ms',
      'connection pool for ' + db + ' grew to 12, above the warm size of 8',
      'POST /api/report accepted, queued for background rendering',
      'cache hit ratio 0.94 over the last 1000 requests',
      'GET /api/parcels 200 in 61 ms',
      'renewed the lease on ' + secret + ', 60 minutes remaining',
      'wrote 3 objects to ' + bucket,
      'upstream ' + upstream + ' answered in ' + fmt.num(Math.round(app.p95 * 2.4)) + ' ms, above the 800 ms budget',
      'GET /api/summary 200 in ' + fmt.num(Math.round(app.p95 * 0.8)) + ' ms',
      'reconciler confirmed declaration ' + app.version + ' is applied',
      'GET /api/health 200 in 4 ms'
    ];
    var levels = ['info', 'info', 'debug', 'info', 'warn', 'info', 'debug', 'info',
      'info', 'info', 'warn', 'info', 'info', 'info'];
    if (app.health !== 'ok') levels[10] = 'error';

    return texts.map(function (t, i) {
      return {
        at: new Date(d.now.getTime() - (texts.length - 1 - i) * 37000),
        level: levels[i],
        text: t
      };
    });
  }

  function logsTab(app) {
    var entries = logEntries(app);
    var live = false;
    var selId = 'log-level-' + app.name;

    /* The log region is aria-live="off" on purpose. A streaming log on
     * aria-live="polite" interrupts a screen-reader user on every new line and
     * makes the rest of the page unusable, so the operator asks for the latest
     * line with a button instead of having it read at them. */
    var view = el('div.logview', {
      role: 'region',
      tabindex: '0',
      'aria-live': 'off',
      'aria-label': 'Recent log lines for ' + app.display
    });

    var levelSel = el('select.field', { id: selId }, [
      el('option', { value: 'all', text: 'All levels' }),
      el('option', { value: 'debug', text: 'Debug' }),
      el('option', { value: 'info', text: 'Info' }),
      el('option', { value: 'warn', text: 'Warning' }),
      el('option', { value: 'error', text: 'Error' })
    ]);

    function visible() {
      return entries.filter(function (e) { return levelSel.value === 'all' || e.level === levelSel.value; });
    }

    function paint() {
      ui.clear(view);
      var rows = visible();
      if (!rows.length) {
        view.appendChild(el('div.logline', { text: 'No lines at this level in the last 9 minutes.' }));
        return;
      }
      rows.forEach(function (e) {
        view.appendChild(el('div.logline', [
          el('span.muted', { text: fmt.stamp(e.at) }),
          ' ',
          el('span.mono', { text: e.level.toUpperCase() }),
          ' ',
          e.text
        ]));
      });
    }

    levelSel.addEventListener('change', function () {
      paint();
      A.announce(visible().length + ' log lines at level ' + levelSel.value);
    });

    /* The tail.
     *
     * The buffer is CAPPED: a tail that appends without bound eventually runs
     * the console out of memory, and the cap is what the eventual real stream
     * will need too. The interval is registered with A.onLeave, so leaving the
     * screen stops the work it started.
     */
    var TAIL_CAP = 500;
    var tailTimer = null;
    var tailSeq = 0;

    function stopTail() {
      if (tailTimer) { window.clearInterval(tailTimer); tailTimer = null; }
    }

    function tick() {
      // The node is gone once the operator switches tab; a tab switch does not
      // go through the router, so the leave hook has not fired yet.
      if (!document.body.contains(view)) { stopTail(); return; }
      var seed = entries[tailSeq % entries.length];
      tailSeq += 1;
      entries.push({
        at: new Date(A.data.now.getTime() + tailSeq * 2000),
        level: seed.level,
        text: seed.text
      });
      if (entries.length > TAIL_CAP) entries.splice(0, entries.length - TAIL_CAP);
      paint();
      view.scrollTop = 1e9;   // no scrollHeight read, so no forced layout
    }

    var toggle = ui.btn('Paused', {
      variant: 'ghost',
      title: 'Tailing is paused by default so the view does not move under the pointer',
      onClick: function () {
        live = !live;
        toggle.textContent = live ? 'Live' : 'Paused';
        toggle.setAttribute('aria-pressed', live ? 'true' : 'false');
        if (live) { stopTail(); tailTimer = window.setInterval(tick, 2000); }
        else stopTail();
        A.announce(live
          ? 'Log view is live, new lines every two seconds, ' + TAIL_CAP + ' lines kept'
          : 'Log view is paused');
      }
    });
    toggle.setAttribute('aria-pressed', 'false');
    A.onLeave(stopTail);

    var announceBtn = ui.btn(named('Announce latest line', 'of ' + app.display), {
      onClick: function () {
        var rows = visible();
        var latest = rows[rows.length - 1];
        A.announce(latest
          ? fmt.stamp(latest.at) + ', ' + latest.level + ', ' + latest.text
          : 'No log lines match this level.');
      }
    });

    paint();

    return ui.card('Logs', [
      el('div.row', [
        el('label.fieldlabel', { for: selId, text: 'Level' }),
        levelSel,
        el('span.spacer'),
        toggle,
        announceBtn
      ]),
      view,
      el('p.hint', { text: 'The last 14 lines from every instance, newest at the bottom. The region is not announced automatically; use Announce latest line.' })
    ]);
  }

  /* -------------------------------------------------------------- traces --- */

  function traceSpans(app) {
    var t = app.p95;
    var svc = app.services;
    return [
      { name: 'caddy edge', start: 0, dur: t, root: true },
      { name: (svc[0] ? svc[0].name : 'gateway') + ' route', start: Math.round(t * 0.03), dur: Math.round(t * 0.90) },
      { name: (svc[1] ? svc[1].name : 'api') + ' handler', start: Math.round(t * 0.10), dur: Math.round(t * 0.78) },
      { name: 'sql ' + (app.depends.databases[0] || 'in-memory store'), start: Math.round(t * 0.22), dur: Math.round(t * 0.46) },
      { name: (app.depends.caches[0] || 'response') + ' write', start: Math.round(t * 0.72), dur: Math.round(t * 0.14) }
    ];
  }

  function tracesTab(app) {
    var spans = traceSpans(app);
    // Same shape: a divisor guard, not a default. An instantaneous root span
    // would otherwise divide by zero and render every bar at Infinity percent.
    var total = spans[0].dur > 0 ? spans[0].dur : 1;
    var slowest = spans.slice(1).reduce(function (a, b) { return b.dur > a.dur ? b : a; }, spans[1]);

    var waterfall = el('div.stack', {
      role: 'img',
      'aria-label': 'Trace waterfall for a median ' + app.display + ' request. ' +
        spans.length + ' spans over ' + fmt.ms(total) + '. The slowest span below the edge is ' +
        slowest.name + ' at ' + fmt.ms(slowest.dur) + '.'
    }, spans.map(function (s) {
      var left = (s.start / total) * 100;
      var width = Math.max(1, (s.dur / total) * 100);
      return el('div.tracerow', [
        el('span', { text: s.name }),
        el('div.tracebar', { style: { width: width.toFixed(1) + '%', 'margin-left': left.toFixed(1) + '%' } }),
        el('span.num', { text: fmt.ms(s.dur) })
      ]);
    }));

    // Every chart gets a table equivalent. The picture is the summary; the
    // table is the data, and it is the only one of the two a screen reader,
    // a printout or a copy-paste into an incident channel can use.
    var cols = [
      { key: 'name', label: 'Span' },
      { key: 'start', label: 'Starts at', align: 'right', render: function (r) { return fmt.ms(r.start); } },
      { key: 'dur', label: 'Duration', align: 'right', render: function (r) { return fmt.ms(r.dur); } },
      {
        key: 'share', label: 'Share of request', align: 'right',
        sort: function (r) { return r.dur / total; },
        render: function (r) { return fmt.ratioPct(r.dur / total, 1); }
      }
    ];

    return el('div.stack', [
      ui.card('Median request, ' + fmt.ms(total) + ' at p95', [
        el('p.hint', { text: 'One representative trace, laid out left to right against the p95 for ' + app.display + '.' }),
        waterfall
      ]),
      ui.card('Spans', ui.table(cols, spans, {
        caption: 'Spans in a median ' + app.display + ' request, with start offset, duration and share of the total',
        sortKey: 'start'
      }), { flush: true })
    ]);
  }

  /* -------------------------------------------------------------- config --- */

  function configRows(app) {
    var rows = [
      { key: 'ASPNETCORE_ENVIRONMENT', value: app.env === 'production' ? 'Production' : 'Staging' },
      { key: 'ARGUS__APP', value: app.name },
      { key: 'ARGUS__VERSION', value: app.version },
      { key: 'ARGUS__IDENTITY', value: app.identity },
      { key: 'ARGUS__LISTEN', value: '0.0.0.0:' + app.services[0].port },
      { key: 'ARGUS__OTLP', value: 'http://otel-collector.argus.local:4317' }
    ];
    (app.depends.databases || []).forEach(function (db, i) {
      rows.push({ key: 'ARGUS__DB__' + i, value: 'Database=' + db + ';Integrated Security=true' });
    });
    (app.depends.buckets || []).forEach(function (b, i) {
      rows.push({ key: 'ARGUS__S3__' + i, value: 's3://' + b });
    });
    (app.depends.caches || []).forEach(function (c, i) {
      rows.push({ key: 'ARGUS__CACHE__' + i, value: c.toLowerCase() + '.argus.local:6379' });
    });
    (app.depends.queues || []).forEach(function (q, i) {
      rows.push({ key: 'ARGUS__NATS__SUBJECT__' + i, value: q });
    });
    (app.depends.external || []).forEach(function (x, i) {
      rows.push({ key: 'ARGUS__EGRESS__' + i, value: x + ' via proxy.argus.local:3128' });
    });
    (app.depends.secrets || []).forEach(function (path) {
      var leaf = path.split('/').pop().toUpperCase().replace(/-/g, '_');
      rows.push({ key: 'ARGUS__SECRET__' + leaf, secret: path });
    });
    return rows;
  }

  function configTab(app) {
    var rows = configRows(app);
    var cols = [
      { key: 'key', label: 'Variable', render: function (r) { return mono(r.key); } },
      {
        key: 'value', label: 'Value',
        sort: function (r) { return r.secret || r.value; },
        render: function (r) {
          // A secret is rendered as its path and nothing else. The console has
          // no read path to a secret value, by design, so there is nothing here
          // to leak into a screenshot or a support ticket.
          if (r.secret) {
            return el('div.row', [mono(r.secret), ui.pill('value hidden', 'idle')]);
          }
          return mono(r.value);
        }
      },
      {
        label: 'Actions', sortable: false,
        render: function (r) {
          if (!r.secret) return el('span.muted', { text: '-' });
          return ui.btn(named('Who read this', 'secret, ' + r.secret), {
            variant: 'ghost',
            title: 'Read history for ' + r.secret,
            onClick: function () { A.go('identity', ['secrets'], { path: r.secret }); }
          });
        }
      }
    ];

    return el('div.stack', [
      el('div.callout.info', { text: 'Secret values are never fetched by the console. The application resolves them from OpenBao at start-up with its own identity, and this screen shows only the path and who has read it.' }),
      ui.card('Environment', ui.table(cols, rows, {
        caption: 'Environment variables and secret references for ' + app.display,
        sortKey: 'key'
      }), { flush: true })
    ]);
  }

  /* ------------------------------------------------------ deploy history --- */

  var DEPLOY_STATE = {
    done: ['Completed', 'ok'],
    rolledback: ['Rolled back', 'bad'],
    inflight: ['In flight', 'warn'],
    awaiting: ['Awaiting approval', 'info']
  };

  function confirmRollback(app, dep, ctx) {
    A.confirmDestructive({
      title: 'Roll back ' + app.display + ' to ' + dep.version,
      detail: 'This opens a revert against the declaration and lets the reconciler take the running version back to ' + dep.version + ', one upgrade domain at a time.',
      match: app.name,
      environment: dep.env || ctx.env,
      blast: fmt.num(app.instances) + ' instances of ' + app.display + ' are replaced. Anything deployed after ' + dep.version + ' is undone with it.',
      confirmLabel: 'Roll back to ' + dep.version,
      onConfirm: function () {
        A.flash('ok', 'Revert opened',
          'A revert to ' + dep.version + ' is open for review. The console never writes to a server.');
      }
    });
  }

  function deployTab(app, ctx) {
    var rows = d.deployments.filter(function (x) { return x.app === app.name; });
    if (!rows.length) {
      return ui.emptyState('No deployments recorded',
        app.display + ' has not been deployed through the console in the retained window.');
    }
    var cols = [
      { key: 'version', label: 'Version', render: function (r) { return mono(r.version); } },
      { key: 'env', label: 'Environment' },
      { key: 'author', label: 'Author' },
      {
        key: 'approvals', label: 'Approver',
        sort: function (r) { return (r.approvals || []).join(', '); },
        render: function (r) {
          return (r.approvals && r.approvals.length)
            ? r.approvals.join(', ')
            : el('span.muted', { text: 'not yet approved' });
        }
      },
      { key: 'durationS', label: 'Duration', align: 'right', render: function (r) { return fmt.dur(r.durationS); } },
      {
        key: 'state', label: 'Outcome', status: true,
        render: function (r) {
          var meta = DEPLOY_STATE[r.state] || ['Unknown', 'idle'];
          return el('div.col', [
            ui.pill(meta[0], meta[1]),
            r.outcome && r.outcome !== 'healthy' ? el('div.muted', { text: r.outcome }) : null
          ]);
        }
      },
      {
        label: 'Actions', sortable: false,
        render: function (r) {
          if (r.state !== 'done') return el('span.muted', { text: '-' });
          return ui.btn(named('Roll back to this', 'version, ' + r.version + ' of ' + app.display), {
            variant: 'ghost',
            title: 'Roll ' + app.display + ' back to ' + r.version,
            onClick: function () { confirmRollback(app, r, ctx); }
          });
        }
      }
    ];
    return ui.card('Deploy history', ui.table(cols, rows, {
      caption: 'Deployments of ' + app.display + ', newest first',
      sortKey: 'version', sortDir: 'desc'
    }), { flush: true });
  }

  /* ------------------------------------------------------------- detail --- */

  function renderDetail(mount, ctx) {
    var app = d.appByName(ctx.rest[0]);
    if (!app) {
      mount.appendChild(ui.errorState(
        'No such application',
        'Nothing on this platform is called "' + ctx.rest[0] + '". It may have been renamed, or the link may come from an older runbook.',
        function () { A.go('apps'); }));
      return;
    }

    mount.appendChild(ui.pageHeader(
      app.display,
      app.name + ' · ' + app.identity + ' · ' + app.host,
      [
        ui.btn(named('Deploy', app.display), {
          variant: 'primary',
          title: 'Open a pull request that deploys ' + app.display,
          onClick: function () { openDeployDialog(app); }
        }),
        ui.btn(named('Restart', app.display), {
          variant: 'ghost',
          title: 'Restart every instance of ' + app.display,
          onClick: function () { confirmRestart(app, ctx); }
        })
      ]));

    mount.appendChild(el('div.tiles', [
      ui.statTile('Instances', fmt.num(app.instances), { note: fmt.num(app.services.length) + ' services' }),
      ui.statTile('p95', fmt.ms(app.p95), { note: 'over the last hour' }),
      ui.statTile('Requests', fmt.num(app.rps), { unit: '/s' }),
      ui.statTile('Error rate', fmt.ratioPct(app.errorRate, 2), { note: 'budget 0.10%' }),
      ui.statTile('SLO this month', fmt.pct(app.slo, 2)),
      ui.statTile('Uptime', fmt.num(app.uptimeDays), { unit: 'days' })
    ]));

    mount.appendChild(ui.tabs([
      { id: 'overview', label: 'Overview', render: function () { return overviewTab(app); } },
      { id: 'instances', label: 'Instances', render: function () { return instancesTab(app); } },
      { id: 'logs', label: 'Logs', render: function () { return logsTab(app); } },
      { id: 'traces', label: 'Traces', render: function () { return tracesTab(app); } },
      { id: 'config', label: 'Config', render: function () { return configTab(app); } },
      { id: 'deploys', label: 'Deploy history', render: function () { return deployTab(app, ctx); } }
    ], {
      label: 'Sections of ' + app.display,
      // This screen is the only one that emits ?tab= (from the row overflow
      // menu, which offers "Logs" and "Deploy history"). The second path
      // segment is accepted too, so #/apps/mills/logs works like every other
      // detail screen in the console.
      initial: (ctx && ctx.params && ctx.params.tab) || (ctx && ctx.rest && ctx.rest[1]) || null
    }));
  }

  /* ----------------------------------------------------------- register --- */

  registerScreen('apps', {
    title: 'Applications',
    crumb: 'Applications',
    render: function (mount, ctx) {
      if (ctx.rest && ctx.rest.length) renderDetail(mount, ctx);
      else renderList(mount, ctx);
    }
  });
})();
