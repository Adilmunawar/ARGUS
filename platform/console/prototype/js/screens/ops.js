/* Operations: runbooks, backups and drills, maintenance windows, capacity and cost.
 *
 * Classic script, no modules, ES5 only, no network. Runbook output is machine
 * output rendered as text nodes, never as markup.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var APPROVAL_TONE = { operator: 'idle', approver: 'info', security: 'warn' };
  var APPROVAL_TEXT = {
    operator: 'operator only',
    approver: 'second person',
    security: 'security on-call'
  };
  var OUTCOME_TONE = { pass: 'ok', partial: 'warn', fail: 'bad' };
  var BACKUP_TONE = { ok: 'ok', warn: 'warn', bad: 'bad' };

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dayLabel(dt) { return DAYS[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()]; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

  /* Plausible PowerShell output per runbook. Each entry is a function of the
   * parameter values so the transcript names the machine the operator chose. */
  var TRANSCRIPTS = {
    'hv-01-drain-node': function (v) {
      var host = v.Host || 'hv-01';
      return [
        'PS> Invoke-ArgusRunbook -Id hv-01-drain-node -HostName ' + host,
        'Suspend-ClusterNode -Name ' + host + ' -Drain -Wait',
        'Draining ' + host + ': 8 virtual machines to live-migrate',
        '  sql-01                 -> hv-01    14.2 s   0 dropped packets',
        '  adfs-01                -> hv-02     9.8 s   0 dropped packets',
        '  legacy-landsurvey-01   -> hv-02    22.6 s   0 dropped packets',
        'Get-ClusterNode ' + host + ' : State = Paused, Drained',
        'Get-VirtualDisk : 3 of 3 fault domains healthy',
        'Runbook completed successfully in 96 s.'
      ];
    },
    'sql-01-restore-drill': function (v) {
      var target = v.Target || 'sql-drill-01';
      return [
        'PS> Invoke-ArgusRunbook -Id sql-01-restore-drill -Target ' + target,
        'Get-DbaBackupHistory -SqlInstance sql-01 -Database umairv3_db -Last',
        'Latest full 09:00, differential 06:14, log 09:03. Chain is unbroken.',
        'Restore-DbaDatabase -SqlInstance ' + target + ' -Path S:\\restore\\umairv3_db',
        '  Restored 611 GB in 41 min 12 s',
        'Invoke-DbaQuery -Query "DBCC CHECKDB (umairv3_db) WITH NO_INFOMSGS"',
        '  CHECKDB found 0 allocation errors and 0 consistency errors.',
        'Row count matches production within the 11 minute RPO window.',
        'Runbook completed successfully in 47 min.'
      ];
    },
    'sql-02-ag-failover': function (v) {
      var mode = v.Mode || 'planned';
      return [
        'PS> Invoke-ArgusRunbook -Id sql-02-ag-failover -Mode ' + mode,
        'Get-DbaAgReplica -SqlInstance sql-01 -AvailabilityGroup argus-ag1',
        '  sql-01 PRIMARY   synchronising   lag 3 s',
        '  sql-02 SECONDARY synchronising   lag 3 s',
        mode === 'forced'
          ? 'WARNING: forced failover accepts data loss up to the current lag.'
          : 'Waiting for sql-02 to reach SYNCHRONIZED before failing over.',
        'Invoke-DbaAgFailover -SqlInstance sql-02 -AvailabilityGroup argus-ag1',
        '  Listener argus-ag1-listener now resolves to 10.131.0.20',
        'Applications reconnected: MillsApi (3), LoanApi (2), ArgusConsoleApi (3)',
        'Runbook completed successfully in 38 s.'
      ];
    },
    'ob-01-unseal': function () {
      return [
        'PS> Invoke-ArgusRunbook -Id ob-01-unseal',
        'bao status : Sealed = true, Threshold = 3, Shares = 5',
        'Key holder 1 of 3 accepted. Progress 1/3.',
        'Key holder 2 of 3 accepted. Progress 2/3.',
        'Key holder 3 of 3 accepted. Progress 3/3.',
        'bao status : Sealed = false, HA mode = active',
        'Leases resumed: 23 dynamic database credentials re-issued.',
        'Runbook completed successfully in 4 min.'
      ];
    },
    'sec-01-suspected-compromise': function (v) {
      var host = v.Host || 'hv-03';
      return [
        'PS> Invoke-ArgusRunbook -Id sec-01-suspected-compromise -HostName ' + host,
        'Capturing volatile state before touching the network.',
        '  Memory image written to argus-artifacts/forensics/' + host + '.raw (64 GB)',
        'Set-VMNetworkAdapterVlan -VMName ' + host + ' -Access -VlanId 90',
        '  All virtual NICs moved to VLAN 90 (forensics only).',
        'Security on-call paged. Incident channel opened.',
        'Wazuh agent left running so the timeline keeps recording.',
        'Runbook completed successfully in 3 min 21 s.'
      ];
    },
    'sec-03-ransomware': function () {
      return [
        'PS> Invoke-ArgusRunbook -Id sec-03-ransomware',
        'Freezing writes on every bucket with an object lock.',
        '  argus-backups, argus-artifacts, argus-logs, argus-sessions : read-only',
        'Hyper-V Replica paused so a bad state is not shipped to Site B.',
        'Get-DbaLastBackup : last clean full at 09:00, verified 6 days ago',
        'Site B restore staged from argus-backups (3.24 TB, lock 35 d).',
        'Security on-call paged. Legal notified per the incident policy.',
        'Runbook completed successfully in 6 min 02 s.'
      ];
    },
    'dr-01-site-a-loss': function (v) {
      return [
        'PS> Invoke-ArgusRunbook -Id dr-01-site-a-loss -Reason "' + (v.Reason || 'unspecified') + '"',
        'Confirming Site A is unreachable from both witness paths.',
        'Start-VMFailover on 9 replicated virtual machines at Site B',
        '  sql-02, pg-01-b, dc-03, adfs-02, guac-02, kuma-b01 online',
        'DNS: zaraatdost.pk records repointed to 10.120.0.10 (TTL 60 s)',
        'Service Fabric quorum re-formed on 3 of 5 nodes.',
        'RPO measured at 214 s. RTO target is 8 h; elapsed 27 min.',
        'Runbook completed successfully in 27 min.'
      ];
    },
    'cert-01-renewal-failure': function (v) {
      var host = v.Host || 'caddy';
      return [
        'PS> Invoke-ArgusRunbook -Id cert-01-renewal-failure -HostName ' + host,
        'Test-NetConnection acme-v02.api.letsencrypt.org -Port 443 : Succeeded',
        'Reading the Caddy storage backend for the failed order.',
        '  Order failed: urn:ietf:params:acme:error:rateLimited',
        'Falling back to the internal AD CS issuing CA for this renewal.',
        'Certificate issued, valid 90 days, SAN count 4.',
        'Restart-Service caddy : running, 2 instances healthy',
        'Runbook completed successfully in 51 s.'
      ];
    }
  };

  function transcriptFor(rb, values) {
    var maker = TRANSCRIPTS[rb.id];
    if (maker) return maker(values);
    return [
      'PS> Invoke-ArgusRunbook -Id ' + rb.id,
      'Pre-flight checks passed.',
      'Applying the change.',
      'Verifying the result.',
      'Runbook completed successfully.'
    ];
  }

  /* ---------------------------------------------------------- runbooks --- */

  function runbooksTab() {
    var d = A.data;

    var cols = [
      {
        key: 'id', label: 'Runbook',
        render: function (rb) {
          var a = A.link(rb.id, 'ops', ['runbook', rb.id]);
          a.classList.add('mono');
          return a;
        }
      },
      { key: 'title', label: 'Title' },
      { key: 'tier', label: 'Tier', align: 'right', render: function (rb) { return 'Tier ' + fmt.num(rb.tier); } },
      {
        key: 'approval', label: 'Approval required', status: true,
        render: function (rb) {
          return ui.pill(APPROVAL_TEXT[rb.approval] || rb.approval, APPROVAL_TONE[rb.approval] || 'idle');
        }
      },
      {
        key: 'lastRun', label: 'Last run',
        sort: function (rb) { return rb.lastRun ? rb.lastRun.getTime() : 0; },
        render: function (rb) { return fmt.time(rb.lastRun); }
      }
    ];

    return el('div.stack', [
      el('div.callout.info', {
        text: 'A runbook is a parameterised script with an owner, an approval level and a transcript. '
          + 'If an operation is not in here, it is being done by hand at three in the morning by whoever is awake.'
      }),
      ui.table(cols, d.runbooks, {
        caption: 'Operational runbooks with their tier, approval requirement and last run',
        empty: 'No runbook is defined.',
        sortKey: 'tier', sortDir: 'asc',
        rowKey: function (rb) { return rb.id; },
        onRow: function (rb) { A.go('ops', ['runbook', rb.id]); }
      })
    ]);
  }

  function runbookDetail(mount, id) {
    var d = A.data;
    var rb = d.runbooks.filter(function (r) { return r.id === id; })[0];

    if (!rb) {
      mount.appendChild(ui.pageHeader('Runbook not found', id));
      mount.appendChild(ui.emptyState(
        'No runbook has that identifier',
        'The link may come from an older version of the console, or the runbook was retired.',
        ui.btn('Back to runbooks', { variant: 'primary', onClick: function () { A.go('ops'); } })));
      return;
    }

    mount.appendChild(ui.pageHeader(rb.title, rb.id, [
      ui.btn('Back to runbooks', { variant: 'ghost', onClick: function () { A.go('ops'); } })
    ]));

    var fields = {};
    var form = el('form.runbookform', {
      on: { submit: function (e) { e.preventDefault(); } }
    }, rb.params.map(function (p) {
      var id2 = 'rb-' + slug(rb.id) + '-' + slug(p.name);
      var input;
      if (p.type === 'select') {
        input = el('select.field', { id: id2 }, (p.options || []).map(function (o) {
          return el('option', { value: o, text: o });
        }));
      } else {
        input = el('input.field', {
          type: 'text', id: id2, value: p.value || '', autocomplete: 'off', spellcheck: 'false'
        });
      }
      fields[p.name] = input;
      return el('div.formrow', [
        el('label.fieldlabel', { for: id2, text: p.name }),
        input
      ]);
    }));

    if (!rb.params.length) {
      form.appendChild(el('p.muted', { text: 'This runbook takes no parameters.' }));
    }

    var logview = el('div.logview', {
      tabindex: '0', role: 'group',
      'aria-label': 'Transcript of ' + rb.id,
      /* The transcript streams a line at a time. On aria-live="polite" that is a
       * screen-reader announcement per line, which drowns out everything else and
       * makes the page unusable while a runbook runs. So it is explicitly off and
       * the operator asks for the result with the button next to it. */
      'aria-live': 'off'
    });
    logview.appendChild(el('div.logline', { text: 'Not started. Fill in the parameters and select Run.' }));

    var lastLine = '';
    var runOpts;
    var runBtn;
    var timers = [];
    // A transcript that outlives its screen keeps appending to a detached node
    // and flashes its result over whatever you navigated to.
    A.onLeave(function () {
      timers.forEach(function (h) { window.clearTimeout(h); });
      timers = [];
    });

    function announceResult() {
      A.announce(lastLine
        ? 'Runbook ' + rb.id + '. ' + lastLine
        : 'Runbook ' + rb.id + ' has not been run in this session.');
    }

    function runNow() {
      timers.forEach(function (t) { window.clearTimeout(t); });
      timers = [];
      ui.clear(logview);
      lastLine = '';

      var values = {};
      Object.keys(fields).forEach(function (k) { values[k] = fields[k].value; });
      var lines = transcriptFor(rb, values);

      runOpts.disabled = true;
      runBtn.disabled = true;
      runBtn.classList.add('is-disabled');
      runBtn.setAttribute('aria-disabled', 'true');

      /* A transcript is capped and scrolled without reading layout.
       *
       * `scrollTop = scrollHeight` reads a layout-forcing property immediately
       * after mutating the same element, and the cost of that read grows with
       * everything already in the container -- so a long transcript pays
       * O(lines squared) in forced layout. Assigning a large number scrolls to
       * the end just as well and reads nothing. The cap is what stops a real
       * streaming transcript from growing without bound, which is the same
       * rule the log tail now follows. */
      var TRANSCRIPT_CAP = 500;
      lines.forEach(function (line, i) {
        timers.push(window.setTimeout(function () {
          logview.appendChild(el('div.logline', { text: line }));
          while (logview.childElementCount > TRANSCRIPT_CAP) logview.removeChild(logview.firstChild);
          logview.scrollTop = 1e9;
          if (i === lines.length - 1) {
            lastLine = line;
            runOpts.disabled = false;
            runBtn.disabled = false;
            runBtn.classList.remove('is-disabled');
            runBtn.setAttribute('aria-disabled', 'false');
            A.flash('ok', rb.id + ' finished', line);
          }
        }, 420 * (i + 1)));
      });
    }

    runOpts = {
      variant: 'primary',
      title: 'Run ' + rb.title,
      onClick: function () {
        A.stepUp('Running ' + rb.id + ' changes ' + (A.state.env === 'production' ? 'production' : 'staging')
          + ', so it needs a second factor.', runNow);
      }
    };
    runBtn = ui.btn('Run ' + rb.id, runOpts);

    mount.appendChild(ui.card('Parameters', [
      rb.approval === 'approver' || rb.approval === 'security' ? el('div.callout.warn', [
        el('strong', {
          text: rb.approval === 'security'
            ? 'Security on-call has to approve this run'
            : 'A second person has to approve this run'
        }),
        el('p', {
          text: 'A real deployment holds the run until a second person agrees, and records both names in the '
            + 'audit next to the transcript. This prototype has no second party, so it runs after the step-up '
            + 'alone. The gate is specified, not built.'
        })
      ]) : null,
      form,
      el('div.row', [runBtn])
    ]));

    mount.appendChild(ui.card('Transcript', [
      logview,
      el('div.row', [
        ui.btn('Announce result', {
          variant: 'ghost',
          title: 'Read the last transcript line to a screen reader',
          onClick: announceResult
        })
      ]),
      el('p.hint', {
        text: 'The transcript is not a live region. A streaming log announced line by line makes a screen reader '
          + 'unusable, so the result is announced on request instead.'
      })
    ]));
  }

  /* ------------------------------------------------- backups and drills --- */

  function backupsTab() {
    var d = A.data;

    var oldest = d.backups.slice().sort(function (a, b) { return a.last - b.last; })[0];
    var passed = d.drills.filter(function (x) { return x.outcome === 'pass'; }).length;
    var restores = d.drills.filter(function (x) { return x.kind === 'Restore'; })
      .slice().sort(function (a, b) { return b.ran - a.ran; });
    // The drill cadence is monthly, so the next one is due 30 days after the last.
    var nextDue = restores.length ? new Date(restores[0].ran.getTime() + 30 * 86400000) : null;
    var worstRpo = d.databases.reduce(function (a, x) { return Math.max(a, x.rpoMin); }, 0);

    var backupCols = [
      { key: 'store', label: 'Store' },
      { key: 'kind', label: 'Kind' },
      { key: 'cadence', label: 'Cadence' },
      { key: 'last', label: 'Last', sort: function (b) { return b.last.getTime(); }, render: function (b) { return fmt.time(b.last); } },
      { key: 'lock', label: 'Lock' },
      { key: 'site', label: 'Site' },
      { key: 'state', label: 'State', status: true, render: function (b) { return ui.pill(b.state, BACKUP_TONE[b.state] || 'idle'); } }
    ];

    var drillCols = [
      { key: 'id', label: 'Drill', render: function (x) { return el('span.mono', { text: x.id }); } },
      { key: 'kind', label: 'Kind' },
      { key: 'target', label: 'Target' },
      { key: 'ran', label: 'Ran', sort: function (x) { return x.ran.getTime(); }, render: function (x) { return fmt.time(x.ran); } },
      { key: 'durationMin', label: 'Duration', align: 'right', render: function (x) { return fmt.dur(x.durationMin * 60); } },
      { key: 'rtoTargetMin', label: 'RTO target', align: 'right', render: function (x) { return fmt.dur(x.rtoTargetMin * 60); } },
      { key: 'outcome', label: 'Outcome', status: true, render: function (x) { return ui.pill(x.outcome, OUTCOME_TONE[x.outcome] || 'idle'); } },
      { key: 'by', label: 'By' }
    ];

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Oldest backup', fmt.ago(oldest.last), { note: oldest.store + ', ' + oldest.cadence }),
        ui.statTile('Drills passed', fmt.num(passed), {
          unit: 'of ' + fmt.num(d.drills.length),
          note: 'A backup nobody has restored is a hope, not a backup'
        }),
        ui.statTile('Next drill due', nextDue ? fmt.stamp(nextDue) : 'unscheduled', {
          note: nextDue ? 'Thirty days after ' + restores[0].id : 'No restore drill on record'
        }),
        ui.statTile('Worst RPO', fmt.num(worstRpo), { unit: 'min', note: 'Across every database in the estate' })
      ]),
      ui.card('Backup stores', ui.table(backupCols, d.backups, {
        caption: 'Backup stores with cadence, last run, object lock duration and site',
        empty: 'No backup store is configured.',
        sortKey: 'last', sortDir: 'asc'
      })),
      ui.card('Restore and DR drills', ui.table(drillCols, d.drills, {
        caption: 'Restore and disaster recovery drills with measured duration against the RTO target',
        empty: 'No drill has been run.',
        sortKey: 'ran', sortDir: 'desc'
      }))
    ]);
  }

  /* -------------------------------------------------------- maintenance --- */

  function maintenanceTab() {
    var d = A.data;
    var start = new Date(Date.UTC(d.now.getUTCFullYear(), d.now.getUTCMonth(), d.now.getUTCDate()));
    var cells = [];
    var windows = [];

    for (var i = 0; i < 28; i++) {
      var day = new Date(start.getTime() + i * 86400000);
      var isPatch = day.getUTCDay() === 2;      // every Tuesday
      var isFreeze = i >= 25;                    // the last three days of the horizon
      var chips = [];

      if (isPatch) {
        chips.push(el('span.chip', { text: 'Patch 22:00-02:00' }));
        windows.push({ day: day, kind: 'Patch window', detail: '22:00 to 02:00 UTC, one fault domain at a time' });
      }
      if (isFreeze) {
        chips.push(el('span.chip', { text: 'Change freeze' }));
        windows.push({ day: day, kind: 'Change freeze', detail: 'No deployment to production without security sign-off' });
      }

      cells.push(el('div.calendar-cell', [
        el('div.muted', { text: dayLabel(day) }),
        chips.length ? el('div.chips', chips) : null
      ]));
    }

    var windowCols = [
      { key: 'day', label: 'Date', sort: function (w) { return w.day.getTime(); }, render: function (w) { return dayLabel(w.day); } },
      { key: 'kind', label: 'Window', status: true, render: function (w) { return ui.pill(w.kind, w.kind === 'Change freeze' ? 'warn' : 'info'); } },
      { key: 'detail', label: 'Detail' }
    ];

    return el('div.stack', [
      ui.card('Next four weeks', [
        el('div.calendar', {
          role: 'img',
          'aria-label': 'Four week maintenance calendar from ' + dayLabel(start)
            + '. Patch windows every Tuesday, change freeze on the last three days. '
            + 'The table below lists every window in full.'
        }, cells),
        el('p.hint', {
          text: 'The calendar is a picture. The table underneath is the same information in words, which is what '
            + 'a screen reader, a printout and a copy-paste into a change ticket all need.'
        })
      ]),
      ui.card('Windows in this period', ui.table(windowCols, windows, {
        caption: 'Patch windows and change freezes in the next four weeks, the text equivalent of the calendar',
        empty: 'No maintenance window falls in the next four weeks.',
        sortKey: 'day', sortDir: 'asc'
      }))
    ]);
  }

  /* ---------------------------------------------------- capacity and cost --- */

  function costTab() {
    var d = A.data, c = d.cost;
    var diff = c.awsBaselineUsd - c.monthlyTotalUsd;

    var breakdownCols = [
      { key: 'app', label: 'Workload' },
      { key: 'cpu', label: 'CPU', align: 'right', render: function (r) { return '$' + fmt.num(r.cpu); } },
      { key: 'storage', label: 'Storage', align: 'right', render: function (r) { return '$' + fmt.num(r.storage); } },
      { key: 'gpu', label: 'GPU', align: 'right', render: function (r) { return '$' + fmt.num(r.gpu); } },
      { key: 'total', label: 'Total', align: 'right', render: function (r) { return '$' + fmt.num(r.total); } },
      {
        key: 'share', label: 'Share of total', sortable: false,
        render: function (r) {
          var ratio = r.total / c.monthlyTotalUsd;
          return el('div.col', [
            ui.bar(ratio, { label: r.app + ' is ' + fmt.ratioPct(ratio, 1) + ' of the monthly total' }),
            el('span.muted', { text: fmt.ratioPct(ratio, 1) })
          ]);
        }
      }
    ];

    var forecastCols = [
      { key: 'resource', label: 'Resource' },
      { key: 'full', label: 'Full by' },
      {
        key: 'headroomPct', label: 'Headroom', align: 'right',
        render: function (f) { return fmt.pct(f.headroomPct, 0); }
      }
    ];

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Monthly total', '$' + fmt.num(c.monthlyTotalUsd), { unit: 'USD', note: 'Amortised hardware plus power' }),
        ui.statTile('AWS baseline', '$' + fmt.num(c.awsBaselineUsd), { unit: 'USD', note: 'The same workloads, on-demand, priced from the calculator' }),
        ui.statTile('Difference', '$' + fmt.num(diff), {
          unit: 'USD',
          delta: { value: fmt.ratioPct(diff / c.awsBaselineUsd, 0) + ' lower', dir: 'down', good: true },
          note: 'Per month, before counting the staff time either option costs'
        })
      ]),
      el('div.callout.info', [
        el('strong', { text: 'These are amortised owned-hardware costs, not a bill.' }),
        el('p', {
          text: 'Capital cost from docs/07 spread over 36 months, plus measured power, attributed to workloads by '
            + 'CPU, storage and GPU share. No cloud vendor gives you this number, because no cloud vendor can tell '
            + 'you what a workload would have cost you to own.'
        })
      ]),
      ui.card('Cost by workload', ui.table(breakdownCols, c.breakdown, {
        caption: 'Monthly amortised cost by workload, split into CPU, storage and GPU, with share of the total',
        empty: 'No cost has been attributed.',
        sortKey: 'total', sortDir: 'desc'
      })),
      ui.card('Capacity forecast', ui.table(forecastCols, c.forecast, {
        caption: 'Resources projected to run out of headroom, with the month they fill',
        empty: 'Nothing is projected to fill.',
        sortKey: 'full', sortDir: 'asc'
      }))
    ]);
  }

  /* -------------------------------------------------------------- screen --- */

  A.screen('ops', {
    title: 'Operations',
    crumb: 'Operations',
    render: function (mount, ctx) {
      if (ctx.rest[0] === 'runbook' && ctx.rest[1]) {
        runbookDetail(mount, ctx.rest[1]);
        return;
      }

      mount.appendChild(ui.pageHeader('Operations',
        'Runbooks you can actually run, backups somebody has actually restored, and what the estate costs to own.'));
      mount.appendChild(ui.tabs([
        { id: 'runbooks', label: 'Runbooks', render: runbooksTab },
        { id: 'backups', label: 'Backups and drills', render: backupsTab },
        { id: 'maintenance', label: 'Maintenance', render: maintenanceTab },
        { id: 'cost', label: 'Capacity and cost', render: costTab }
      ], { label: 'Operations sections' }));
    }
  });
})();
