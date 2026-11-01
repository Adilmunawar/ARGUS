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

  var UNSET = '(not specified)';
  function val(v, key) {
    var x = v && v[key];
    return (x === undefined || x === null || x === '') ? UNSET : x;
  }

  var TRANSCRIPTS = {
    'hv-01-drain-node': function (v) {
      var host = val(v, 'Host');
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
      var target = val(v, 'Target');
      return [
        'PS> Invoke-ArgusRunbook -Id sql-01-restore-drill -Target ' + target,
        'Get-DbaBackupHistory -SqlInstance sql-01 -Database orders_db -Last',
        'Latest full 09:00, differential 06:14, log 09:03. Chain is unbroken.',
        'Restore-DbaDatabase -SqlInstance ' + target + ' -Path S:\\restore\\orders_db',
        '  Restored 611 GB in 41 min 12 s',
        'Invoke-DbaQuery -Query "DBCC CHECKDB (orders_db) WITH NO_INFOMSGS"',
        '  CHECKDB found 0 allocation errors and 0 consistency errors.',
        'Row count matches production within the 11 minute RPO window.',
        'Runbook completed successfully in 47 min.'
      ];
    },
    'sql-02-ag-failover': function (v) {
      var mode = val(v, 'Mode');
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
        'Applications reconnected: OrdersApi (3), BillingApi (2), ArgusConsoleApi (3)',
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
      var host = val(v, 'Host');
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
        'PS> Invoke-ArgusRunbook -Id dr-01-site-a-loss -Reason "' + val(v, 'Reason') + '"',
        'Confirming Site A is unreachable from both witness paths.',
        'Start-VMFailover on 9 replicated virtual machines at Site B',
        '  sql-02, pg-01-b, dc-03, adfs-02, guac-02, kuma-b01 online',
        'DNS: example.com records repointed to 10.120.0.10 (TTL 60 s)',
        'Service Fabric quorum re-formed on 3 of 5 nodes.',
        'RPO measured at 214 s. RTO target is 8 h; elapsed 27 min.',
        'Runbook completed successfully in 27 min.'
      ];
    },
    'cert-01-renewal-failure': function (v) {
      var host = val(v, 'Host');
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
      'aria-live': 'off'
    });
    logview.appendChild(el('div.logline', { text: 'Not started. Fill in the parameters and select Run.' }));

    var lastLine = '';
    var runOpts;
    var runBtn;
    var timers = [];
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

      runBtn.setDisabled(true);

      var TRANSCRIPT_CAP = 500;
      lines.forEach(function (line, i) {
        timers.push(window.setTimeout(function () {
          logview.appendChild(el('div.logline', { text: line }));
          while (logview.childElementCount > TRANSCRIPT_CAP) logview.removeChild(logview.firstChild);
          logview.scrollTop = 1e9;
          if (i === lines.length - 1) {
            lastLine = line;
            runBtn.setDisabled(false);
            rb.lastRun = new Date(d.now.getTime());
            A.record('runbook.run', rb.id + ' (' + A.state.env + ')');
            A.refreshBadges();
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

  function backupsTab() {
    var d = A.data;

    var oldest = d.backups.slice().sort(function (a, b) { return a.last - b.last; })[0] || null;
    var passed = d.drills.filter(function (x) { return x.outcome === 'pass'; }).length;
    var restores = d.drills.filter(function (x) { return x.kind === 'Restore'; })
      .slice().sort(function (a, b) { return b.ran - a.ran; });
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

    var backupTable = ui.table(backupCols, d.backups, {
      caption: 'Backup stores with cadence, last run, object lock duration and site',
      empty: 'No backup store is configured.',
      sortKey: 'last', sortDir: 'asc',
      rowKey: function (b) { return b.store + ' ' + b.kind; }
    });
    var drillTable = ui.table(drillCols, d.drills, {
      caption: 'Restore and disaster recovery drills with measured duration against the RTO target',
      empty: 'No drill has been run.',
      sortKey: 'ran', sortDir: 'desc',
      rowKey: function (x) { return x.id; }
    });

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Oldest backup', oldest ? fmt.ago(oldest.last) : '-', {
          note: oldest ? oldest.store + ', ' + oldest.cadence : 'No backup store is configured.'
        }),
        ui.statTile('Drills passed', fmt.num(passed), {
          unit: 'of ' + fmt.num(d.drills.length),
          note: 'A backup nobody has restored is a hope, not a backup'
        }),
        ui.statTile('Next drill due', nextDue ? fmt.stamp(nextDue) : 'unscheduled', {
          note: nextDue ? 'Thirty days after ' + restores[0].id : 'No restore drill on record'
        }),
        ui.statTile('Worst RPO', fmt.num(worstRpo), { unit: 'min', note: 'Across every database in the estate' })
      ]),
      ui.card('Backup stores', backupTable, { actions: [ui.exportButton(backupTable, 'backup stores')] }),
      ui.card('Restore and DR drills', drillTable, { actions: [ui.exportButton(drillTable, 'drills')] })
    ]);
  }

  function declareFreeze() {
    var d = A.data;
    var reason = el('input.field', { type: 'text', id: 'freeze-why', autocomplete: 'off', spellcheck: 'false', placeholder: 'Quarter-end close, audit week, a migration in progress' });
    var hours = el('select.field', { id: 'freeze-hours' }, [['24', '24 hours'], ['72', '3 days'], ['168', '7 days']].map(function (o) {
      return el('option', { value: o[0], text: o[1] });
    }));
    A.dialog({
      title: 'Declare a change freeze',
      body: function () {
        return [
          el('p', { text: 'While a freeze is in force, approving any deployment into production needs security sign-off with a written reason, every approval records that it happened during the freeze, and the environment pill says so on every screen.' }),
          el('label.fieldlabel', { for: 'freeze-why', text: 'Reason (shown to everyone who hits it)' }), reason,
          el('label.fieldlabel', { for: 'freeze-hours', text: 'Duration' }), hours,
          el('p.hint', { text: 'A freeze lifts on its own at the end, or by hand from this screen.' })
        ];
      },
      actions: function (close) {
        var go = ui.btn('Declare freeze', {
          variant: 'danger', disabled: true,
          onClick: function () {
            var why = reason.value.trim();
            if (!why) return;
            close();
            A.stepUp('Declaring a change freeze needs a second factor.', function () {
              d.policy.freeze = { from: new Date(d.now.getTime()), until: new Date(d.now.getTime() + Number(hours.value) * 3600000), reason: why, by: A.me() };
              A.record('freeze.declare', why + ' for ' + hours.value + ' h');
              A.flash('warn', 'Change freeze declared', 'Until ' + fmt.stamp(d.policy.freeze.until) + '. Production approvals now need security sign-off.');
              A.refresh();
            });
          }
        });
        reason.addEventListener('input', function () { go.setDisabled(!reason.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
    reason.focus();
  }

  function liftFreeze() {
    var d = A.data;
    var f = A.freeze();
    if (!f) return;
    A.confirmDestructive({
      title: 'Lift the change freeze',
      match: 'lift',
      confirmLabel: 'Lift the freeze',
      detail: 'Declared by ' + f.by + ' until ' + fmt.stamp(f.until) + ': ' + f.reason + '. Lifting it early means production approvals go back to one or two people with a key, with no security sign-off.',
      blast: 'Every deployment waiting for approval becomes approvable without a justification.',
      reversible: 'A new freeze can be declared at any time.',
      onConfirm: function () {
        d.policy.freeze = null;
        A.record('freeze.lift', f.reason);
        A.flash('ok', 'Change freeze lifted', 'Production approvals are back to the normal policy.');
        A.refresh();
      }
    });
  }

  function freezeCard() {
    var f = A.freeze();
    if (f) {
      return el('div.callout.warn', [
        el('strong', { text: 'A change freeze is in force until ' + fmt.stamp(f.until) + '.' }),
        el('p', { text: f.reason + ' Declared by ' + f.by + ' ' + fmt.ago(f.from) + '.' }),
        el('div.row', [ui.btn('Lift the freeze', { variant: 'ghost', onClick: liftFreeze })])
      ]);
    }
    return el('div.callout.info', [
      el('strong', { text: 'No change freeze is in force.' }),
      el('p', { text: 'Deployments into production need the approvals their tier requires and nothing more. A freeze adds security sign-off with a written reason to every production approval until it lifts.' }),
      el('div.row', [ui.btn('Declare a change freeze', { variant: 'ghost', onClick: declareFreeze })])
    ]);
  }

  function maintenanceTab() {
    var d = A.data;
    var start = new Date(Date.UTC(d.now.getUTCFullYear(), d.now.getUTCMonth(), d.now.getUTCDate()));
    var cells = [];
    var windows = [];

    for (var i = 0; i < 28; i++) {
      var day = new Date(start.getTime() + i * 86400000);
      var isPatch = day.getUTCDay() === 2;
      var isFreeze = i >= 25;
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
      freezeCard(),
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

  var ALARM_METRICS = [
    { id: 'p95', label: 'p95 latency (ms)' },
    { id: 'errorRate', label: 'Error rate (%)' },
    { id: 'rps', label: 'Requests per second' }
  ];

  function alarmDialog(existing, onDone) {
    var d = A.data;
    var alarm = existing || { name: '', app: d.apps[0].name, metric: 'p95', op: '>', threshold: 500, forMin: 5, owner: A.me() };
    var name = el('input.field', { type: 'text', id: 'alarm-name', autocomplete: 'off', spellcheck: 'false', value: alarm.name, placeholder: 'What the page should say' });
    var app = el('select.field', { id: 'alarm-app' }, d.apps.map(function (a) { return el('option', { value: a.name, text: a.display, selected: a.name === alarm.app ? true : null }); }));
    var metric = el('select.field', { id: 'alarm-metric' }, ALARM_METRICS.map(function (m) { return el('option', { value: m.id, text: m.label, selected: m.id === alarm.metric ? true : null }); }));
    var op = el('select.field', { id: 'alarm-op' }, [['>', 'is above'], ['<', 'is below']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === alarm.op ? true : null }); }));
    var threshold = el('input.field', { type: 'number', id: 'alarm-threshold', step: 'any', min: '0', value: String(alarm.threshold) });
    var forMin = el('select.field', { id: 'alarm-for' }, [1, 5, 10, 30].map(function (n) { return el('option', { value: String(n), text: n + ' min', selected: n === alarm.forMin ? true : null }); }));
    var preview = el('p.hint', { role: 'status' });
    function paintPreview() {
      var trial = { app: app.value, metric: metric.value, op: op.value, threshold: Number(threshold.value), forMin: Number(forMin.value) };
      var ev = A.evaluateAlarm(trial);
      preview.textContent = 'Right now this would be ' + ev.state + ': ' + ev.text;
    }
    [app, metric, op, threshold, forMin].forEach(function (n) { n.addEventListener('change', paintPreview); n.addEventListener('input', paintPreview); });
    paintPreview();
    A.dialog({
      title: existing ? 'Edit alarm ' + existing.id : 'Create an alarm',
      body: function () {
        return [
          el('p', { text: 'An alarm is a Prometheus rule written for you: a metric, a comparison, a threshold and how long it has to hold. It pages the owner and lands in the inbox while it is in ALARM.' }),
          el('label.fieldlabel', { for: 'alarm-name', text: 'Name' }), name,
          el('label.fieldlabel', { for: 'alarm-app', text: 'Application' }), app,
          el('label.fieldlabel', { for: 'alarm-metric', text: 'Metric' }), metric,
          el('div.row', [
            el('div.formrow', [el('label.fieldlabel', { for: 'alarm-op', text: 'Condition' }), op]),
            el('div.formrow', [el('label.fieldlabel', { for: 'alarm-threshold', text: 'Threshold' }), threshold]),
            el('div.formrow', [el('label.fieldlabel', { for: 'alarm-for', text: 'For' }), forMin])
          ]),
          preview
        ];
      },
      actions: function (close) {
        var go = ui.btn(existing ? 'Save alarm' : 'Create alarm', {
          variant: 'primary', disabled: !alarm.name,
          onClick: function () {
            var label = name.value.trim();
            var value = Number(threshold.value);
            if (!label || !isFinite(value)) return;
            close();
            if (!existing) {
              var n = (d.alarms || []).reduce(function (m, a) { return Math.max(m, Number(String(a.id).replace(/\D/g, '')) || 0); }, 0) + 1;
              alarm = { id: 'alm-' + n, owner: A.me() };
              d.alarms = d.alarms || [];
              d.alarms.push(alarm);
            }
            alarm.name = label; alarm.app = app.value; alarm.metric = metric.value; alarm.op = op.value; alarm.threshold = value; alarm.forMin = Number(forMin.value);
            A.record(existing ? 'alarm.update' : 'alarm.create', alarm.id + ' ' + alarm.name + ': ' + alarm.app + ' ' + alarm.metric + ' ' + alarm.op + ' ' + alarm.threshold + ' for ' + alarm.forMin + ' min');
            A.flash('ok', existing ? 'Alarm saved' : 'Alarm created', alarm.name + '. The rule opens as a PrometheusRule in the next pull request.', { timeout: 6000 });
            if (onDone) onDone(alarm);
          }
        });
        name.addEventListener('input', function () { go.setDisabled(!name.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
    name.focus();
  }

  function alarmsTab() {
    var d = A.data;
    var list = d.alarms || [];
    var wanted = (A.state.params || {}).id;
    var inAlarm = list.filter(function (a) { return A.evaluateAlarm(a).state === 'ALARM'; }).length;

    var cols = [
      { key: 'id', label: 'Alarm', render: function (a) { return el('span.mono', { text: a.id }); } },
      { key: 'name', label: 'Name' },
      {
        key: 'state', label: 'State', status: true,
        sort: function (a) { return ['ALARM', 'INSUFFICIENT', 'OK'].indexOf(A.evaluateAlarm(a).state); },
        csv: function (a) { return A.evaluateAlarm(a).state; },
        render: function (a) {
          var ev = A.evaluateAlarm(a);
          return ui.pill(ev.state, ev.state === 'ALARM' ? 'bad' : ev.state === 'OK' ? 'ok' : 'idle', { title: ev.text });
        }
      },
      { key: 'app', label: 'Application', render: function (a) { var app = d.appByName(a.app); return app ? A.link(app.display, 'apps', [app.name]) : a.app; } },
      {
        key: 'rule', label: 'Rule', sortable: false,
        csv: function (a) { return a.metric + ' ' + a.op + ' ' + a.threshold + ' for ' + a.forMin + ' min'; },
        render: function (a) { return el('span.mono', { text: a.metric + ' ' + a.op + ' ' + a.threshold + ' for ' + a.forMin + ' min' }); }
      },
      {
        key: 'value', label: 'Now', align: 'right',
        sort: function (a) { return A.evaluateAlarm(a).value; },
        render: function (a) { var ev = A.evaluateAlarm(a); return ev.value === null ? el('span.muted', { text: 'no data' }) : fmt.num(ev.value, a.metric === 'errorRate' ? 2 : 0) + ev.unit; }
      },
      { key: 'owner', label: 'Pages' },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (a) {
          return el('div.row', [
            ui.btn('Edit ' + a.id, { variant: 'ghost', onClick: function () { alarmDialog(a, function () { A.replaceHash(A.href('ops', ['alarms'], { id: a.id })); A.refresh(); }); } }),
            ui.btn('Delete ' + a.id, {
              variant: 'ghost',
              onClick: function () {
                A.confirmDestructive({
                  title: 'Delete alarm ' + a.id, match: a.id, confirmLabel: 'Delete ' + a.id,
                  detail: a.name + ' stops being evaluated and nobody is paged for ' + a.app + ' ' + a.metric + ' again.',
                  blast: 'Owner ' + a.owner + ' is not told. The rule is removed from the next pull request.',
                  reversible: 'Create it again from this tab.',
                  onConfirm: function () {
                    d.alarms = d.alarms.filter(function (x) { return x !== a; });
                    A.record('alarm.delete', a.id + ' ' + a.name);
                    A.flash('warn', 'Alarm ' + a.id + ' deleted', a.name + '.');
                    A.replaceHash(A.href('ops', ['alarms']));
                    A.refresh();
                  }
                });
              }
            })
          ]);
        }
      }
    ];

    var table = ui.table(cols, list, {
      id: 'ops.alarms',
      caption: 'Alarms with their state right now, the application and metric they watch, the rule and who is paged',
      empty: 'No alarm is defined. Create one above.',
      sortKey: 'state', sortDir: 'asc',
      rowKey: function (a) { return a.id; }
    });
    if (wanted) ui.revealRow(table, wanted, { label: 'Alarm ' + wanted + ' is highlighted' });

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Alarms', fmt.num(list.length), { note: 'rules evaluated against the current values' }),
        ui.statTile('In alarm', fmt.num(inAlarm), { note: inAlarm ? 'each one is in the inbox' : 'nothing is firing' }),
        ui.statTile('OK', fmt.num(list.length - inAlarm - list.filter(function (a) { return A.evaluateAlarm(a).state === 'INSUFFICIENT'; }).length), { note: 'within their thresholds' })
      ]),
      el('div.callout.info', [
        el('strong', { text: 'An alarm here is a PrometheusRule in Git.' }),
        el('p', { text: 'Creating or editing one opens the change in the next pull request, the same way a deployment does. The state column is evaluated against the values this console holds right now, so the preview in the editor is exact.' })
      ]),
      el('div.row', [
        ui.btn('Create alarm', { variant: 'primary', onClick: function () { alarmDialog(null, function (a) { A.replaceHash(A.href('ops', ['alarms'], { id: a.id })); A.refresh(); }); } }),
        el('span.spacer'),
        ui.columnsButton(table, 'alarms'),
        ui.exportButton(table, 'alarms')
      ]),
      table
    ]);
  }

  function costTab() {
    var d = A.data, c = d.cost;
    var diff = c.awsBaselineUsd - c.monthlyTotalUsd;

    var centres = {};
    c.breakdown.forEach(function (r) {
      var k = r.costCentre || 'unallocated';
      centres[k] = centres[k] || { centre: k, total: 0, workloads: [] };
      centres[k].total += r.total;
      centres[k].workloads.push(r.app);
    });
    var centreRows = Object.keys(centres).map(function (k) { return centres[k]; });
    var centreCols = [
      { key: 'centre', label: 'Cost centre', render: function (r) { return el('span.chip.mono', { text: 'cost-centre: ' + r.centre }); } },
      { key: 'total', label: 'Monthly', align: 'right', render: function (r) { return '$' + fmt.num(r.total); } },
      {
        key: 'share', label: 'Share', align: 'right',
        sort: function (r) { return r.total / c.monthlyTotalUsd; },
        render: function (r) { return fmt.ratioPct(r.total / c.monthlyTotalUsd, 1); }
      },
      { key: 'workloads', label: 'Workloads', sortable: false, csv: function (r) { return r.workloads.join('; '); }, render: function (r) { return r.workloads.join(', '); } }
    ];
    var history = c.history || [];
    var trend = history.length > 1 ? history[history.length - 1] - history[0] : 0;

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
      ui.card('Cost by cost-centre tag', [
        el('p.hint', { text: 'Allocation follows the cost-centre tag on each workload, the way a cost allocation tag does on a cloud bill. Change the tag on an application and its cost moves here next month.' }),
        ui.table(centreCols, centreRows, {
          caption: 'Monthly amortised cost by cost-centre tag, with share of the total and the workloads under each',
          sortKey: 'total', sortDir: 'desc',
          rowKey: function (r) { return r.centre; }
        })
      ]),
      ui.card('Six-month trend', [
        el('div.row', [
          ui.sparkline(history, { width: 320, height: 44, label: 'Monthly total over the last ' + history.length + ' months, from $' + fmt.num(Math.min.apply(null, history)) + ' to $' + fmt.num(Math.max.apply(null, history)) }),
          el('span.num', { text: (trend >= 0 ? '+' : '-') + '$' + fmt.num(Math.abs(trend)) + ' over ' + history.length + ' months' })
        ]),
        el('p.hint', { text: 'Owned hardware barely moves month to month; what moves is power and the GPU share. A step up here is a new machine, not a surprise.' })
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

  function stampIso(iso) {
    if (!iso) return null;
    var t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (isNaN(t)) return String(iso);
    return fmt.stamp(new Date(t));
  }

  function readAt(env) {
    return el('p.hint', { text: 'Read from the console API at ' + (stampIso(env && env.at) || 'an unknown time') + '.' });
  }

  function liveOnly(sampleRender, liveRender) {
    if (A.storeMode() === A.MODE.SAMPLE) return sampleRender();
    var box = el('div.stack');
    A.whenProbed(function (mode) {
      ui.clear(box);
      ui.append(box, mode === A.MODE.LIVE ? liveRender() : sampleRender());
    });
    return box;
  }

  function notConfiguredCallout(what) {
    return function (body, e) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: what + ' is not configured.' }),
        el('p', { text: (e && e.message) || 'The console API has no address for it, so nothing here has been read.' })
      ]));
    };
  }

  function inline(text) {
    return String(text).replace(/\*\*/g, '').replace(/`/g, '');
  }

  function markdownNodes(body) {
    var lines = String(body || '').split(/\r?\n/);
    var out = [];
    var para = [];
    var list = null;
    var code = null;

    function flushPara() {
      if (para.length) out.push(el('p', { text: inline(para.join(' ')) }));
      para = [];
    }
    function flushList() {
      if (list) out.push(list.node);
      list = null;
    }
    function flushAll() { flushPara(); flushList(); }

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (code) {
        if (/^\s*```/.test(line)) { out.push(code.node); code = null; return; }
        code.node.appendChild(el('div.logline', { text: raw }));
        return;
      }
      if (/^\s*```/.test(line)) {
        flushAll();
        code = { node: el('div.logview', { role: 'group', 'aria-label': 'Code block' }) };
        return;
      }
      var h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flushAll();
        var level = Math.min(h[1].length + 1, 6);
        out.push(el('h' + level, { text: inline(h[2]) }));
        return;
      }
      var num = line.match(/^\s*\d+\.\s+(.+)$/);
      var bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (num || bullet) {
        flushPara();
        var kind = num ? 'ol' : 'ul';
        if (!list || list.kind !== kind) { flushList(); list = { kind: kind, node: el(kind) }; }
        list.node.appendChild(el('li', { text: inline(num ? num[1] : bullet[1]) }));
        return;
      }
      if (!line.trim()) { flushAll(); return; }
      if (/^\s*\|/.test(line)) { flushAll(); out.push(el('div.mono', { text: line.trim() })); return; }
      if (list && /^\s{2,}/.test(raw)) {
        var last = list.node.lastChild;
        if (last) last.textContent += ' ' + inline(line.trim());
        return;
      }
      para.push(line.trim());
    });
    if (code) out.push(code.node);
    flushAll();
    return out;
  }

  function approvalPill(approval) {
    if (!approval || approval === 'none') return ui.pill('none declared', 'idle');
    return ui.pill(APPROVAL_TEXT[approval] || String(approval), APPROVAL_TONE[approval] || 'idle');
  }

  function orderedRunbooks(list) {
    return (list || []).slice().sort(function (a, b) {
      var ix = Number(!!a.isIndex) - Number(!!b.isIndex);
      if (ix !== 0) return ix;
      return String(a.path || '').localeCompare(String(b.path || ''));
    });
  }

  function backButton() {
    return ui.btn('Back to runbooks', { variant: 'ghost', onClick: function () { A.go('ops'); } });
  }

  function liveRunbooksTab() {
    var cols = [
      {
        key: 'id', label: 'Runbook',
        render: function (rb) {
          var a = A.link(rb.id, 'ops', ['runbook', rb.id]);
          a.classList.add('mono');
          return a;
        }
      },
      {
        key: 'title', label: 'Title',
        render: function (rb) {
          return rb.isIndex ? el('span', [el('span', { text: rb.title + ' ' }), ui.pill('index', 'idle')]) : rb.title;
        }
      },
      {
        key: 'tier', label: 'Tier', align: 'right',
        render: function (rb) { return rb.tier === null || rb.tier === undefined ? el('span.muted', { text: 'none' }) : 'Tier ' + fmt.num(rb.tier); }
      },
      { key: 'approval', label: 'Approval', status: true, render: function (rb) { return approvalPill(rb.approval); } },
      { key: 'steps', label: 'Steps', align: 'right', render: function (rb) { return fmt.num(rb.steps || 0); } },
      {
        key: 'sections', label: 'Sections', sortable: false,
        csv: function (rb) { return (rb.sections || []).join('; '); },
        render: function (rb) { return (rb.sections || []).length ? rb.sections.join(', ') : el('span.muted', { text: 'none' }); }
      },
      { key: 'updatedAt', label: 'Updated', render: function (rb) { return el('span.mono', { text: stampIso(rb.updatedAt) || 'unknown' }); } }
    ];

    return el('div.stack', [
      A.livePanel('Runbooks', '/api/runbooks', function (body, data, env) {
        var rows = orderedRunbooks(data.runbooks);
        body.appendChild(el('div.callout.info', [
          el('strong', { text: 'Runbooks are documents here, not scripts the console can run.' }),
          el('p', { text: (data.note || 'The endpoint that would execute a runbook does not exist yet.') + ' Source: ' + (data.source || 'unknown') + '.' })
        ]));
        body.appendChild(ui.table(cols, rows, {
          caption: 'Runbooks read from the runbooks directory, with their tier, approval, step count and sections',
          empty: 'The runbooks directory holds no markdown file.',
          rowKey: function (rb) { return rb.path; },
          onRow: function (rb) { A.go('ops', ['runbook', rb.id]); }
        }));
        body.appendChild(readAt(env));
      }, { notConfigured: notConfiguredCallout('The runbooks directory'), skeletonRows: 5 })
    ]);
  }

  function liveRunbookDetail(mount, id) {
    var box = el('div.stack', [ui.skeleton(4)]);
    mount.appendChild(box);
    var alive = true;
    A.onLeave(function () { alive = false; });

    A.read('/api/runbooks', { ttlMs: 15000 }).then(function (env) {
      if (!alive) return;
      ui.clear(box);
      if (!env.ok) {
        var e = env.error || {};
        box.appendChild(ui.pageHeader('Runbook ' + id, 'The runbook list could not be read.', [backButton()]));
        if (e.reason === 'unauthenticated') {
          box.appendChild(ui.emptyState('Sign in to read this', 'The console API answers only to a signed-in operator.'));
        } else if (e.reason === 'not-configured') {
          notConfiguredCallout('The runbooks directory')(box, e);
        } else {
          box.appendChild(ui.errorState('The runbooks could not be read', e.message || 'The request failed.',
            function () { A.forget('/api/runbooks'); A.refresh(); }));
        }
        return;
      }

      var list = orderedRunbooks(env.data.runbooks);
      var rb = list.filter(function (r) { return r.id === id; })[0];

      if (!rb) {
        box.appendChild(ui.pageHeader('Runbook not found', id, [backButton()]));
        box.appendChild(ui.emptyState(
          'No runbook has that identifier',
          'The runbooks directory read at ' + (stampIso(env.at) || 'an unknown time') + ' holds ' + fmt.num(list.length)
            + ' document' + (list.length === 1 ? '' : 's') + ', and none is called ' + id
            + '. The link may come from the sample dataset or from an older version of the console.'));
        if (list.length) {
          box.appendChild(ui.card('Runbooks that exist', el('ul', list.map(function (r) {
            var a = A.link(r.id, 'ops', ['runbook', r.id]);
            a.classList.add('mono');
            return el('li', [a, el('span.muted', { text: ' ' + r.title })]);
          }))));
        }
        return;
      }

      box.appendChild(ui.pageHeader(rb.title, rb.id, [backButton()]));

      var meta = ui.dl([
        ['Path', el('span.mono', { text: rb.path })],
        ['Tier', rb.tier === null || rb.tier === undefined ? 'none declared' : 'Tier ' + fmt.num(rb.tier)],
        ['Approval', approvalPill(rb.approval)],
        ['Numbered steps', fmt.num(rb.steps || 0)],
        ['Sections', (rb.sections || []).length ? rb.sections.join(', ') : 'none'],
        ['Updated', stampIso(rb.updatedAt) || 'unknown'],
        ['Size', fmt.num(rb.bytes || 0) + ' bytes'],
        ['Read', stampIso(env.at) || 'unknown']
      ]);

      var params = rb.params || [];
      var paramsNode = params.length
        ? ui.table([
          { key: 'name', label: 'Parameter', render: function (p) { return el('span.mono', { text: p.name || '(unnamed)' }); } },
          { key: 'type', label: 'Type', render: function (p) { return p.type || 'unspecified'; } },
          { key: 'default', label: 'Default', render: function (p) { return p.default === null || p.default === undefined ? el('span.muted', { text: 'none' }) : String(p.default); } }
        ], params, { caption: 'Parameters the runbook declares in its front matter', rowKey: function (p) { return p.name; } })
        : el('p.muted', { text: 'This runbook declares no parameters.' });

      box.appendChild(ui.card('About this runbook', [
        meta,
        el('div.callout.info', [
          el('strong', { text: env.data.executable === false ? 'This runbook cannot be run from the console.' : 'Running is not available from this screen.' }),
          el('p', { text: (env.data.note || 'The endpoint that would execute it does not exist yet.') + ' Reading it here records nothing, because the console has no write path.' })
        ]),
        paramsNode
      ]));

      box.appendChild(A.livePanel('Runbook', '/api/runbooks/body?path=' + encodeURIComponent(rb.path), function (body, data, env2) {
        var nodes = markdownNodes(data.body);
        if (!nodes.length) {
          body.appendChild(ui.emptyState('The runbook is empty', 'The file holds front matter and nothing else.'));
        } else {
          body.appendChild(el('div.prose', nodes));
        }
        body.appendChild(readAt(env2));
      }, { skeletonRows: 8, errorTitle: 'The runbook body could not be read' }));
    });
  }

  function matcherText(m) { return m.name + (m.isRegex ? '=~' : '=') + m.value; }

  function liveAlarmsTab() {
    var ruleCols = [
      { key: 'name', label: 'Rule', render: function (r) { return el('span.mono', { text: r.name || '(unnamed)' }); } },
      { key: 'group', label: 'Group' },
      { key: 'type', label: 'Type', status: true, render: function (r) { return ui.pill(r.type || 'unknown', r.type === 'alerting' ? 'info' : 'idle'); } },
      {
        key: 'state', label: 'State', status: true,
        render: function (r) {
          if (!r.state) return el('span.muted', { text: 'n/a' });
          return ui.pill(r.state, r.state === 'firing' ? 'bad' : r.state === 'pending' ? 'warn' : r.state === 'inactive' ? 'ok' : 'idle');
        }
      },
      {
        key: 'health', label: 'Health', status: true,
        render: function (r) { return ui.pill(r.health || 'unknown', r.health === 'ok' ? 'ok' : r.health === 'err' ? 'bad' : 'idle', { title: r.lastError || null }); }
      },
      { key: 'file', label: 'File', render: function (r) { return el('span.mono', { text: r.file || '' }); } }
    ];

    var silenceCols = [
      { key: 'id', label: 'Silence', render: function (s) { return el('span.mono', { text: s.id || '(no id)' }); } },
      { key: 'comment', label: 'Comment', render: function (s) { return s.comment || el('span.muted', { text: 'none' }); } },
      { key: 'createdBy', label: 'By', render: function (s) { return s.createdBy || el('span.muted', { text: 'unknown' }); } },
      { key: 'state', label: 'State', status: true, render: function (s) { return ui.pill(s.state || 'unknown', s.state === 'active' ? 'warn' : 'idle'); } },
      { key: 'endsAt', label: 'Ends', render: function (s) { return el('span.mono', { text: stampIso(s.endsAt) || 'unknown' }); } },
      {
        key: 'matchers', label: 'Matchers', sortable: false,
        csv: function (s) { return (s.matchers || []).map(matcherText).join('; '); },
        render: function (s) { return el('span.mono', { text: (s.matchers || []).map(matcherText).join(', ') }); }
      }
    ];

    return el('div.stack', [
      el('div.callout.info', [
        el('strong', { text: 'An alarm here is a Prometheus rule in Git.' }),
        el('p', { text: 'The console reads the rules Prometheus has loaded and the silences Alertmanager holds. It has no write path, so there is nothing to create, edit or delete on this screen; a rule changes through a pull request.' })
      ]),
      A.livePanel('Alerting and recording rules', '/api/metrics/rules', function (body, data, env) {
        var rows = [];
        (data.groups || []).forEach(function (g) {
          (g.rules || []).forEach(function (r) {
            rows.push({ group: g.name, file: g.file, name: r.name, type: r.type, state: r.state, health: r.health, lastError: r.lastError });
          });
        });
        rows.sort(function (a, b) {
          var t = Number(b.type === 'alerting') - Number(a.type === 'alerting');
          if (t !== 0) return t;
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
        var firing = rows.filter(function (r) { return r.state === 'firing'; }).length;
        var alerting = rows.filter(function (r) { return r.type === 'alerting'; }).length;
        body.appendChild(el('div.tiles', [
          ui.statTile('Rule groups', fmt.num((data.groups || []).length), { note: 'loaded by Prometheus' }),
          ui.statTile('Alerting rules', fmt.num(alerting), { note: 'of ' + fmt.num(rows.length) + ' rules in total' }),
          ui.statTile('Firing', fmt.num(firing), { note: firing ? 'alerting rules in the firing state' : 'no alerting rule is firing' })
        ]));
        body.appendChild(ui.table(ruleCols, rows, {
          caption: 'Rules loaded by Prometheus, alerting rules first, with their state and health',
          empty: 'Prometheus answered and has no rule loaded.',
          rowKey: function (r) { return r.group + '/' + r.name; }
        }));
        body.appendChild(readAt(env));
      }, { notConfigured: notConfiguredCallout('Prometheus'), skeletonRows: 4 }),
      A.livePanel('Silences', '/api/alerts/silences', function (body, data, env) {
        body.appendChild(ui.table(silenceCols, data.silences || [], {
          caption: 'Active silences held by Alertmanager',
          empty: 'Alertmanager answered and holds no active silence.',
          rowKey: function (s) { return s.id; }
        }));
        body.appendChild(readAt(env));
      }, { notConfigured: notConfiguredCallout('Alertmanager'), skeletonRows: 2 })
    ]);
  }

  function liveMaintenanceTab() {
    return el('div.stack', [
      A.notInStack('Change freezes', 'are a console-only policy with no source in this stack: nothing records one, so none can be declared, lifted or shown here.'),
      A.notInStack('Maintenance windows', 'have no calendar in this stack. There is no patch schedule the console can read, so none is drawn rather than a picture nobody keeps.')
    ]);
  }

  function liveBackupsTab() {
    var cols = [
      { key: 'name', label: 'Bucket', render: function (b) { var a = A.link(b.name, 'data', ['bucket', b.name]); a.classList.add('mono'); return a; } },
      { key: 'owner', label: 'Owner', render: function (b) { return b.owner || el('span.muted', { text: 'undeclared' }); } },
      {
        key: 'lock', label: 'Object lock',
        render: function (b) {
          if (b.lock) return b.lock + (b.lockDays ? ' ' + fmt.num(b.lockDays) + ' d' : '');
          return b.lockDeclared ? 'declared ' + b.lockDeclared : el('span.muted', { text: 'none' });
        }
      },
      {
        key: 'versioning', label: 'Versioning',
        render: function (b) { return b.versioning === null || b.versioning === undefined ? el('span.muted', { text: 'unknown' }) : (b.versioning ? 'on' : 'off'); }
      },
      {
        key: 'diskBytes', label: 'On disk', align: 'right',
        render: function (b) { return b.diskBytes === null || b.diskBytes === undefined ? el('span.muted', { text: 'unknown' }) : fmt.bytesTB(b.diskBytes / 1099511627776); }
      },
      { key: 'replication', label: 'Replication', render: function (b) { return b.replication || 'not configured'; } }
    ];
    return el('div.stack', [
      A.notInStack('Backups and restore drills', 'have no source here: no Kopia, no wal-g and no drill record run in this stack, so no backup age, drill outcome or RPO is shown.'),
      A.livePanel('Buckets named for backups', '/api/storage/buckets', function (body, data, env) {
        var rows = (data.buckets || []).filter(function (b) { return /backup/i.test(b.name || ''); });
        body.appendChild(el('p.hint', { text: 'The only backup-shaped thing the console can read is the object store. These are the buckets whose name contains "backup"; whether anything writes to them is not known from here.' }));
        if (data.declaredError) body.appendChild(el('p.muted', { text: 'Declared buckets could not be read: ' + data.declaredError }));
        body.appendChild(ui.table(cols, rows, {
          caption: 'Buckets in the object store whose name contains backup',
          empty: 'The object store answered and no bucket is named for backups.',
          rowKey: function (b) { return b.name; }
        }));
        body.appendChild(readAt(env));
      }, { notConfigured: notConfiguredCallout('The object store'), skeletonRows: 2 })
    ]);
  }

  function liveCostTab() {
    return el('div.stack', [
      A.notInStack('Capacity and cost', 'have no source in this stack: there is no billing, no amortisation schedule and no capacity forecast the console can read, so no figure is shown.')
    ]);
  }

  A.screen('ops', {
    title: 'Operations',
    crumb: 'Operations',
    crumbs: function (rest) {
      if (rest[0] === 'runbook' && rest[1]) return ['Runbooks', rest[1]];
      return rest.map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); });
    },
    render: function (mount, ctx) {
      if (ctx.rest[0] === 'runbook' && ctx.rest[1]) {
        if (A.storeMode() === A.MODE.SAMPLE) { runbookDetail(mount, ctx.rest[1]); return; }
        var holder = el('div');
        mount.appendChild(holder);
        A.whenProbed(function (mode) {
          if (mode === A.MODE.LIVE) liveRunbookDetail(holder, ctx.rest[1]); else runbookDetail(holder, ctx.rest[1]);
        });
        return;
      }

      mount.appendChild(ui.pageHeader('Operations', A.storeMode() === A.MODE.LIVE
        ? 'The runbooks this stack holds, the rules Prometheus has loaded, and a plain statement of what has no source here.'
        : 'Runbooks you can actually run, backups somebody has actually restored, and what the estate costs to own.'));
      mount.appendChild(ui.tabs([
        { id: 'runbooks', label: 'Runbooks', render: function () { return liveOnly(runbooksTab, liveRunbooksTab); } },
        { id: 'backups', label: 'Backups and drills', render: function () { return liveOnly(backupsTab, liveBackupsTab); } },
        { id: 'maintenance', label: 'Maintenance', render: function () { return liveOnly(maintenanceTab, liveMaintenanceTab); } },
        { id: 'alarms', label: 'Alarms', render: function () { return liveOnly(alarmsTab, liveAlarmsTab); } },
        { id: 'cost', label: 'Capacity and cost', render: function () { return liveOnly(costTab, liveCostTab); } }
      ], {
        label: 'Operations sections',
        initial: (ctx && ctx.rest && ctx.rest[0]) || null,
        href: function (id) { return A.href('ops', [id]); }
      }));
    }
  });
})();
