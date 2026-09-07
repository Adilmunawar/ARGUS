/* Security: posture, alerts, vulnerabilities, recorded sessions, evidence.
 *
 * Everything here renders strings that came from outside the product: Wazuh rule
 * names, CVE component strings, session reasons typed by an operator. They are
 * built as text nodes through ui.el and never as markup.
 *
 * Classic script, no modules, ES5 only: the console opens from file:// with no
 * build step and no network (ADR-0027).
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  /* siem-01 and guac-01 run Ubuntu. Wazuh reports 0 for the Defender family on
   * them because the family does not exist there, not because it failed. */
  var LINUX_HOSTS = { 'siem-01': true, 'guac-01': true };

  var SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info' };
  var STATE_TONE = { open: 'warn', ack: 'info', resolved: 'ok' };
  var SESSION_TONE = { active: 'warn', closed: 'ok', terminated: 'bad' };

  /* Named CIS and Microsoft baseline checks, one set per control family. The
   * numbering follows the CIS Microsoft Windows Server benchmark layout. */
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

  /* A recorded session is only useful if you can see what was typed. These are
   * the keystroke tracks Guacamole would have written alongside the video. */
  var KEYSTROKES = {
    's-2291': [
      { at: 18, text: 'sqlcmd -S sql-drill-01 -E -Q "SELECT @@VERSION"' },
      { at: 96, text: 'Restore-DbaDatabase -SqlInstance sql-drill-01 -Path S:\\restore\\umairv3_db' },
      { at: 540, text: 'Get-DbaDbRestoreHistory -SqlInstance sql-drill-01 -Last' },
      { at: 902, text: 'Invoke-DbaQuery -Query "DBCC CHECKDB (umairv3_db) WITH NO_INFOMSGS"' },
      { at: 1288, text: 'Test-DbaLastBackup -SqlInstance sql-drill-01 -Database umairv3_db' },
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

  /* ------------------------------------------------------------ helpers --- */

  function isApplicable(d, host, colIndex) {
    return !(LINUX_HOSTS[host] && d.posture.families[colIndex] === 'Defender');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** mm:ss, or h:mm:ss once a recording runs past an hour. */
  function offsetLabel(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(sec);
  }

  /** What else would stop if this machine were pulled off the network. */
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

  /** ui.btn captures its options object, so flipping opts.disabled works. */
  function setEnabled(node, opts, on) {
    opts.disabled = !on;
    node.disabled = !on;
    node.classList.toggle('is-disabled', !on);
    node.setAttribute('aria-disabled', on ? 'false' : 'true');
  }

  /* ------------------------------------------------------------ posture --- */

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

  /* ------------------------------------------------------------- alerts --- */

  function acknowledgeDialog(alert) {
    A.dialog({
      title: 'Acknowledge ' + alert.id,
      body: function () {
        var note = el('textarea.field', {
          id: 'ack-note', rows: '4', spellcheck: 'false',
          'aria-describedby': 'ack-help'
        });
        return [
          el('p', { text: alert.rule + ' on ' + alert.host + ', raised by ' + alert.source + '.' }),
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
          ui.btn('Acknowledge alert ' + alert.id, {
            variant: 'primary',
            onClick: function () {
              var field = document.getElementById('ack-note');
              var note = field && field.value.trim();
              close();
              A.flash('ok', 'Alert ' + alert.id + ' acknowledged',
                note ? 'Note recorded: ' + note : 'No note was recorded, so the audit shows an empty reason.');
            }
          })
        ];
      }
    });
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
        A.flash('warn', alert.host + ' quarantined',
          'NICs moved to VLAN 90 and security paged. Follow sec-01-suspected-compromise to preserve evidence.');
      }
    });
  }

  function alertsTab() {
    var d = A.data;

    var accessors = {
      severity: function (r) { return r.severity; },
      source: function (r) { return r.source; },
      host: function (r) { return r.host; },
      state: function (r) { return r.state; }
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
        render: function (r) { return ui.pill(r.state, STATE_TONE[r.state] || 'idle'); }
      },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (r) {
          return el('div.row', [
            ui.btn('Acknowledge ' + r.id, {
              variant: 'ghost',
              title: 'Acknowledge ' + r.rule + ' on ' + r.host,
              onClick: function () { acknowledgeDialog(r); }
            }),
            ui.btn('Quarantine ' + r.host, {
              variant: 'danger',
              title: 'Move every NIC on ' + r.host + ' to VLAN 90',
              onClick: function () { quarantineHost(r); }
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

    function paint(tokens) {
      var rows = ui.applyTokens(d.alerts, tokens || [], accessors);
      ui.clear(tableHost);
      tableHost.appendChild(ui.table(cols, rows, {
        caption: 'Open and recent security alerts, by severity, source, host and state',
        empty: 'No alert matches every filter. Remove a token to widen the search.',
        sortKey: 'severity', sortDir: 'asc',
        rowKey: function (r) { return r.id; }
      }));
    }

    var filter = ui.propertyFilter([
      { key: 'severity', label: 'Severity' },
      { key: 'source', label: 'Source' },
      { key: 'host', label: 'Host' },
      { key: 'state', label: 'State' }
    ], paint);

    paint([]);

    return el('div.stack', [
      filter,
      el('p.hint', {
        text: 'Filters combine with AND, so severity high and host gpu-01 narrows to the intersection. '
          + 'Only the table repaints; the filter keeps its focus.'
      }),
      tableHost
    ]);
  }

  /* --------------------------------------------------- vulnerabilities --- */

  function waiverCell(v) {
    var d = A.data;
    if (!v.waiver) return el('span.muted', { text: 'none' });
    var expired = v.waiver.until < d.now;
    if (expired) {
      /* An expired waiver is not a silent pass. It is a finding with nobody
       * currently accountable for it, which is worse than an open CVE. */
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

  function addWaiverDialog() {
    A.dialog({
      title: 'Add a waiver',
      body: function () {
        return [
          el('p', {
            text: 'A waiver says a named person accepted this risk until a named date. All three fields are '
              + 'required, because a waiver without an owner or an expiry is just a suppressed finding.'
          }),
          el('div.formrow', [
            el('label.fieldlabel', { for: 'waiver-owner', text: 'Owner' }),
            el('input.field', { type: 'text', id: 'waiver-owner', autocomplete: 'off', spellcheck: 'false' })
          ]),
          el('div.formrow', [
            el('label.fieldlabel', { for: 'waiver-reason', text: 'Reason' }),
            el('textarea.field', { id: 'waiver-reason', rows: '3', spellcheck: 'false' })
          ]),
          el('div.formrow', [
            el('label.fieldlabel', { for: 'waiver-expiry', text: 'Expires on' }),
            el('input.field', { type: 'date', id: 'waiver-expiry' })
          ]),
          el('p.hint', { text: 'The waiver expires on its own. Nothing renews it quietly.' })
        ];
      },
      actions: function (close) {
        var opts = {
          variant: 'primary', disabled: true,
          onClick: function () {
            var owner = document.getElementById('waiver-owner').value.trim();
            var until = document.getElementById('waiver-expiry').value;
            close();
            A.flash('ok', 'Waiver recorded',
              'Owner ' + owner + ', expiring ' + until + '. It will reappear as an alert on that date.');
          }
        };
        var submit = ui.btn('Add waiver', opts);
        setEnabled(submit, opts, false);

        function check() {
          var owner = document.getElementById('waiver-owner');
          var reason = document.getElementById('waiver-reason');
          var expiry = document.getElementById('waiver-expiry');
          var ready = !!(owner && owner.value.trim() && reason && reason.value.trim() && expiry && expiry.value);
          setEnabled(submit, opts, ready);
        }

        ['waiver-owner', 'waiver-reason', 'waiver-expiry'].forEach(function (id) {
          var node = document.getElementById(id);
          if (node) { node.addEventListener('input', check); node.addEventListener('change', check); }
        });

        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), submit];
      }
    });
  }

  function vulnsTab() {
    var d = A.data;
    var expired = d.vulns.filter(function (v) { return v.waiver && v.waiver.until < d.now; });

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
      { key: 'waiver', label: 'Waiver', status: true, sortable: false, render: waiverCell }
    ];

    return el('div.stack', [
      expired.length ? el('div.callout.bad', [
        el('strong', { text: fmt.num(expired.length) + ' waiver has expired' }),
        el('p', {
          text: 'An expired waiver is an alert, not a pass: ' + expired.map(function (v) { return v.id; }).join(', ')
            + '. Either patch the component or have somebody sign for the risk again.'
        })
      ]) : null,
      ui.card('Known vulnerabilities', ui.table(cols, d.vulns, {
        caption: 'Vulnerabilities found by Trivy in deployed components, with waiver owner and expiry',
        empty: 'No vulnerabilities are open against a deployed component.',
        sortKey: 'severity', sortDir: 'asc'
      }), {
        actions: [ui.btn('Add waiver', { variant: 'ghost', onClick: addWaiverDialog })]
      })
    ]);
  }

  /* ----------------------------------------------------------- sessions --- */

  function buildPlayer(session) {
    var keys = (KEYSTROKES[session.id] || []).slice();
    var duration = session.duration || 1;
    var playTimer = null;
    var speed = 1;

    var heading = el('h3', {
      tabindex: '-1',
      text: session.user + ' on ' + session.target + ' · ' + session.protocol + ' · ' + session.reason
    });

    /* Two readouts on purpose. statusNode is a live region and only changes when
     * the operator does something. posNode ticks once a second and is NOT live,
     * because a screen reader announcing the playhead every second is unusable. */
    var statusNode = el('p.hint', { role: 'status', text: 'Paused at the start.' });
    var posNode = el('span.mono', { text: offsetLabel(0) + ' / ' + offsetLabel(duration) });

    var track = el('div.scrubber-track');
    var markers = keys.map(function (k) {
      return el('span.scrubber-marker', {
        'aria-hidden': 'true',
        title: offsetLabel(k.at) + '  ' + k.text,
        style: { left: ((k.at / duration) * 100).toFixed(2) + '%' }
      });
    });

    /* The scrubber is an input[type=range]: a div you can only drag fails
     * WCAG 2.5.7 Dragging Movements, and an operator on a keyboard cannot seek. */
    var range = el('input', {
      type: 'range', min: '0', max: String(duration), step: '1', value: '0',
      'aria-label': 'Playhead in the recording of ' + session.id + ', ' + session.user
        + ' on ' + session.target + ', ' + fmt.dur(duration) + ' long',
      'aria-valuetext': offsetLabel(0)
    });

    var scrubber = el('div.scrubber', [track].concat(markers).concat([range]));

    var logHost = el('div.logview', {
      tabindex: '0', role: 'group',
      'aria-label': 'Keystrokes recorded during session ' + session.id
    });
    var search = el('input.field', {
      type: 'search', id: 'ks-search-' + session.id, autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Filter keystrokes'
    });

    function currentIndex(at) {
      var idx = -1;
      keys.forEach(function (k, i) { if (k.at <= at) idx = i; });
      return idx;
    }

    function paintLog() {
      var q = search.value.trim().toLowerCase();
      var shown = keys.filter(function (k) {
        return !q || k.text.toLowerCase().indexOf(q) !== -1;
      });
      ui.clear(logHost);
      if (!shown.length) {
        logHost.appendChild(el('div.logline', { text: 'No keystroke in this recording matches ' + search.value }));
        return;
      }
      var at = Number(range.value);
      var idx = currentIndex(at);
      shown.forEach(function (k) {
        var line = el('div.logline', {
          title: fmt.stamp(new Date(session.started.getTime() + k.at * 1000)),
          'aria-current': (keys.indexOf(k) === idx) ? 'true' : null
        }, [
          el('span.mono', { text: offsetLabel(k.at) + '  ' }),
          el('span', { text: k.text })
        ]);
        logHost.appendChild(line);
      });
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
        // The tab panel is rebuilt on navigation, so a detached player stops itself.
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

    return el('div.stack', [
      el('div.callout.info', {
        text: 'Every interactive session through the gateway is recorded to argus-sessions, which is '
          + 'write-once for 400 days. Nobody, including an administrator, can delete a recording from the console.'
      }),
      ui.table(cols, d.sessions, {
        caption: 'Recorded gateway sessions, with the reason given and the person who approved them',
        empty: 'No session has been recorded.',
        sortKey: 'started', sortDir: 'desc',
        rowKey: function (s) { return s.id; },
        onRow: show
      }),
      detail
    ]);
  }

  /* ---------------------------------------------------------- evidence --- */

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
                  A.flash('ok', 'Evidence pack queued',
                    'It will be written to argus-artifacts and locked for 365 days. You will get a flash when the signature is verified.');
                });
            }
          })
        ]
      })
    ]);
  }

  /* -------------------------------------------------------------- screen --- */

  A.screen('security', {
    title: 'Security',
    crumb: 'Security',
    render: function (mount, ctx) {
      var items = [
        { id: 'posture', label: 'Posture', render: postureTab },
        { id: 'alerts', label: 'Alerts', render: alertsTab },
        { id: 'vulns', label: 'Vulnerabilities', render: vulnsTab },
        { id: 'sessions', label: 'Sessions', render: sessionsTab },
        { id: 'evidence', label: 'Evidence', render: evidenceTab }
      ];


      mount.appendChild(ui.pageHeader('Security',
        'Baseline drift, alerts, vulnerabilities and every recorded session, with the evidence pack that ties them together.'));
      // The bell links to #/security/alerts, so that tab opens. Selecting it is
      // not the same as reordering the tablist, which would move the tabs about
      // depending on how you arrived.
      mount.appendChild(ui.tabs(items, {
        label: 'Security sections',
        initial: (ctx && ctx.rest && ctx.rest[0]) || null
      }));
    }
  });
})();
