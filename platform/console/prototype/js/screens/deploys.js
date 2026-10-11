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
  var CHECK_GLYPH = { pass: '✓', warn: '▲', fail: '✕' };

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

  function checkRow(dep) {
    return el('div.checkrow', {
      role: 'group',
      'aria-label': 'Continuous integration evidence for deployment ' + dep.id
    }, checkKeys(dep.checks).map(function (k) {
      var value = dep.checks[k];
      var tone = CHECK_TONE[value] || 'fail';
      return el('span.check.' + tone, [
        el('span', { 'aria-hidden': 'true', text: CHECK_GLYPH[tone] }),
        ' ' + checkLabel(k) + ' ' + (CHECK_WORD[value] || value)
      ]);
    }));
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
      el('p.hint', { text: sentence + '. The reconciler moves one domain at a time and stops and rolls back on its own if a domain fails its health policy.' })
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

  function deployCard(dep) {
    var progressHost = dep.state === 'inflight' ? el('div', progressBlock(dep)) : null;
    if (progressHost) progressHost.repaint = function () { ui.clear(progressHost); progressHost.appendChild(progressBlock(dep)); };
    return el('div.deploycard', { data: { key: 'dep-' + dep.id } }, [
      el('h3', { text: appDisplay(dep) + ' ' + dep.version }),
      el('div.chips', [
        el('span.chip', { text: dep.env }),
        el('span.chip', { text: 'Deployment ' + dep.id }),
        el('span.chip.mono', { text: dep.sha }),
        dep.state === 'awaiting' && approvalsNeeded(dep) > 1 ? el('span.chip', { text: (dep.approvals || []).length + ' of ' + approvalsNeeded(dep) + ' approvals' }) : null,
        dep.state === 'awaiting' && frozenFor(dep) ? el('span.chip', { text: 'freeze in force' }) : null
      ]),
      el('div.row', [
        el('span.muted', { text: 'Opened by ' + personName(dep.author) }),
        fmt.time(dep.opened)
      ]),
      checkRow(dep),
      progressHost,
      dep.state === 'rolledback' ? el('div.callout.bad', { text: 'Rolled back: ' + dep.outcome }) : null,
      dep.state === 'rejected' ? el('div.callout.warn', { text: 'Rejected: ' + dep.outcome }) : null,
      dep.state === 'done' && dep.durationS
        ? el('p.hint', { text: 'Applied in ' + fmt.dur(dep.durationS) + ', outcome ' + dep.outcome + '.' })
        : null,
      el('div.row', A.link(
        (dep.state === 'awaiting' ? 'Review' : 'Open') + ' deployment ' + dep.id,
        'deploys', [String(dep.id)]))
    ]);
  }

  function lane(heading, deps, emptyTitle, emptyDetail) {
    return el('div.lane', [
      el('div.row', [
        el('h2', { text: heading }),
        el('span.chip', { text: fmt.num(deps.length) })
      ]),
      deps.length
        ? el('div.stack', deps.map(deployCard))
        : ui.emptyState(emptyTitle, emptyDetail)
    ]);
  }

  function renderQueue(mount) {
    var byNewest = function (a, b) { return b.opened - a.opened; };
    var awaiting = d.deployments.filter(function (p) { return p.state === 'awaiting'; }).sort(byNewest);
    var inflight = d.deployments.filter(function (p) { return p.state === 'inflight'; }).sort(byNewest);
    var recent = d.deployments.filter(function (p) {
      return p.state === 'done' || p.state === 'rolledback' || p.state === 'rejected';
    }).sort(byNewest);

    mount.appendChild(ui.pageHeader(
      'Deployments',
      'Every write to production is a pull request. Nothing reaches a server that a person did not approve.'));

    var lanes = el('div.lanes', [
      lane('Awaiting approval', awaiting,
        'Nothing is waiting for an approver',
        'The queue is empty. A deployment appears here as soon as somebody opens a pull request against the production branch.'),
      lane('In flight', inflight,
        'No upgrade is running',
        'The reconciler is idle. An upgrade shows its progress here, one upgrade domain at a time.'),
      lane('Recent', recent,
        'No deployment has finished yet',
        'Completed and rolled-back deployments stay here so you can see what changed and when.')
    ]);
    mount.appendChild(lanes);

    if (inflight.length) {
      rollWhile(lanes, function () {
        return d.deployments.filter(function (p) { return p.state === 'inflight'; });
      }, function () {
        Array.prototype.forEach.call(lanes.querySelectorAll('.deploycard'), function (card) {
          var dep = d.deployments.filter(function (p) { return 'dep-' + p.id === card.dataset.key; })[0];
          var host = card.querySelector('.progressbar') && card.querySelector('.progressbar').parentNode.parentNode;
          if (dep && host && host.repaint) host.repaint();
        });
      });
    }
  }

  function planTab(dep) {
    var intro = el('div.callout.info', [
      el('strong', { text: 'This is desired state against actual state.' }),
      el('p', {
        text: 'The reconciler computed this difference by comparing the manifests in Git with what is running in the cluster. Nothing below has been applied yet, and nothing will be until an approver signs off.'
      })
    ]);

    if (!dep.plan || !dep.plan.length) {
      return el('div.stack', [
        intro,
        ui.emptyState(
          'Nothing to apply',
          'The reconciler found no difference between Git and the cluster for this deployment. That is normal for a deployment that has already been applied.')
      ]);
    }

    return el('div.stack', [
      intro,
      el('div.plan-diff', dep.plan.map(function (p) {
        return el('div.row', [
          el('span.chip', { text: p.action }),
          el('span.mono', { text: p.kind }),
          el('strong', { text: p.name }),
          el('span.sr', { text: ' changes from ' }),
          el('span.plan-del', { text: String(p.from) }),
          el('span', { 'aria-hidden': 'true', text: '→' }),
          el('span.sr', { text: ' to ' }),
          el('span.plan-add', { text: String(p.to) })
        ]);
      })),
      declarationDiff(dep)
    ]);
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

    var risk = 'Applying this restarts ' + fmt.num((b.services || []).length) +
      ' service group' + ((b.services || []).length === 1 ? '' : 's') + ' and touches ' +
      fmt.num((b.dependents || []).length) + ' dependent workload' +
      ((b.dependents || []).length === 1 ? '' : 's') + '. ' +
      (b.sessions
        ? fmt.num(b.sessions) + ' signed-in session' + (b.sessions === 1 ? '' : 's') +
          ' will reconnect once as each upgrade domain is replaced.'
        : 'Nobody is signed in to it right now.');

    return el('div.stack', [
      el('div.blast', [
        ui.dl([
          ['Services touched', chipList(b.services, 'None')],
          ['Dependents', chipList(b.dependents, 'Nothing depends on it')],
          ['Signed-in sessions', fmt.num(b.sessions || 0)],
          ['Environment', dep.env],
          ['Tier', app ? fmt.num(app.tier) : 'unknown']
        ])
      ]),
      el('p', { text: risk }),
      ui.graph(nodes, edges, { label: 'What depends on ' + appLabel })
    ]);
  }

  function evidenceTab(dep) {
    var rows = checkKeys(dep.checks).map(function (k) {
      return { key: k, check: checkLabel(k), result: dep.checks[k] };
    });

    return el('div.stack', [
      ui.table([
        { key: 'check', label: 'Check' },
        {
          key: 'result', label: 'Result', status: true,
          render: function (row) {
            var tone = CHECK_TONE[row.result] === 'pass' ? 'ok'
              : CHECK_TONE[row.result] === 'warn' ? 'warn' : 'bad';
            var word = CHECK_WORD[row.result] || row.result;
            return ui.pill(word.charAt(0).toUpperCase() + word.slice(1), tone);
          }
        }
      ], rows, {
        caption: 'Continuous integration evidence for deployment ' + dep.id,
        rowKey: function (row) { return row.key; },
        empty: 'This deployment carries no recorded evidence, which should never happen in production.'
      }),
      ui.dl([
        ['Commit', el('code', { text: dep.sha })],
        ['Author', personName(dep.author)],
        ['Opened', fmt.time(dep.opened)],
        ['Approvals', (dep.approvals && dep.approvals.length)
          ? dep.approvals.map(function (a) { return personName(a); }).join(', ')
          : el('span.muted', { text: 'None yet' })]
      ]),
      el('p.hint', {
        text: 'The signature line is checked again by the reconciler at apply time. Evidence recorded here is what the pipeline saw when the artefact was built.'
      })
    ]);
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
      el('p.hint', { text: 'platform/gitops/apps/' + dep.app + '.yaml as the reconciler will read it, before and after. ' + fmt.num(changed) + ' line' + (changed === 1 ? '' : 's') + ' change.' }),
      el('div.diffview', { role: 'region', 'aria-label': 'Unified diff of the ' + dep.app + ' declaration, ' + changed + ' changed lines' },
        lines.map(function (l) {
          return el('div.diffline.' + l.kind, [
            el('span.ln', { text: l.ln ? String(l.ln) : '' }),
            el('span.sr', { text: l.kind === 'add' ? 'added: ' : l.kind === 'del' ? 'removed: ' : '' }),
            el('span', { 'aria-hidden': 'true', text: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ' }),
            el('span', { text: l.text })
          ]);
        }))
    ]);
  }

  function rejectButton(dep) {
    return ui.btn('Reject deployment ' + dep.id, {
      variant: 'ghost',
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
      mount.appendChild(ui.errorState(
        'No deployment numbered ' + id,
        'Nothing in the queue has that number. It may have been closed before this console kept history, or the link may be mistyped.'));
      mount.appendChild(ui.btn('Back to the deployment queue', {
        variant: 'primary',
        onClick: function () { A.go('deploys'); }
      }));
      return;
    }

    var actions = [];
    if (dep.state === 'awaiting') { actions.push(approveButton(dep)); actions.push(rejectButton(dep)); }
    if (dep.state === 'done') actions.push(rollbackButton(dep));

    mount.appendChild(ui.pageHeader(
      appDisplay(dep) + ' ' + dep.version + ' to ' + dep.env,
      'Deployment ' + dep.id + ', opened by ' + personName(dep.author) + ' ' + fmt.ago(dep.opened) +
        '. Commit ' + dep.sha + '.',
      actions));

    if (dep.state === 'awaiting' && frozenFor(dep)) {
      mount.appendChild(el('div.callout.warn', [
        el('strong', { text: 'A change freeze is in force until ' + fmt.stamp(frozenFor(dep).until) + '.' }),
        el('p', { text: frozenFor(dep).reason + ' Approving into production needs security sign-off with a written reason, recorded beside the approval.' })
      ]));
    }
    if (dep.state === 'awaiting' && approvalsNeeded(dep) > 1) {
      mount.appendChild(el('div.callout.info', [
        el('strong', { text: 'Tier ' + appOf(dep).tier + ': ' + approvalsNeeded(dep) + ' approvals required.' }),
        el('p', { text: (dep.approvals || []).length ? 'Approved so far by ' + dep.approvals.map(personName).join(', ') + '.' : 'Nobody has approved it yet.' })
      ]));
    }
    if (dep.state === 'awaiting' && dep.author === ME) {
      mount.appendChild(el('div.callout.warn', [
        el('strong', { text: 'You opened this deployment.' }),
        el('p', { text: 'Four eyes: a different Tier 1 person has to approve it. You can still reject your own deployment.' })
      ]));
    }
    if (dep.state === 'inflight') {
      var progressHost = el('div', progressBlock(dep));
      mount.appendChild(progressHost);
      rollWhile(progressHost, function () { return dep.state === 'inflight' ? [dep] : []; }, function () {
        ui.clear(progressHost);
        progressHost.appendChild(progressBlock(dep));
      });
    }
    if (dep.state === 'rolledback') mount.appendChild(el('div.callout.bad', { text: 'Rolled back: ' + dep.outcome }));
    if (dep.state === 'rejected') {
      mount.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Rejected.' }),
        el('p', { text: dep.outcome || 'No reason was recorded.' })
      ]));
    }

    mount.appendChild(ui.card(null, ui.tabs([
      { id: 'plan', label: 'Plan', render: function () { return planTab(dep); } },
      { id: 'blast', label: 'Blast radius', render: function () { return blastTab(dep); } },
      { id: 'evidence', label: 'Evidence', render: function () { return evidenceTab(dep); } }
    ], {
      label: 'Deployment ' + dep.id + ' detail',
      initial: tab || null,
      href: function (t) { return A.href('deploys', [String(dep.id), t]); }
    }), { flush: true }));
  }

  var screen = {
    title: 'Deployments',
    crumb: 'Deployments',
    render: function (mount, ctx) {
      if (ctx.rest && ctx.rest.length) renderDetail(mount, ctx.rest[0], ctx.rest[1]);
      else renderQueue(mount);
    }
  };

  if (typeof A.screen === 'function') A.screen('deploys', screen);
  else document.addEventListener('DOMContentLoaded', function () { A.screen('deploys', screen); });
})();
