(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var LINUX_HOSTS = { 'siem-01': true, 'guac-01': true };

  var SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info' };
  var STATE_TONE = { open: 'warn', ack: 'info', resolved: 'ok' };
  var SESSION_TONE = { active: 'warn', closed: 'ok', terminated: 'bad' };

  var CIS_CHECKS = {
    'Account policy': [
      '1.1.1 Enforce password history: 24 passwords remembered',
      '1.2.2 Account lockout threshold: 5 invalid attempts',
      '1.1.4 Minimum password length: 14 characters'
    ],
    'Audit': [
      '17.2.1 Audit Application Group Management: Success and Failure',
      '17.5.2 Audit Logon: Success and Failure',
      '17.9.4 Audit Security State Change: Success'
    ],
    'Defender': [
      '18.9.47.5.1 Turn on behaviour monitoring',
      '18.9.47.9.1 Scan removable drives',
      '18.9.47.4.1 Configure detection for potentially unwanted applications'
    ],
    'Firewall': [
      '9.1.2 Domain profile: inbound connections blocked by default',
      '9.3.5 Public profile: log dropped packets',
      '9.2.1 Private profile: firewall state is On'
    ],
    'Network': [
      '18.5.4.1 Turn off multicast name resolution',
      '18.5.8.1 Disable the SMBv1 client driver',
      '2.3.10.7 Restrict anonymous access to named pipes and shares'
    ],
    'Services': [
      '5.1 Print Spooler is disabled',
      '5.9 Remote Registry is disabled',
      '5.24 Xbox Live Auth Manager is disabled'
    ],
    'User rights': [
      '2.2.7 Deny log on locally includes Guests',
      '2.2.21 Impersonate a client after authentication: service accounts only',
      '2.2.30 Debug programs: Administrators only'
    ]
  };

  var KEYSTROKES = {
    's-2291': [
      { at: 18, text: 'sqlcmd -S sql-drill-01 -E -Q "SELECT @@VERSION"' },
      { at: 96, text: 'Restore-DbaDatabase -SqlInstance sql-drill-01 -Path S:\\restore\\orders_db' },
      { at: 540, text: 'Get-DbaDbRestoreHistory -SqlInstance sql-drill-01 -Last' },
      { at: 902, text: 'Invoke-DbaQuery -Query "DBCC CHECKDB (orders_db) WITH NO_INFOMSGS"' },
      { at: 1288, text: 'Test-DbaLastBackup -SqlInstance sql-drill-01 -Database orders_db' },
      { at: 1602, text: 'exit' }
    ],
    's-2290': [
      { at: 11, text: 'systemctl status ray-worker' },
      { at: 74, text: 'journalctl -u ray-worker -n 200 --no-pager' },
      { at: 208, text: 'nvidia-smi' },
      { at: 331, text: 'sudo systemctl restart ray-worker' },
      { at: 402, text: 'ray status --address 10.31.0.60:6379' },
      { at: 522, text: 'logout' }
    ],
    's-2289': [
      { at: 22, text: 'Import-Module WebAdministration' },
      { at: 140, text: 'Get-WebAppPoolState -Name LandSurveyApiPool' },
      { at: 611, text: 'Restart-WebAppPool -Name LandSurveyApiPool' },
      { at: 980, text: 'Get-EventLog -LogName Application -Newest 40 -Source "ASP.NET 4.0"' },
      { at: 1544, text: 'Invoke-WebRequest http://localhost/landsurvey/health -UseBasicParsing' },
      { at: 2044, text: 'logoff' }
    ],
    's-2288': [
      { at: 14, text: 'sudo -u wazuh /var/ossec/bin/wazuh-logtest' },
      { at: 190, text: 'sudo nano /var/ossec/etc/rules/local_rules.xml' },
      { at: 466, text: 'sudo /var/ossec/bin/wazuh-analysisd -t' },
      { at: 640, text: 'sudo systemctl restart wazuh-manager' },
      { at: 802, text: 'tail -n 50 /var/ossec/logs/ossec.log' },
      { at: 880, text: 'logout' }
    ]
  };

  function isApplicable(d, host, colIndex) {
    return !(LINUX_HOSTS[host] && d.posture.families[colIndex] === 'Defender');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function offsetLabel(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(sec);
  }

  function blastFor(name) {
    var d = A.data;
    var guests = d.vms.filter(function (v) { return v.host === name; })
      .map(function (v) { return v.name; });
    if (guests.length) {
      return 'Guests on ' + name + ' that lose their network with it: ' + guests.join(', ') + '.';
    }
    var vm = d.vmByName(name);
    if (vm) return name + ' runs ' + vm.role + ' in zone ' + vm.zone + '.';
    var node = d.sfNodes.filter(function (n) { return n.name === name; })[0];
    if (node) return name + ' hosts ' + node.apps.join(', ') + '.';
    var app = d.appByName(name);
    if (app) return name + ' serves ' + app.display + ' on ' + app.host + '.';
    return 'Nothing else in the inventory is recorded as running on ' + name + '.';
  }

  function postureTab() {
    var d = A.data, p = d.posture;

    var total = 0, count = 0, worstHostCount = 0;
    var familySum = [], familyCount = [];
    p.families.forEach(function () { familySum.push(0); familyCount.push(0); });

    p.hosts.forEach(function (host) {
      var lowest = 100;
      p.families.forEach(function (fam, ci) {
        if (!isApplicable(d, host, ci)) return;
        var v = p.scores[host][ci];
        total += v; count += 1;
        familySum[ci] += v; familyCount[ci] += 1;
        if (v < lowest) lowest = v;
      });
      if (lowest < 95) worstHostCount += 1;
    });

    var mean = count ? total / count : 0;
    var worstIndex = 0, worstMean = 101;
    p.families.forEach(function (fam, ci) {
      var m = familyCount[ci] ? familySum[ci] / familyCount[ci] : 100;
      if (m < worstMean) { worstMean = m; worstIndex = ci; }
    });

    var tiles = el('div.tiles', [
      ui.statTile('Mean baseline score', fmt.pct(mean, 1), {
        note: fmt.num(count) + ' applicable host and family pairs'
      }),
      ui.statTile('Hosts below 95%', fmt.num(worstHostCount), {
        unit: 'of ' + fmt.num(p.hosts.length),
        note: 'Counted where any single family drifts below the threshold'
      }),
      ui.statTile('Worst family', p.families[worstIndex], {
        note: 'Mean ' + fmt.pct(worstMean, 1) + ' across the estate'
      })
    ]);

    var grid = ui.heatgrid(p.hosts, p.families, function (host, colIndex) {
      if (!isApplicable(d, host, colIndex)) return null;
      return p.scores[host][colIndex];
    }, {
      caption: 'CIS and Microsoft baseline score by host and control family',
      corner: 'Host',
      onCell: function (host, family, score) {
        var colIndex = p.families.indexOf(family);
        var na = !isApplicable(d, host, colIndex);
        var checks = CIS_CHECKS[family] || [];
        var failing = na || score >= 100 ? [] : checks.slice(0, score >= 95 ? 2 : 3);

        A.dialog({
          title: host + ' · ' + family,
          body: function () {
            return [
              el('p', {
                text: na
                  ? host + ' runs Ubuntu, so the ' + family + ' family does not apply to it. '
                    + 'Wazuh reports 0 because there is nothing to score, not because the host failed.'
                  : 'Wazuh SCA scored the ' + family + ' family on ' + host + ' at '
                    + fmt.pct(score, 0) + ' at the last daily evaluation.'
              }),
              na ? el('div.callout.info', {
                text: 'Not applicable. This cell is excluded from the mean score and from the paging threshold.'
              }) : null,
              !na && failing.length ? el('div.sectiontitle', { text: 'Failing checks' }) : null,
              !na && failing.length ? el('ul', failing.map(function (c) {
                return el('li', el('span.mono', { text: c }));
              })) : null,
              !na && !failing.length ? el('div.callout.ok', {
                text: 'Every check in this family passed at the last evaluation.'
              }) : null,
              el('p.hint', {
                text: 'Scores come from the Wazuh SCA module and are re-evaluated once a day at 02:00.'
              })
            ];
          },
          actions: function (close) {
            return [
              ui.btn('Close', { variant: 'ghost', onClick: close }),
              ui.btn('Open runbook', {
                variant: 'primary',
                title: 'Operations, runbooks',
                onClick: function () { close(); A.go('ops'); }
              })
            ];
          }
        });
      }
    });

    return el('div.stack', [
      tiles,
      el('div.callout.info', [
        el('strong', { text: 'Wazuh SCA scores every host once a day.' }),
        el('p', {
          text: 'A control family that drifts below 95% raises an alert and pages the on-call operator. '
            + 'The score is a measurement, not a gate: nothing is blocked automatically, because a false '
            + 'positive that quarantines a domain controller is worse than the drift it was chasing.'
        })
      ]),
      ui.card('Baseline score by host and control family', [
        grid,
        el('p.hint', {
          text: 'Cells reading 0 for Defender on siem-01 and guac-01 are not applicable rather than failures: '
            + 'both hosts run Ubuntu 24.04 and have no Microsoft Defender to configure. They are excluded from '
            + 'the mean and from the alerting threshold. Select any cell for the failing checks behind its score.'
        })
      ], { flush: false })
    ]);
  }

  function acknowledgeDialog(alert, many) {
    var targets = many && many.length ? many : [alert];
    var plural = !!(many && many.length);
    A.dialog({
      title: plural ? 'Acknowledge ' + fmt.num(targets.length) + ' alert' + (targets.length === 1 ? '' : 's') : 'Acknowledge ' + alert.id,
      body: function () {
        var note = el('textarea.field', {
          id: 'ack-note', rows: '4', spellcheck: 'false',
          'aria-describedby': 'ack-help'
        });
        return [
          plural
            ? el('ul', targets.map(function (a) { return el('li', { text: a.id + ' · ' + a.rule + ' on ' + a.host }); }))
            : el('p', { text: alert.rule + ' on ' + alert.host + ', raised by ' + alert.source + '.' }),
          el('label.fieldlabel', { for: 'ack-note', text: 'Why are you acknowledging it?' }),
          note,
          el('p.hint', {
            id: 'ack-help',
            text: 'The note is written to the audit next to your name. Acknowledging stops the pages; it does not close the alert.'
          })
        ];
      },
      actions: function (close) {
        return [
          ui.btn('Cancel', { variant: 'ghost', onClick: close }),
          ui.btn(plural ? 'Acknowledge ' + fmt.num(targets.length) + ' alert' + (targets.length === 1 ? '' : 's') : 'Acknowledge alert ' + alert.id, {
            variant: 'primary',
            onClick: function () {
              var field = document.getElementById('ack-note');
              var note = field && field.value.trim();
              close();
              var rows = targets.map(function (a) {
                a.state = 'ack';
                return A.record('alert.acknowledge', a.id + ' ' + a.rule + ' on ' + a.host + (note ? ': ' + note : ''));
              });
              var undo = A.undoable('Undo', function () {
                targets.forEach(function (a) { a.state = 'open'; });
                rows.forEach(A.unrecord);
                A.flash('info', plural ? 'Acknowledgements undone' : 'Acknowledgement undone',
                  (plural ? fmt.num(targets.length) + ' alerts are' : alert.id + ' is') + ' open again and the audit rows are withdrawn.', { timeout: 6000 });
                A.refresh();
              });
              A.flash('ok', plural ? fmt.num(targets.length) + ' alert' + (targets.length === 1 ? '' : 's') + ' acknowledged' : 'Alert ' + alert.id + ' acknowledged',
                (note ? 'Note recorded: ' + note : 'No note was recorded, so the audit shows an empty reason.') +
                ' Pages have stopped; the alerts stay listed until they are resolved at the source.', { action: undo });
              var keep = { f: (A.state.params || {}).f || null, id: plural ? null : alert.id };
              A.replaceHash(A.href('security', ['alerts'], keep));
              A.refresh();
            }
          })
        ];
      }
    });
  }

  var INC_TONE = { open: 'bad', mitigated: 'warn', resolved: 'ok' };

  function incidentById(id) {
    return (A.data.incidents || []).filter(function (i) { return i.id === id; })[0] || null;
  }

  function openIncidentDialog(alert) {
    var d = A.data;
    var title = el('input.field', { type: 'text', id: 'inc-title', autocomplete: 'off', spellcheck: 'false', value: alert ? alert.rule + ' on ' + alert.host : '' });
    var sev = el('select.field', { id: 'inc-sev' }, ['critical', 'high', 'medium', 'low'].map(function (s) {
      return el('option', { value: s, text: s, selected: alert && alert.severity === s ? true : null });
    }));
    var who = el('select.field', { id: 'inc-cmd' }, d.people.map(function (p) {
      return el('option', { value: p.upn, text: p.name + ' (' + p.upn + ')', selected: p.upn === A.me() ? true : null });
    }));
    var note = el('textarea.field', { id: 'inc-note', rows: '3', spellcheck: 'false', placeholder: 'What is known right now, and what is being done first.' });
    A.dialog({
      title: 'Open an incident',
      body: function () {
        return [
          el('p', { text: alert ? 'From alert ' + alert.id + ', raised by ' + alert.source + '. The alert is linked and acknowledged, and the incident collects every audit row about ' + alert.host + ' from here on.' : 'An incident gathers a commander, a timeline and every related audit row in one place.' }),
          el('label.fieldlabel', { for: 'inc-title', text: 'Title' }), title,
          el('label.fieldlabel', { for: 'inc-sev', text: 'Severity' }), sev,
          el('label.fieldlabel', { for: 'inc-cmd', text: 'Incident commander' }), who,
          el('label.fieldlabel', { for: 'inc-note', text: 'First timeline entry' }), note
        ];
      },
      actions: function (close) {
        var go = ui.btn('Open incident', {
          variant: 'primary', disabled: !title.value.trim(),
          onClick: function () {
            var name = title.value.trim();
            if (!name) return;
            var n = (d.incidents || []).reduce(function (m, i) { return Math.max(m, Number(String(i.id).replace(/\D/g, '')) || 0); }, 0) + 1;
            var inc = {
              id: 'inc-' + n, title: name, severity: sev.value, state: 'open', commander: who.value,
              host: alert ? alert.host : '-', alerts: alert ? [alert.id] : [],
              opened: new Date(d.now.getTime()), updated: new Date(d.now.getTime()),
              timeline: [{ at: new Date(d.now.getTime()), who: A.me(), text: (alert ? 'Opened from alert ' + alert.id + '. ' : 'Opened. ') + (note.value.trim() || 'No first note.') }]
            };
            if (!d.incidents) d.incidents = [];
            d.incidents.unshift(inc);
            if (alert && alert.state === 'open') alert.state = 'ack';
            A.record('incident.open', inc.id + ' ' + inc.title + ' (' + inc.severity + ', commander ' + inc.commander + ')');
            close();
            A.flash('warn', 'Incident ' + inc.id + ' opened', inc.title + '. ' + personName(inc.commander) + ' is the commander; every step goes on its timeline.');
            A.go('security', ['incidents'], { id: inc.id });
          }
        });
        title.addEventListener('input', function () { go.setDisabled(!title.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
  }

  function personName(upn) {
    var p = A.data.personByUpn(upn);
    return p ? p.name : upn;
  }

  function addTimelineNote(inc) {
    var note = el('textarea.field', { id: 'inc-add-note', rows: '3', spellcheck: 'false' });
    A.dialog({
      title: 'Add to the timeline of ' + inc.id,
      body: function () {
        return [el('label.fieldlabel', { for: 'inc-add-note', text: 'What happened, or what was decided' }), note];
      },
      actions: function (close) {
        var go = ui.btn('Add entry', {
          variant: 'primary', disabled: true,
          onClick: function () {
            var text = note.value.trim();
            if (!text) return;
            inc.timeline.push({ at: new Date(A.data.now.getTime()), who: A.me(), text: text });
            inc.updated = new Date(A.data.now.getTime());
            A.record('incident.note', inc.id + ': ' + text);
            close();
            A.replaceHash(A.href('security', ['incidents'], { id: inc.id }));
            A.refresh();
          }
        });
        note.addEventListener('input', function () { go.setDisabled(!note.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
    note.focus();
  }

  function setIncidentState(inc, next) {
    var d = A.data;
    var apply = function () {
      inc.state = next;
      inc.updated = new Date(d.now.getTime());
      inc.timeline.push({ at: inc.updated, who: A.me(), text: next === 'resolved' ? 'Resolved.' : next === 'mitigated' ? 'Mitigated. Watching before resolving.' : 'Reopened.' });
      if (next === 'resolved') {
        inc.alerts.forEach(function (id) {
          var a = d.alerts.filter(function (x) { return x.id === id; })[0];
          if (a && a.state !== 'resolved') a.state = 'resolved';
        });
      }
      A.record('incident.' + (next === 'open' ? 'reopen' : next), inc.id + ' ' + inc.title);
      A.flash(next === 'resolved' ? 'ok' : 'info', inc.id + ' ' + next, inc.title + (next === 'resolved' && inc.alerts.length ? '. The linked alerts are resolved with it.' : '.'));
      A.replaceHash(A.href('security', ['incidents'], { id: inc.id }));
      A.refresh();
    };
    if (next === 'resolved') {
      A.confirmDestructive({
        title: 'Resolve ' + inc.id,
        match: inc.id,
        confirmLabel: 'Resolve ' + inc.id,
        detail: 'Resolving closes the incident and marks ' + (inc.alerts.length ? 'its ' + fmt.num(inc.alerts.length) + ' linked alert' + (inc.alerts.length === 1 ? '' : 's') : 'no alert') + ' resolved. The timeline stays readable for ever.',
        blast: 'Commander ' + personName(inc.commander) + ', opened ' + fmt.ago(inc.opened) + ', ' + fmt.num(inc.timeline.length) + ' timeline entries.',
        reversible: 'An incident can be reopened from its page, which writes a new timeline entry rather than erasing this one.',
        onConfirm: apply
      });
      return;
    }
    apply();
  }

  function relatedAudit(inc) {
    var d = A.data;
    var needles = [inc.id, inc.host].concat(inc.alerts).filter(function (x) { return x && x !== '-'; }).map(String);
    return d.audit.filter(function (r) {
      var hay = r.target + ' ' + r.action;
      return needles.some(function (n) { return hay.indexOf(n) !== -1; }) && r.at >= inc.opened;
    });
  }

  function incidentDetail(inc) {
    var entries = inc.timeline.map(function (t) { return { at: t.at, who: t.who, text: t.text, kind: 'note' }; })
      .concat(relatedAudit(inc).map(function (r) {
        return { at: r.at, who: r.actor, text: r.action.split('.').join(' ') + ': ' + r.target, kind: 'audit' };
      }))
      .sort(function (a, b) { return a.at - b.at; });

    var actions = [];
    if (inc.state !== 'resolved') actions.push(ui.btn('Add to timeline', { variant: 'primary', onClick: function () { addTimelineNote(inc); } }));
    if (inc.state === 'open') actions.push(ui.btn('Mark mitigated', { variant: 'ghost', onClick: function () { setIncidentState(inc, 'mitigated'); } }));
    if (inc.state !== 'resolved') actions.push(ui.btn('Resolve ' + inc.id, { variant: 'danger', onClick: function () { setIncidentState(inc, 'resolved'); } }));
    if (inc.state === 'resolved') actions.push(ui.btn('Reopen ' + inc.id, { variant: 'ghost', onClick: function () { setIncidentState(inc, 'open'); } }));

    return ui.card(inc.id + ' · ' + inc.title, [
      el('div.row', [
        ui.pill(inc.state, INC_TONE[inc.state] || 'idle'),
        ui.pill(inc.severity, SEV_TONE[inc.severity] || 'idle'),
        el('span.muted', { text: 'Commander ' + personName(inc.commander) + ' · opened ' + fmt.ago(inc.opened) + ' · updated ' + fmt.ago(inc.updated) })
      ]),
      ui.dl([
        ['Host', el('span.mono', { text: inc.host })],
        ['Linked alerts', inc.alerts.length
          ? el('div.chips', inc.alerts.map(function (id) { return A.link(id, 'security', ['alerts'], { id: id }, 'chip'); }))
          : el('span.muted', { text: 'none' })],
        ['Timeline entries', fmt.num(inc.timeline.length) + ', plus ' + fmt.num(entries.length - inc.timeline.length) + ' related audit rows']
      ]),
      el('div.sectiontitle', { text: 'Timeline' }),
      el('ol.timeline-list', entries.map(function (t) {
        return el('li.timeline-item' + (t.kind === 'audit' ? '.is-audit' : ''), [
          el('div.timeline-meta', { text: fmt.stamp(t.at) + ' · ' + personName(t.who) + (t.kind === 'audit' ? ' · from the audit' : '') }),
          el('div', { text: t.text })
        ]);
      })),
      el('p.hint', { text: 'Notes are written here by people. Audit rows that name the incident, its host or its alerts are folded in automatically, so the timeline cannot miss an action somebody took elsewhere in the console.' })
    ], { actions: actions });
  }

  function incidentsTab() {
    var d = A.data;
    var list = d.incidents || [];
    var wanted = (A.state.params || {}).id;
    var detailHost = el('div');

    function show(inc) {
      ui.clear(detailHost);
      detailHost.appendChild(incidentDetail(inc));
      A.replaceHash(A.href('security', ['incidents'], { id: inc.id }));
    }

    var cols = [
      { key: 'id', label: 'Incident', render: function (i) { return el('span.mono', { text: i.id }); } },
      { key: 'title', label: 'Title' },
      {
        key: 'severity', label: 'Severity', status: true,
        sort: function (i) { return ['critical', 'high', 'medium', 'low'].indexOf(i.severity); },
        render: function (i) { return ui.pill(i.severity, SEV_TONE[i.severity] || 'idle'); }
      },
      {
        key: 'state', label: 'State', status: true,
        sort: function (i) { return ['open', 'mitigated', 'resolved'].indexOf(i.state); },
        render: function (i) { return ui.pill(i.state, INC_TONE[i.state] || 'idle'); }
      },
      { key: 'commander', label: 'Commander', render: function (i) { return personName(i.commander); } },
      { key: 'host', label: 'Host', render: function (i) { return el('span.mono', { text: i.host }); } },
      { key: 'opened', label: 'Opened', sort: function (i) { return i.opened.getTime(); }, render: function (i) { return fmt.time(i.opened); } },
      { key: 'updated', label: 'Updated', sort: function (i) { return i.updated.getTime(); }, render: function (i) { return fmt.time(i.updated); } },
      { key: 'alerts', label: 'Alerts', align: 'right', sort: function (i) { return i.alerts.length; }, csv: function (i) { return i.alerts.join('; '); }, render: function (i) { return fmt.num(i.alerts.length); } }
    ];

    var open = list.filter(function (i) { return i.state === 'open'; }).length;
    var table = ui.table(cols, list, {
      id: 'security.incidents',
      caption: 'Incidents with severity, state, commander, host and the alerts linked to each',
      empty: 'No incident has been opened. One is opened from an alert, or from the button above.',
      sortKey: 'state', sortDir: 'asc',
      rowKey: function (i) { return i.id; },
      onRow: show
    });

    ui.clear(detailHost);
    var initial = wanted ? incidentById(wanted) : null;
    if (initial) detailHost.appendChild(incidentDetail(initial));
    else detailHost.appendChild(ui.emptyState('No incident selected', 'Choose an incident to read its timeline, add to it, or resolve it.'));

    return el('div.stack', [
      el('div.tiles', [
        ui.statTile('Open incidents', fmt.num(open), { note: open ? 'Somebody is on each one' : 'Nothing is being worked right now' }),
        ui.statTile('Mitigated', fmt.num(list.filter(function (i) { return i.state === 'mitigated'; }).length), { note: 'Contained, not yet closed' }),
        ui.statTile('Resolved', fmt.num(list.filter(function (i) { return i.state === 'resolved'; }).length), { note: 'Timelines kept for ever' })
      ]),
      el('div.row', [
        ui.btn('Open an incident', { variant: 'primary', onClick: function () { openIncidentDialog(null); } }),
        el('span.spacer'),
        ui.columnsButton(table, 'incidents'),
        ui.exportButton(table, 'incidents')
      ]),
      table,
      detailHost
    ]);
  }

  function silenced(a) {
    return !!(a.silencedUntil && a.silencedUntil.getTime() > A.data.now.getTime());
  }

  function silenceDialog(alert) {
    var d = A.data;
    var hours = el('select.field', { id: 'silence-hours' }, [['1', '1 hour'], ['4', '4 hours'], ['24', '24 hours']].map(function (o) {
      return el('option', { value: o[0], text: o[1], selected: o[0] === '4' ? true : null });
    }));
    var why = el('input.field', { type: 'text', id: 'silence-why', autocomplete: 'off', spellcheck: 'false', placeholder: 'Known noisy rule during the drill; fix is in deployment 1848' });
    A.dialog({
      title: 'Silence ' + alert.id,
      body: function () {
        return [
          el('p', { text: alert.rule + ' on ' + alert.host + '. A silence stops the pages and takes the alert out of the open count for a fixed time; it does not acknowledge or resolve it, and it ends on its own.' }),
          el('label.fieldlabel', { for: 'silence-hours', text: 'For how long' }), hours,
          el('label.fieldlabel', { for: 'silence-why', text: 'Reason (required, recorded in the audit)' }), why,
          el('p.hint', { text: 'A silence without a reason is a muted smoke detector.' })
        ];
      },
      actions: function (close) {
        var go = ui.btn('Silence ' + alert.id, {
          variant: 'primary', disabled: true,
          onClick: function () {
            var reason = why.value.trim();
            if (!reason) return;
            close();
            alert.silencedUntil = new Date(d.now.getTime() + Number(hours.value) * 3600000);
            alert.silenceReason = reason;
            alert.silencedBy = A.me();
            var row = A.record('alert.silence', alert.id + ' for ' + hours.value + ' h: ' + reason);
            var undo = A.undoable('Undo', function () {
              alert.silencedUntil = null; alert.silenceReason = null; alert.silencedBy = null;
              A.unrecord(row);
              A.flash('info', 'Silence undone', alert.id + ' counts as open again.', { timeout: 6000 });
              A.refresh();
            });
            A.flash('ok', alert.id + ' silenced for ' + hours.value + ' h', 'Until ' + fmt.stamp(alert.silencedUntil) + '. ' + reason, { action: undo });
            A.replaceHash(A.href('security', ['alerts'], { f: (A.state.params || {}).f || null, id: alert.id }));
            A.refresh();
          }
        });
        why.addEventListener('input', function () { go.setDisabled(!why.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
    why.focus();
  }

  function unsilence(alert) {
    alert.silencedUntil = null;
    A.record('alert.unsilence', alert.id + (alert.silenceReason ? ' (was: ' + alert.silenceReason + ')' : ''));
    alert.silenceReason = null;
    alert.silencedBy = null;
    A.flash('info', alert.id + ' is no longer silenced', 'It counts as open again and pages resume.');
    A.replaceHash(A.href('security', ['alerts'], { f: (A.state.params || {}).f || null, id: alert.id }));
    A.refresh();
  }

  function quarantineHost(alert) {
    A.confirmDestructive({
      title: 'Quarantine ' + alert.host,
      match: alert.host,
      environment: A.state.env,
      confirmLabel: 'Quarantine ' + alert.host,
      detail: 'Quarantine moves every virtual NIC on ' + alert.host + ' to VLAN 90, which reaches the '
        + 'forensics collector and nothing else, and pages the security on-call. Running processes are left '
        + 'alone so that memory can be captured; only the network is cut.',
      blast: blastFor(alert.host),
      onConfirm: function () {
        A.record('host.quarantine', alert.host + ' for ' + alert.id + ' ' + alert.rule);
        A.flash('warn', alert.host + ' quarantined',
          'NICs moved to VLAN 90 and security paged. Follow sec-01-suspected-compromise to preserve evidence.');
      }
    });
  }

  var AM_RANK = { critical: 0, page: 1, high: 2, warning: 3, warn: 3, medium: 4, info: 5, low: 6, none: 7 };

  function amRank(sev) {
    var key = String(sev || 'none').toLowerCase();
    return Object.prototype.hasOwnProperty.call(AM_RANK, key) ? AM_RANK[key] : 8;
  }

  function amTone(sev) {
    var key = String(sev || '').toLowerCase();
    if (key === 'critical' || key === 'page' || key === 'high') return 'bad';
    if (key === 'warning' || key === 'warn' || key === 'medium') return 'warn';
    if (key === 'info' || key === 'low') return 'info';
    return 'idle';
  }

  function amSuppression(alert) {
    var st = alert.status || {};
    var silenced = (st.silencedBy || []).length;
    var inhibited = (st.inhibitedBy || []).length;
    if (silenced) return ui.pill('silenced', 'idle', { title: 'Silenced by ' + st.silencedBy.join(', ') });
    if (inhibited) return ui.pill('inhibited', 'idle', { title: 'Inhibited by ' + st.inhibitedBy.join(', ') });
    if (st.state === 'unprocessed') return ui.pill('unprocessed', 'warn');
    return ui.pill('firing', 'bad');
  }

  function amRow(alert) {
    var labels = alert.labels || {};
    var annotations = alert.annotations || {};
    var started = alert.startsAt ? new Date(alert.startsAt) : null;
    var name = labels.alertname || 'unnamed rule';
    var where = labels.instance || labels.job || labels.service || labels.namespace || null;

    return el('div.row', [
      ui.pill(labels.severity || 'unlabelled', amTone(labels.severity)),
      el('div.col', [
        el('strong', { text: name + (where ? ' on ' + where : '') }),
        el('span.muted', {
          text: annotations.summary || annotations.description ||
            'The rule carries no summary annotation, so there is nothing to quote here.'
        })
      ]),
      amSuppression(alert),
      started && isFinite(started.getTime())
        ? el('span.num', { text: 'since ' + fmt.stamp(started) })
        : el('span.muted', { text: 'no start time' })
    ]);
  }

  function alertInbox() {
    var body = el('div', [ui.skeleton(3)]);
    var card = ui.card('Alert inbox', body);
    var alive = true;
    A.onLeave(function () { alive = false; });

    A.probe().then(function () {
      if (!alive) return;
      if (A.storeMode() !== A.MODE.LIVE) {
        ui.clear(body);
        body.appendChild(el('div.callout.warn', [
          el('strong', { text: 'Alertmanager has not been read.' }),
          el('p', {
            text: 'The console API is not answering, so nothing here is firing or not firing -- it is ' +
              'unknown. The table below is the bundled sample dataset and is not a reading of this estate.'
          })
        ]));
        return;
      }

      A.read('/api/alerts/active', { ttlMs: 10000 }).then(function (env) {
        if (!alive) return;
        ui.clear(body);

        if (!env.ok) {
          var e = env.error || {};
          body.appendChild(ui.errorState(
            'Alertmanager could not be read',
            (e.message || 'The console API gave no reason.') +
              ' Until it answers, this console cannot say what is firing. Nothing has been substituted.',
            function () { A.forget('/api/alerts/active'); A.go('security', ['alerts']); }));
          return;
        }

        var payload = env.data || {};
        if (payload.ok === false) {
          body.appendChild(el('div.callout.warn', [
            el('strong', { text: 'Alertmanager is not reachable from the console.' }),
            el('p', { text: payload.message || 'The reader answered without a reason.' })
          ]));
          return;
        }

        var alerts = Array.isArray(payload) ? payload : (payload.alerts || []);
        if (!alerts.length) {
          body.appendChild(ui.emptyState(
            'Nothing is firing',
            'Alertmanager answered and is holding no active alert. That is a real answer, not a failure ' +
              'to load.'));
          return;
        }

        if (env.stale) {
          body.appendChild(el('div.callout.warn', [
            el('strong', { text: 'Showing the last list that could be read.' }),
            el('p', {
              text: 'A fresh read failed' + (env.error && env.error.message ? ': ' + env.error.message : '.') +
                ' An alert raised since then would not appear below.'
            })
          ]));
        }

        var ranked = alerts.slice().sort(function (a, b) {
          var byRank = amRank((a.labels || {}).severity) - amRank((b.labels || {}).severity);
          if (byRank !== 0) return byRank;
          return String(b.startsAt || '').localeCompare(String(a.startsAt || ''));
        });

        var firing = ranked.filter(function (a) {
          var st = a.status || {};
          return !(st.silencedBy || []).length && !(st.inhibitedBy || []).length;
        });

        body.appendChild(el('p.hint', {
          text: fmt.num(ranked.length) + ' alert' + (ranked.length === 1 ? '' : 's') + ' held by ' +
            'Alertmanager, ' + fmt.num(firing.length) + ' of them neither silenced nor inhibited, worst ' +
            'severity first.'
        }));
        body.appendChild(el('div.stack', ranked.slice(0, 40).map(amRow)));
        if (ranked.length > 40) {
          body.appendChild(el('p.hint', {
            text: 'The remaining ' + fmt.num(ranked.length - 40) + ' are not listed. Silence or group them ' +
              'in Alertmanager rather than reading past forty rows here.'
          }));
        }
      });
    });

    return card;
  }

  function linkedIncident(alert) {
    return (A.data.incidents || []).filter(function (i) { return i.alerts.indexOf(alert.id) !== -1 && i.state !== 'resolved'; })[0] || null;
  }

  var ALERT_FIELDS = [
    { key: 'severity', label: 'Severity' },
    { key: 'source', label: 'Source' },
    { key: 'host', label: 'Host' },
    { key: 'state', label: 'State' }
  ];

  function alertsTab() {
    var d = A.data;

    var accessors = {
      severity: function (r) { return r.severity; },
      source: function (r) { return r.source; },
      host: function (r) { return r.host; },
      state: function (r) { return silenced(r) ? 'silenced' : r.state; }
    };

    var cols = [
      {
        key: 'severity', label: 'Severity', status: true,
        sort: function (r) { return ['critical', 'high', 'medium', 'low'].indexOf(r.severity); },
        render: function (r) { return ui.pill(r.severity, SEV_TONE[r.severity] || 'idle'); }
      },
      { key: 'source', label: 'Source' },
      { key: 'rule', label: 'Rule' },
      { key: 'host', label: 'Host', render: function (r) { return el('span.mono', { text: r.host }); } },
      { key: 'first', label: 'First seen', sort: function (r) { return r.first.getTime(); }, render: function (r) { return fmt.time(r.first); } },
      { key: 'last', label: 'Last seen', sort: function (r) { return r.last.getTime(); }, render: function (r) { return fmt.time(r.last); } },
      { key: 'count', label: 'Count', align: 'right', render: function (r) { return fmt.num(r.count); } },
      {
        key: 'state', label: 'State', status: true,
        csv: function (r) { return silenced(r) ? 'silenced' : r.state; },
        render: function (r) {
          if (silenced(r)) {
            return ui.pill('silenced', 'idle', { title: 'Until ' + fmt.stamp(r.silencedUntil) + ' by ' + r.silencedBy + ': ' + r.silenceReason });
          }
          return ui.pill(r.state, STATE_TONE[r.state] || 'idle');
        }
      },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (r) {
          if (r.state === 'resolved') {
            return el('div.row', [
              el('span.muted', { text: 'Resolved at the source.' }),
              r.runbook ? ui.btn('Open runbook ' + r.runbook, {
                variant: 'ghost',
                onClick: function () { A.go('ops', ['runbook', r.runbook]); }
              }) : null
            ]);
          }
          return el('div.row', [
            r.state === 'open' ? ui.btn('Acknowledge ' + r.id, {
              variant: 'ghost',
              title: 'Acknowledge ' + r.rule + ' on ' + r.host,
              onClick: function () { acknowledgeDialog(r); }
            }) : el('span.muted', { text: 'Acknowledged.' }),
            r.state === 'open' && !silenced(r) ? ui.btn('Silence ' + r.id, {
              variant: 'ghost',
              title: 'Stop the pages for a fixed time with a reason',
              onClick: function () { silenceDialog(r); }
            }) : null,
            silenced(r) ? ui.btn('Unsilence ' + r.id, {
              variant: 'ghost',
              title: 'Silenced until ' + fmt.stamp(r.silencedUntil) + ': ' + r.silenceReason,
              onClick: function () { unsilence(r); }
            }) : null,
            ui.btn('Quarantine ' + r.host, {
              variant: 'danger',
              title: 'Move every NIC on ' + r.host + ' to VLAN 90',
              onClick: function () { quarantineHost(r); }
            }),
            linkedIncident(r)
              ? A.link('Incident ' + linkedIncident(r).id, 'security', ['incidents'], { id: linkedIncident(r).id })
              : ui.btn('Open incident for ' + r.id, {
                variant: 'ghost',
                title: 'Open an incident from ' + r.id + ' with a commander and a timeline',
                onClick: function () { openIncidentDialog(r); }
              }),
            r.runbook ? ui.btn('Open runbook ' + r.runbook, {
              variant: 'ghost',
              onClick: function () { A.go('ops', ['runbook', r.runbook]); }
            }) : null
          ]);
        }
      }
    ];

    var tableHost = el('div');
    var alertTable = null;
    var countNode = el('span.count', { text: 'Nothing selected' });
    var bulkBtn = ui.btn('Acknowledge selected', {
      variant: 'primary', disabled: true,
      title: 'Select one or more open alerts first',
      onClick: function () {
        if (!alertTable) return;
        var open = alertTable.selectedRows().filter(function (a) { return a.state === 'open'; });
        if (!open.length) { A.flash('info', 'Nothing to acknowledge', 'None of the selected alerts is open.'); return; }
        acknowledgeDialog(open[0], open);
      }
    });

    function onSelect(keys) {
      var open = alertTable ? alertTable.selectedRows().filter(function (a) { return a.state === 'open'; }).length : 0;
      countNode.textContent = keys.length
        ? fmt.num(keys.length) + ' selected, ' + fmt.num(open) + ' of them open'
        : 'Nothing selected';
      bulkBtn.setDisabled(!open);
      bulkBtn.title = open ? 'Acknowledge the ' + fmt.num(open) + ' open alerts selected with one note' : 'Select one or more open alerts first';
    }

    function syncUrl(tokens) {
      var params = {};
      Object.keys(A.state.params || {}).forEach(function (k) { if (k !== 'f' && k !== 'id') params[k] = A.state.params[k]; });
      params.f = ui.encodeTokens(tokens);
      A.replaceHash(A.href('security', ['alerts'], params));
    }

    function paint(tokens) {
      var rows = ui.applyTokens(d.alerts, tokens || [], accessors);
      if (alertTable) { alertTable.setRows(rows); return; }
      alertTable = ui.table(cols, rows, {
        id: 'security.alerts',
        caption: 'Open and recent security alerts, by severity, source, host and state',
        empty: 'No alert matches every filter. Remove a token to widen the search.',
        sortKey: 'severity', sortDir: 'asc',
        rowKey: function (r) { return r.id; },
        selectable: true,
        selectLabel: function (r) { return r.id + ', ' + r.rule + ' on ' + r.host; },
        onSelect: onSelect
      });
      tableHost.appendChild(alertTable);
    }

    var filter = ui.propertyFilter(ALERT_FIELDS, function (tokens) { paint(tokens); syncUrl(tokens); }, {
      initial: ui.decodeTokens(A.state.params && A.state.params.f)
    });

    paint(filter.tokens());

    return el('div.stack', [
      alertInbox(),
      el('div.sectiontitle', { text: 'Console alert history' }),
      filter,
      el('p.hint', {
        text: 'Filters combine with AND, so severity high and host gpu-01 narrows to the intersection. '
          + 'The filter is part of the address, so a shared link opens the same view. Only the table repaints; the filter keeps its focus.'
      }),
      el('div.bulkbar', [
        countNode,
        bulkBtn,
        el('span.spacer'),
        ui.viewsBar('security', function () { return window.location.hash; }),
        ui.columnsButton(function () { return alertTable; }, 'alerts'),
        ui.exportButton(function () { return alertTable; }, 'alerts')
      ]),
      tableHost
    ]);
  }

  function waiverCell(v) {
    var d = A.data;
    if (!v.waiver) return el('span.muted', { text: 'none' });
    var expired = v.waiver.until < d.now;
    if (expired) {
      return el('div.col', [
        ui.pill('waiver expired', 'bad'),
        el('span.muted', {
          text: v.waiver.owner + ', expired ' + fmt.stamp(v.waiver.until)
        })
      ]);
    }
    return el('span.waiverbadge', {
      title: v.waiver.reason,
      text: v.waiver.owner + ' until ' + fmt.stamp(v.waiver.until)
    });
  }

  function addWaiverDialog(preselected) {
    var d = A.data;
    var candidates = d.vulns.filter(function (v) { return !v.waiver || v.waiver.until < d.now; });
    var cve = el('select.field', { id: 'waiver-cve' }, candidates.map(function (v) {
      return el('option', {
        value: v.id, text: v.id + ' · ' + v.component + ' in ' + v.app + ' (' + v.severity + ')',
        selected: preselected && preselected.id === v.id ? true : null
      });
    }));
    var owner = el('input.field', { type: 'text', id: 'waiver-owner', autocomplete: 'off', spellcheck: 'false', value: A.me() });
    var reason = el('textarea.field', { id: 'waiver-reason', rows: '3', spellcheck: 'false' });
    var expiry = el('input.field', { type: 'date', id: 'waiver-expiry' });

    A.dialog({
      title: 'Add a waiver',
      body: function () {
        return [
          el('p', {
            text: 'A waiver says a named person accepted this risk until a named date. Every field is '
              + 'required, because a waiver without an owner or an expiry is just a suppressed finding.'
          }),
          candidates.length
            ? el('div.formrow', [el('label.fieldlabel', { for: 'waiver-cve', text: 'Vulnerability' }), cve])
            : el('div.callout.ok', { text: 'Every open vulnerability already carries a live waiver, so there is nothing to waive.' }),
          el('div.formrow', [el('label.fieldlabel', { for: 'waiver-owner', text: 'Owner' }), owner]),
          el('div.formrow', [el('label.fieldlabel', { for: 'waiver-reason', text: 'Reason' }), reason]),
          el('div.formrow', [el('label.fieldlabel', { for: 'waiver-expiry', text: 'Expires on' }), expiry]),
          el('p.hint', { text: 'The waiver expires on its own. Nothing renews it quietly.' })
        ];
      },
      actions: function (close) {
        var submit = ui.btn('Add waiver', {
          variant: 'primary',
          disabled: true,
          title: 'An owner, a reason and an expiry date are all required.',
          onClick: function () {
            var who = owner.value.trim(), until = expiry.value;
            var target = d.vulns.filter(function (v) { return v.id === cve.value; })[0];
            close();
            if (target) {
              var untilDate = new Date(until + 'T00:00:00Z');
              target.waiver = { owner: who, until: isFinite(untilDate.getTime()) ? untilDate : d.now, reason: reason.value.trim() };
              A.record('vuln.waive', target.id + ' in ' + target.app + ' until ' + until + ' by ' + who);
            }
            A.flash('ok', 'Waiver recorded',
              'Owner ' + who + ', expiring ' + until + '. It will reappear as an alert on that date.',
              { timeout: 12000 });
            A.replaceHash(A.href('security', ['vulns']));
            A.refresh();
          }
        });

        function check() {
          submit.setDisabled(!(candidates.length && cve.value && owner.value.trim() && reason.value.trim() && expiry.value));
        }
        [cve, owner, reason, expiry].forEach(function (node) {
          node.addEventListener('input', check);
          node.addEventListener('change', check);
        });
        check();

        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), submit];
      }
    });
  }

  function vulnsTab() {
    var d = A.data;
    var expired = d.vulns.filter(function (v) { return v.waiver && v.waiver.until < d.now; });
    var vulnTable = null;
    function vulnCard() {
      vulnTable = ui.table(cols, d.vulns, {
        caption: 'Vulnerabilities found by Trivy in deployed components, with waiver owner and expiry',
        empty: 'No vulnerabilities are open against a deployed component.',
        sortKey: 'severity', sortDir: 'asc',
        rowKey: function (v) { return v.id; }
      });
      return ui.card('Known vulnerabilities', vulnTable, {
        actions: [
          ui.exportButton(function () { return vulnTable; }, 'vulnerabilities'),
          ui.btn('Add waiver', { variant: 'ghost', onClick: function () { addWaiverDialog(null); } })
        ]
      });
    }

    var cols = [
      { key: 'id', label: 'CVE', render: function (v) { return el('span.mono', { text: v.id }); } },
      {
        key: 'severity', label: 'Severity', status: true,
        sort: function (v) { return ['critical', 'high', 'medium', 'low'].indexOf(v.severity); },
        render: function (v) { return ui.pill(v.severity, SEV_TONE[v.severity] || 'idle'); }
      },
      { key: 'component', label: 'Component' },
      { key: 'app', label: 'Application' },
      { key: 'fixedIn', label: 'Fixed in', render: function (v) { return el('span.mono', { text: v.fixedIn }); } },
      { key: 'found', label: 'Found', sort: function (v) { return v.found.getTime(); }, render: function (v) { return fmt.time(v.found); } },
      {
        key: 'waiver', label: 'Waiver', status: true, sortable: false, render: waiverCell,
        csv: function (v) { return v.waiver ? v.waiver.owner + ' until ' + v.waiver.until.toISOString().slice(0, 10) : ''; }
      },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (v) {
          var live = v.waiver && v.waiver.until >= d.now;
          if (live) return el('span.muted', { text: 'Waived until ' + fmt.stamp(v.waiver.until) });
          return ui.btn('Waive ' + v.id, {
            variant: 'ghost',
            title: 'Record a named, time-boxed waiver for ' + v.id,
            onClick: function () { addWaiverDialog(v); }
          });
        }
      }
    ];

    return el('div.stack', [
      expired.length ? el('div.callout.bad', [
        el('strong', { text: fmt.num(expired.length) + ' waiver has expired' }),
        el('p', {
          text: 'An expired waiver is an alert, not a pass: ' + expired.map(function (v) { return v.id; }).join(', ')
            + '. Either patch the component or have somebody sign for the risk again.'
        })
      ]) : null,
      vulnCard()
    ]);
  }

  function buildPlayer(session) {
    var keys = (session.keys || KEYSTROKES[session.id] || []).slice();
    var duration = session.duration > 0 ? session.duration : 1;
    var playTimer = null;
    var speed = 1;

    var heading = el('h3', {
      tabindex: '-1',
      text: session.user + ' on ' + session.target + ' · ' + session.protocol + ' · ' + session.reason
    });

    var statusNode = el('p.hint', { role: 'status', text: 'Paused at the start.' });
    var posNode = el('span.mono', { text: offsetLabel(0) + ' / ' + offsetLabel(duration) });

    var MARKER_CAP = 160;
    var markerKeys = keys;
    if (keys.length > MARKER_CAP) {
      markerKeys = [];
      var stride = keys.length / MARKER_CAP;
      for (var mi = 0; mi < MARKER_CAP; mi++) markerKeys.push(keys[Math.floor(mi * stride)]);
    }
    var track = el('div.scrubber-track', markerKeys.map(function (k) {
      return el('span.scrubber-marker', {
        'aria-hidden': 'true',
        title: offsetLabel(k.at) + '  ' + k.text,
        style: { left: ((k.at / duration) * 100).toFixed(2) + '%' }
      });
    }));

    var range = el('input', {
      type: 'range', min: '0', max: String(duration), step: '1', value: '0',
      'aria-label': 'Playhead in the recording of ' + session.id + ', ' + session.user
        + ' on ' + session.target + ', ' + fmt.dur(duration) + ' long',
      'aria-valuetext': offsetLabel(0)
    });

    var scrubber = el('div.scrubber', [track, range]);

    var logHost = el('div.logview', {
      tabindex: '0', role: 'group',
      'aria-label': 'Keystrokes recorded during session ' + session.id
    });
    var search = el('input.field', {
      type: 'search', id: 'ks-search-' + session.id, autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Filter keystrokes'
    });

    function currentIndex(at) {
      var lo = 0, hi = keys.length - 1, idx = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (keys[mid].at <= at) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return idx;
    }

    var haystack = keys.map(function (k) { return k.text.toLowerCase(); });

    function paintLog() {
      var q = search.value.trim().toLowerCase();
      ui.clear(logHost);

      var at = Number(range.value);
      var idx = currentIndex(at);

      var frag = document.createDocumentFragment();
      var shown = 0;
      for (var i = 0; i < keys.length; i++) {
        if (q && haystack[i].indexOf(q) === -1) continue;
        shown += 1;
        frag.appendChild(el('div.logline', {
          title: fmt.stamp(new Date(session.started.getTime() + keys[i].at * 1000)),
          'aria-current': i === idx ? 'true' : null
        }, [
          el('span.mono', { text: offsetLabel(keys[i].at) + '  ' }),
          el('span', { text: keys[i].text })
        ]));
      }

      if (!shown) {
        logHost.appendChild(el('div.logline', { text: 'No keystroke in this recording matches ' + search.value }));
        return;
      }
      logHost.appendChild(frag);
    }

    function setPosition(at, announce) {
      range.value = String(at);
      range.setAttribute('aria-valuetext', offsetLabel(at));
      posNode.textContent = offsetLabel(at) + ' / ' + offsetLabel(duration);
      paintLog();
      if (announce) {
        var idx = currentIndex(at);
        statusNode.textContent = 'Paused at ' + offsetLabel(at)
          + (idx >= 0 ? '. Last command: ' + keys[idx].text : '. Nothing typed yet.');
      }
    }

    function stop() {
      if (playTimer) { window.clearInterval(playTimer); playTimer = null; }
    }

    function play() {
      stop();
      statusNode.textContent = 'Playing at ' + speed + 'x from ' + offsetLabel(Number(range.value)) + '.';
      playTimer = window.setInterval(function () {
        if (!document.body.contains(range)) { stop(); return; }
        var at = Number(range.value) + speed;
        if (at >= duration) {
          setPosition(duration, false);
          stop();
          statusNode.textContent = 'Reached the end of the recording, ' + offsetLabel(duration) + '.';
          return;
        }
        setPosition(at, false);
      }, 1000);
    }

    var speedSel = el('select.field', {
      id: 'speed-' + session.id,
      on: {
        change: function () {
          speed = Number(speedSel.value);
          statusNode.textContent = (playTimer ? 'Playing' : 'Paused') + ' at ' + speed + 'x.';
        }
      }
    }, [
      el('option', { value: '1', text: '1x' }),
      el('option', { value: '2', text: '2x' }),
      el('option', { value: '4', text: '4x' })
    ]);

    range.addEventListener('input', function () { stop(); setPosition(Number(range.value), true); });
    search.addEventListener('input', paintLog);

    var player = el('div.sessionplayer', [
      heading,
      el('p.muted', {
        text: 'Started ' + fmt.stamp(session.started) + ' · ' + fmt.dur(duration) + ' · '
          + fmt.num(session.sizeMB) + ' MB · approved by ' + session.approver
      }),
      scrubber,
      el('div.row', [
        ui.btn('Play recording ' + session.id, { variant: 'primary', onClick: play }),
        ui.btn('Pause recording ' + session.id, {
          variant: 'ghost',
          onClick: function () { stop(); setPosition(Number(range.value), true); }
        }),
        el('label.fieldlabel', { for: 'speed-' + session.id, text: 'Speed' }),
        speedSel,
        posNode
      ]),
      statusNode,
      el('div.sectiontitle', { text: 'Keystrokes' }),
      el('div.formrow', [
        el('label.fieldlabel', { for: 'ks-search-' + session.id, text: 'Filter keystrokes' }),
        search
      ]),
      logHost,
      el('p.hint', {
        text: 'Every control here is reachable from the keyboard, and the scrubber is a range input rather than '
          + 'a draggable bar: dragging as the only way to seek fails WCAG 2.5.7.'
      })
    ]);

    setPosition(0, false);
    return { node: player, focus: function () { heading.focus(); } };
  }

  function sessionsTab() {
    var d = A.data;
    var detail = el('div');

    function show(session) {
      ui.clear(detail);
      var built = buildPlayer(session);
      detail.appendChild(ui.card('Recording ' + session.id, built.node));
      try { detail.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { detail.scrollIntoView(); }
      built.focus();
    }

    var cols = [
      { key: 'id', label: 'Session', render: function (s) { return el('span.mono', { text: s.id }); } },
      { key: 'user', label: 'User' },
      { key: 'target', label: 'Target', render: function (s) { return el('span.mono', { text: s.target }); } },
      { key: 'protocol', label: 'Protocol' },
      { key: 'started', label: 'Started', sort: function (s) { return s.started.getTime(); }, render: function (s) { return fmt.time(s.started); } },
      { key: 'duration', label: 'Duration', align: 'right', render: function (s) { return fmt.dur(s.duration); } },
      { key: 'reason', label: 'Reason' },
      { key: 'approver', label: 'Approver' },
      { key: 'sizeMB', label: 'Size', align: 'right', render: function (s) { return fmt.num(s.sizeMB) + ' MB'; } },
      {
        key: 'state', label: 'State', status: true,
        render: function (s) { return ui.pill(s.state, SESSION_TONE[s.state] || 'idle'); }
      }
    ];

    ui.clear(detail);
    detail.appendChild(ui.emptyState(
      'No recording selected',
      'Choose a session to scrub through its recording and read what was typed.'));

    var sessionTable = ui.table(cols, d.sessions, {
      id: 'security.sessions',
      caption: 'Recorded gateway sessions, with the reason given and the person who approved them',
      empty: 'No session has been recorded.',
      sortKey: 'started', sortDir: 'desc',
      rowKey: function (s) { return s.id; },
      onRow: show
    });

    var wantedSession = (A.state.params || {}).id;
    var preselected = wantedSession ? d.sessions.filter(function (s) { return s.id === wantedSession; })[0] : null;
    if (preselected) {
      ui.clear(detail);
      detail.appendChild(ui.card('Recording ' + preselected.id, buildPlayer(preselected).node));
      ui.revealRow(sessionTable, preselected.id, { label: 'Recording ' + preselected.id + ' is highlighted and open below' });
    }

    return el('div.stack', [
      el('div.callout.info', {
        text: 'Every interactive session through the gateway is recorded to argus-sessions, which is '
          + 'write-once for 400 days. Nobody, including an administrator, can delete a recording from the console.'
      }),
      el('div.row', [el('span.spacer'), ui.exportButton(sessionTable, 'sessions')]),
      sessionTable,
      detail
    ]);
  }

  function evidenceItems() {
    var d = A.data;

    var fido = d.people.filter(function (p) { return p.mfa === 'FIDO2'; }).length;
    var wdacAudit = d.hosts.filter(function (h) { return h.wdac === 'audit'; }).length;
    var wdacEnforced = d.hosts.filter(function (h) { return h.wdac === 'enforced'; }).length;
    var oldestPatch = d.hosts.reduce(function (a, h) { return Math.max(a, h.patchAgeDays); }, 0);
    var passed = d.drills.filter(function (x) { return x.outcome === 'pass'; }).length;
    var restores = d.drills.filter(function (x) { return x.kind === 'Restore'; });
    var lastRestore = restores.length ? restores[0] : null;
    var openVulns = d.vulns.filter(function (v) { return !v.waiver || v.waiver.until < d.now; }).length;
    var activeGrants = d.grants.filter(function (g) { return g.state === 'active'; });

    return [
      { label: 'MFA coverage', value: fmt.num(fido) + ' of ' + fmt.num(d.people.length) + ' people on FIDO2 hardware keys' },
      { label: 'WDAC state', value: fmt.num(wdacEnforced) + ' hosts enforced, ' + fmt.num(wdacAudit) + ' in audit mode' },
      { label: 'Patch age', value: 'Oldest host is ' + fmt.num(oldestPatch) + ' days behind' },
      { label: 'Backup drill outcomes', value: fmt.num(passed) + ' of ' + fmt.num(d.drills.length) + ' drills passed' },
      {
        label: 'Restore timings',
        value: lastRestore
          ? fmt.dur(lastRestore.durationMin * 60) + ' against an RTO target of ' + fmt.dur(lastRestore.rtoTargetMin * 60)
          : 'No restore drill on record'
      },
      { label: 'Open vulnerabilities', value: fmt.num(openVulns) + ' without a live waiver, ' + fmt.num(d.vulns.length) + ' in total' },
      {
        label: 'Privileged grants and expiries',
        value: activeGrants.length
          ? fmt.num(activeGrants.length) + ' active, next expiring ' + fmt.stamp(activeGrants[0].expires)
          : 'No standing privileged grant'
      },
      { label: 'Firewall changes', value: 'Read from the network repository git history at pack time, commit by commit' }
    ];
  }

  function evidenceTab() {
    var items = evidenceItems();
    var list = el('ul', items.map(function (it) {
      return el('li', [
        ui.pill('included', 'ok'),
        ' ',
        el('strong', { text: it.label }),
        ', ',
        el('span', { text: it.value })
      ]);
    }));

    return el('div.stack', [
      ui.card('Monthly evidence pack', [
        el('p', {
          text: 'One PDF and one signed JSON bundle, generated on the first of each month and written to '
            + 'argus-artifacts under a 365 day compliance lock. It is what an auditor is handed, and it is '
            + 'assembled from the same data this console renders rather than from a screenshot of it.'
        }),
        list,
        el('p.hint', {
          text: 'Values shown are live as of ' + fmt.stamp(A.data.now) + '. The pack freezes them at generation time.'
        })
      ], {
        actions: [
          ui.btn('Generate pack', {
            variant: 'primary',
            onClick: function () {
              A.stepUp('Generating an evidence pack reads privileged grant history, so it needs a second factor.',
                function () {
                  A.record('evidence.generate', 'monthly pack to argus-artifacts');
                  A.flash('ok', 'Evidence pack queued',
                    'It will be written to argus-artifacts and locked for 365 days. You will get a flash when the signature is verified.');
                });
            }
          })
        ]
      })
    ]);
  }

  A.screen('security', {
    title: 'Security',
    crumb: 'Security',
    render: function (mount, ctx) {
      var items = [
        { id: 'posture', label: 'Posture', render: postureTab },
        { id: 'alerts', label: 'Alerts', render: alertsTab },
        { id: 'incidents', label: 'Incidents', render: incidentsTab },
        { id: 'vulns', label: 'Vulnerabilities', render: vulnsTab },
        { id: 'sessions', label: 'Sessions', render: sessionsTab },
        { id: 'evidence', label: 'Evidence', render: evidenceTab }
      ];

      mount.appendChild(ui.pageHeader('Security',
        'Baseline drift, alerts, vulnerabilities and every recorded session, with the evidence pack that ties them together.'));
      mount.appendChild(ui.tabs(items, {
        label: 'Security sections',
        initial: (ctx && ctx.rest && ctx.rest[0]) || null,
        href: function (id) { return A.href('security', [id]); },
        onSelect: function (id) {
          var want = ctx && ctx.params && ctx.params.id;
          if (id === 'alerts' && want) ui.revealRow(mount, want, { label: 'Alert ' + want + ' is highlighted' });
        }
      }));
    }
  });
})();
