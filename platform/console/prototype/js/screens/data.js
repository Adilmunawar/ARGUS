/* Argus Console: Data.
 *
 * Databases, object storage, cache and queues, plus the two detail screens an
 * operator actually lands on from an alert: a database and a bucket.
 *
 * Two rules shape this file:
 *  - Nothing here is built from an HTML string. Bucket names, prefixes, stream
 *    names and query text all come from outside the product, and one innerHTML
 *    on that path is a stored XSS in an admin tool.
 *  - Every picture (the backup band, the AG topology) carries a text
 *    equivalent, because a screenshot of a backup chain that a screen reader
 *    cannot read is decoration, not evidence.
 *
 * Classic script, no modules, ES5 only: the console opens from file:// with no
 * build step and no network (ADR-0027).
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, d = A.data;
  var fmt = ui.fmt;

  var DAY_MS = 86400000;
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* ---------------------------------------------------------- helpers --- */

  function chips(list, empty) {
    if (!list || !list.length) return el('span.muted', { text: empty || 'none' });
    return el('span.chips', list.map(function (t) { return el('span.chip', { text: t }); }));
  }

  function mono(text) { return el('span.mono', { text: text }); }

  function dbByName(name) {
    return d.databases.filter(function (x) { return x.name === name; })[0];
  }
  function bucketByName(name) {
    return d.buckets.filter(function (x) { return x.name === name; })[0];
  }

  function notFound(kind, name) {
    return ui.emptyState(
      'No ' + kind + ' called ' + name,
      'The link may be from an older version of the console, or the ' + kind + ' has been removed.',
      ui.btn('Back to Data', { variant: 'primary', onClick: function () { A.go('data'); } }));
  }

  function agTone(state) { return state === 'synchronising' ? 'ok' : 'idle'; }

  var SIMPLE_TITLE =
    'SIMPLE recovery truncates the transaction log at every checkpoint, so there is no log chain and no point-in-time recovery: a restore can only reach the last full or differential backup.';

  function recoveryPill(db) {
    if (db.recovery === 'SIMPLE') return ui.pill('SIMPLE', 'warn', { title: SIMPLE_TITLE });
    return ui.pill(db.recovery, 'idle');
  }

  /* ------------------------------------------------------ databases tab --- */

  function databasesTab() {
    var simple = d.databases.filter(function (x) { return x.recovery === 'SIMPLE'; });

    var cols = [
      {
        key: 'name', label: 'Database', width: '20%',
        render: function (r) { return A.link(r.name, 'data', ['database', r.name]); }
      },
      { key: 'engine', label: 'Engine' },
      {
        key: 'host', label: 'Host',
        render: function (r) { return mono(r.host); }
      },
      {
        key: 'sizeGB', label: 'Size', align: 'right',
        render: function (r) { return fmt.num(r.sizeGB) + ' GB'; }
      },
      {
        key: 'agState', label: 'AG state', status: true,
        render: function (r) {
          return ui.pill(r.agState, agTone(r.agState), {
            title: r.ag ? 'Availability group ' + r.ag : 'This engine is not in an availability group.'
          });
        }
      },
      {
        key: 'lagS', label: 'Lag', align: 'right',
        render: function (r) { return r.ag ? fmt.dur(r.lagS) : el('span.muted', { text: 'n/a' }); }
      },
      {
        key: 'recovery', label: 'Recovery model', status: true,
        render: function (r) { return recoveryPill(r); }
      },
      {
        key: 'lastLog', label: 'Last log backup',
        sort: function (r) { return r.lastLog ? r.lastLog.getTime() : 0; },
        // "not applicable" rather than "never": a SIMPLE database is not
        // overdue a log backup, it cannot take one. lastDiff a few lines up
        // already reads this way; lastLog did not.
        render: function (r) {
          if (r.lastLog) return fmt.time(r.lastLog);
          return el('span.muted', {
            text: 'not applicable',
            title: r.recovery === 'SIMPLE'
              ? 'SIMPLE recovery keeps no log chain, so there is no log backup to take.'
              : 'No log backup has been recorded for this database.'
          });
        }
      },
      {
        key: 'rpoMin', label: 'RPO', align: 'right',
        render: function (r) { return fmt.num(r.rpoMin) + ' min'; }
      },
      { key: 'connections', label: 'Connections', align: 'right' }
    ];

    return el('div.stack', [
      simple.length ? el('div.callout.warn', [
        el('strong', {
          text: 'Point-in-time recovery is not available for ' +
            simple.map(function (x) { return x.name; }).join(', ') + '.'
        }),
        el('p', { text: SIMPLE_TITLE }),
        el('p', {
          text: 'ADR-0031 requires FULL recovery for every Tier 1 database, so this is a standing exception and not a setting to leave alone.'
        })
      ]) : null,
      ui.card('Databases', ui.table(cols, d.databases, {
        caption: 'Databases, with engine, host, size, availability group state, recovery model, last log backup, RPO and open connections',
        sortKey: 'name',
        empty: 'No databases are registered in this environment.'
      }), { flush: true })
    ]);
  }

  /* -------------------------------------------------- object storage tab --- */

  function lockCell(b) {
    if (!b.lock) return ui.pill('none', 'idle', { title: 'Objects in this bucket can be deleted or overwritten.' });
    return el('span.lockbadge', {
      title: 'Object lock in ' + b.lock + ' mode. Objects cannot be deleted or overwritten for ' +
        b.lockDays + ' days, by anybody, including an administrator.',
      text: b.lock + ' · ' + fmt.num(b.lockDays) + ' days'
    });
  }

  function bucketsTab() {
    var totalObjects = 0, totalTB = 0, locked = 0, worstLag = 0, worstLagBucket = null;
    d.buckets.forEach(function (b) {
      totalObjects += b.objects;
      totalTB += b.sizeTB;
      if (b.lock) locked++;
      if (b.replication !== 'none' && b.lagS > worstLag) { worstLag = b.lagS; worstLagBucket = b.name; }
    });

    var cols = [
      {
        key: 'name', label: 'Bucket', width: '22%',
        render: function (r) { return A.link(r.name, 'data', ['bucket', r.name]); }
      },
      {
        key: 'objects', label: 'Objects', align: 'right',
        render: function (r) { return fmt.num(r.objects); }
      },
      {
        key: 'sizeTB', label: 'Size', align: 'right',
        render: function (r) { return fmt.bytesTB(r.sizeTB); }
      },
      {
        key: 'lock', label: 'Object lock', status: true,
        sort: function (r) { return r.lock ? r.lockDays : -1; },
        render: function (r) { return lockCell(r); }
      },
      {
        key: 'replication', label: 'Replication',
        render: function (r) {
          return r.replication === 'none'
            ? el('span.muted', { text: 'none' })
            : ui.pill(r.replication, 'ok', { title: 'Replicated to ' + r.replication + '.' });
        }
      },
      {
        key: 'lagS', label: 'Replication lag', align: 'right',
        render: function (r) {
          return r.replication === 'none' ? el('span.muted', { text: 'n/a' }) : fmt.dur(r.lagS);
        }
      },
      {
        key: 'owner', label: 'Owner',
        render: function (r) { return mono(r.owner); }
      },
      {
        key: 'growth', label: 'Monthly growth', align: 'right',
        render: function (r) { return fmt.pct(r.growth); }
      }
    ];

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Objects', fmt.num(totalObjects), { note: 'Across ' + d.buckets.length + ' buckets' }),
        ui.statTile('Stored', fmt.bytesTB(totalTB), { note: 'Logical size before erasure coding' }),
        ui.statTile('Under object lock', fmt.num(locked), {
          note: locked + ' of ' + d.buckets.length + ' buckets are write-once'
        }),
        ui.statTile('Worst replication lag', fmt.dur(worstLag), {
          note: worstLagBucket ? worstLagBucket + ' to Site B' : 'No bucket is replicated'
        })
      ]),
      ui.card('Buckets', ui.table(cols, d.buckets, {
        caption: 'Object storage buckets, with object count, size, object lock mode, replication target and lag, owning identity and monthly growth',
        sortKey: 'name',
        empty: 'No buckets exist in this environment.'
      }), { flush: true })
    ]);
  }

  /* ------------------------------------------------------------ cache tab --- */

  function cacheTab() {
    var c = d.cache;
    var pressure = c.memoryUsedGB / c.memoryTotalGB;
    // Garnet evicts once the working set no longer fits, so pressure is the
    // number that predicts a hit-rate collapse, not the hit rate itself.
    var tone = pressure >= 0.9 ? 'bad' : pressure >= 0.8 ? 'warn' : 'ok';

    var prefixCols = [
      { key: 'key', label: 'Prefix', render: function (r) { return mono(r.key); } },
      { key: 'keys', label: 'Keys', align: 'right', render: function (r) { return fmt.num(r.keys); } },
      { key: 'mb', label: 'Memory', align: 'right', render: function (r) { return fmt.num(r.mb) + ' MB'; } },
      {
        key: 'share', label: 'Share of used memory', align: 'right', sortable: false,
        sort: function (r) { return r.mb; },
        render: function (r) { return fmt.pct((r.mb / (c.memoryUsedGB * 1024)) * 100); }
      }
    ];

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Memory used', fmt.num(c.memoryUsedGB, 1), {
          unit: 'GB', note: 'of ' + fmt.num(c.memoryTotalGB) + ' GB allocated'
        }),
        ui.statTile('Hit rate', fmt.ratioPct(c.hitRate), { note: 'Last hour, all prefixes' }),
        ui.statTile('Operations', fmt.num(c.opsPerSec), { unit: '/s', note: 'Reads and writes combined' }),
        ui.statTile('Evictions', fmt.num(c.evictions), { note: 'Keys dropped under memory pressure' })
      ]),
      ui.card('Memory pressure', el('div.stack', [
        ui.bar(pressure, {
          tone: tone,
          label: 'Memory pressure: ' + fmt.ratioPct(pressure, 0) + ' of ' + fmt.num(c.memoryTotalGB) + ' GB used'
        }),
        el('p.hint', {
          text: fmt.num(c.memoryUsedGB, 1) + ' GB of ' + fmt.num(c.memoryTotalGB) + ' GB used (' +
            fmt.ratioPct(pressure, 0) + '), with ' + fmt.num(c.evictions) +
            ' evictions in the last hour. Evictions rising while the hit rate falls means the working set no longer fits.'
        })
      ])),
      ui.card('Keys by prefix', ui.table(prefixCols, c.prefixes, {
        caption: 'Cache prefixes, with key count, memory held and share of used memory',
        sortKey: 'mb', sortDir: 'desc',
        empty: 'The cache holds no keys.'
      }), { flush: true })
    ]);
  }

  /* ----------------------------------------------------------- queues tab --- */

  var DLQ_REASONS = [
    'Handler threw after 5 delivery attempts',
    'Payload failed schema validation on field parcel_id',
    'Consumer acknowledgement timed out after 30 s'
  ];
  var DLQ_CONSUMERS = ['mills-ingest-worker', 'export-worker', 'scene-indexer'];

  /** Dead letters are derived from the stream, so the list never changes between runs. */
  function deadLetters(q) {
    var out = [];
    for (var i = 0; i < q.dlq; i++) {
      out.push({
        id: q.stream + '.dl.' + (4100 + i * 7 + q.stream.length),
        reason: DLQ_REASONS[(q.stream.length + i) % DLQ_REASONS.length],
        consumer: DLQ_CONSUMERS[(q.consumers + i) % DLQ_CONSUMERS.length],
        attempts: 5 + i,
        at: new Date(d.now.getTime() - (i + 1) * 41 * 60000)
      });
    }
    return out;
  }

  function inspectDeadLetters(q) {
    var msgs = deadLetters(q);
    A.dialog({
      title: 'Dead letters on ' + q.stream,
      wide: true,
      body: function () {
        return el('div.stack', [
          el('p', {
            text: 'These messages exhausted their delivery attempts and were parked. Replaying re-publishes the message to ' +
              q.stream + '; it does not fix the reason it failed.'
          }),
          el('div.stack', msgs.map(function (m) {
            return el('div.card', el('div.card-body', el('div.stack', [
              el('div.row', [mono(m.id), ui.pill('dead letter', 'bad')]),
              ui.dl([
                ['Reason', m.reason],
                ['Consumer', mono(m.consumer)],
                ['Attempts', fmt.num(m.attempts)],
                ['Parked', fmt.time(m.at)]
              ]),
              ui.btn('Replay ' + m.id, {
                variant: 'ghost',
                onClick: function () {
                  A.flash('ok', 'Replay queued for ' + m.id,
                    'The message is re-published to ' + q.stream +
                    ' and the replay is recorded in the audit. If the handler still fails it will park again.');
                }
              })
            ])));
          }))
        ]);
      }
    });
  }

  function queuesTab() {
    var cols = [
      { key: 'stream', label: 'Stream', width: '26%', render: function (r) { return mono(r.stream); } },
      { key: 'messages', label: 'Messages', align: 'right', render: function (r) { return fmt.num(r.messages); } },
      {
        key: 'rate', label: 'Rate', align: 'right',
        render: function (r) { return fmt.num(r.rate, 1) + ' /s'; }
      },
      { key: 'consumers', label: 'Consumers', align: 'right' },
      {
        key: 'lag', label: 'Consumer lag', status: true,
        render: function (r) {
          return r.lag > 10
            ? ui.pill(fmt.num(r.lag) + ' behind', 'warn', {
              title: 'More than ten messages behind: the consumer is not keeping up with the publish rate.'
            })
            : ui.pill(fmt.num(r.lag) + ' behind', 'ok');
        }
      },
      {
        key: 'dlq', label: 'Dead letters', status: true,
        render: function (r) {
          return r.dlq > 0
            ? ui.pill(fmt.num(r.dlq), 'bad', { title: 'Messages that exhausted their delivery attempts.' })
            : ui.pill('0', 'idle');
        }
      },
      {
        label: 'Actions', sortable: false, status: true,
        render: function (r) {
          if (!r.dlq) return el('span.muted', { text: 'nothing parked' });
          return ui.btn('Inspect dead letters on ' + r.stream, {
            variant: 'ghost',
            onClick: function () { inspectDeadLetters(r); }
          });
        }
      }
    ];

    return ui.card('JetStream streams', ui.table(cols, d.queues, {
      caption: 'NATS JetStream streams, with message count, publish rate, consumer count, consumer lag and dead letters',
      sortKey: 'stream',
      empty: 'No streams are defined.'
    }), { flush: true });
  }

  /* ------------------------------------------------------- backup band --- */

  /**
   * The last fourteen days of backup coverage, derived from the recovery model
   * rather than invented: SIMPLE has no log chain, which is exactly the fact the
   * band exists to make visible.
   */
  function backupDays(db) {
    var out = [];
    for (var i = 13; i >= 0; i--) {
      var day = new Date(d.now.getTime() - i * DAY_MS);
      var weekly = day.getUTCDay() === 0;
      var kinds;
      if (db.recovery === 'WAL') {
        kinds = [weekly ? 'base backup' : 'incremental base', 'WAL segments'];
      } else if (db.recovery === 'SIMPLE') {
        kinds = [weekly ? 'full' : 'differential'];
      } else {
        kinds = [weekly ? 'full' : 'differential', 'log every 15 min'];
      }
      out.push({
        day: day,
        kinds: kinds,
        tone: db.recovery === 'SIMPLE' ? 'warn' : 'ok'
      });
    }
    return out;
  }

  function backupSection(db) {
    var days = backupDays(db);
    var fulls = days.filter(function (x) { return x.kinds[0].indexOf('full') === 0 || x.kinds[0].indexOf('base') === 0; }).length;
    var hasLog = db.recovery !== 'SIMPLE';

    var summary = 'Backup coverage for the last 14 days of ' + db.name + ': ' +
      fulls + ' full or base backups, ' + (days.length - fulls) + ' differential or incremental backups, and ' +
      (hasLog ? 'a continuous log chain, so a restore can reach any point in time.'
        : 'no log chain at all, so a restore can only reach the last full or differential backup.');

    var band = el('div.backupband', { role: 'img', 'aria-label': summary },
      days.map(function (x) {
        var label = DAY_NAMES[x.day.getUTCDay()] + ' ' + fmt.stamp(x.day).slice(0, 10) + ': ' + x.kinds.join(' + ');
        return el('div.backupband-seg.' + x.tone, { title: label });
      }));

    var cols = [
      {
        key: 'day', label: 'Day',
        sort: function (r) { return r.day.getTime(); },
        render: function (r) { return DAY_NAMES[r.day.getUTCDay()] + ' ' + fmt.stamp(r.day).slice(0, 10); }
      },
      {
        key: 'kinds', label: 'Backups taken', sortable: false,
        render: function (r) { return chips(r.kinds); }
      },
      {
        label: 'Point in time', sortable: false, status: true,
        render: function () {
          return hasLog
            ? ui.pill('any point', 'ok')
            : ui.pill('last full or diff only', 'warn', { title: SIMPLE_TITLE });
        }
      }
    ];

    return ui.card('Backup coverage, last 14 days', el('div.stack', [
      band,
      el('p.hint', { text: summary }),
      ui.table(cols, days, {
        caption: 'Backup coverage for ' + db.name + ' over the last 14 days, one row per day, with the backups taken and the recovery point they allow',
        empty: 'No backup history is recorded for this database.'
      })
    ]));
  }

  /* ----------------------------------------------------- query editor --- */

  // Comments and string literals are stripped before the keyword scan, so a row
  // whose text contains the word "update" is not mistaken for an UPDATE. SELECT
  // ... INTO writes a table in T-SQL, and several routines write through a call
  // that begins with SELECT, so both are refused: the editor is for reading and
  // the check has to mean it.
  var WRITE_GRAMMAR = /\b(delete|update|drop|insert|alter|truncate|create|merge|exec|execute|grant|revoke|call|copy|vacuum|reindex|refresh|analyze|cluster)\b/i;
  var SELECT_INTO = /\bselect\b[\s\S]*?\binto\b/i;

  /*
   * Routines that write, lock, or reach outside the database -- every one of
   * them callable through a statement that begins with SELECT.
   *
   * Three holes were found here by testing this check rather than reading it:
   *
   *   SELECT nextval('parcels_id_seq')      accepted -- advances a sequence
   *   SELECT setval('parcels_id_seq', 1)    accepted -- rewinds one
   *   SELECT lo_import('C:/secret.txt')     accepted -- reads a server file in
   *   SELECT pg_advisory_lock(1)            accepted
   *
   * The last is the instructive one. `lock` WAS in the grammar list above, but
   * \block\b finds no word boundary inside `pg_advisory_lock`, so a blocklist
   * of bare words silently misses every function whose name merely contains
   * one. Function names are matched in full here instead.
   */
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

  /**
   * The statements in a batch, ignoring a single trailing semicolon.
   *
   * Only the FIRST statement's leading keyword was ever checked, so anything
   * after a semicolon rode through untested unless it happened to use a
   * blocklisted word. `SELECT 1; REFRESH MATERIALIZED VIEW mv_parcels`,
   * `SELECT 1; ANALYZE parcels` and `SELECT 1; SET statement_timeout = 0` were
   * all accepted, and each reported back "3 rows returned ... written to the
   * audit". Refusing a batch outright closes the whole class, rather than
   * chasing the keywords that might appear inside one.
   */
  function statementsIn(probe) {
    return probe.split(';').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /** Remove comments and string literals so they cannot hide a keyword. */
  function stripLiterals(sql) {
    return String(sql)
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/\[[^\]]*\]/g, '[]');
  }
  var ROW_CAP = 100;

  function sampleQuery(db) {
    if (db.engine.indexOf('PostgreSQL') === 0) {
      return 'SELECT datname, pg_database_size(datname) AS bytes\n' +
        'FROM pg_database\n' +
        'ORDER BY bytes DESC\n' +
        'LIMIT ' + ROW_CAP + ';';
    }
    return 'SELECT TOP ' + ROW_CAP + ' name, recovery_model_desc, state_desc\n' +
      'FROM sys.databases\n' +
      'ORDER BY name;';
  }

  function queryEditor(db) {
    var editorId = 'queryeditor-' + db.name.replace(/[^a-z0-9]/gi, '-');
    var area = el('textarea.queryeditor', {
      id: editorId, rows: '5', spellcheck: 'false', autocomplete: 'off',
      'aria-describedby': editorId + '-help'
    });
    area.value = sampleQuery(db);

    var result = el('div.queryresult', { role: 'region', 'aria-live': 'off', 'aria-label': 'Query result for ' + db.name });

    function paintEmpty() {
      ui.clear(result);
      result.appendChild(ui.emptyState('No result yet',
        'Run the statement to see the first ' + ROW_CAP + ' rows.'));
    }

    function run() {
      var text = area.value;
      var probe = stripLiterals(text);

      if (statementsIn(probe).length > 1) {
        A.flash('bad', 'Statement rejected on ' + db.name,
          'One statement at a time. A batch is refused outright rather than checked statement by statement, because everything after the first semicolon is exactly where a write hides.');
        return;
      }
      if (!LEADING_SELECT.test(probe)) {
        A.flash('bad', 'Statement rejected on ' + db.name,
          'Only a statement beginning with SELECT is accepted. This grammar is not available to the Operator role, and the console query editor is a read-only investigation tool, not a replacement for SSMS or psql.');
        return;
      }
      if (WRITE_GRAMMAR.test(probe) || SELECT_INTO.test(probe) || WRITE_ROUTINE.test(probe)) {
        A.flash('bad', 'Statement rejected on ' + db.name,
          'Write grammar is not accepted for non-Admin roles. That covers DELETE, UPDATE, DROP, INSERT, ALTER and TRUNCATE, and also SELECT ... INTO and routines that write or interrupt a session, both of which begin with SELECT. Change data through a runbook with an approval, not through this box: the query editor is a read-only investigation tool, not a replacement for SSMS or psql.');
        return;
      }

      // A deterministic, plausible result set drawn from the same host, so the
      // shape of a result is demonstrated without inventing numbers.
      var rows = d.databases.filter(function (x) { return x.host === db.host; }).slice(0, ROW_CAP);
      var cols = [
        { key: 'name', label: 'name', render: function (r) { return mono(r.name); } },
        { key: 'recovery', label: 'recovery_model_desc', render: function (r) { return mono(r.recovery); } },
        { key: 'sizeGB', label: 'size_gb', align: 'right', render: function (r) { return fmt.num(r.sizeGB); } }
      ];

      ui.clear(result);
      result.appendChild(ui.table(cols, rows, {
        caption: 'Result of the read-only query against ' + db.name + ', ' + rows.length + ' rows',
        empty: 'The statement returned no rows.'
      }));
      result.appendChild(el('p.hint', {
        text: rows.length + ' rows returned, capped at ' + ROW_CAP +
          '. The statement, the row count and your identity are written to the audit.'
      }));
      A.announce('Query returned ' + rows.length + ' rows from ' + db.name);
    }

    paintEmpty();

    return ui.card('Query editor', el('div.stack', [
      el('div.callout.info', {
        text: 'Read-only. Statements run as a short-lived, least-privilege login and every statement is written to the audit with your identity.'
      }),
      el('label.fieldlabel', { for: editorId, text: 'SELECT statement to run against ' + db.name }),
      area,
      el('p.hint', {
        id: editorId + '-help',
        text: 'Only SELECT is accepted, and results are capped at ' + ROW_CAP +
          ' rows. This is an investigation tool for reading state during an incident, not a replacement for SSMS or psql.'
      }),
      el('div.row', [
        ui.btn('Run statement against ' + db.name, { variant: 'primary', onClick: run }),
        ui.btn('Reset to the sample statement', {
          variant: 'ghost',
          onClick: function () { area.value = sampleQuery(db); paintEmpty(); }
        })
      ]),
      result
    ]));
  }

  /* --------------------------------------------------- credential dialog --- */

  function requestCredential(db) {
    A.stepUp('Issuing a one-time credential for ' + db.name + ' needs a second factor.', function () {
      // Deliberately not a secret: the prototype has no vault, and a console that
      // ever proxies a real credential is a console that can leak one.
      var user = 'ARGUS\\otp-' + db.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      var value = 'PROTOTYPE-NOT-A-REAL-CREDENTIAL-0000';
      var expires = new Date(d.now.getTime() + 3600000);

      A.dialog({
        title: 'One-time credential for ' + db.name,
        body: function () {
          return el('div.stack', [
            el('div.callout.warn', {
              text: 'This prototype has no vault. The value below is a fixed placeholder, it authenticates nothing, and it is safe to screenshot.'
            }),
            el('div.secretrow', [
              el('span.muted', { text: 'Login' }),
              mono(user)
            ]),
            el('div.secretrow', [
              el('span.muted', { text: 'Credential' }),
              mono(value),
              ui.btn('Copy the one-time credential for ' + db.name, {
                variant: 'ghost',
                onClick: function () {
                  // Clipboard access is unavailable on file:// in some browsers,
                  // so failure is reported rather than swallowed.
                  try {
                    if (window.navigator && window.navigator.clipboard) {
                      window.navigator.clipboard.writeText(value);
                      A.flash('ok', 'Copied', 'The placeholder credential is on your clipboard.', { timeout: 5000 });
                      return;
                    }
                  } catch (e) { /* fall through to the honest message */ }
                  A.flash('warn', 'Could not copy',
                    'This browser blocks clipboard access from a local file. Select the text and copy it manually.');
                }
              })
            ]),
            ui.dl([
              ['Database', db.name],
              ['Host', mono(db.host)],
              ['Expires', fmt.stamp(expires) + ' (1 hour)'],
              ['Revocation', 'Automatic at expiry, and immediately if your session ends']
            ]),
            el('p.hint', {
              text: 'Shown once. It expires in one hour, is revoked automatically, and the issue is recorded in the audit against your identity.'
            })
          ]);
        }
      });
    });
  }

  /* --------------------------------------------------- database detail --- */

  function databaseDetail(mount, name) {
    var db = dbByName(name);
    if (!db) { mount.appendChild(notFound('database', name)); return; }

    mount.appendChild(ui.pageHeader(db.name, db.engine + ' on ' + db.host, [
      ui.btn('Request credential for ' + db.name, {
        variant: 'primary', onClick: function () { requestCredential(db); }
      }),
      ui.btn('Trigger backup of ' + db.name, {
        variant: 'ghost',
        onClick: function () {
          A.flash('ok', 'Backup queued for ' + db.name,
            'An out-of-band ' + (db.recovery === 'WAL' ? 'base backup' : 'full backup') +
            ' is queued on ' + db.host + '. It does not disturb the scheduled chain, and it is recorded in the audit.');
        }
      }),
      /* A forced failover needs somewhere to fail over TO. The PostgreSQL
         databases have no availability group -- this screen's own callout says
         so, a few centimetres below -- so the action is offered but refused,
         with the reason, rather than promising to move a role that does not
         exist to a SQL Server host that does not hold it. */
      ui.btn('Fail over ' + db.name, {
        variant: 'danger',
        disabled: !db.ag,
        title: db.ag
          ? 'Move the primary role for ' + db.ag + ' to Site B'
          : db.name + ' has no availability group. ' + db.engine + ' protects it with '
            + 'continuous WAL archiving, so there is no synchronous replica to fail over to.',
        onClick: function () {
          A.confirmDestructive({
            title: 'Fail over ' + db.name + ' to Site B',
            detail: 'A forced failover moves the ' + (db.ag || 'primary') +
              ' role to sql-02 at Site B. With ' + fmt.dur(db.lagS) +
              ' of replication lag, any transaction not yet shipped is lost.',
            match: db.name,
            environment: A.state.env,
            blast: fmt.num(db.connections) + ' open connections to ' + db.name +
              ' are dropped, and every application holding them reconnects to Site B.',
            confirmLabel: 'Fail over ' + db.name,
            onConfirm: function () {
              A.flash('warn', 'Failover started for ' + db.name,
                'Watch the availability group state below. Applications reconnect on their own retry loop.');
            }
          });
        }
      })
    ]));

    mount.appendChild(el('div.tiles', [
      ui.statTile('Size', fmt.num(db.sizeGB), { unit: 'GB' }),
      ui.statTile('RPO', fmt.num(db.rpoMin), { unit: 'min', note: 'Recovery point objective' }),
      ui.statTile('Connections', fmt.num(db.connections), { note: 'Open right now' }),
      ui.statTile('Replication lag', db.ag ? fmt.dur(db.lagS) : 'n/a', {
        note: db.ag ? 'To sql-02 at Site B' : 'Not in an availability group'
      }),
      ui.statTile('Last verified restore', fmt.ago(db.lastVerified), {
        note: 'A backup nobody restored is a hope, not a backup'
      })
    ]));

    if (db.ag) {
      mount.appendChild(ui.card('Availability group ' + db.ag, el('div.stack', [
        ui.graph(
          [
            { id: 'sql-01', label: 'sql-01', kind: 'primary, Site A' },
            { id: 'sql-02', label: 'sql-02', kind: 'async secondary, Site B' }
          ],
          [['sql-01', 'sql-02']],
          {
            label: 'Availability group ' + db.ag + ': sql-01 is the primary at Site A and ships to sql-02, the asynchronous secondary at Site B',
            // Same direction as the label and the hint below it: the primary
            // ships TO the secondary. "sql-01 depends on sql-02" was backwards.
            verb: 'ships to'
          }
        ),
        el('p.hint', {
          text: 'sql-01 at Site A is the primary and ships to sql-02 at Site B asynchronously, currently ' +
            fmt.dur(db.lagS) + ' behind. Asynchronous commit means a site loss can lose whatever has not shipped.'
        })
      ])));
    } else {
      mount.appendChild(el('div.callout.info', [
        el('strong', { text: 'No availability group.' }),
        el('p', {
          text: db.engine + ' protects ' + db.name +
            ' with continuous WAL archiving to Site B through wal-g rather than an availability group, so there is no synchronous replica to fail over to. Recovery is a restore of the base backup plus WAL replay, which is why the RPO is ' +
            fmt.num(db.rpoMin) + ' minutes rather than seconds.'
        })
      ]));
    }

    mount.appendChild(backupSection(db));

    mount.appendChild(ui.card('Details', ui.dl([
      ['Engine', db.engine],
      ['Host', mono(db.host)],
      ['Availability group', db.ag ? mono(db.ag) : el('span.muted', { text: 'none' })],
      ['Availability group state', ui.pill(db.agState, agTone(db.agState))],
      ['Recovery model', recoveryPill(db)],
      ['Last full backup', fmt.time(db.lastFull)],
      ['Last differential backup', db.lastDiff ? fmt.time(db.lastDiff) : el('span.muted', { text: 'not applicable' })],
      ['Last log backup', db.lastLog
        ? fmt.time(db.lastLog)
        : el('span.muted', {
            text: 'not applicable',
            title: db.recovery === 'SIMPLE'
              ? 'SIMPLE recovery keeps no log chain, so there is no log backup to take.'
              : 'No log backup has been recorded for this database.'
          })],
      ['Last verified restore', fmt.time(db.lastVerified)]
    ])));

    mount.appendChild(queryEditor(db));
  }

  /* ----------------------------------------------------- bucket detail --- */

  // Prefixes are fixed per bucket and the counts are a fixed split of the real
  // object count, so the browser is stable between runs.
  var PREFIXES = {
    'argus-survey-pictures': [['2026/09/', 0.41], ['2026/08/', 0.34], ['2026/07/', 0.19], ['thumbnails/', 0.06]],
    'argus-rasters': [['sentinel2/', 0.52], ['planet/', 0.28], ['dem/', 0.14], ['masks/', 0.06]],
    'argus-sentinel': [['s2/l2a/', 0.62], ['s1/grd/', 0.29], ['manifests/', 0.09]],
    'argus-ml': [['checkpoints/', 0.44], ['datasets/', 0.36], ['exports/', 0.20]],
    'argus-artifacts': [['nupkg/', 0.47], ['sbom/', 0.31], ['signatures/', 0.22]],
    'argus-backups': [['sql/', 0.38], ['wal/', 0.34], ['kopia/', 0.28]],
    'argus-logs': [['loki/chunks/', 0.71], ['wazuh/archives/', 0.21], ['index/', 0.08]],
    'argus-sessions': [['guacamole/2026/09/', 0.55], ['guacamole/2026/08/', 0.34], ['manifests/', 0.11]]
  };

  function prefixesFor(b) {
    var spec = PREFIXES[b.name] || [['/', 1]];
    return spec.map(function (p) {
      return { key: p[0], objects: Math.round(b.objects * p[1]), share: p[1] };
    });
  }

  function bucketDetail(mount, name) {
    var b = bucketByName(name);
    if (!b) { mount.appendChild(notFound('bucket', name)); return; }

    var lockReason = b.lock
      ? 'object lock, ' + fmt.num(b.lockDays) + ' days remaining'
      : null;

    mount.appendChild(ui.pageHeader(b.name, 'Owned by ' + b.owner, [
      ui.btn('Upload an object to ' + b.name, {
        variant: 'ghost',
        onClick: function () {
          A.flash('info', 'Upload is not available from the console',
            'Objects reach ' + b.name + ' through ' + b.owner +
            ', not through an operator browser session. Use the ingest pipeline or a signed URL issued by a runbook.');
        }
      }),
      ui.btn('Delete objects in ' + b.name, {
        variant: 'danger',
        disabled: !!b.lock,
        title: lockReason ||
          'Deleting objects in ' + b.name + ' cannot be undone from the console.',
        onClick: function () {
          A.confirmDestructive({
            title: 'Delete objects in ' + b.name,
            detail: 'This permanently removes every object under the selected prefix. There is no undo and no recycle bin.',
            match: b.name,
            environment: A.state.env,
            blast: fmt.num(b.objects) + ' objects and ' + fmt.bytesTB(b.sizeTB) +
              ' are in scope, and ' + b.owner + ' loses the data immediately.',
            confirmLabel: 'Delete objects in ' + b.name,
            onConfirm: function () {
              A.flash('warn', 'Delete requested for ' + b.name,
                'The prototype performs no deletion. In production this is a two-approver runbook, not a button.');
            }
          });
        }
      })
    ]));

    mount.appendChild(el('div.tiles', [
      ui.statTile('Objects', fmt.num(b.objects)),
      ui.statTile('Size', fmt.bytesTB(b.sizeTB), { note: fmt.pct(b.growth) + ' growth per month' }),
      ui.statTile('Object lock', b.lock ? b.lock : 'none', {
        note: b.lock ? fmt.num(b.lockDays) + ' days remaining' : 'Objects can be deleted or overwritten'
      }),
      ui.statTile('Replication lag', b.replication === 'none' ? 'n/a' : fmt.dur(b.lagS), {
        note: b.replication === 'none' ? 'Not replicated off site' : 'To ' + b.replication
      })
    ]));

    if (b.lock) {
      mount.appendChild(el('div.callout.info', [
        el('strong', { text: 'Write-once for ' + fmt.num(b.lockDays) + ' days.' }),
        el('p', {
          text: 'Object lock is in ' + b.lock + ' mode, so no identity can delete or overwrite an object before the retention period ends, including an administrator and including the account that wrote it. That is the property that makes this bucket survive ransomware, and it is why Delete is unavailable above.'
        })
      ]));
    }

    mount.appendChild(ui.card('Details', ui.dl([
      ['Bucket', mono(b.name)],
      ['Owner', mono(b.owner)],
      ['Objects', fmt.num(b.objects)],
      ['Size', fmt.bytesTB(b.sizeTB)],
      ['Object lock', b.lock ? lockCell(b) : ui.pill('none', 'idle')],
      ['Retention remaining', b.lock ? fmt.num(b.lockDays) + ' days' : el('span.muted', { text: 'not applicable' })],
      ['Replication', b.replication === 'none' ? el('span.muted', { text: 'none' }) : b.replication],
      ['Replication lag', b.replication === 'none' ? el('span.muted', { text: 'n/a' }) : fmt.dur(b.lagS)],
      ['Monthly growth', fmt.pct(b.growth)]
    ])));

    var prefixes = prefixesFor(b);
    mount.appendChild(ui.card('Prefixes', el('div.stack', [
      el('ul.treelist', { 'aria-label': 'Top-level prefixes in ' + b.name },
        prefixes.map(function (p) {
          return el('li.treelist-item', [
            mono(p.key),
            el('span.muted', { text: fmt.num(p.objects) + ' objects · ' + fmt.pct(p.share * 100, 0) + ' of the bucket' })
          ]);
        })),
      el('p.hint', {
        text: 'Top-level prefixes only. The console never lists individual objects, because a bucket with ' +
          fmt.num(b.objects) + ' objects cannot be browsed usefully and listing them all is an expensive operation.'
      })
    ])));
  }

  /* ------------------------------------------------------------- screen --- */

  A.screen('data', {
    title: 'Data',
    crumb: 'Data',
    render: function (mount, ctx) {
      var rest = ctx.rest || [];

      if (rest[0] === 'database' && rest[1]) { databaseDetail(mount, rest[1]); return; }
      if (rest[0] === 'bucket' && rest[1]) { bucketDetail(mount, rest[1]); return; }

      mount.appendChild(ui.pageHeader(
        'Data',
        'Databases, object storage, cache and queues across both sites.'));

      mount.appendChild(ui.tabs([
        { id: 'databases', label: 'Databases', render: databasesTab },
        { id: 'buckets', label: 'Object storage', render: bucketsTab },
        { id: 'cache', label: 'Cache', render: cacheTab },
        { id: 'queues', label: 'Queues', render: queuesTab }
      ], {
        label: 'Data stores',
        /* The breadcrumb and the document title already name the segment
           (#/ops/cost read "Operations / cost" and titled itself "cost"),
           so the panel has to match it. identity and security have always
           read it; these three ignored it and opened tab zero. */
        initial: (ctx && ctx.rest && ctx.rest[0]) || null
      }));
    }
  });
})();
