(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt, d = A.data;

  var ME = String(d.me.upn || '').split('@')[0];

  var CHECK_ORDER = ['build', 'tests', 'trivy', 'sbom', 'signature', 'vulnerable'];
  var CHECK_LABEL = {
    build: 'Build', tests: 'Tests', trivy: 'Image scan',
    sbom: 'SBOM', signature: 'Signature', vulnerable: 'Vulnerabilities'
  };
  var CHECK_WORD = { pass: 'passed', verified: 'verified', warn: 'warning', fail: 'failed' };
  var CHECK_TONE = { pass: 'pass', verified: 'pass', warn: 'warn', fail: 'fail' };

  function personName(upn) {
    var p = d.personByUpn(upn);
    return p ? p.name : (upn || 'unknown');
  }

  function appOf(dep) { return d.appByName(dep.app); }

  function appDisplay(dep) {
    var app = appOf(dep);
    return app ? app.display : dep.app;
  }

  function checkKeys(checks) {
    var known = CHECK_ORDER.filter(function (k) { return checks[k]; });
    var extra = Object.keys(checks).filter(function (k) { return CHECK_ORDER.indexOf(k) === -1; });
    return known.concat(extra);
  }

  function checkLabel(key) {
    return CHECK_LABEL[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  }

  var STATE = {
    awaiting: ['Awaiting approval', 'pending'],
    inflight: ['In progress', 'info'],
    done: ['Succeeded', 'ok'],
    rolledback: ['Rolled back', 'bad'],
    rejected: ['Rejected', 'warn']
  };

  function stateStatus(dep) {
    var m = STATE[dep.state] || [String(dep.state), 'idle'];
    return ui.status(m[1], m[0]);
  }

  function checksStatus(dep) {
    var keys = checkKeys(dep.checks);
    var failed = keys.filter(function (k) { return CHECK_TONE[dep.checks[k]] === 'fail'; }).length;
    var warned = keys.filter(function (k) { return CHECK_TONE[dep.checks[k]] === 'warn'; }).length;
    if (failed) return ui.status('bad', fmt.num(failed) + ' failed');
    if (warned) return ui.status('warn', fmt.num(warned) + ' warning');
    return ui.status('ok', fmt.num(keys.length) + ' passed');
  }

  function mono(text) { return el('span.mono', { text: String(text) }); }

  function progressBar(dep) {
    var p = dep.progress || { ud: 0, total: 1, healthy: true };
    var pct = (p.total ? (p.ud / p.total) * 100 : 0);
    var sentence = 'Upgrade domain ' + fmt.num(p.ud) + ' of ' + fmt.num(p.total) + ', health ' + (p.healthy ? 'OK' : 'failing');
    return el('div.col', [
      el('div.progressbar', {
        role: 'progressbar',
        'aria-valuenow': String(p.ud),
        'aria-valuemin': '0',
        'aria-valuemax': String(p.total),
        'aria-valuetext': sentence,
        'aria-label': 'Rolling upgrade for deployment ' + dep.id
      }, el('div.progressbar-fill', { style: { width: pct.toFixed(1) + '%' } })),
      el('span.num', { text: fmt.num(p.ud) + ' of ' + fmt.num(p.total) })
    ]);
  }

  function progressBlock(dep) {
    var p = dep.progress || { ud: 0, total: 1, healthy: true };
    var pct = (p.total ? (p.ud / p.total) * 100 : 0);
    var sentence = 'Upgrade domain ' + fmt.num(p.ud) + ' of ' + fmt.num(p.total) +
      ', health ' + (p.healthy ? 'OK' : 'failing');
    return el('div.stack', [
      el('div.progressbar', {
        role: 'progressbar',
        'aria-valuenow': String(p.ud),
        'aria-valuemin': '0',
        'aria-valuemax': String(p.total),
        'aria-valuetext': sentence,
        'aria-label': 'Rolling upgrade for deployment ' + dep.id
      }, el('div.progressbar-fill', { style: { width: pct.toFixed(1) + '%' } })),
      el('p.hint', { text: sentence + '. One domain at a time; a failing domain rolls back.' })
    ]);
  }

  var ROLL_MS = 4000;
  var UD_SECONDS = 38;

  function advance(dep) {
    var p = dep.progress;
    if (dep.state !== 'inflight' || !p) return false;
    p.ud = Math.min(p.total, p.ud + 1);
    if (p.ud < p.total) return false;
    dep.state = 'done';
    dep.outcome = 'healthy';
    dep.durationS = p.total * UD_SECONDS;
    dep.progress = null;
    var app = appOf(dep);
    if (app && dep.env === 'production') {
      app.version = dep.version;
      app.deployedAt = new Date(d.now.getTime());
    } else if (app) {
      app.staging = dep.version;
    }
    A.record('reconcile.apply', dep.app + ' ' + dep.version + ' to ' + dep.env, dep.id, 'reconciler', 'System');
    A.flash('ok', 'Deployment ' + dep.id + ' applied',
      appDisplay(dep) + ' ' + dep.version + ' is live in ' + dep.env + ' after ' + fmt.dur(dep.durationS) +
      '. Every upgrade domain passed its health policy.', { timeout: 10000 });
    return true;
  }

  function rollWhile(host, getDeps, onTick) {
    var timer = window.setInterval(function () {
      if (!document.body.contains(host)) { window.clearInterval(timer); return; }
      var deps = getDeps();
      if (!deps.length) { window.clearInterval(timer); return; }
      var finished = false;
      deps.forEach(function (dep) { if (advance(dep)) finished = true; });
      A.refreshBadges();
      if (finished) { window.clearInterval(timer); A.refresh(); return; }
      onTick();
    }, ROLL_MS);
    A.onLeave(function () { window.clearInterval(timer); });
  }

  function queueColumns(extra) {
    var cols = [
      { key: 'id', label: 'Deployment', render: function (dep) { return A.link(String(dep.id), 'deploys', [String(dep.id)]); } },
      { key: 'app', label: 'Application', sort: function (dep) { return appDisplay(dep); }, render: function (dep) { return appDisplay(dep); } },
      { key: 'version', label: 'Version', render: function (dep) { return mono(dep.version); } },
      { key: 'env', label: 'Environment', sort: function (dep) { return dep.env + ' ' + (100000000 + Number(dep.id || 0)); } }
    ];
    return cols.concat(extra || []).concat([
      { key: 'opened', label: 'Opened', sort: function (dep) { return dep.opened.getTime(); }, render: function (dep) { return fmt.time(dep.opened); } }
    ]);
  }

  function queueTable(caption, rows, extra, empty) {
    return ui.table(queueColumns(extra), rows, {
      caption: caption,
      sortKey: 'opened', sortDir: 'desc',
      rowKey: function (dep) { return 'dep-' + dep.id; },
      onRow: function (dep) { A.go('deploys', [String(dep.id)]); },
      emptyTitle: empty[0],
      empty: empty[1]
    });
  }

  function renderQueue(mount) {
    var byNewest = function (a, b) { return b.opened - a.opened; };
    var awaiting = d.deployments.filter(function (p) { return p.state === 'awaiting'; }).sort(byNewest);
    var inflight = d.deployments.filter(function (p) { return p.state === 'inflight'; }).sort(byNewest);
    var recent = d.deployments.filter(function (p) {
      return p.state === 'done' || p.state === 'rolledback' || p.state === 'rejected';
    }).sort(byNewest);

    mount.appendChild(ui.pageHeader('Deployments', null, null, { counter: d.deployments.length }));

    var approvals = {
      key: 'approvals', label: 'Approvals', align: 'right', sort: function (dep) { return (dep.approvals || []).length; },
      render: function (dep) { return fmt.num((dep.approvals || []).length) + ' of ' + fmt.num(approvalsNeeded(dep)); }
    };
    var checks = { key: 'checks', label: 'Checks', status: true, sortable: false, render: checksStatus };
    var progress = { key: 'progress', label: 'Upgrade domains', sortable: false, render: progressBar };
    var status = { key: 'state', label: 'Status', status: true, render: stateStatus };
    var duration = { key: 'durationS', label: 'Duration', align: 'right', render: function (dep) { return dep.durationS ? fmt.dur(dep.durationS) : '-'; } };

    var flight = queueTable('Deployments rolling out now', inflight, [progress], ['Nothing in progress', 'An approved deployment rolls out here, one upgrade domain at a time.']);
    mount.appendChild(el('div.grid', [
      ui.card('Awaiting approval', queueTable('Deployments waiting for an approver', awaiting, [checks, approvals], ['Nothing awaiting approval', 'A pull request against production appears here.']), { counter: awaiting.length }),
      ui.card('In progress', flight, { counter: inflight.length }),
      ui.card('Recent', queueTable('Finished, rolled back and rejected deployments', recent, [status, duration], ['No finished deployments', 'Finished deployments stay here.']), { counter: recent.length })
    ]));

    if (inflight.length) {
      rollWhile(flight, function () {
        return d.deployments.filter(function (p) { return p.state === 'inflight'; });
      }, function () { flight.repaint(); });
    }
  }

  function planTab(dep) {
    var steps = dep.plan || [];
    return el('div.grid', [
      detailsCard(dep),
      ui.card('Plan', ui.table([
        { key: 'action', label: 'Action', render: function (p) { return ui.badge(p.action); } },
        { key: 'kind', label: 'Kind', render: function (p) { return mono(p.kind); } },
        { key: 'name', label: 'Name' },
        { key: 'from', label: 'From', render: function (p) { return el('span.plan-del', [el('span.sr', { text: 'changes from ' }), String(p.from)]); } },
        { key: 'to', label: 'To', render: function (p) { return el('span.plan-add', [el('span.sr', { text: 'to ' }), String(p.to)]); } }
      ], steps, {
        caption: 'What applying deployment ' + dep.id + ' changes',
        rowKey: function (p) { return p.kind + ':' + p.name; },
        emptyTitle: 'Nothing to apply',
        empty: 'Git and the cluster agree for this deployment.'
      }), { counter: steps.length, description: 'Git against the cluster. Nothing applies until an approver signs off.' }),
      steps.length ? declarationDiff(dep) : null
    ]);
  }

  function detailsCard(dep) {
    var app = appOf(dep);
    return ui.card('Details', ui.dl([
      ['Application', app ? A.link(app.display, 'apps', [app.name]) : dep.app],
      ['Version', mono(dep.version)],
      ['Environment', dep.env],
      ['Status', stateStatus(dep)],
      ['Opened by', personName(dep.author)],
      ['Opened', fmt.time(dep.opened)],
      ['Commit', mono(dep.sha)],
      ['Checks', checksStatus(dep)],
      ['Approvals', fmt.num((dep.approvals || []).length) + ' of ' + fmt.num(approvalsNeeded(dep)) +
        ((dep.approvals && dep.approvals.length) ? ': ' + dep.approvals.map(personName).join(', ') : '')],
      dep.durationS ? ['Duration', fmt.dur(dep.durationS)] : null
    ]));
  }

  function blastTab(dep) {
    var b = dep.blast || { services: [], dependents: [], sessions: 0 };
    var app = appOf(dep);
    var appLabel = appDisplay(dep);

    function chipList(items, none) {
      return items && items.length
        ? el('div.chips', items.map(function (x) { return el('span.chip', { text: x }); }))
        : el('span.muted', { text: none });
    }

    var nodes = [{ id: '__app', label: appLabel, kind: 'application' }];
    var edges = [];
    (b.dependents || []).forEach(function (name, i) {
      var id = 'dep-' + i;
      nodes.push({ id: id, label: name, kind: 'dependent' });
      edges.push([id, '__app']);
    });

    return el('div.grid', [
      ui.card('Blast radius', ui.dl([
        ['Services touched', chipList(b.services, 'None')],
        ['Dependents', chipList(b.dependents, 'None')],
        ['Signed-in sessions', fmt.num(b.sessions || 0)],
        ['Environment', dep.env],
        ['Tier', app ? fmt.num(app.tier) : 'Unknown']
      ])),
      ui.card('Dependents', ui.graph(nodes, edges, { label: 'What depends on ' + appLabel }), { counter: (b.dependents || []).length })
    ]);
  }

  function evidenceTab(dep) {
    var rows = checkKeys(dep.checks).map(function (k) {
      return { key: k, check: checkLabel(k), result: dep.checks[k] };
    });

    return ui.card('Evidence', ui.table([
        { key: 'check', label: 'Check' },
        {
          key: 'result', label: 'Result', status: true,
          render: function (row) {
            var tone = CHECK_TONE[row.result] === 'pass' ? 'ok'
              : CHECK_TONE[row.result] === 'warn' ? 'warn' : 'bad';
            var word = CHECK_WORD[row.result] || row.result;
            return ui.status(tone, word.charAt(0).toUpperCase() + word.slice(1));
          }
        }
      ], rows, {
        caption: 'Continuous integration evidence for deployment ' + dep.id,
        rowKey: function (row) { return row.key; },
        emptyTitle: 'No evidence',
        empty: 'This deployment carries no recorded evidence.'
      }), { counter: rows.length, description: 'What the pipeline saw at build time. The signature is checked again at apply.' });
  }

  function approvalsNeeded(dep) {
    var app = appOf(dep);
    var byTier = (d.policy && d.policy.approvalsByTier) || {};
    var tier = app ? app.tier : 1;
    return Object.prototype.hasOwnProperty.call(byTier, tier) ? byTier[tier] : 1;
  }

  function frozenFor(dep) {
    return dep.env === 'production' ? A.freeze() : null;
  }

  function grantApproval(dep, note) {
    dep.approvals = (dep.approvals || []).concat([ME]);
    var needed = approvalsNeeded(dep);
    A.record('deployment.approve', dep.app + ' ' + dep.version + ' (' + dep.env + ')' + (note ? ', ' + note : '') +
      (needed > 1 ? ', approval ' + dep.approvals.length + ' of ' + needed : ''), dep.id);
    if (dep.approvals.length < needed) {
      A.flash('info', 'Approval ' + dep.approvals.length + ' of ' + needed + ' recorded',
        appDisplay(dep) + ' is Tier ' + appOf(dep).tier + ', so ' + needed + ' people have to approve before the reconciler moves. Nothing has been applied.');
      A.refresh();
      return;
    }
    dep.state = 'inflight';
    dep.progress = { ud: 0, total: 5, healthy: true };
    A.flash('ok', 'Approved',
      'Deployment ' + dep.id + ' for ' + appDisplay(dep) + ' ' + dep.version +
      ' is queued. The reconciler verifies the signatures on every artefact, then runs a health-gated rolling upgrade one upgrade domain at a time, and rolls back automatically if a domain fails its health policy.');
    A.refresh();
  }

  function freezeOverrideDialog(dep, freeze) {
    var reason = el('textarea.field', { id: 'freeze-reason', rows: '3', spellcheck: 'false', 'aria-describedby': 'freeze-help' });
    A.dialog({
      title: 'A change freeze is in force',
      body: function () {
        return [
          el('div.callout.warn', [
            el('strong', { text: 'Frozen until ' + fmt.stamp(freeze.until) + ' by ' + personName(freeze.by) + '.' }),
            el('p', { text: freeze.reason })
          ]),
          el('p', { text: 'Approving ' + appDisplay(dep) + ' ' + dep.version + ' into production during the freeze needs security sign-off. Write the justification; it is recorded next to the approval and paged to the security channel.' }),
          el('label.fieldlabel', { for: 'freeze-reason', text: 'Why this cannot wait for the freeze to lift' }),
          reason,
          el('p.hint', { id: 'freeze-help', text: '"Customer is waiting" is not a reason; "the fix for incident inc-32" is.' })
        ];
      },
      actions: function (close) {
        var go = ui.btn('Sign off and approve', {
          variant: 'danger', disabled: true,
          onClick: function () {
            var why = reason.value.trim();
            if (!why) return;
            close();
            A.stepUp('Overriding a change freeze needs a second factor.', function () {
              A.record('freeze.override', dep.app + ' ' + dep.version + ': ' + why, dep.id);
              grantApproval(dep, 'during a freeze: ' + why);
            });
          }
        });
        reason.addEventListener('input', function () { go.setDisabled(!reason.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
  }

  function approveButton(dep) {
    var selfOpened = dep.author === ME;
    var already = (dep.approvals || []).indexOf(ME) !== -1;
    var needed = approvalsNeeded(dep);
    var freeze = frozenFor(dep);
    var label = 'Approve deployment ' + dep.id + (needed > 1 ? ' (' + (dep.approvals || []).length + ' of ' + needed + ')' : '');
    return ui.btn(label, {
      variant: freeze ? 'danger' : 'primary',
      disabled: selfOpened || already,
      title: selfOpened
        ? 'You opened this deployment. A different Tier 1 person must approve it.'
        : already
          ? 'You have already approved it. Another person has to give the next approval.'
          : freeze
            ? 'A change freeze is in force. Approving needs security sign-off and a written reason.'
            : 'Approving needs your security key.',
      onClick: function () {
        if (freeze) { freezeOverrideDialog(dep, freeze); return; }
        A.stepUp('Approving a ' + dep.env + ' deployment needs a second factor.', function () { grantApproval(dep, null); });
      }
    });
  }

  function declarationOf(dep, version) {
    var app = appOf(dep);
    var lines = [
      'kind: ServiceFabricApp',
      'name: ' + dep.app,
      'environment: ' + dep.env,
      'version: ' + version,
      'identity: ' + (app ? app.identity : 'gmsa-' + dep.app + '$'),
      'services:'
    ];
    (app ? app.services : []).forEach(function (svc) {
      lines.push('  - name: ' + svc.name);
      lines.push('    exe: ' + svc.exe);
      lines.push('    instances: ' + svc.instances);
      lines.push('    port: ' + svc.port);
    });
    (dep.plan || []).forEach(function (p) {
      if (p.kind === 'PrometheusRule') {
        lines.push('rules:');
        lines.push('  - alert: ' + p.name);
        lines.push('    expr: p95 ' + (version === dep.version ? p.to : p.from));
      }
    });
    return lines;
  }

  function diffLines(before, after) {
    var n = before.length, m = after.length;
    var table = [];
    for (var i = 0; i <= n; i++) { table.push([]); for (var j = 0; j <= m; j++) table[i].push(0); }
    for (var i2 = n - 1; i2 >= 0; i2--) {
      for (var j2 = m - 1; j2 >= 0; j2--) {
        table[i2][j2] = before[i2] === after[j2] ? table[i2 + 1][j2 + 1] + 1 : Math.max(table[i2 + 1][j2], table[i2][j2 + 1]);
      }
    }
    var out = [], a = 0, b = 0;
    while (a < n && b < m) {
      if (before[a] === after[b]) { out.push({ kind: 'same', text: before[a], ln: b + 1 }); a++; b++; }
      else if (table[a + 1][b] >= table[a][b + 1]) { out.push({ kind: 'del', text: before[a] }); a++; }
      else { out.push({ kind: 'add', text: after[b], ln: b + 1 }); b++; }
    }
    while (a < n) { out.push({ kind: 'del', text: before[a++] }); }
    while (b < m) { out.push({ kind: 'add', text: after[b], ln: b + 1 }); b++; }
    return out;
  }

  function declarationDiff(dep) {
    var from = (dep.plan || []).filter(function (p) { return p.kind === 'ServiceFabricApp'; })[0];
    var before = declarationOf(dep, from ? from.from : dep.version);
    var after = declarationOf(dep, dep.version);
    var lines = diffLines(before, after);
    var changed = lines.filter(function (l) { return l.kind !== 'same'; }).length;
    return ui.card('Declaration diff', [
      el('div.diffview', { role: 'region', 'aria-label': 'Unified diff of the ' + dep.app + ' declaration, ' + changed + ' changed lines' },
        lines.map(function (l) {
          return el('div.diffline.' + l.kind, [
            el('span.ln', { text: l.ln ? String(l.ln) : '' }),
            el('span.sr', { text: l.kind === 'add' ? 'added: ' : l.kind === 'del' ? 'removed: ' : '' }),
            el('span', { 'aria-hidden': 'true', text: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ' }),
            el('span', { text: l.text })
          ]);
        }))
    ], { description: 'platform/gitops/apps/' + dep.app + '.yaml, ' + fmt.num(changed) + ' line' + (changed === 1 ? '' : 's') + ' changed.' });
  }

  function rejectButton(dep) {
    return ui.btn('Reject deployment ' + dep.id, {
      onClick: function () {
        var area = el('textarea.field', {
          id: 'reject-reason', rows: '4', autocomplete: 'off',
          'aria-describedby': 'reject-help'
        });
        var rejectOpts = {
          variant: 'danger',
          disabled: true,
          onClick: function () {
            var why = area.value.trim();
            close();
            dep.state = 'rejected';
            dep.outcome = why;
            A.record('deployment.reject', dep.app + ' ' + dep.version + ' (' + dep.env + '): ' + why, dep.id);
            A.flash('warn', 'Rejected',
              'Deployment ' + dep.id + ' was rejected and ' + personName(dep.author) +
              ' has been told why. The reason is recorded in the audit trail.');
            A.refresh();
          }
        };
        var go = ui.btn('Reject deployment ' + dep.id, rejectOpts);
        var close = null;

        area.addEventListener('input', function () {
          go.setDisabled(area.value.trim().length === 0);
        });

        var dlg = A.dialog({
          title: 'Reject deployment ' + dep.id,
          body: function () {
            return [
              el('p', {
                text: 'Rejecting sends ' + appDisplay(dep) + ' ' + dep.version + ' back to ' +
                  personName(dep.author) + '. Nothing is applied and nothing is deleted.'
              }),
              el('label.fieldlabel', { for: 'reject-reason', text: 'Reason (recorded in the audit and sent to the author)' }),
              area,
              el('p.hint', { id: 'reject-help', text: 'Say what would have to change for you to approve it.' })
            ];
          },
          actions: function (closeFn) {
            close = closeFn;
            return [ui.btn('Cancel', { variant: 'ghost', onClick: closeFn }), go];
          }
        });
        if (dlg) area.focus();
      }
    });
  }

  function rollbackButton(dep) {
    return ui.btn('Roll back deployment ' + dep.id, {
      variant: 'danger',
      onClick: function () {
        var b = dep.blast || { services: [], sessions: 0 };
        A.confirmDestructive({
          title: 'Roll back ' + appDisplay(dep) + ' to the previous version',
          detail: 'Deployment ' + dep.id + ' put ' + appDisplay(dep) + ' ' + dep.version + ' into ' +
            dep.env + '. Rolling back re-applies the version before it across every upgrade domain.',
          match: dep.app,
          environment: dep.env,
          blast: (b.services && b.services.length)
            ? 'This restarts ' + b.services.join(', ') + ' and ends ' + fmt.num(b.sessions || 0) + ' signed-in session(s).'
            : 'Every instance of ' + appDisplay(dep) + ' restarts, one upgrade domain at a time.',
          confirmLabel: 'Roll back ' + appDisplay(dep),
          onConfirm: function () {
            A.record('deployment.rollback', dep.app + ' from ' + dep.version + ' (' + dep.env + ')', dep.id);
            A.flash('warn', 'Roll back queued',
              appDisplay(dep) + ' will return to the version before ' + dep.version +
              '. The reconciler applies it one upgrade domain at a time and stops if health fails.');
          }
        });
      }
    });
  }

  function renderDetail(mount, id, tab) {
    var dep = d.deployments.filter(function (p) { return String(p.id) === String(id); })[0];

    if (!dep) {
      mount.appendChild(ui.notFound('deployment', id, 'deploys', 'Back to the deployment queue'));
      return;
    }

    var actions = [];
    if (dep.state === 'awaiting') { actions.push(rejectButton(dep)); actions.push(approveButton(dep)); }
    if (dep.state === 'done') actions.push(rollbackButton(dep));

    mount.appendChild(ui.pageHeader('Deployment ' + dep.id, appDisplay(dep) + ' ' + dep.version + ' to ' + dep.env, actions, { status: stateStatus(dep) }));

    var notes = [];
    var freeze = frozenFor(dep);
    if (dep.state === 'awaiting' && freeze) {
      notes.push(el('div.callout.warn', [
        el('strong', { text: 'Change freeze until ' + fmt.stamp(freeze.until) + '.' }),
        el('p', { text: freeze.reason + ' Approving needs security sign-off.' })
      ]));
    }
    if (dep.state === 'awaiting' && approvalsNeeded(dep) > 1) {
      notes.push(el('div.callout.info', [
        el('strong', { text: 'Tier ' + appOf(dep).tier + ': ' + approvalsNeeded(dep) + ' approvals required.' }),
        el('p', { text: (dep.approvals || []).length ? 'Approved so far by ' + dep.approvals.map(personName).join(', ') + '.' : 'Nobody has approved it yet.' })
      ]));
    }
    if (dep.state === 'awaiting' && dep.author === ME) {
      notes.push(el('div.callout.warn', [
        el('strong', { text: 'You opened this deployment.' }),
        el('p', { text: 'A different Tier 1 person has to approve it. You can still reject it.' })
      ]));
    }
    if (dep.state === 'rolledback') notes.push(el('div.callout.bad', [el('strong', { text: 'Rolled back.' }), el('p', { text: dep.outcome })]));
    if (dep.state === 'rejected') {
      notes.push(el('div.callout.warn', [
        el('strong', { text: 'Rejected.' }),
        el('p', { text: dep.outcome || 'No reason was recorded.' })
      ]));
    }
    notes.forEach(function (n) { mount.appendChild(n); });

    if (dep.state === 'inflight') {
      var progressHost = el('div', progressBlock(dep));
      mount.appendChild(ui.card('Rollout', progressHost));
      rollWhile(progressHost, function () { return dep.state === 'inflight' ? [dep] : []; }, function () {
        ui.clear(progressHost);
        progressHost.appendChild(progressBlock(dep));
      });
    }

    var tabs = ui.tabs([
      { id: 'plan', label: 'Details', render: function () { return planTab(dep); } },
      { id: 'blast', label: 'Blast radius', render: function () { return blastTab(dep); } },
      { id: 'evidence', label: 'Evidence', render: function () { return evidenceTab(dep); } }
    ], {
      label: 'Deployment ' + dep.id + ' detail',
      initial: tab || null,
      href: function (t) { return A.href('deploys', [String(dep.id), t]); }
    });
    if (dep.state === 'inflight') tabs.style.marginTop = 'var(--s-l)';
    mount.appendChild(tabs);
  }

  function placeholderOf(sha) {
    var t = String(sha || '').trim();
    return t || 'no digest declared';
  }

  function declaredVersions(body, data) {
    var rows = [];
    (data.environments || []).forEach(function (e) {
      (e.apps || []).forEach(function (a) {
        rows.push({ env: e.name, app: a.app, version: a.version, sha256: a.sha256, pinned: !!a.pinned, file: e.file });
      });
    });
    body.appendChild(ui.table([
      { key: 'env', label: 'Environment' },
      { key: 'app', label: 'Application', render: function (r) { return A.link(r.app, 'apps', [r.app]); } },
      { key: 'version', label: 'Version', render: function (r) { return el('code', { text: String(r.version) }); } },
      {
        key: 'pinned', label: 'Digest', status: true,
        render: function (r) {
          return r.pinned
            ? ui.status('ok', 'Pinned')
            : ui.status('warn', 'Unpinned: ' + placeholderOf(r.sha256));
        }
      },
      { key: 'file', label: 'File', render: function (r) { return el('code', { text: String(r.file) }); } }
    ], rows, {
      caption: 'Versions declared per environment',
      rowKey: function (r) { return r.env + '/' + r.app; },
      emptyTitle: 'No versions declared',
      empty: 'No environment declares any application.'
    }));
    if (data.note) body.appendChild(el('p.hint', { text: data.note }));
  }

  function declaredApps(body, data) {
    var apps = data.apps || [];
    if (!apps.length) {
      body.appendChild(ui.emptyState('No application is declared', 'platform/gitops/apps holds no application declaration.'));
      return;
    }
    body.appendChild(ui.table([
      { key: 'name', label: 'Application', render: function (r) { return A.link(r.name, 'apps', [r.name]); } },
      { key: 'kind', label: 'Kind' },
      { key: 'tier', label: 'Tier', align: 'right' },
      { key: 'owner', label: 'Owner' },
      { key: 'services', label: 'Services', align: 'right', render: function (r) { return fmt.num((r.services || []).length); } },
      { key: 'directory', label: 'Directory', render: function (r) { return el('code', { text: String(r.directory || '') }); } }
    ], apps, {
      caption: 'Applications declared in the repository',
      rowKey: function (r) { return r.name; }
    }));
    if (data.problems && data.problems.length) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: fmt.num(data.problems.length) + ' declaration' + (data.problems.length === 1 ? '' : 's') + ' could not be read.' }),
        el('ul.nis-list', data.problems.map(function (p) { return el('li', [mono(p.directory), ' ', String(p.message || '')]); }))
      ]));
    }
  }

  function counted(title, path, draw, count) {
    var card = null;
    card = A.livePanel(title, path, function (body, data, env) {
      var row = card.querySelector('.card-titlerow');
      if (row && !row.querySelector('.card-counter')) row.appendChild(el('span.card-counter', { text: '(' + fmt.num(count(data)) + ')' }));
      draw(body, data, env);
    });
    return card;
  }

  function renderLive(host) {
    host.appendChild(ui.pageHeader('Deployments', 'Declared in the repository; nothing here has been applied.'));
    host.appendChild(el('div.grid', [
      counted('Declared versions', '/api/gitops/environments', declaredVersions, function (data) {
        return (data.environments || []).reduce(function (n, e) { return n + (e.apps || []).length; }, 0);
      }),
      counted('Declared applications', '/api/gitops/apps', declaredApps, function (data) { return (data.apps || []).length; }),
      A.notInStack('The GitOps reconciler',
        'does not run in this stack, so nothing has been planned, approved or applied.')
    ]));
  }

  function renderLiveDetail(host, id) {
    host.appendChild(ui.notFound('deployment', id, 'deploys', 'Back to the declared versions'));
    host.appendChild(A.notInStack('The GitOps reconciler',
      'does not run in this stack, so it holds no deployment history and no deployment number can be looked up here.'));
  }

  var screen = {
    title: 'Deployments',
    crumb: 'Deployments',
    liveCrumbs: function (rest) { return ['Deployment ' + rest[0]]; },
    crumbs: function (rest) {
      var TAB = { plan: 'Details', blast: 'Blast radius', evidence: 'Evidence' };
      if (!rest[1]) return ['Deployment ' + rest[0]];
      return [{ label: 'Deployment ' + rest[0], href: A.href('deploys', [rest[0]]) }, TAB[rest[1]] || rest[1]];
    },
    render: function (mount, ctx) {
      var host = el('div');
      mount.appendChild(host);
      A.whenProbed(function (mode) {
        if (mode === 'live') {
          if (ctx.rest && ctx.rest.length) renderLiveDetail(host, ctx.rest[0]);
          else renderLive(host);
          return;
        }
        if (ctx.rest && ctx.rest.length) renderDetail(host, ctx.rest[0], ctx.rest[1]);
        else renderQueue(host);
      });
    }
  };

  A.screen('deploys', screen);
})();
