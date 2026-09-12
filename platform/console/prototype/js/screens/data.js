(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    document.addEventListener('DOMContentLoaded', function () { A.screen(id, def); });
  }

  var API = {
    pgDatabases: '/api/pg/databases',
    pgRoles: '/api/pg/roles',
    pgActivity: '/api/pg/activity',
    pgStatements: '/api/pg/statements',
    pgReplication: '/api/pg/replication',
    pgHealth: '/api/pg/health',

    cacheServer: '/api/cache/server',
    cacheMemory: '/api/cache/memory',
    cacheKeyspace: '/api/cache/keyspace',
    cacheHealth: '/api/cache/health',

    storageBuckets: '/api/storage/buckets',
    storageCapacity: '/api/storage/capacity',
    storageHealth: '/api/storage/health',
    storageLock: '/api/storage/lock-status',
    storageObjects: '/api/storage/objects',

    queueStreams: '/api/queues/streams',
    queueConsumers: '/api/queues/consumers'
  };

  var MODULE_FOR = [
    ['/api/pg/', 'platform/console/server/src/pg.js'],
    ['/api/cache/', 'platform/console/server/src/garnet.js'],
    ['/api/storage/', 'platform/console/server/src/storage.js'],
    ['/api/queues/', 'platform/console/server/src/queues.js']
  ];

  function moduleFor(path) {
    for (var i = 0; i < MODULE_FOR.length; i++) {
      if (path.indexOf(MODULE_FOR[i][0]) === 0) return MODULE_FOR[i][1];
    }
    return null;
  }

  function unknown(reason) {
    return el('span.muted', {
      text: 'unknown',
      title: reason || 'The server did not report this value, so nothing is shown in its place.'
    });
  }

  function mono(text) { return el('span.mono', { text: String(text) }); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function bytesText(n) {
    if (!isNum(n)) return null;
    if (n < 1024) return fmt.num(n) + ' B';
    var kb = n / 1024;
    if (kb < 1024) return fmt.num(kb, 1) + ' KB';
    var mb = kb / 1024;
    if (mb < 1024) return fmt.num(mb, 1) + ' MB';
    var gb = mb / 1024;
    if (gb < 1024) return fmt.num(gb, 2) + ' GB';
    return fmt.num(gb / 1024, 2) + ' TB';
  }

  function bytesNode(n, reason) {
    var t = bytesText(n);
    return t === null ? unknown(reason) : el('span.num', { text: t });
  }

  function numNode(n, reason, dp) {
    return isNum(n) ? el('span.num', { text: fmt.num(n, dp) }) : unknown(reason);
  }

  function ratioNode(r, reason, dp) {
    return isNum(r) ? el('span.num', { text: fmt.ratioPct(r, dp === undefined ? 1 : dp) }) : unknown(reason);
  }

  function tileText(value) { return value === null || value === undefined ? 'unknown' : String(value); }

  function metricNode(m, format) {
    if (!m) return unknown('This reader did not report the field at all.');
    if (!isNum(m.value)) return unknown(m.unavailable || 'The server did not report this field.');
    var text = format ? format(m.value) : fmt.num(m.value);
    return el('span.num', { text: text, title: m.field ? 'INFO field ' + m.field : null });
  }

  function metricText(m, format) {
    if (!m || !isNum(m.value)) return null;
    return format ? format(m.value) : fmt.num(m.value);
  }

  function textMetricNode(m) {
    if (!m) return unknown('This reader did not report the field at all.');
    if (m.value === null || m.value === undefined || m.value === '') {
      return unknown(m.unavailable || 'The server did not report this field.');
    }
    return mono(m.value);
  }

  function parseIso(s) {
    if (!s) return null;
    var t = Date.parse(s);
    return isFinite(t) ? new Date(t) : null;
  }

  function stampOf(iso) {
    var d = parseIso(iso);
    return d ? d.toISOString().replace('T', ' ').slice(0, 19) + 'Z' : null;
  }

  function sinceText(iso) {
    var d = parseIso(iso);
    if (!d) return null;
    var s = Math.round((Date.now() - d.getTime()) / 1000);
    var future = s < 0;
    s = Math.abs(s);
    var out;
    if (s < 60) out = s + ' s';
    else if (s < 3600) out = Math.round(s / 60) + ' min';
    else if (s < 86400) out = Math.round(s / 3600) + ' h';
    else out = Math.round(s / 86400) + ' d';
    return future ? 'in ' + out : out + ' ago';
  }

  function timeNode(iso, reason) {
    var d = parseIso(iso);
    if (!d) return unknown(reason);
    return el('time', { datetime: d.toISOString(), title: stampOf(iso), text: sinceText(iso) });
  }

  function secondsNode(s, reason) {
    if (!isNum(s)) return unknown(reason);
    if (s < 1) return el('span', { text: fmt.ms(Math.round(s * 1000)) });
    if (s < 60) return el('span', { text: fmt.num(s, 1) + ' s' });
    return el('span', { text: fmt.dur(s) });
  }

  function clipped(text, max) {
    if (text === null || text === undefined) return unknown('The server did not return this text.');
    var s = String(text).replace(/\s+/g, ' ').trim();
    var cap = max || 110;
    if (s.length <= cap) return mono(s);
    return el('span.mono', { text: s.slice(0, cap) + '\u2026', title: s });
  }

  function hint(text) { return el('p.hint', { text: text }); }

  function calloutOf(tone, title, text) {
    return el('div.callout.' + tone, [
      el('strong', { text: title }),
      text ? el('p', { text: text }) : null
    ]);
  }

  function livePanel(title, path, render, opts) {
    opts = opts || {};
    var body = el('div');
    var card = ui.card(title, body, { flush: opts.flush, actions: opts.actions });
    var alive = true;
    A.onLeave(function () { alive = false; });

    body.appendChild(ui.skeleton(opts.skeletonRows || 3));

    A.read(path, opts).then(function (env) {
      if (!alive) return;
      ui.clear(body);
      try {
        paintPanel(body, env, path, render, opts);
      } catch (err) {
        body.appendChild(ui.errorState(
          'This panel could not be drawn',
          'The data arrived but the console failed to render it: ' + (err && err.message ? err.message : String(err)) +
            '. That is a defect in the console, not in the service it read.',
          null));
      }
    });

    return card;
  }

  function paintPanel(body, env, path, render, opts) {
    if (env.mode === A.MODE.SAMPLE) {
      body.appendChild(ui.emptyState(
        'Not available on bundled sample data',
        'This panel reads ' + path + ' through the console API. Start it with `npm start` in ' +
          'platform/console/server (or open the console it serves) and this fills in.'));
      return;
    }

    var e = env.error || {};
    var readerAnswered = !!(env.data && env.data.ok === false);

    if (!env.ok && !readerAnswered) {
      if (e.reason === 'http-404') { body.appendChild(notWired(path)); return; }
      body.appendChild(ui.errorState(
        opts.errorTitle || 'This could not be read',
        e.message || 'The request failed and gave no reason.',
        function () { A.forget(path); A.go(A.state.route, A.state.rest); }));
      return;
    }

    if (readerAnswered) {
      body.appendChild(readerRefusal(env.data));
      return;
    }

    if (env.stale) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Showing the last value that could be read.' }),
        el('p', {
          text: 'A fresh read failed' + (env.error && env.error.message ? ': ' + env.error.message : '.') +
            ' Everything below was measured at ' + (stampOf(env.data && (env.data.cachedAt || env.data.at)) || 'an unrecorded time') + '.'
        })
      ]));
    }

    render(body, env.data, env);

    var when = env.data && (env.data.at || env.data.cachedAt);
    if (when) {
      body.appendChild(hint('Measured at ' + stampOf(when) + ' (' + sinceText(when) + ').' +
        (env.data.cachedAt && env.data.cachedAt !== env.data.at
          ? ' Served from a value cached at ' + stampOf(env.data.cachedAt) + '.'
          : '')));
    }
  }

  function notWired(path) {
    var mod = moduleFor(path);
    return ui.emptyState(
      'This part of the console API is not wired yet',
      'The console API answered 404 for ' + path + '. ' +
        (mod ? 'The reader for it lives in ' + mod + '; ' : '') +
        'the route has to be added to platform/console/server/src/index.js before there is anything to read. ' +
        'Nothing here has failed -- there is simply no answer yet.');
  }

  function readerRefusal(d) {
    var reason = d.reason || 'error';
    var tone = reason === 'not-configured' ? 'idle' : reason === 'denied' ? 'warn' : 'bad';
    return el('div.stack', [
      el('div.row', [
        ui.pill(reason, tone),
        el('span.muted', { text: 'reported by the console API, not guessed at by this screen' })
      ]),
      el('div.callout.warn', [
        el('strong', { text: 'This service could not be read.' }),
        el('p', { text: d.message || 'The reader gave no reason, which is itself a defect worth reporting.' })
      ])
    ]);
  }

  function refreshButton(rest) {
    var live = true;
    var b = ui.btn('Refresh', {
      title: 'Drop every cached read and ask the services again.',
      onClick: function () {
        if (!live) {
          A.flash('info', 'There is nothing to refresh',
            'No console API answered, so this screen is showing no readings to take again. Start it with ' +
            '`npm start` in platform/console/server and open the console it serves.', { timeout: 6000 });
          return;
        }
        A.forget();
        A.go('data', rest);
      }
    });
    var alive = true;
    A.onLeave(function () { alive = false; });
    A.probe().then(function () {
      if (!alive) return;
      live = A.storeMode() === A.MODE.LIVE;
      if (!live) b.title = 'There is nothing to refresh: no console API answered, so nothing here was read from one.';
    });
    return b;
  }

  function findByName(list, name) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].name === name) return list[i];
    return null;
  }

  function renderPgHealth(body, d) {
    body.appendChild(el('div.tiles', [
      ui.statTile('Role', tileText(d.role), { note: 'One cluster; see Replication' }),
      ui.statTile('Version', tileText(d.version), { note: 'Reported by the server' }),
      ui.statTile('Uptime', isNum(d.uptimeSeconds) ? fmt.dur(d.uptimeSeconds) : 'unknown', {
        note: 'Since postmaster start'
      }),
      ui.statTile('Round trip', isNum(d.latencyMs) ? fmt.ms(d.latencyMs) : 'unknown', {
        note: 'SELECT 1 from this console'
      })
    ]));

    var cols = [
      { key: 'name', label: 'Check', width: '22%' },
      {
        key: 'ok', label: 'Verdict', status: true,
        sort: function (r) { return r.ok === false ? 0 : r.ok === true ? 2 : 1; },
        render: function (r) {
          if (r.ok === true) return ui.pill('ok', 'ok');
          if (r.ok === false) return ui.pill('attention', 'bad');
          return ui.pill('not applicable', 'idle', { title: 'This check has no pass or fail here; read the detail.' });
        }
      },
      { key: 'detail', label: 'Detail', render: function (r) { return el('span', { text: r.detail || '' }); } }
    ];

    body.appendChild(ui.table(cols, d.components || [], {
      caption: 'PostgreSQL health checks, each with its verdict and the detail behind it',
      rowKey: function (r) { return r.name; },
      empty: 'The health reader returned no components, which should not happen.'
    }));

    body.appendChild(hint(
      (d.degraded ? 'At least one check needs attention. ' : 'No check is failing. ') +
      'Deadlocks since the statistics were last reset: ' +
      (isNum(d.deadlocksSinceStatsReset) ? fmt.num(d.deadlocksSinceStatsReset) : 'not reported') + '.'));
  }

  function renderPgReplication(body, d) {
    if (!d.configured) {
      body.appendChild(el('div.callout.info', [
        el('strong', { text: 'Not configured. There is one node.' }),
        el('p', { text: d.message || 'Nothing is replicating this cluster.' })
      ]));

      var c = d.capable || {};
      body.appendChild(ui.dl([
        ['Role', mono(d.role || 'primary')],
        ['State', el('span', { text: d.state || 'not configured' })],
        ['Standbys connected', numNode((d.counts || {}).standbys, 'The reader did not report a standby count.')],
        ['Replication slots', numNode((d.counts || {}).slots, 'The reader did not report a slot count.')],
        ['WAL receivers', numNode((d.counts || {}).walReceivers, 'The reader did not report a receiver count.')],
        ['Logical subscriptions', numNode((d.counts || {}).logicalSubscriptions, 'The reader did not report a subscription count.')],
        ['wal_level', c.walLevel ? mono(c.walLevel) : unknown('wal_level was not reported.')],
        ['Could feed a standby', c.canFeedStandby === true
          ? ui.pill('yes', 'idle', { title: 'A setting, not an observation.' })
          : ui.pill('no', 'warn', { title: 'wal_level cannot feed a standby as configured.' })],
        ['max_wal_senders', numNode(c.maxWalSenders, 'max_wal_senders was not reported.')],
        ['archive_mode', c.archiveMode ? mono(c.archiveMode) : unknown('archive_mode was not reported.')],
        ['synchronous_commit', c.synchronousCommit ? mono(c.synchronousCommit) : unknown('synchronous_commit was not reported.')]
      ]));

      body.appendChild(hint(c.note ||
        'These are settings, not observations: they say this server could accept a standby, not that one exists.'));
      return;
    }

    body.appendChild(el('div.callout.ok', [
      el('strong', { text: d.state || 'Replicating' }),
      el('p', { text: 'Role ' + (d.role || 'unknown') + '. Every lag below was measured against this server\'s current WAL position.' })
    ]));

    body.appendChild(ui.table([
      { key: 'applicationName', label: 'Standby', render: function (r) { return mono(r.applicationName || r.clientAddr || ('pid ' + r.pid)); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return ui.pill(r.state || 'unknown', r.state === 'streaming' ? 'ok' : 'warn'); } },
      { key: 'syncState', label: 'Sync', render: function (r) { return el('span', { text: r.syncState || 'unknown' }); } },
      {
        key: 'replayLagBytes', label: 'Replay lag (WAL)', align: 'right',
        render: function (r) { return bytesNode(r.replayLagBytes, 'This standby has not reported a replay position yet.'); }
      },
      {
        key: 'replayLagSeconds', label: 'Replay lag (time)', align: 'right',
        render: function (r) { return secondsNode(r.replayLagSeconds, 'The standby has not replied since it connected, so there is no interval to report.'); }
      },
      { key: 'lastReplyAt', label: 'Last reply', render: function (r) { return timeNode(r.lastReplyAt, 'This standby has not replied yet.'); } }
    ], d.standbys || [], {
      caption: 'Connected standbys, with replay lag in bytes and in time',
      rowKey: function (r) { return String(r.pid); },
      empty: 'No standby is connected.'
    }));

    if (d.slots && d.slots.length) {
      body.appendChild(el('div.sectiontitle', { text: 'Replication slots' }));
      body.appendChild(ui.table([
        { key: 'name', label: 'Slot', render: function (r) { return mono(r.name); } },
        { key: 'active', label: 'Active', status: true, render: function (r) { return r.active ? ui.pill('active', 'ok') : ui.pill('inactive', 'bad', { title: r.warning || '' }); } },
        { key: 'walStatus', label: 'WAL status', render: function (r) { return el('span', { text: r.walStatus || 'unknown' }); } },
        { key: 'retainedWalBytes', label: 'WAL retained', align: 'right', render: function (r) { return bytesNode(r.retainedWalBytes, 'The server did not report retained WAL for this slot.'); } }
      ], d.slots, {
        caption: 'Replication slots, with whether they are connected and how much WAL each is holding',
        rowKey: function (r) { return r.name; },
        empty: 'No replication slot exists.'
      }));
      body.appendChild(hint('An inactive slot retains WAL indefinitely for a consumer that is gone, which is the classic way a PostgreSQL volume fills.'));
    }
  }

  function renderPgDatabases(body, d) {
    var list = d.databases || [];

    body.appendChild(el('div.tiles', [
      ui.statTile('Databases', fmt.num(d.count), { note: 'On this cluster' }),
      ui.statTile(d.sizesComplete ? 'Total size' : 'Size measured so far',
        tileText(bytesText(d.sizesComplete ? d.totalSizeBytes : d.measuredSizeBytes)), {
          note: d.sizesComplete
            ? 'Every database reported a size'
            : fmt.num(d.measuredCount) + ' of ' + fmt.num(d.count) + ' databases reported a size'
        }),
      ui.statTile('Block I/O timing', d.ioTimingMeasured ? 'measured' : 'off', {
        note: d.ioTimingMeasured ? 'track_io_timing is on' : 'Times are null, not zero'
      })
    ]));

    var cols = [
      {
        key: 'name', label: 'Database', width: '18%',
        render: function (r) { return A.link(r.name, 'data', ['database', r.name]); }
      },
      { key: 'owner', label: 'Owner', render: function (r) { return mono(r.owner || 'unknown'); } },
      {
        key: 'sizeBytes', label: 'Size', align: 'right',
        render: function (r) { return bytesNode(r.diskBytes, r.sizeUnknownReason); }
      },
      {
        key: 'connections', label: 'Sessions', align: 'right',
        sort: function (r) { return r.connections ? r.connections.total : -1; },
        render: function (r) {
          var c = r.connections || {};
          return el('span.num', {
            text: fmt.num(c.total),
            title: fmt.num(c.active) + ' active, ' + fmt.num(c.idle) + ' idle, ' +
              fmt.num(c.idleInTransaction) + ' idle in transaction, ' + fmt.num(c.other) +
              ' other. Counted from pg_stat_activity, so it shows what this role may see.'
          });
        }
      },
      {
        key: 'backends', label: 'Backends', align: 'right',
        render: function (r) {
          return numNode(r.backends, 'pg_stat_database reported no backend count for this database.');
        }
      },
      {
        key: 'cache', label: 'Cache hit ratio', align: 'right',
        sort: function (r) { return r.cache && isNum(r.cache.hitRatio) ? r.cache.hitRatio : -1; },
        render: function (r) {
          var c = r.cache || {};
          if (!isNum(c.hitRatio)) {
            return unknown('No blocks have been read or hit ' + (c.window || 'in the counting window') +
              ', so there is no ratio to take. That is not a 100% hit rate.');
          }
          return el('span.num', { text: fmt.ratioPct(c.hitRatio, 1), title: 'Cumulative ' + c.window });
        }
      },
      {
        key: 'deadlocks', label: 'Deadlocks', align: 'right',
        render: function (r) { return numNode(r.deadlocks, 'pg_stat_database reported no deadlock count.'); }
      },
      {
        key: 'tempBytes', label: 'Temp written', align: 'right',
        render: function (r) { return bytesNode(r.tempBytes, 'No temporary-file total was reported.'); }
      },
      {
        key: 'consoleCanConnect', label: 'Console access', status: true,
        render: function (r) {
          if (r.consoleCanConnect) return ui.pill('can connect', 'ok');
          return ui.pill('no access', 'idle', {
            title: r.allowsConnections === false
              ? 'This database does not accept connections at all (datallowconn is false), which is normal for template0.'
              : 'The console role was not granted CONNECT on this database. That is a deliberate grant in platform/compose/sql/20-grants.sql, not a fault.'
          });
        }
      }
    ];

    body.appendChild(ui.table(cols, list, {
      caption: 'Databases on this cluster, with owner, size, sessions, backends, cache hit ratio, deadlocks, temporary bytes written and whether the console may connect',
      sortKey: 'sizeBytes', sortDir: 'desc',
      rowKey: function (r) { return r.name; },
      empty: 'This cluster reported no databases, which should not happen.'
    }));

    if (d.ioTimingNote) body.appendChild(hint(d.ioTimingNote));
    if (d.sizeError) body.appendChild(hint('Sizes: ' + d.sizeError));
  }

  function renderPgActivity(body, d) {
    var s = d.summary || {};

    if (d.countsCoverWholeCluster === false) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'These counts cover only this console\'s own sessions.' }),
        el('p', {
          text: 'The console role does not hold pg_read_all_stats, so pg_stat_activity hides other roles\' ' +
            'sessions and blanks their query text. A cluster running two hundred backends would still read as a ' +
            'handful here. Run platform/compose/sql/20-grants.sql to fix it.'
        })
      ]));
    }

    body.appendChild(el('div.tiles', [
      ui.statTile('Client backends', tileText(isNum(s.clientBackends) ? fmt.num(s.clientBackends) : null), {
        note: isNum(s.maxConnections) ? 'of ' + fmt.num(s.maxConnections) + ' max_connections' : 'max_connections not reported'
      }),
      ui.statTile('Active', tileText(isNum(s.active) ? fmt.num(s.active) : null), { note: 'Running a statement now' }),
      ui.statTile('Idle in transaction', tileText(isNum(s.idleInTransaction) ? fmt.num(s.idleInTransaction) : null), {
        note: 'Holds a snapshot and blocks vacuum cluster-wide'
      }),
      ui.statTile('Waiting on a lock', tileText(isNum(s.waitingOnLock) ? fmt.num(s.waitingOnLock) : null), {
        note: 'Blocked by another session'
      }),
      ui.statTile('Longest transaction',
        isNum(s.longestTransactionSeconds) ? fmt.dur(s.longestTransactionSeconds) : 'none open', {
          note: 'Excludes this console\'s own read'
        })
    ]));

    if (isNum(s.connectionsUsedRatio)) {
      body.appendChild(ui.bar(s.connectionsUsedRatio, {
        tone: s.connectionsUsedRatio >= 0.9 ? 'bad' : s.connectionsUsedRatio >= 0.75 ? 'warn' : null,
        label: 'Connections in use: ' + fmt.ratioPct(s.connectionsUsedRatio, 0) + ' of max_connections'
      }));
    }

    body.appendChild(ui.table([
      { key: 'pid', label: 'PID', align: 'right', render: function (r) { return mono(r.pid); } },
      { key: 'database', label: 'Database', render: function (r) { return r.database ? mono(r.database) : unknown('A background worker is attached to no database.'); } },
      { key: 'role', label: 'Role', render: function (r) { return r.role ? mono(r.role) : el('span.muted', { text: 'n/a' }); } },
      {
        key: 'state', label: 'State', status: true,
        render: function (r) {
          if (!r.state) return el('span.muted', { text: r.backendType || 'background' });
          var tone = r.state === 'active' ? 'ok' : r.state.indexOf('idle in transaction') === 0 ? 'warn' : 'idle';
          return ui.pill(r.state, tone);
        }
      },
      {
        key: 'waitEvent', label: 'Waiting on',
        render: function (r) {
          if (!r.waitEventType) return el('span.muted', { text: 'not waiting' });
          return el('span', { text: r.waitEventType + ': ' + (r.waitEvent || 'unnamed') });
        }
      },
      {
        key: 'querySeconds', label: 'Running', align: 'right',
        render: function (r) { return secondsNode(r.querySeconds, 'This session has no statement running, so there is nothing to time.'); }
      },
      {
        key: 'query', label: 'Statement', width: '30%', sortable: false,
        render: function (r) {
          if (r.queryVisible === false) {
            return el('span.muted', {
              text: 'hidden from this role',
              title: 'The server withheld the query text because the console role does not hold pg_read_all_stats.'
            });
          }
          if (!r.query) return el('span.muted', { text: 'none' });
          var node = clipped(r.query, 90);
          if (r.queryTruncatedByServer) node.title = (node.title || r.query) + '\n\nTruncated by the server at track_activity_query_size.';
          return node;
        }
      },
      {
        label: 'Blocked by', sortable: false,
        render: function (r) {
          if (r.blockedBy === null || r.blockedBy === undefined) return el('span.muted', { text: 'n/a' });
          if (!r.blockedBy.length) return el('span.muted', { text: 'cleared' });
          return ui.pill(r.blockedBy.join(', '), 'bad', { title: 'Process ids holding the lock this session wants.' });
        }
      }
    ], d.sessions || [], {
      caption: 'Sessions on this cluster, with database, role, state, what each is waiting on, how long its statement has run and what is blocking it',
      sortKey: 'querySeconds', sortDir: 'desc',
      rowKey: function (r) { return String(r.pid); },
      empty: 'No session is open other than this console\'s own read.'
    }));

    if (d.listTruncated) {
      body.appendChild(hint('The list is capped at ' + fmt.num(d.listLimit) +
        ' sessions; the counts above are not capped and cover every backend.'));
    }
    if (isNum(d.redactedSessions) && d.redactedSessions > 0) {
      body.appendChild(hint(fmt.num(d.redactedSessions) +
        ' sessions had their query text withheld from this role. They are listed, but their statements are not readable here.'));
    }
  }

  function renderPgStatements(body, d) {
    if (d.available === false) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Slow queries are not being recorded: ' + (d.reason || 'unavailable') + '.' }),
        el('p', { text: d.message || 'No reason was given.' })
      ]));
      if (d.sharedPreloadLibraries) {
        body.appendChild(ui.dl([['shared_preload_libraries', mono(d.sharedPreloadLibraries)]]));
      }
      return;
    }

    var list = d.statements || [];

    body.appendChild(ui.table([
      {
        key: 'query', label: 'Statement', width: '34%', sortable: false,
        render: function (r) { return clipped(r.query, 110); }
      },
      { key: 'database', label: 'Database', render: function (r) { return r.database ? mono(r.database) : unknown('The database this statement ran in no longer exists.'); } },
      { key: 'calls', label: 'Calls', align: 'right', render: function (r) { return numNode(r.calls, 'No call count was reported.'); } },
      {
        key: 'totalMs', label: 'Total time', align: 'right',
        render: function (r) { return isNum(r.totalMs) ? el('span.num', { text: fmt.ms(r.totalMs) }) : unknown('No execution time was reported.'); }
      },
      {
        key: 'meanMs', label: 'Mean', align: 'right',
        render: function (r) { return isNum(r.meanMs) ? el('span.num', { text: fmt.ms(r.meanMs) }) : unknown('No mean execution time was reported.'); }
      },
      {
        key: 'maxMs', label: 'Slowest', align: 'right',
        render: function (r) { return isNum(r.maxMs) ? el('span.num', { text: fmt.ms(r.maxMs) }) : unknown('No maximum execution time was reported.'); }
      },
      { key: 'rows', label: 'Rows', align: 'right', render: function (r) { return numNode(r.rows, 'No row count was reported.'); } },
      {
        key: 'ioReadMs', label: 'Read I/O', align: 'right',
        render: function (r) {
          return isNum(r.ioReadMs) ? el('span.num', { text: fmt.ms(r.ioReadMs) })
            : unknown('track_io_timing is off on this server, so no time was measured. This is not zero time.');
        }
      }
    ], list, {
      caption: 'Statements recorded by pg_stat_statements, ordered by ' + (d.orderedBy || 'total time') +
        ', with call count, total, mean and slowest execution time, rows returned and read I/O time',
      sortKey: 'totalMs', sortDir: 'desc',
      rowKey: function (r) { return String(r.queryid); },
      empty: d.emptyMeaning || 'No statement has been recorded.'
    }));

    var notes = [];
    if (d.trackNote) notes.push(d.trackNote);
    if (d.countersResetAt) notes.push('Every total here is cumulative since the counters were reset at ' + stampOf(d.countersResetAt) + '.');
    if (isNum(d.entriesEvicted) && d.entriesEvicted > 0) {
      notes.push(fmt.num(d.entriesEvicted) + ' entries have been discarded because pg_stat_statements.max was reached, ' +
        'so this list is not the whole truth about the workload.');
    }
    if (d.extensionVersion) notes.push('pg_stat_statements ' + d.extensionVersion + ' in schema ' + d.schema + '.');
    if (notes.length) body.appendChild(hint(notes.join(' ')));
  }

  function renderPgRoles(body, d) {
    var complete = d.sessionCountsCoverWholeCluster === true;

    body.appendChild(ui.table([
      { key: 'name', label: 'Role', render: function (r) { return mono(r.name); } },
      {
        key: 'predefined', label: 'Kind', status: true,
        render: function (r) {
          return r.predefined
            ? ui.pill('predefined', 'idle', { title: 'One of PostgreSQL\'s own roles, not created by this platform.' })
            : ui.pill('local', 'info');
        }
      },
      {
        key: 'superuser', label: 'Superuser', status: true,
        render: function (r) { return r.superuser ? ui.pill('superuser', 'bad', { title: 'Bypasses every permission check.' }) : el('span.muted', { text: 'no' }); }
      },
      {
        key: 'canLogin', label: 'Login', status: true,
        render: function (r) { return r.canLogin ? ui.pill('can log in', 'warn') : el('span.muted', { text: 'group only' }); }
      },
      {
        key: 'memberOf', label: 'Member of', sortable: false,
        render: function (r) {
          if (!r.memberOf || !r.memberOf.length) return el('span.muted', { text: 'nothing' });
          return el('span.chips', r.memberOf.map(function (m) { return el('span.chip', { text: m }); }));
        }
      },
      {
        key: 'sessions', label: 'Sessions', align: 'right',
        render: function (r) {
          if (!complete) {
            return unknown('Session counts per role need pg_read_all_stats, which this console role does not hold. ' +
              'Every role but this console\'s own would read zero, so no number is shown.');
          }
          return numNode(r.sessions, 'No session count was reported for this role.');
        }
      },
      {
        key: 'validUntil', label: 'Password expires',
        render: function (r) {
          if (!r.validUntil) return el('span.muted', { text: 'no expiry set' });
          if (r.validUntil === 'infinity') return el('span.muted', { text: 'never' });
          return timeNode(r.validUntil, 'The expiry could not be read.');
        }
      }
    ], d.roles || [], {
      caption: 'Roles on this cluster, with kind, superuser and login rights, group memberships, open sessions and password expiry',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      empty: 'This cluster reported no roles, which should not happen.'
    }));

    body.appendChild(hint(d.passwordsNotReported ||
      'Whether a role has a password is in pg_authid, which only a superuser may read, so it is not reported here.'));
  }

  function databasesTab() {
    return el('div.stack', [
      el('div.grid.grid-2', [
        livePanel('Cluster health', API.pgHealth, renderPgHealth, {
          ttlMs: 10000, errorTitle: 'The cluster health could not be read'
        }),
        livePanel('Replication', API.pgReplication, renderPgReplication, {
          ttlMs: 10000, errorTitle: 'The replication state could not be read'
        })
      ]),
      livePanel('Databases', API.pgDatabases, renderPgDatabases, {
        ttlMs: 10000, errorTitle: 'The database list could not be read'
      }),
      livePanel('Sessions', API.pgActivity, renderPgActivity, {
        ttlMs: 2000, errorTitle: 'Session activity could not be read'
      }),
      livePanel('Slowest statements', API.pgStatements, renderPgStatements, {
        ttlMs: 15000, errorTitle: 'Statement statistics could not be read'
      }),
      livePanel('Roles', API.pgRoles, renderPgRoles, {
        ttlMs: 30000, errorTitle: 'The role list could not be read'
      })
    ]);
  }

  function renderStorageCapacity(body, d) {
    var t = d.totals || {}, slots = d.slots || {};
    var usedRatio = isNum(t.usedBytes) && isNum(t.allBytes) && t.allBytes > 0 ? t.usedBytes / t.allBytes : null;

    body.appendChild(el('div.tiles', [
      ui.statTile('Used', tileText(bytesText(t.usedBytes)), { note: isNum(t.allBytes) ? 'of ' + bytesText(t.allBytes) : 'total not reported' }),
      ui.statTile('Free', tileText(bytesText(t.freeBytes)), { note: d.scope || 'Disk free on the volume servers' }),
      ui.statTile('Writable now', tileText(bytesText(d.available)), {
        note: 'Bound by ' + (d.binding || 'unknown') + ': ' + fmt.num(slots.free) + ' of ' + fmt.num(slots.max) + ' volume slots free'
      }),
      ui.statTile('Volume slots free', tileText(isNum(slots.free) ? fmt.num(slots.free) : null), {
        note: isNum(slots.volumeSizeMB) ? fmt.num(slots.volumeSizeMB) + ' MB per volume' : 'Volume size not reported'
      })
    ]));

    if (isNum(usedRatio)) {
      body.appendChild(ui.bar(usedRatio, {
        tone: usedRatio >= 0.9 ? 'bad' : usedRatio >= 0.75 ? 'warn' : null,
        label: 'Object store disk: ' + fmt.ratioPct(usedRatio, 0) + ' used'
      }));
    }

    body.appendChild(ui.table([
      { key: 'url', label: 'Volume server', render: function (r) { return mono(r.url); } },
      {
        key: 'ok', label: 'Reachable', status: true,
        render: function (r) { return r.ok ? ui.pill('reachable', 'ok') : ui.pill('unreachable', 'bad', { title: r.error || 'No reason given.' }); }
      },
      { key: 'dataCenter', label: 'Site', render: function (r) { return el('span', { text: (r.dataCenter || '?') + ' / ' + (r.rack || '?') }); } },
      { key: 'usedBytes', label: 'Used', align: 'right', render: function (r) { return bytesNode(r.usedBytes, 'This volume server did not answer.'); } },
      { key: 'freeBytes', label: 'Free', align: 'right', render: function (r) { return bytesNode(r.freeBytes, 'This volume server did not answer.'); } },
      {
        key: 'volumes', label: 'Volumes', align: 'right',
        render: function (r) { return el('span.num', { text: fmt.num(r.volumes) + ' of ' + fmt.num(r.maxVolumes) }); }
      }
    ], d.nodes || [], {
      caption: 'Volume servers, with reachability, site, used and free capacity and volume slots in use',
      rowKey: function (r) { return r.url; },
      empty: 'The master reported no volume servers.'
    }));

    if (d.partial) {
      body.appendChild(hint('At least one volume server did not answer, so these totals are a partial sum and not the capacity of the cluster.'));
    }
    if (d.scope) body.appendChild(hint('Scope: ' + d.scope + '.'));
  }

  function renderStorageBuckets(body, d) {
    var enumerated = !d.inventoryError && !d.declaredError;

    if (d.inventoryError) {
      body.appendChild(calloutOf('warn', 'The bucket inventory could not be read.', d.inventoryError));
    }
    if (d.declaredError) {
      body.appendChild(calloutOf('warn', 'The declared bucket list could not be read.', d.declaredError));
    }
    if (d.topologyOk === false) {
      body.appendChild(calloutOf('warn', 'The volume topology could not be read, so no size or object count below was measured.',
        d.topologyError || 'No reason was given.'));
    }

    body.appendChild(ui.table([
      {
        key: 'name', label: 'Bucket', width: '20%',
        render: function (r) { return A.link(r.name, 'data', ['bucket', r.name]); }
      },
      {
        key: 'sizeBytes', label: 'Size', align: 'right',
        render: function (r) { return bytesNode(r.diskBytes, r.unknownSizeReason); }
      },
      {
        key: 'objects', label: 'Objects', align: 'right',
        render: function (r) {
          if (!isNum(r.objects)) return unknown(r.unknownSizeReason || 'The topology reported no object count for this bucket.');
          return el('span.num', {
            text: fmt.num(r.objects),
            title: r.objectsApprox
              ? 'Approximate: counted from the volume servers, which include deleted-but-not-compacted entries. Listing every object to get an exact count is an O(objects) operation and is not done on page load.'
              : 'Exact count.'
          });
        }
      },
      {
        key: 'lock', label: 'Object lock', status: true,
        sort: function (r) { return r.lock ? 1 : 0; },
        render: function (r) {
          if (!r.lock) return ui.pill('none', 'idle', { title: 'Objects in this bucket can be deleted or overwritten.' });
          return el('span.lockbadge', {
            text: r.lock + ' \u00b7 ' + fmt.num(r.lockDays) + ' days',
            title: 'Declared ' + (r.lockDeclared || 'nothing') + '. Retention cannot be shortened or removed before it expires, by anybody.'
          });
        }
      },
      {
        key: 'lockEnforced', label: 'Lock proven', status: true,
        render: function (r) {
          if (!r.lock) return el('span.muted', { text: 'n/a' });
          if (r.lockEnforced === 'enforced') return ui.pill('proven', 'ok', { title: 'A versioned delete was attempted and refused.' });
          if (!r.lockEnforced) return unknown('No delete probe result was recorded for this bucket.');
          return ui.pill(r.lockEnforced, 'warn');
        }
      },
      { key: 'owner', label: 'Owner', render: function (r) { return r.owner ? mono(r.owner) : unknown('No owning identity is declared for this bucket.'); } },
      {
        key: 'replication', label: 'Replication',
        render: function (r) {
          if (!r.replication || r.replication === 'not configured') {
            return el('span.muted', { text: 'not configured', title: 'Nothing is copying this bucket off this node.' });
          }
          return el('span', { text: r.replication });
        }
      },
      {
        key: 'backup', label: 'Backup', sortable: false,
        render: function (r) {
          if (!r.backup) return el('span.muted', { text: 'none declared' });
          return el('span', { text: r.backup.tool + ' ' + r.backup.schedule, title: 'Target: ' + r.backup.target });
        }
      }
    ], d.buckets || [], {
      caption: 'Buckets in the object store, with size, object count, object lock mode and whether it is proven, owner, replication and backup',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      empty: enumerated
        ? 'No bucket exists in this object store.'
        : 'The bucket inventory could not be read, so nothing could be enumerated. This is not evidence that the object store is empty.'
    }));

    var drift = d.drift || {};
    if ((drift.declaredButMissing && drift.declaredButMissing.length) ||
        (drift.existsButUndeclared && drift.existsButUndeclared.length)) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'The object store and the declaration disagree.' }),
        el('p', {
          text: (drift.declaredButMissing || []).length
            ? 'Declared but missing: ' + drift.declaredButMissing.join(', ') + '. '
            : ''
        }),
        el('p', {
          text: (drift.existsButUndeclared || []).length
            ? 'Exists but undeclared: ' + drift.existsButUndeclared.join(', ') + '.'
            : ''
        })
      ]));
    }

    body.appendChild(hint('Inventory from ' + (d.inventorySource || 'the object store') +
      '. Object lock across the estate: ' +
      (!d.wormVerdict || d.wormVerdict === 'unknown' ? 'not established by a delete probe' : d.wormVerdict) + '.'));
  }

  function renderStorageHealth(body, d) {
    body.appendChild(el('div.tiles', [
      ui.statTile('Writable', d.writable ? 'yes' : 'no', {
        note: d.writable ? 'The master has a volume slot for a new write' : 'No free volume slot: writes will fail'
      }),
      ui.statTile('Signed S3 call', d.s3 && d.s3.signedCallOk ? 'ok' : 'failed', {
        note: 'The console\'s own credential against the S3 gateway'
      }),
      ui.statTile('Free volumes', tileText(isNum(d.freeVolumes) ? fmt.num(d.freeVolumes) : null), {
        note: 'Slots the master can still place'
      })
    ]));

    body.appendChild(ui.table([
      { key: 'name', label: 'Component', render: function (r) { return mono(r.name); } },
      {
        key: 'reachable', label: 'Reachable', status: true,
        render: function (r) { return r.reachable ? ui.pill('reachable', 'ok') : ui.pill('unreachable', 'bad', { title: r.error || 'No reason given.' }); }
      },
      { key: 'version', label: 'Version', render: function (r) { return r.version ? mono(r.version) : unknown('This component did not report a version.'); } },
      {
        key: 'latencyMs', label: 'Latency', align: 'right',
        render: function (r) { return isNum(r.latencyMs) ? el('span.num', { text: fmt.ms(r.latencyMs) }) : unknown('Latency was not measured for this component.'); }
      }
    ], d.components || [], {
      caption: 'Object store components, with reachability, version and probe latency',
      rowKey: function (r) { return r.name; },
      empty: 'The health reader returned no components.'
    }));
  }

  function bucketsTab() {
    return el('div.stack', [
      livePanel('Capacity', API.storageCapacity, renderStorageCapacity, {
        ttlMs: 15000, errorTitle: 'Object store capacity could not be read'
      }),
      livePanel('Buckets', API.storageBuckets, renderStorageBuckets, {
        ttlMs: 15000, errorTitle: 'The bucket list could not be read'
      }),
      livePanel('Object store health', API.storageHealth, renderStorageHealth, {
        ttlMs: 15000, errorTitle: 'Object store health could not be read'
      })
    ]);
  }

  var SPILL_WARN = 0.5;
  var SPILL_BAD = 0.9;

  function spillTone(ratio) {
    if (!isNum(ratio)) return null;
    return ratio >= SPILL_BAD ? 'bad' : ratio >= SPILL_WARN ? 'warn' : null;
  }

  function renderCacheServer(body, d) {
    var srv = d.server || {}, tp = d.throughput || {}, id = d.identity || {}, clock = d.clock || {};

    body.appendChild(el('div.tiles', [
      ui.statTile('Operations', tileText(metricText(tp.opsPerSec)), {
        unit: isNum(tp.opsPerSec && tp.opsPerSec.value) ? '/s' : null,
        note: isNum(tp.opsPerSec && tp.opsPerSec.value)
          ? 'Sampled by the server'
          : 'The metrics sampling task is off, so nothing is sampling this'
      }),
      ui.statTile('Commands processed', tileText(metricText(tp.totalCommandsProcessed)), { note: 'Since this server started' }),
      ui.statTile('Uptime', tileText(metricText(srv.uptimeSeconds, function (v) { return fmt.dur(v); })), {
        note: 'Garnet starts cold on every boot'
      }),
      ui.statTile('Probe', tileText(isNum(d.probeMs) ? fmt.ms(d.probeMs) : null), { note: 'One connection, one pass' })
    ]));

    body.appendChild(ui.dl([
      ['Endpoint', mono(d.endpoint || 'unknown')],
      ['Garnet version', textMetricNode(srv.garnetVersion)],
      ['RESP compatibility', textMetricNode(srv.redisCompatVersion)],
      ['Authenticated as', id.user
        ? el('span', [mono(id.user), id.matches === false
          ? ui.pill('not the expected user', 'warn', { title: 'Expected ' + id.expected + '. The console is holding whatever grants that other rule has.' })
          : null])
        : unknown(id.unavailable)],
      ['Clock skew', isNum(clock.skewMs)
        ? el('span.num', { text: fmt.num(clock.skewMs) + ' ms', title: clock.note })
        : unknown(clock.unavailable)],
      ['Reads / writes', el('span', [
        metricNode(tp.totalReads), el('span.muted', { text: ' / ' }), metricNode(tp.totalWrites)
      ])],
      ['Network in / out', el('span', [
        metricNode(tp.netInputBytes, function (v) { return bytesText(v); }),
        el('span.muted', { text: ' / ' }),
        metricNode(tp.netOutputBytes, function (v) { return bytesText(v); })
      ])]
    ]));

    if (d.hitRate && d.hitRate.available === false) {
      body.appendChild(calloutOf('info', 'There is no hit rate to show.', d.hitRate.message));
    }
  }

  function renderCacheMemory(body, d) {
    var c = d.container || {};

    body.appendChild(el('div.tiles', [
      ui.statTile('Spill ratio', tileText(isNum(d.spillRatio) ? fmt.ratioPct(d.spillRatio, 1) : null), {
        note: isNum(d.spillRatio)
          ? 'Worst log: ' + (d.spillRatioLog || 'unnamed')
          : (d.spillUnavailable ? 'Not computable on this server' : 'No log has anything in it yet')
      }),
      ui.statTile('Container memory', tileText(isNum(c.usedRatio) ? fmt.ratioPct(c.usedRatio, 0) : null), {
        note: isNum(c.processBytes)
          ? bytesText(c.processBytes) + (isNum(c.limitBytes) ? ' of ' + bytesText(c.limitBytes) : ', no limit known')
          : 'The process size could not be read'
      }),
      ui.statTile('Logs reported', tileText(d.logs ? fmt.num(d.logs.length) : null), {
        note: 'Main store and object store are separate logs'
      }),
      ui.statTile('Spilling to disk', d.spilling === null || d.spilling === undefined ? 'unknown' : (d.spilling ? 'yes' : 'no'), {
        note: d.spillDirectory && d.spillDirectory.value ? 'Directory: ' + d.spillDirectory.value : 'Spill directory not reported'
      })
    ]));

    if (isNum(d.spillRatio)) {
      body.appendChild(ui.bar(d.spillRatio, {
        tone: spillTone(d.spillRatio),
        label: 'Spill ratio: ' + fmt.ratioPct(d.spillRatio, 0) + ' of the live log is on disk (' + (d.spillRatioLog || 'worst log') + ')'
      }));
      body.appendChild(hint('Spilled records are still live and still served; reading one is a disk read rather than a miss. ' +
        'Nothing has been lost. What eventually does lose keys is the segment cap, which deletes the oldest segment whole ' +
        'when the spill area is full -- a disk ceiling, by age of write, not memory pressure.'));
    } else if (d.spillUnavailable) {
      body.appendChild(calloutOf('warn', 'The spill ratio could not be computed.', d.spillUnavailable));
    }

    if (isNum(c.usedRatio)) {
      body.appendChild(ui.bar(c.usedRatio, {
        tone: c.usedRatio >= 0.9 ? 'bad' : c.usedRatio >= 0.75 ? 'warn' : null,
        label: 'Container memory: ' + fmt.ratioPct(c.usedRatio, 0) + ' of mem_limit'
      }));
    }
    if (c.limitUnavailable) body.appendChild(calloutOf('warn', 'There is no denominator for the container memory gauge.', c.limitUnavailable));
    if (c.processUnavailable) body.appendChild(calloutOf('warn', 'The container memory numerator could not be read.', c.processUnavailable));

    body.appendChild(el('div.sectiontitle', { text: 'Hybrid logs' }));
    body.appendChild(ui.table([
      { key: 'log', label: 'Log', render: function (r) { return mono(r.log); } },
      {
        key: 'spillRatio', label: 'Spilled', align: 'right',
        render: function (r) { return ratioNode(r.spillRatio, r.unavailable, 1); }
      },
      { key: 'spilledBytes', label: 'On disk', align: 'right', render: function (r) { return bytesNode(r.spilledBytes, r.unavailable); } },
      { key: 'residentBytes', label: 'In memory', align: 'right', render: function (r) { return bytesNode(r.residentBytes, r.unavailable); } },
      {
        key: 'memoryBytes', label: 'Log memory', align: 'right',
        sort: function (r) { return r.memoryBytes && isNum(r.memoryBytes.value) ? r.memoryBytes.value : -1; },
        render: function (r) { return metricNode(r.memoryBytes, function (v) { return bytesText(v); }); }
      },
      {
        key: 'memoryRatio', label: 'Of its budget', align: 'right',
        render: function (r) {
          return ratioNode(r.memoryRatio,
            'This build did not report both the current and maximum memory size for this log, so there is no ratio to take.', 0);
        }
      }
    ], d.logs || [], {
      caption: 'Garnet hybrid logs, with the share of each that has spilled to disk, the bytes on disk and in memory, and memory held against its budget',
      sortKey: 'log',
      rowKey: function (r) { return r.log; },
      empty: 'This server reported no log addresses in INFO, so there is nothing to break down.'
    }));

    if (d.evictions && d.evictions.available === false) {
      body.appendChild(calloutOf('info', 'This cache does not evict, so there is no eviction count.', d.evictions.message));
    }

    var mm = d.maxmemory || {};
    body.appendChild(hint('maxmemory: ' + (mm.configured ? String(mm.value) : 'not configured') + '. ' + (mm.evidence || '')));

    if (c.note) body.appendChild(hint(c.note));
  }

  function renderCacheKeyspace(body, d) {
    body.appendChild(el('div.tiles', [
      ui.statTile('Keys', tileText(isNum(d.keys) ? fmt.num(d.keys) : null), {
        note: isNum(d.keys) ? 'One logical database' : 'Not readable'
      })
    ]));

    if (!isNum(d.keys) && d.keysUnavailable) {
      body.appendChild(calloutOf('warn', 'The key count could not be read.', d.keysUnavailable));
    } else if (d.keysNote) {
      body.appendChild(hint(d.keysNote));
    }

    if (d.byPrefix && d.byPrefix.available === false) {
      body.appendChild(calloutOf('info', 'There is no per-prefix breakdown, and there is not supposed to be.', d.byPrefix.message));
    }
    if (d.keyIsolationNote) body.appendChild(hint(d.keyIsolationNote));
  }

  function renderCacheHealth(body, d) {
    var tone = d.status === 'ok' ? 'ok'
      : d.status === 'insecure' ? 'bad'
        : d.status === 'degraded' ? 'warn'
          : d.status === 'not-configured' ? 'idle' : 'bad';

    body.appendChild(el('div.row', [
      ui.pill(d.status || 'unknown', tone),
      ui.pill(d.reachable ? 'reachable' : 'not reachable', d.reachable ? 'ok' : 'bad'),
      el('span.muted', { text: d.endpoint || '' })
    ]));

    if (d.authRequired === false) {
      body.appendChild(calloutOf('bad', 'This cache answers unauthenticated connections.',
        (d.authProbe || '') + ' Anything that can reach this port has full rights, FLUSHALL included.'));
    } else if (d.authRequired === true) {
      body.appendChild(calloutOf('ok', 'A credential is required.', d.authProbe || 'An unauthenticated PING was refused, which is the correct answer.'));
    } else {
      body.appendChild(calloutOf('warn', 'Whether a credential is required could not be established.',
        d.authProbe || 'The unauthenticated probe gave an answer this reader does not understand.'));
    }

    if (d.message) body.appendChild(calloutOf('warn', 'The console could not use this cache: ' + (d.reason || 'unknown'), d.message));

    body.appendChild(ui.dl([
      ['Version', d.version ? mono(d.version) : unknown('The server did not report a version.')],
      ['Uptime', secondsNode(d.uptimeSeconds, 'The server did not report an uptime.')],
      ['Console user', mono(d.user || 'unknown')],
      ['Spill', d.spill && isNum(d.spill.ratio)
        ? el('span.num', { text: fmt.ratioPct(d.spill.ratio, 1) + ' (' + (d.spill.log || 'worst log') + ')' })
        : unknown((d.spill && d.spill.unavailable) || 'The spill ratio was not available to this check.')]
    ]));

    if (d.notes && d.notes.length) {
      body.appendChild(el('div.sectiontitle', { text: 'Notes' }));
      body.appendChild(el('ul.treelist', d.notes.map(function (n) {
        return el('li.treelist-item', el('span', { text: n }));
      })));
    }

    if (d.scope) body.appendChild(hint(d.scope));
  }

  function cacheTab() {
    return el('div.stack', [
      livePanel('Cache health', API.cacheHealth, renderCacheHealth, {
        ttlMs: 10000, errorTitle: 'The cache health could not be read'
      }),
      livePanel('Memory and spill', API.cacheMemory, renderCacheMemory, {
        ttlMs: 10000, errorTitle: 'Cache memory could not be read'
      }),
      livePanel('Server', API.cacheServer, renderCacheServer, {
        ttlMs: 10000, errorTitle: 'The cache server state could not be read'
      }),
      livePanel('Keyspace', API.cacheKeyspace, renderCacheKeyspace, {
        ttlMs: 120000, errorTitle: 'The key count could not be read'
      })
    ]);
  }

  function jetStreamUnusable(body, d) {
    if (d.jetStream === 'enabled') return false;
    body.appendChild(calloutOf('warn',
      'JetStream is ' + (d.jetStream || 'in an unknown state') + ' on this server.',
      d.message || 'Without JetStream there are no streams: NATS is a plain message bus and nothing is stored.'));
    return true;
  }

  function renderQueueStreams(body, d) {
    if (jetStreamUnusable(body, d)) return;

    body.appendChild(ui.table([
      { key: 'name', label: 'Stream', width: '18%', render: function (r) { return mono(r.name); } },
      {
        key: 'subjects', label: 'Subjects', sortable: false,
        render: function (r) {
          if (!r.subjects || !r.subjects.length) return unknown('The server did not report the subject list for this stream.');
          return el('span.chips', r.subjects.slice(0, 3).map(function (s) { return el('span.chip', { text: s }); }));
        }
      },
      {
        key: 'messages', label: 'Messages', align: 'right',
        render: function (r) { return numNode(r.messages, r.stateUnknownReason); }
      },
      { key: 'bytes', label: 'Bytes', align: 'right', render: function (r) { return bytesNode(r.bytes, r.stateUnknownReason); } },
      {
        key: 'consumerCount', label: 'Consumers', align: 'right',
        render: function (r) { return numNode(r.consumerCount, r.stateUnknownReason); }
      },
      {
        key: 'config', label: 'Retention', sortable: false,
        render: function (r) {
          var c = r.config || {};
          return el('span', { text: (c.retention || '?') + ' / discard ' + (c.discard || '?') + ' / ' + (c.storage || '?') });
        }
      },
      {
        key: 'replicated', label: 'Replicas', status: true,
        render: function (r) {
          var n = (r.config || {}).replicas;
          if (!isNum(n)) return unknown('The server did not report a replica count for this stream.');
          return n > 1 ? ui.pill('R' + n, 'ok') : ui.pill('R1', 'warn', { title: 'One replica, no redundancy: if this node\'s volume is lost, every message in this stream is lost with it.' });
        }
      },
      {
        key: 'fillRatio', label: 'Of max_bytes', align: 'right',
        render: function (r) {
          return ratioNode(r.fillRatio, 'This stream has no max_bytes, so there is no ceiling to be a fraction of.', 0);
        }
      },
      {
        label: 'Attention', sortable: false, status: true,
        render: function (r) {
          if (!r.attention || !r.attention.length) return el('span.muted', { text: 'nothing' });
          var worst = 'info';
          r.attention.forEach(function (a) { if (a.severity === 'bad') worst = 'bad'; else if (a.severity === 'warn' && worst !== 'bad') worst = 'warn'; });
          return ui.pill(fmt.num(r.attention.length) + ' to read', worst, {
            title: r.attention.map(function (a) { return a.message; }).join('\n\n')
          });
        }
      }
    ], d.streams || [], {
      caption: 'JetStream streams, with subjects, messages held, bytes, consumer count, retention policy, replica count, fill against max_bytes and anything needing attention',
      sortKey: 'name',
      rowKey: function (r) { return r.name; },
      empty: 'No stream is defined on this server.'
    }));

    if (d.unreadable && d.unreadable.length) {
      body.appendChild(hint('State could not be established for: ' + d.unreadable.join(', ') +
        '. Those rows show unknown rather than zero.'));
    }
    body.appendChild(hint('Inventory from ' + (d.inventorySource || 'the NATS server') + '.'));
  }

  function renderQueueConsumers(body, d) {
    if (jetStreamUnusable(body, d)) return;

    body.appendChild(ui.table([
      { key: 'stream', label: 'Stream', render: function (r) { return mono(r.stream); } },
      { key: 'name', label: 'Consumer', render: function (r) { return mono(r.name); } },
      {
        key: 'pending', label: 'Not yet delivered', align: 'right',
        render: function (r) { return numNode(r.pending, 'The server did not report a pending count for this consumer.'); }
      },
      {
        key: 'ackPending', label: 'Awaiting ack', align: 'right',
        render: function (r) { return numNode(r.ackPending, 'The server did not report an unacknowledged count for this consumer.'); }
      },
      {
        key: 'waiting', label: 'Pull requests parked', align: 'right',
        render: function (r) { return numNode(r.waiting, 'This is a push consumer, so there are no parked pull requests.'); }
      },
      {
        key: 'redelivered', label: 'Redelivering', align: 'right',
        render: function (r) { return numNode(r.redelivered, 'The server did not report a redelivery count.'); }
      },
      {
        key: 'lastActiveAt', label: 'Last delivery',
        render: function (r) { return timeNode(r.lastActiveAt, 'Nothing has been delivered to this consumer yet.'); }
      },
      {
        label: 'Attention', sortable: false, status: true,
        render: function (r) {
          if (!r.attention || !r.attention.length) return el('span.muted', { text: 'nothing' });
          var worst = 'info';
          r.attention.forEach(function (a) { if (a.severity === 'bad') worst = 'bad'; else if (a.severity === 'warn' && worst !== 'bad') worst = 'warn'; });
          return ui.pill(fmt.num(r.attention.length) + ' to read', worst, {
            title: r.attention.map(function (a) { return a.message; }).join('\n\n')
          });
        }
      }
    ], d.consumers || [], {
      caption: 'JetStream consumers, with messages not yet delivered, messages awaiting acknowledgement, parked pull requests, redeliveries and last delivery',
      sortKey: 'stream',
      rowKey: function (r) { return r.stream + '/' + r.name; },
      empty: 'No consumer is registered on any stream.'
    }));

    if (d.lagNote) body.appendChild(hint(d.lagNote));
    if (d.streamsWithoutConsumers && d.streamsWithoutConsumers.length) {
      body.appendChild(hint('Streams with no consumer: ' + d.streamsWithoutConsumers.join(', ') +
        '. Some are deliberately consumer-less, so this is a fact and not a verdict.'));
    }
  }

  function queuesTab() {
    return el('div.stack', [
      livePanel('Streams', API.queueStreams, renderQueueStreams, {
        ttlMs: 5000, errorTitle: 'The stream list could not be read'
      }),
      livePanel('Consumers', API.queueConsumers, renderQueueConsumers, {
        ttlMs: 5000, errorTitle: 'The consumer list could not be read'
      })
    ]);
  }

  function notFound(kind, name, detail) {
    return ui.emptyState(
      'No ' + kind + ' called ' + name,
      detail || ('The link may be from an older version of the console, or the ' + kind + ' has been removed.'),
      ui.btn('Back to Data', { variant: 'primary', onClick: function () { A.go('data'); } }));
  }

  function renderOneDatabase(body, d, name) {
    var db = findByName(d.databases, name);
    if (!db) {
      body.appendChild(notFound('database', name,
        'This cluster reports ' + fmt.num(d.count) + ' databases and none of them is called ' + name + '. ' +
        'The ones that exist: ' + (d.databases || []).map(function (x) { return x.name; }).join(', ') + '.'));
      return;
    }

    var conns = db.connections || {};
    body.appendChild(el('div.tiles', [
      ui.statTile('Size', tileText(bytesText(db.sizeBytes)), {
        note: isNum(db.sizeBytes) ? 'Measured by the server' : (db.sizeUnknownReason || 'Not measured')
      }),
      ui.statTile('Sessions', tileText(isNum(conns.total) ? fmt.num(conns.total) : null), {
        note: fmt.num(conns.active) + ' active, ' + fmt.num(conns.idleInTransaction) + ' idle in transaction'
      }),
      ui.statTile('Cache hit ratio', tileText(isNum((db.cache || {}).hitRatio) ? fmt.ratioPct(db.cache.hitRatio, 1) : null), {
        note: (db.cache || {}).window || 'No window reported'
      }),
      ui.statTile('Deadlocks', tileText(isNum(db.deadlocks) ? fmt.num(db.deadlocks) : null), {
        note: db.statsResetAt ? 'Since ' + stampOf(db.statsResetAt) : 'Since the statistics were initialised'
      })
    ]));

    body.appendChild(ui.dl([
      ['Owner', mono(db.owner || 'unknown')],
      ['Encoding', el('span', { text: (db.encoding || '?') + ' / ' + (db.collate || '?') })],
      ['Accepts connections', db.allowsConnections ? ui.pill('yes', 'ok') : ui.pill('no', 'idle', { title: 'datallowconn is false, which is normal for template0.' })],
      ['Console may connect', db.consoleCanConnect
        ? ui.pill('yes', 'ok')
        : ui.pill('no', 'idle', { title: 'A deliberate grant in platform/compose/sql/20-grants.sql, not a fault.' })],
      ['Connection limit', isNum(db.connectionLimit) ? el('span.num', { text: fmt.num(db.connectionLimit) }) : el('span.muted', { text: 'none' })],
      ['Backends (statistics collector)', numNode(db.backends, 'pg_stat_database reported no backend count.')],
      ['Temporary bytes written', bytesNode(db.tempBytes, 'No temporary-file total was reported.')],
      ['Transaction id age', numNode(db.transactionIdAge, 'The transaction id age could not be read.')],
      ['Block read time', isNum(db.blockReadMs)
        ? el('span.num', { text: fmt.ms(db.blockReadMs) })
        : unknown('track_io_timing is off on this server, so block time was not measured. This is not zero time.')],
      ['Comment', db.comment ? el('span', { text: db.comment }) : el('span.muted', { text: 'none' })]
    ]));
  }

  function renderDatabaseSessions(body, d, name) {
    var rows = (d.sessions || []).filter(function (s) { return s.database === name; });

    if (d.countsCoverWholeCluster === false) {
      body.appendChild(calloutOf('warn', 'Only this console\'s own sessions are visible.',
        'The console role does not hold pg_read_all_stats, so this list is not the sessions on ' + name + '.'));
    }

    body.appendChild(ui.table([
      { key: 'pid', label: 'PID', align: 'right', render: function (r) { return mono(r.pid); } },
      { key: 'role', label: 'Role', render: function (r) { return r.role ? mono(r.role) : el('span.muted', { text: 'n/a' }); } },
      { key: 'applicationName', label: 'Application', render: function (r) { return r.applicationName ? mono(r.applicationName) : el('span.muted', { text: 'unnamed' }); } },
      {
        key: 'state', label: 'State', status: true,
        render: function (r) {
          if (!r.state) return el('span.muted', { text: r.backendType || 'background' });
          return ui.pill(r.state, r.state === 'active' ? 'ok' : r.state.indexOf('idle in transaction') === 0 ? 'warn' : 'idle');
        }
      },
      { key: 'querySeconds', label: 'Running', align: 'right', render: function (r) { return secondsNode(r.querySeconds, 'Nothing is running in this session.'); } },
      {
        key: 'query', label: 'Statement', width: '34%', sortable: false,
        render: function (r) {
          if (r.queryVisible === false) return el('span.muted', { text: 'hidden from this role' });
          return r.query ? clipped(r.query, 100) : el('span.muted', { text: 'none' });
        }
      }
    ], rows, {
      caption: 'Sessions open on ' + name + ', with role, application, state, how long each statement has run and the statement itself',
      sortKey: 'querySeconds', sortDir: 'desc',
      rowKey: function (r) { return String(r.pid); },
      empty: 'No session is open on ' + name + ' right now.'
    }));
  }

  function renderDatabaseStatements(body, d, name) {
    if (d.available === false) {
      body.appendChild(calloutOf('warn', 'Slow queries are not being recorded: ' + (d.reason || 'unavailable') + '.', d.message));
      return;
    }
    var rows = (d.statements || []).filter(function (s) { return s.database === name; });
    body.appendChild(ui.table([
      { key: 'query', label: 'Statement', width: '44%', sortable: false, render: function (r) { return clipped(r.query, 120); } },
      { key: 'calls', label: 'Calls', align: 'right', render: function (r) { return numNode(r.calls, 'No call count was reported.'); } },
      { key: 'totalMs', label: 'Total time', align: 'right', render: function (r) { return isNum(r.totalMs) ? el('span.num', { text: fmt.ms(r.totalMs) }) : unknown('No execution time was reported.'); } },
      { key: 'meanMs', label: 'Mean', align: 'right', render: function (r) { return isNum(r.meanMs) ? el('span.num', { text: fmt.ms(r.meanMs) }) : unknown('No mean execution time was reported.'); } },
      { key: 'rows', label: 'Rows', align: 'right', render: function (r) { return numNode(r.rows, 'No row count was reported.'); } }
    ], rows, {
      caption: 'Statements recorded against ' + name + ', with call count, total and mean execution time and rows returned',
      sortKey: 'totalMs', sortDir: 'desc',
      rowKey: function (r) { return String(r.queryid); },
      empty: 'No statement has been recorded against ' + name + ' since the counters were last reset.'
    }));
  }

  var WRITE_GRAMMAR = /\b(delete|update|drop|insert|alter|truncate|create|merge|exec|execute|grant|revoke|call|copy|vacuum|reindex|refresh|analyze|cluster)\b/i;
  var SELECT_INTO = /\bselect\b[\s\S]*?\binto\b/i;

  var WRITE_ROUTINE = new RegExp('\\b(' + [
    'pg_terminate_backend', 'pg_cancel_backend',
    'pg_read_file', 'pg_read_binary_file', 'pg_write_file', 'pg_ls_dir', 'pg_sleep',
    'pg_advisory_lock', 'pg_advisory_xact_lock', 'pg_try_advisory_lock',
    'pg_try_advisory_xact_lock', 'pg_advisory_unlock', 'pg_advisory_unlock_all',
    'nextval', 'setval',
    'lo_import', 'lo_export', 'lo_create', 'lo_unlink', 'lo_put',
    'dblink', 'dblink_exec',
    'pg_logical_emit_message', 'pg_create_restore_point', 'pg_switch_wal',
    'pg_reload_conf', 'pg_rotate_logfile', 'pg_stat_reset', 'pg_stat_statements_reset',
    'xp_cmdshell', 'sp_executesql', 'sp_configure',
    'openrowset', 'openquery', 'opendatasource'
  ].join('|') + ')\\b', 'i');

  var LEADING_SELECT = /^\s*(?:with\b[\s\S]*?)?select\b/i;

  function statementsIn(probe) {
    return probe.split(';').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  function stripLiterals(sql) {
    return String(sql)
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/\[[^\]]*\]/g, '[]');
  }

  var ROW_CAP = 100;

  function sampleQuery() {
    return 'SELECT datname, pg_database_size(datname) AS bytes\n' +
      'FROM pg_database\n' +
      'ORDER BY bytes DESC\n' +
      'LIMIT ' + ROW_CAP + ';';
  }

  function queryEditor(name) {
    var editorId = 'queryeditor-' + String(name).replace(/[^a-z0-9]/gi, '-');
    var area = el('textarea.queryeditor', {
      id: editorId, rows: '5', spellcheck: 'false', autocomplete: 'off',
      'aria-describedby': editorId + '-help'
    });
    area.value = sampleQuery();

    var result = el('div.queryresult', {
      role: 'region', 'aria-live': 'off', 'aria-label': 'Query result for ' + name
    });

    function paintIdle() {
      ui.clear(result);
      result.appendChild(ui.emptyState('Nothing has been run',
        'The checks below run in this browser. Nothing is sent anywhere.'));
    }

    function run() {
      var probe = stripLiterals(area.value);

      if (statementsIn(probe).length > 1) {
        A.flash('bad', 'Statement rejected for ' + name,
          'One statement at a time. A batch is refused outright rather than checked statement by statement, ' +
          'because everything after the first semicolon is exactly where a write hides.');
        return;
      }
      if (!LEADING_SELECT.test(probe)) {
        A.flash('bad', 'Statement rejected for ' + name,
          'Only a statement beginning with SELECT is accepted. This is a read-only investigation surface, not a ' +
          'replacement for psql.');
        return;
      }
      if (WRITE_GRAMMAR.test(probe) || SELECT_INTO.test(probe) || WRITE_ROUTINE.test(probe)) {
        A.flash('bad', 'Statement rejected for ' + name,
          'Write grammar is not accepted. That covers DELETE, UPDATE, DROP, INSERT, ALTER and TRUNCATE, and also ' +
          'SELECT ... INTO and routines that write or interrupt a session, both of which begin with SELECT. ' +
          'Change data through a runbook with an approval, not through this box.');
        return;
      }

      ui.clear(result);
      result.appendChild(ui.emptyState(
        'Accepted by the read-only check, and not run',
        'This statement passes the grammar the console enforces. It was not executed: the console API exposes no ' +
          'route that runs a statement, and the role it connects with (pg_monitor, no table privileges) could not ' +
          'read an application table if it did. Run it through psql or a runbook, where it is audited.'));
      result.appendChild(hint('Nothing left this browser. No rows were fetched and no audit record was written, ' +
        'because nothing happened.'));
      A.announce('Statement accepted by the read-only check and not run');
    }

    paintIdle();

    return ui.card('Read-only statement check', el('div.stack', [
      el('div.callout.info', {
        text: 'This box checks a statement against the grammar the console will accept. It does not run anything.'
      }),
      el('label.fieldlabel', { for: editorId, text: 'SELECT statement to check against ' + name }),
      area,
      el('p.hint', {
        id: editorId + '-help',
        text: 'Only a single SELECT is accepted: batches, write grammar, SELECT ... INTO and routines that write or ' +
          'interrupt a session are all refused, including the ones whose names merely contain a blocked word.'
      }),
      el('div.row', [
        ui.btn('Run the read-only check for ' + name, { variant: 'primary', onClick: run }),
        ui.btn('Reset to the sample statement', {
          variant: 'ghost',
          onClick: function () { area.value = sampleQuery(); paintIdle(); }
        })
      ]),
      result
    ]));
  }

  function databaseDetail(mount, name) {
    mount.appendChild(ui.pageHeader(
      name,
      'One database on the PostgreSQL cluster this console reads. Everything below is live.',
      [refreshButton(['database', name])]));

    mount.appendChild(livePanel('Database', API.pgDatabases, function (body, d) {
      renderOneDatabase(body, d, name);
    }, { ttlMs: 10000, errorTitle: 'This database could not be read' }));

    mount.appendChild(livePanel('Sessions on ' + name, API.pgActivity, function (body, d) {
      renderDatabaseSessions(body, d, name);
    }, { ttlMs: 2000, errorTitle: 'Sessions could not be read' }));

    mount.appendChild(livePanel('Slowest statements on ' + name, API.pgStatements, function (body, d) {
      renderDatabaseStatements(body, d, name);
    }, { ttlMs: 15000, errorTitle: 'Statement statistics could not be read' }));

    mount.appendChild(queryEditor(name));
  }

  function renderOneBucket(body, d, name) {
    var b = findByName(d.buckets, name);
    if (!b) {
      body.appendChild(notFound('bucket', name,
        'This object store holds ' + fmt.num(d.count) + ' buckets and none of them is called ' + name + '.'));
      return;
    }

    body.appendChild(el('div.tiles', [
      ui.statTile('Size', tileText(bytesText(b.diskBytes)), {
        note: isNum(b.diskBytes) ? 'From the volume servers' : 'Not measured'
      }),
      ui.statTile('Objects', tileText(isNum(b.objects) ? fmt.num(b.objects) : null), {
        note: isNum(b.objects) ? (b.objectsApprox ? 'Approximate: includes uncompacted deletes' : 'Exact') : 'Not counted'
      }),
      ui.statTile('Object lock', b.lock ? b.lock : 'none', {
        note: b.lock ? fmt.num(b.lockDays) + ' days retention' : 'Objects can be deleted or overwritten'
      }),
      ui.statTile('Volumes', tileText(isNum(b.volumes) ? fmt.num(b.volumes) : null), {
        note: b.volumes === 0 ? 'Nothing has been written here yet' : 'Holding this bucket\'s collection'
      })
    ]));

    if (b.unknownSize && b.unknownSizeReason) {
      body.appendChild(calloutOf('info', 'The size of this bucket is unknown, not zero.', b.unknownSizeReason));
    }

    body.appendChild(ui.dl([
      ['Bucket', mono(b.name)],
      ['Created', timeNode(b.createdAt, 'The creation time was not reported.')],
      ['Owner', b.owner ? mono(b.owner) : unknown('No owning identity is declared for this bucket.')],
      ['Versioning', b.versioning ? ui.pill('on', 'ok') : ui.pill('off', 'idle', { title: 'Without versioning an overwrite is unrecoverable, and object lock has nothing to hold.' })],
      ['Object lock declared', b.lockDeclared ? mono(b.lockDeclared) : el('span.muted', { text: 'none' })],
      ['Object lock in effect', b.lock ? el('span.lockbadge', { text: b.lock + ' \u00b7 ' + fmt.num(b.lockDays) + ' days' }) : el('span.muted', { text: 'none' })],
      ['Replication', b.replication ? el('span', { text: b.replication }) : el('span.muted', { text: 'not configured' })],
      ['Backup', b.backup ? el('span', { text: b.backup.tool + ' ' + b.backup.schedule + ' to ' + b.backup.target }) : el('span.muted', { text: 'none declared' })],
      ['Lifecycle', isNum(b.lifecycleDays) ? el('span', { text: fmt.num(b.lifecycleDays) + ' days' }) : el('span.muted', { text: 'none' })]
    ]));
  }

  function renderBucketLock(body, d, name) {
    var row = findByName(d.buckets, name);

    body.appendChild(el('div.row', [
      ui.pill(d.verdict || 'undetermined', d.verdict === 'enforced' ? 'ok' : 'warn'),
      el('span.muted', { text: d.determined ? 'proven by a real delete attempt' : 'not proven' })
    ]));

    body.appendChild(el('div.callout.' + (d.verdict === 'enforced' ? 'ok' : 'warn'), [
      el('strong', { text: 'Object lock across this object store: ' + (d.verdict || 'undetermined') + '.' }),
      el('p', { text: d.detail || 'No detail was given.' })
    ]));

    if (!row) {
      body.appendChild(ui.emptyState('No lock record for ' + name,
        'The lock probe did not cover this bucket, which normally means object lock was never enabled on it.'));
    } else {
      body.appendChild(ui.dl([
        ['Lock enabled', row.lockEnabled ? ui.pill('yes', 'ok') : ui.pill('no', 'idle')],
        ['Mode in effect', row.mode ? mono(row.mode) : unknown('No mode was reported for this bucket.')],
        ['Retention in effect', isNum(row.days) ? el('span', { text: fmt.num(row.days) + ' days' }) : unknown('No retention period was reported.')],
        ['Declared', row.declared ? mono(row.declared) : el('span.muted', { text: 'nothing declared' })],
        ['Delete probe', row.enforced === 'enforced'
          ? ui.pill('refused the delete', 'ok')
          : ui.pill(row.enforced || 'not probed', 'warn', { title: row.probeError || '' })]
      ]));
    }

    var notes = [];
    if (d.probedAt) notes.push('Probed at ' + stampOf(d.probedAt) + '.');
    if (d.scope) notes.push('Scope: ' + d.scope + '.');
    if (d.profile) notes.push('Profile: ' + d.profile + '.');
    if (d.devOverrides) {
      notes.push('Development overrides are in force: ' + d.devOverrides.mode + ' for ' + d.devOverrides.days +
        ' days, which is not what the declaration asks for and is why a mode below reads GOVERNANCE.');
    }
    if (notes.length) body.appendChild(hint(notes.join(' ')));
  }

  function objectBrowser(name) {
    var body = el('div');
    var alive = true;
    A.onLeave(function () { alive = false; });

    function idle() {
      ui.clear(body);
      body.appendChild(ui.emptyState('Objects are not listed until you ask',
        'Listing walks the bucket, so it happens on a button press rather than on every page load.',
        ui.btn('List the top level of ' + name, { variant: 'primary', onClick: function () { load(''); } })));
    }

    function load(prefix) {
      ui.clear(body);
      body.appendChild(ui.skeleton(4));
      var path = API.storageObjects + '?bucket=' + encodeURIComponent(name) +
        '&prefix=' + encodeURIComponent(prefix || '');

      A.read(path, { ttlMs: 0 }).then(function (env) {
        if (!alive) return;
        ui.clear(body);

        if (env.mode === A.MODE.SAMPLE) {
          body.appendChild(ui.emptyState('Not available on bundled sample data',
            'Listing objects needs the console API. Start it with `npm start` in platform/console/server.'));
          return;
        }
        if (!env.ok) {
          var e = env.error || {};
          if (e.reason === 'http-404') { body.appendChild(notWired(API.storageObjects)); return; }
          body.appendChild(ui.errorState('The listing failed', e.message || 'No reason was given.',
            function () { load(prefix); }));
          return;
        }

        var d = env.data || {};
        body.appendChild(el('div.row', [
          ui.btn('Back to the top level of ' + name, {
            variant: 'ghost', disabled: !prefix, onClick: function () { load(''); }
          }),
          el('span.muted', { text: prefix ? name + '/' + prefix : name + '/' })
        ]));

        if (d.folders && d.folders.length) {
          body.appendChild(el('ul.treelist', { 'aria-label': 'Prefixes under ' + (prefix || 'the top level') },
            d.folders.map(function (f) {
              return el('li.treelist-item', [
                ui.btn(f, { variant: 'ghost', onClick: function () { load(f); } })
              ]);
            })));
        }

        body.appendChild(ui.table([
          { key: 'key', label: 'Key', width: '46%', render: function (r) { return clipped(r.key, 90); } },
          { key: 'sizeBytes', label: 'Size', align: 'right', render: function (r) { return bytesNode(r.diskBytes, 'The listing returned no size for this object.'); } },
          { key: 'modifiedAt', label: 'Modified', render: function (r) { return timeNode(r.modifiedAt, 'The listing returned no modification time.'); } },
          { key: 'storageClass', label: 'Class', render: function (r) { return r.storageClass ? mono(r.storageClass) : el('span.muted', { text: 'default' }); } }
        ], d.objects || [], {
          caption: 'Objects directly under ' + (prefix || 'the top level') + ' of ' + name + ', with size, last modification and storage class',
          sortKey: 'key',
          rowKey: function (r) { return r.key; },
          empty: (d.folders && d.folders.length)
            ? 'No object sits directly at this level; the prefixes above hold them.'
            : 'This level holds no objects.'
        }));

        if (d.truncated) {
          body.appendChild(hint('The listing was cut at ' + fmt.num(d.pageSize) +
            ' entries. Narrow it with a prefix rather than paging through a bucket from a browser.'));
        }
        if (d.keyRepair && d.keyRepair.applied) {
          body.appendChild(hint('Key names on this listing were corrected before display: ' + d.keyRepair.reason));
        }
        body.appendChild(hint('Listed at ' + (stampOf(d.at) || 'an unrecorded time') + '.'));
      });
    }

    idle();
    return ui.card('Objects', body);
  }

  function bucketDetail(mount, name) {
    mount.appendChild(ui.pageHeader(
      name,
      'One bucket in the object store this platform runs. Everything below is live.',
      [refreshButton(['bucket', name])]));

    mount.appendChild(livePanel('Bucket', API.storageBuckets, function (body, d) {
      renderOneBucket(body, d, name);
    }, { ttlMs: 15000, errorTitle: 'This bucket could not be read' }));

    mount.appendChild(livePanel('Object lock', API.storageLock, function (body, d) {
      renderBucketLock(body, d, name);
    }, { ttlMs: 60000, errorTitle: 'The object lock state could not be read' }));

    mount.appendChild(objectBrowser(name));
  }

  registerScreen('data', {
    title: 'Data',
    crumb: 'Data',
    render: function (mount, ctx) {
      var rest = (ctx && ctx.rest) || [];

      if (rest[0] === 'database' && rest[1]) { databaseDetail(mount, rest[1]); return; }
      if (rest[0] === 'bucket' && rest[1]) { bucketDetail(mount, rest[1]); return; }

      mount.appendChild(ui.pageHeader(
        'Data',
        'The databases, object store, cache and queues this platform runs, read live through the console API.',
        [refreshButton(rest)]));

      var banner = el('div');
      mount.appendChild(banner);
      var alive = true;
      A.onLeave(function () { alive = false; });
      A.probe().then(function () { if (alive) renderBanner(banner); });

      mount.appendChild(ui.tabs([
        { id: 'databases', label: 'Databases', render: databasesTab },
        { id: 'buckets', label: 'Object storage', render: bucketsTab },
        { id: 'cache', label: 'Cache', render: cacheTab },
        { id: 'queues', label: 'Queues', render: queuesTab }
      ], {
        label: 'Data stores',
        initial: rest[0] || null
      }));
    }
  });

  function renderBanner(mount) {
    ui.clear(mount);

    if (A.storeMode() !== A.MODE.LIVE) {
      mount.appendChild(el('div.callout.warn', [
        el('strong', { text: 'The console API is not running, so this screen has nothing to read.' }),
        el('p', {
          text: 'This screen reads PostgreSQL, the object store, Garnet and NATS through the console API. Start it ' +
            'with `npm start` in platform/console/server and open the console it serves. The panels below say ' +
            'which endpoint each one needs.'
        })
      ]));
      return;
    }

    var caps = A.capabilities() || {};
    mount.appendChild(el('div.callout.info', [
      el('strong', { text: 'Live data.' }),
      el('p', {
        text: 'Every figure below was read from a running service and carries the time it was measured. ' +
          (caps.writesAllowed
            ? 'This console is permitted to make changes.'
            : 'This console is read-only: it refuses every request that would change anything, before the route is ' +
              'even looked up.')
      })
    ]));
  }
})();
