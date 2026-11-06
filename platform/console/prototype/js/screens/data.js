(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

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

    queueStreams: '/api/queues/streams',
    queueConsumers: '/api/queues/consumers'
  };

  function unknown(reason) {
    return el('span.muted', {
      text: 'unknown',
      title: reason || 'The server did not report this value, so nothing is shown in its place.'
    });
  }

  function mono(text) { return el('span.mono', { text: String(text) }); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function bytesText(n) {
    return isNum(n) ? fmt.bytes(n) : null;
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
    var limit = max || 110;
    if (s.length <= limit) return mono(s);
    return el('span.mono', { text: s.slice(0, limit) + '\u2026', title: s });
  }

  function hint(text) { return el('p.hint', { text: text }); }

  function cap(t) { t = String(t); return t.charAt(0).toUpperCase() + t.slice(1); }

  function pill(text, tone, opts) { return ui.status(tone, cap(text), opts); }

  function tile(label, value, opts) {
    opts = opts || {};
    return [label, el('div.col', [
      el('span', { text: String(value) + (opts.unit ? ' ' + opts.unit : '') }),
      opts.note ? el('span.hint', { text: opts.note }) : null
    ])];
  }

  function figures(list) {
    var node = ui.dl(list);
    node.style.marginBottom = 'var(--s-m)';
    return node;
  }


  function details(list) {
    var nodes = (list || []).filter(Boolean).map(function (t) {
      return typeof t === 'string' ? el('p', { text: t }) : t;
    });
    return nodes.length ? ui.disclosure('Details', nodes) : document.createDocumentFragment();
  }

  function calloutOf(tone, title, text) {
    var long = tone === 'info' && text && String(text).length > 140;
    return el('div.callout.' + tone, [
      el('strong', { text: title }),
      text && !long ? el('p', { text: text }) : null,
      long ? ui.disclosure('Details', [el('p', { text: text })]) : null
    ]);
  }

  function livePanel(title, path, render, opts) {
    opts = opts || {};
    return A.livePanel(title, path, render, {
      ttlMs: opts.ttlMs, skeletonRows: opts.skeletonRows,
      card: { flush: opts.flush, actions: opts.actions, description: opts.description }
    });
  }

  function refreshButton(rest) {
    var live = true;
    var b = ui.btn('Refresh', {
      title: 'Drop every cached read and ask the services again.',
      onClick: function () {
        if (!live) {
          A.flash('info', 'There is nothing to refresh',
            'No console API answered, so nothing here was read from one.', { timeout: 6000 });
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
    body.appendChild(figures([
      tile('Role', tileText(d.role), { note: 'One cluster; see Replication' }),
      tile('Version', tileText(d.version), { note: 'Reported by the server' }),
      tile('Uptime', isNum(d.uptimeSeconds) ? fmt.dur(d.uptimeSeconds) : 'unknown', {
        note: 'Since postmaster start'
      }),
      tile('Round trip', isNum(d.latencyMs) ? fmt.ms(d.latencyMs) : 'unknown', {
        note: 'SELECT 1 from this console'
      })
    ]));

    var cols = [
      { key: 'name', label: 'Check', width: '22%' },
      {
        key: 'ok', label: 'Verdict', status: true,
        sort: function (r) { return r.ok === false ? 0 : r.ok === true ? 2 : 1; },
        render: function (r) {
          if (r.ok === true) return pill('passed', 'ok');
          if (r.ok === false) return pill('attention', 'bad');
          return pill('not applicable', 'idle', { title: 'This check has no pass or fail here; read the detail.' });
        }
      },
      { key: 'detail', label: 'Detail', render: function (r) { return el('span', { text: r.detail || '' }); } }
    ];

    body.appendChild(ui.table(cols, d.components || [], {
      caption: 'PostgreSQL health checks, each with its verdict and the detail behind it',
      rowKey: function (r) { return r.name; },
      empty: 'The health reader returned no components, which should not happen.'
    }));

    body.insertBefore(el('p', { style: { 'margin-bottom': 'var(--s-s)' } }, [
      d.degraded ? ui.status('bad', 'At least one check needs attention') : ui.status('ok', 'No check is failing'),
      el('span.muted', { text: ' · Deadlocks since reset: ' + (isNum(d.deadlocksSinceStatsReset) ? fmt.num(d.deadlocksSinceStatsReset) : 'not reported') })
    ]), body.firstChild);
  }

  function renderPgReplication(body, d) {
    if (!d.configured) {
      body.appendChild(el('div.callout.info', [
        el('strong', { text: 'Not configured. There is one node.' })
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
          ? pill('yes', 'idle', { title: 'A setting, not an observation.' })
          : pill('no', 'warn', { title: 'wal_level cannot feed a standby as configured.' })],
        ['max_wal_senders', numNode(c.maxWalSenders, 'max_wal_senders was not reported.')],
        ['archive_mode', c.archiveMode ? mono(c.archiveMode) : unknown('archive_mode was not reported.')],
        ['synchronous_commit', c.synchronousCommit ? mono(c.synchronousCommit) : unknown('synchronous_commit was not reported.')]
      ]));

      body.appendChild(details([d.message || null, c.note ||
        'These are settings, not observations: they say this server could accept a standby, not that one exists.']));
      return;
    }

    body.appendChild(el('div.callout.ok', [
      el('strong', { text: d.state || 'Replicating' }),
      el('p', { text: 'Role ' + (d.role || 'unknown') + '. Every lag below was measured against this server\'s current WAL position.' })
    ]));

    body.appendChild(ui.table([
      { key: 'applicationName', label: 'Standby', render: function (r) { return mono(r.applicationName || r.clientAddr || ('pid ' + r.pid)); } },
      { key: 'state', label: 'State', status: true, render: function (r) { return pill(r.state || 'unknown', r.state === 'streaming' ? 'ok' : 'warn'); } },
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
        { key: 'active', label: 'Active', status: true, render: function (r) { return r.active ? pill('active', 'ok') : pill('inactive', 'bad', { title: r.warning || '' }); } },
        { key: 'walStatus', label: 'WAL status', render: function (r) { return el('span', { text: r.walStatus || 'unknown' }); } },
        { key: 'retainedWalBytes', label: 'WAL retained', align: 'right', render: function (r) { return bytesNode(r.retainedWalBytes, 'The server did not report retained WAL for this slot.'); } }
      ], d.slots, {
        caption: 'Replication slots, with whether they are connected and how much WAL each is holding',
        rowKey: function (r) { return r.name; },
        empty: 'No replication slot exists.'
      }));
      body.appendChild(details(['An inactive slot retains WAL indefinitely for a consumer that is gone, which is the classic way a PostgreSQL volume fills.']));
    }
  }

  var dbTable = null;

  function renderPgDatabases(body, d) {
    var list = d.databases || [];

    body.appendChild(figures([
      tile(d.sizesComplete ? 'Total size' : 'Size measured so far',
        tileText(bytesText(d.sizesComplete ? d.totalSizeBytes : d.measuredSizeBytes)), {
          note: d.sizesComplete
            ? 'Every database reported a size'
            : fmt.num(d.measuredCount) + ' of ' + fmt.num(d.count) + ' databases reported a size'
        }),
      tile('Block I/O timing', d.ioTimingMeasured ? 'measured' : 'off', {
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
        render: function (r) { return bytesNode(r.sizeBytes, r.sizeUnknownReason); }
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
          if (r.consoleCanConnect) return pill('can connect', 'ok');
          return pill('no access', 'idle', {
            title: r.allowsConnections === false
              ? 'This database does not accept connections at all (datallowconn is false), which is normal for template0.'
              : 'The console role was not granted CONNECT on this database. That is a deliberate grant in platform/compose/sql/20-grants.sql, not a fault.'
          });
        }
      }
    ];

    dbTable = ui.table(cols, list, {
      id: 'data.databases', defaultHidden: ['backends', 'tempBytes'],
      caption: 'Databases on this cluster, with owner, size, sessions, backends, cache hit ratio, deadlocks, temporary bytes written and whether the console may connect',
      sortKey: 'sizeBytes', sortDir: 'desc',
      rowKey: function (r) { return r.name; },
      empty: 'This cluster reported no databases, which should not happen.'
    });
    body.appendChild(dbTable);

    body.appendChild(details([d.ioTimingNote || null, d.sizeError ? 'Sizes: ' + d.sizeError : null]));
  }

  function renderPgActivity(body, d) {
    var s = d.summary || {};

    if (d.countsCoverWholeCluster === false) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'These counts cover only this console\'s own sessions.' })
      ]));
    }

    body.appendChild(figures([
      tile('Client backends', tileText(isNum(s.clientBackends) ? fmt.num(s.clientBackends) : null), {
        note: isNum(s.maxConnections) ? 'of ' + fmt.num(s.maxConnections) + ' max_connections' : 'max_connections not reported'
      }),
      tile('Active', tileText(isNum(s.active) ? fmt.num(s.active) : null), { note: 'Running a statement now' }),
      tile('Idle in transaction', tileText(isNum(s.idleInTransaction) ? fmt.num(s.idleInTransaction) : null), {
        note: 'Holds a snapshot and blocks vacuum cluster-wide'
      }),
      tile('Waiting on a lock', tileText(isNum(s.waitingOnLock) ? fmt.num(s.waitingOnLock) : null), {
        note: 'Blocked by another session'
      }),
      tile('Longest transaction',
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
          return pill(r.state, tone);
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
          return pill(r.blockedBy.join(', '), 'bad', { title: 'Process ids holding the lock this session wants.' });
        }
      }
    ], d.sessions || [], {
      caption: 'Sessions on this cluster, with database, role, state, what each is waiting on, how long its statement has run and what is blocking it',
      sortKey: 'querySeconds', sortDir: 'desc',
      rowKey: function (r) { return String(r.pid); },
      empty: 'No session is open other than this console\'s own read.'
    }));

    body.appendChild(details([
      d.countsCoverWholeCluster === false
        ? 'The console role does not hold pg_read_all_stats, so pg_stat_activity hides other roles\' sessions and ' +
          'blanks their query text. A cluster running two hundred backends would still read as a handful here. ' +
          'Run platform/compose/sql/20-grants.sql to fix it.'
        : null,
      d.listTruncated ? 'The list is capped at ' + fmt.num(d.listLimit) + ' sessions; the counts above are not capped and cover every backend.' : null,
      isNum(d.redactedSessions) && d.redactedSessions > 0
        ? fmt.num(d.redactedSessions) + ' sessions had their query text withheld from this role. They are listed, but their statements are not readable here.'
        : null
    ]));
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
    body.appendChild(details(notes));
  }

  function renderPgRoles(body, d) {
    var complete = d.sessionCountsCoverWholeCluster === true;

    body.appendChild(ui.table([
      { key: 'name', label: 'Role', render: function (r) { return mono(r.name); } },
      {
        key: 'predefined', label: 'Kind', status: true,
        render: function (r) {
          return r.predefined
            ? pill('predefined', 'idle', { title: 'One of PostgreSQL\'s own roles, not created by this platform.' })
            : pill('local', 'info');
        }
      },
      {
        key: 'superuser', label: 'Superuser', status: true,
        render: function (r) { return r.superuser ? pill('superuser', 'bad', { title: 'Bypasses every permission check.' }) : el('span.muted', { text: 'no' }); }
      },
      {
        key: 'canLogin', label: 'Login', status: true,
        render: function (r) { return r.canLogin ? pill('can log in', 'warn') : el('span.muted', { text: 'group only' }); }
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

    body.appendChild(details([d.passwordsNotReported ||
      'Whether a role has a password is in pg_authid, which only a superuser may read, so it is not reported here.']));
  }

  function counted(title, path, render, count, opts) {
    var card = null;
    card = livePanel(title, path, function (body, d, env) {
      var n = count(d);
      var row = card.querySelector('.card-titlerow');
      if (row && isNum(n) && !row.querySelector('.card-counter')) row.appendChild(el('span.card-counter', { text: '(' + fmt.num(n) + ')' }));
      render(body, d, env);
      if (opts && opts.onDraw) opts.onDraw(card);
    }, opts);
    return card;
  }

  function sampleGate(fn) {
    return function () {
      var mode = A.storeMode();
      if (mode === A.MODE.LIVE) return fn();
      if (mode === A.MODE.SAMPLE) return sampleBlock();
      var host = el('div', [ui.skeleton(3)]);
      A.whenProbed(function (m) {
        ui.clear(host);
        host.appendChild(m === A.MODE.LIVE ? fn() : sampleBlock());
      });
      return host;
    };
  }

  function sampleBlock() {
    return ui.stateBlock('sample', {
      reason: 'sample-mode',
      detail: 'These stores are read live through the console API; there is no sample data for them. Open the console the API serves and sign in.'
    });
  }

  function databasesTab() {
    return el('div.grid', [
      el('div.grid.grid-2', [
        livePanel('Cluster health', API.pgHealth, renderPgHealth, { ttlMs: 10000 }),
        livePanel('Replication', API.pgReplication, renderPgReplication, { ttlMs: 10000 })
      ]),
      counted('Databases', API.pgDatabases, renderPgDatabases, function (d) { return d.count; }, {
        ttlMs: 10000,
        onDraw: function (card) {
          var row = card.querySelector('.card-head');
          if (!row || row.querySelector('.card-actions')) return;
          row.appendChild(el('div.card-actions', [ui.columnsButton(function () { return dbTable; }, 'databases'), ui.exportButton(function () { return dbTable; }, 'databases')]));
        }
      })
    ]);
  }

  function sessionsTab() {
    return counted('Sessions', API.pgActivity, renderPgActivity, function (d) { return (d.sessions || []).length; }, { ttlMs: 2000 });
  }

  function statementsTab() {
    return counted('Slowest statements', API.pgStatements, renderPgStatements, function (d) { return d.available === false ? null : (d.statements || []).length; }, { ttlMs: 15000 });
  }

  function rolesTab() {
    return counted('Roles', API.pgRoles, renderPgRoles, function (d) { return (d.roles || []).length; }, { ttlMs: 30000 });
  }

  function renderStorageSummary(body, d) {
    var list = d.buckets || [];
    var known = list.filter(function (b) { return !b.unknownSize && isNum(b.diskBytes); });
    var total = known.reduce(function (n, b) { return n + b.diskBytes; }, 0);
    var locked = list.filter(function (b) { return b.lock; }).length;
    var drift = d.drift || {};
    var off = (drift.declaredButMissing || []).length + (drift.existsButUndeclared || []).length;
    body.appendChild(ui.dl([
      ['Buckets', fmt.num(list.length)],
      ['On disk', known.length ? 'About ' + fmt.bytes(total) + ' across ' + fmt.num(known.length) + ' measured' : 'None measured'],
      ['Object lock', fmt.num(locked)],
      ['Out of step with buckets.yaml', off ? pill(fmt.num(off), 'warn') : '0']
    ]));
    body.appendChild(el('p', { style: { 'margin-top': 'var(--s-s)' } }, A.link('View buckets on Object storage', 'storage')));
  }

  function bucketsTab() {
    return livePanel('Object storage', API.storageBuckets, renderStorageSummary, { ttlMs: 15000, skeletonRows: 1 });
  }

  var SPILL_WARN = 0.5;
  var SPILL_BAD = 0.9;

  function spillTone(ratio) {
    if (!isNum(ratio)) return null;
    return ratio >= SPILL_BAD ? 'bad' : ratio >= SPILL_WARN ? 'warn' : null;
  }

  function renderCacheServer(body, d) {
    var srv = d.server || {}, tp = d.throughput || {}, id = d.identity || {}, clock = d.clock || {};

    body.appendChild(figures([
      tile('Operations', tileText(metricText(tp.opsPerSec)), {
        unit: isNum(tp.opsPerSec && tp.opsPerSec.value) ? '/s' : null,
        note: isNum(tp.opsPerSec && tp.opsPerSec.value)
          ? 'Sampled by the server'
          : 'The metrics sampling task is off, so nothing is sampling this'
      }),
      tile('Commands processed', tileText(metricText(tp.totalCommandsProcessed)), { note: 'Since this server started' }),
      tile('Uptime', tileText(metricText(srv.uptimeSeconds, function (v) { return fmt.dur(v); })), {
        note: 'Garnet starts cold on every boot'
      }),
      tile('Probe', tileText(isNum(d.probeMs) ? fmt.ms(d.probeMs) : null), { note: 'One connection, one pass' })
    ]));

    body.appendChild(ui.dl([
      ['Endpoint', mono(d.endpoint || 'unknown')],
      ['Garnet version', textMetricNode(srv.garnetVersion)],
      ['RESP compatibility', textMetricNode(srv.redisCompatVersion)],
      ['Authenticated as', id.user
        ? el('span', [mono(id.user), id.matches === false
          ? pill('not the expected user', 'warn', { title: 'Expected ' + id.expected + '. The console is holding whatever grants that other rule has.' })
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

    body.appendChild(figures([
      tile('Spill ratio', tileText(isNum(d.spillRatio) ? fmt.ratioPct(d.spillRatio, 1) : null), {
        note: isNum(d.spillRatio)
          ? 'Worst log: ' + (d.spillRatioLog || 'unnamed')
          : (d.spillUnavailable ? 'Not computable on this server' : 'No log has anything in it yet')
      }),
      tile('Container memory', tileText(isNum(c.usedRatio) ? fmt.ratioPct(c.usedRatio, 0) : null), {
        note: isNum(c.processBytes)
          ? bytesText(c.processBytes) + (isNum(c.limitBytes) ? ' of ' + bytesText(c.limitBytes) : ', no limit known')
          : 'The process size could not be read'
      }),
      tile('Logs reported', tileText(d.logs ? fmt.num(d.logs.length) : null), {
        note: 'Main store and object store are separate logs'
      }),
      tile('Spilling to disk', d.spilling === null || d.spilling === undefined ? 'unknown' : (d.spilling ? 'yes' : 'no'), {
        note: d.spillDirectory && d.spillDirectory.value ? 'Directory: ' + d.spillDirectory.value : 'Spill directory not reported'
      })
    ]));

    if (isNum(d.spillRatio)) {
      body.appendChild(ui.bar(d.spillRatio, {
        tone: spillTone(d.spillRatio),
        label: 'Spill ratio: ' + fmt.ratioPct(d.spillRatio, 0) + ' of the live log is on disk (' + (d.spillRatioLog || 'worst log') + ')'
      }));
      body.appendChild(details(['Spilled records are still live and still served; reading one is a disk read rather than a miss. ' +
        'Nothing has been lost. What eventually does lose keys is the segment cap, which deletes the oldest segment whole ' +
        'when the spill area is full. That is a disk ceiling, by age of write, not memory pressure.']));
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
    body.appendChild(details(['maxmemory: ' + (mm.configured ? String(mm.value) : 'not configured') + '. ' + (mm.evidence || ''), c.note || null]));
  }

  function renderCacheKeyspace(body, d) {
    body.appendChild(figures([
      tile('Keys', tileText(isNum(d.keys) ? fmt.num(d.keys) : null), {
        note: isNum(d.keys) ? 'One logical database' : 'Not readable'
      })
    ]));

    if (!isNum(d.keys) && d.keysUnavailable) {
      body.appendChild(calloutOf('warn', 'The key count could not be read.', d.keysUnavailable));
    }

    body.appendChild(details([
      isNum(d.keys) || !d.keysUnavailable ? d.keysNote || null : null,
      d.byPrefix && d.byPrefix.available === false
        ? 'There is no per-prefix breakdown, and there is not supposed to be. ' + (d.byPrefix.message || '')
        : null,
      d.keyIsolationNote || null
    ]));
  }

  function renderCacheHealth(body, d) {
    var tone = d.status === 'ok' ? 'ok'
      : d.status === 'insecure' ? 'bad'
        : d.status === 'degraded' ? 'warn'
          : d.status === 'not-configured' ? 'idle' : 'bad';

    body.appendChild(el('div.row', [
      pill(d.status || 'unknown', tone),
      pill(d.reachable ? 'reachable' : 'not reachable', d.reachable ? 'ok' : 'bad'),
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

    body.appendChild(details((d.notes || []).concat([d.scope || null])));
  }

  function cacheTab() {
    return el('div.stack', [
      livePanel('Cache health', API.cacheHealth, renderCacheHealth, {
        ttlMs: 10000
      }),
      livePanel('Memory and spill', API.cacheMemory, renderCacheMemory, {
        ttlMs: 10000
      }),
      livePanel('Server', API.cacheServer, renderCacheServer, {
        ttlMs: 10000
      }),
      livePanel('Keyspace', API.cacheKeyspace, renderCacheKeyspace, {
        ttlMs: 120000
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
          return n > 1 ? pill('R' + n, 'ok') : pill('R1', 'warn', { title: 'One replica, no redundancy: if this node\'s volume is lost, every message in this stream is lost with it.' });
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
          return pill(fmt.num(r.attention.length) + ' to read', worst, {
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
    body.appendChild(details(['Inventory from ' + (d.inventorySource || 'the NATS server') + '.']));
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
          return pill(fmt.num(r.attention.length) + ' to read', worst, {
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

    body.appendChild(details([
      d.lagNote || null,
      d.streamsWithoutConsumers && d.streamsWithoutConsumers.length
        ? 'Streams with no consumer: ' + d.streamsWithoutConsumers.join(', ') + '. Some are deliberately consumer-less, so this is a fact and not a verdict.'
        : null
    ]));
  }

  function queuesTab() {
    return el('div.stack', [
      livePanel('Streams', API.queueStreams, renderQueueStreams, {
        ttlMs: 5000
      }),
      livePanel('Consumers', API.queueConsumers, renderQueueConsumers, {
        ttlMs: 5000
      })
    ]);
  }

  function goneSince(kind, name) {
    return ui.stateBlock('notFound', {
      reason: 'unknown-id',
      detail: 'No ' + kind + ' called ' + name + ' is in this answer. It may have been removed since the page opened.'
    });
  }

  function whenItExists(mount, path, listKey, kind, name, paint) {
    if (A.storeMode() === A.MODE.SAMPLE) { paint(); return; }
    var holder = el('div', [ui.skeleton(3)]);
    mount.appendChild(holder);
    var alive = true;
    A.onLeave(function () { alive = false; });
    A.read(path, { ttlMs: 15000 }).then(function (env) {
      if (!alive) return;
      if (holder.parentNode) holder.parentNode.removeChild(holder);
      if (A.envelopeState(env) === 'ok' && env.data && !findByName(env.data[listKey], name)) {
        mount.appendChild(ui.notFound(kind, name, 'data', 'Back to Data'));
        return;
      }
      paint();
    });
  }

  function renderOneDatabase(body, d, name) {
    var db = findByName(d.databases, name);
    if (!db) { body.appendChild(goneSince('database', name)); return; }

    var conns = db.connections || {};
    body.appendChild(figures([
      tile('Size', tileText(bytesText(db.sizeBytes)), {
        note: isNum(db.sizeBytes) ? 'Measured by the server' : (db.sizeUnknownReason || 'Not measured')
      }),
      tile('Sessions', tileText(isNum(conns.total) ? fmt.num(conns.total) : null), {
        note: fmt.num(conns.active) + ' active, ' + fmt.num(conns.idleInTransaction) + ' idle in transaction'
      }),
      tile('Cache hit ratio', tileText(isNum((db.cache || {}).hitRatio) ? fmt.ratioPct(db.cache.hitRatio, 1) : null), {
        note: (db.cache || {}).window || 'No window reported'
      }),
      tile('Deadlocks', tileText(isNum(db.deadlocks) ? fmt.num(db.deadlocks) : null), {
        note: db.statsResetAt ? 'Since ' + stampOf(db.statsResetAt) : 'Since the statistics were initialised'
      })
    ]));

    body.appendChild(ui.dl([
      ['Owner', mono(db.owner || 'unknown')],
      ['Encoding', el('span', { text: (db.encoding || '?') + ' / ' + (db.collate || '?') })],
      ['Accepts connections', db.allowsConnections ? pill('yes', 'ok') : pill('no', 'idle', { title: 'datallowconn is false, which is normal for template0.' })],
      ['Console may connect', db.consoleCanConnect
        ? pill('yes', 'ok')
        : pill('no', 'idle', { title: 'A deliberate grant in platform/compose/sql/20-grants.sql, not a fault.' })],
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
          return pill(r.state, r.state === 'active' ? 'ok' : r.state.indexOf('idle in transaction') === 0 ? 'warn' : 'idle');
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
    whenItExists(mount, API.pgDatabases, 'databases', 'database', name, function () {
      mount.appendChild(ui.pageHeader(name, 'PostgreSQL database', [refreshButton(['database', name])]));

      if (A.storeMode() === A.MODE.SAMPLE) {
        mount.appendChild(el('div.grid', [sampleBlock(), queryEditor(name)]));
        return;
      }
      mount.appendChild(el('div.grid', [
        livePanel('Details', API.pgDatabases, function (body, d) {
          renderOneDatabase(body, d, name);
        }, { ttlMs: 15000 }),
        livePanel('Sessions', API.pgActivity, function (body, d) {
          renderDatabaseSessions(body, d, name);
        }, { ttlMs: 2000 }),
        livePanel('Slowest statements', API.pgStatements, function (body, d) {
          renderDatabaseStatements(body, d, name);
        }, { ttlMs: 15000, description: 'Since the counters were reset.' }),
        queryEditor(name)
      ]));
    });
  }

  function renderOneBucket(body, d, name) {
    var b = findByName(d.buckets, name);
    if (!b) { body.appendChild(goneSince('bucket', name)); return; }
    body.appendChild(ui.dl([
      ['Size on disk', b.unknownSize || !isNum(b.diskBytes) ? unknown('Not measured.') : 'About ' + fmt.bytes(b.diskBytes)],
      ['Object lock', b.lock ? b.lock + ' for ' + fmt.num(b.lockDays) + ' days' : 'None'],
      ['Versioning', b.versioning ? pill('on', 'ok') : pill('off', 'idle')]
    ]));
  }

  function bucketDetail(mount, name) {
    whenItExists(mount, API.storageBuckets, 'buckets', 'bucket', name, function () {
      mount.appendChild(ui.pageHeader(name, 'Bucket', [refreshButton(['bucket', name])]));
      if (A.storeMode() === A.MODE.SAMPLE) { mount.appendChild(sampleBlock()); return; }
      mount.appendChild(livePanel('Bucket', API.storageBuckets, function (body, d) {
        renderOneBucket(body, d, name);
        body.appendChild(el('p', { style: { 'margin-top': 'var(--s-s)' } }, A.link('Browse ' + name + ' on Object storage', 'storage', null, { bucket: name })));
      }, { ttlMs: 15000, skeletonRows: 1 }));
    });
  }

  var CRUMB = { databases: 'Databases', sessions: 'Sessions', statements: 'Statements', roles: 'Roles', buckets: 'Object storage', cache: 'Cache', queues: 'Queues' };

  function dataCrumbs(rest) {
    if (rest[0] === 'database' && rest[1]) return [{ label: 'Databases', href: A.href('data', ['databases']) }, rest[1]];
    if (rest[0] === 'bucket' && rest[1]) return [{ label: 'Buckets', href: A.href('data', ['buckets']) }, rest[1]];
    return rest.slice(0, 1).map(function (r) { return Object.prototype.hasOwnProperty.call(CRUMB, r) ? CRUMB[r] : r; });
  }

  A.screen('data', {
    title: 'Data',
    crumb: 'Data',
    crumbs: dataCrumbs,
    liveCrumbs: dataCrumbs,
    render: function (mount, ctx) {
      var rest = (ctx && ctx.rest) || [];

      if (rest[0] === 'database' && rest[1]) { databaseDetail(mount, rest[1]); return; }
      if (rest[0] === 'bucket' && rest[1]) { bucketDetail(mount, rest[1]); return; }

      mount.appendChild(ui.pageHeader('Data', null, [refreshButton(rest)]));

      mount.appendChild(ui.tabs([
        { id: 'databases', label: 'Databases', render: sampleGate(databasesTab) },
        { id: 'sessions', label: 'Sessions', render: sampleGate(sessionsTab) },
        { id: 'statements', label: 'Statements', render: sampleGate(statementsTab) },
        { id: 'roles', label: 'Roles', render: sampleGate(rolesTab) },
        { id: 'buckets', label: 'Object storage', render: sampleGate(bucketsTab) },
        { id: 'cache', label: 'Cache', render: sampleGate(cacheTab) },
        { id: 'queues', label: 'Queues', render: sampleGate(queuesTab) }
      ], {
        label: 'Data stores',
        initial: rest[0] || null,
        href: function (id) { return A.href('data', [id]); }
      }));
    }
  });
})();
