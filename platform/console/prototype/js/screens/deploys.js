/* Argus Console: Deployments.
 *
 * Two modes on one route: the queue (#/deploys) and one deployment
 * (#/deploys/1847). Every write to production arrives here as a pull request,
 * so this screen is where the four-eyes rule is enforced in the interface as
 * well as in the pipeline: the person who opened a deployment cannot approve it.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt, d = A.data;

  // The signed-in operator, as the deployment records spell it.
  var ME = String(d.me.upn || '').split('@')[0];

  var CHECK_ORDER = ['build', 'tests', 'trivy', 'sbom', 'signature', 'vulnerable'];
  var CHECK_LABEL = {
    build: 'Build', tests: 'Tests', trivy: 'Image scan',
    sbom: 'SBOM', signature: 'Signature', vulnerable: 'Vulnerabilities'
  };
  var CHECK_WORD = { pass: 'passed', verified: 'verified', warn: 'warning', fail: 'failed' };
  var CHECK_TONE = { pass: 'pass', verified: 'pass', warn: 'warn', fail: 'fail' };
  var CHECK_GLYPH = { pass: '✓', warn: '▲', fail: '✕' };

  /* ------------------------------------------------------------ helpers --- */

  function personName(upn) {
    var p = d.people.filter(function (x) { return x.upn === upn; })[0];
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

  /** Evidence as a row of chips: a glyph for shape, a word for meaning. */
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
      el('p.hint', { text: sentence + '. The reconciler stops and rolls back on its own if a domain fails its health policy.' })
    ]);
  }

  function deployCard(dep) {
    return el('div.deploycard', [
      el('h3', { text: appDisplay(dep) + ' ' + dep.version }),
      el('div.chips', [
        el('span.chip', { text: dep.env }),
        el('span.chip', { text: 'Deployment ' + dep.id }),
        el('span.chip.mono', { text: dep.sha })
      ]),
      el('div.row', [
        el('span.muted', { text: 'Opened by ' + personName(dep.author) }),
        fmt.time(dep.opened)
      ]),
      checkRow(dep),
      dep.state === 'inflight' ? progressBlock(dep) : null,
      dep.state === 'rolledback' ? el('div.callout.bad', { text: 'Rolled back: ' + dep.outcome }) : null,
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

  /* --------------------------------------------------------------- queue --- */

  function renderQueue(mount) {
    var byNewest = function (a, b) { return b.opened - a.opened; };
    var awaiting = d.deployments.filter(function (p) { return p.state === 'awaiting'; }).sort(byNewest);
    var inflight = d.deployments.filter(function (p) { return p.state === 'inflight'; }).sort(byNewest);
    var recent = d.deployments.filter(function (p) {
      return p.state === 'done' || p.state === 'rolledback';
    }).sort(byNewest);

    mount.appendChild(ui.pageHeader(
      'Deployments',
      'Every write to production is a pull request. Nothing reaches a server that a person did not approve.'));

    mount.appendChild(el('div.lanes', [
      lane('Awaiting approval', awaiting,
        'Nothing is waiting for an approver',
        'The queue is empty. A deployment appears here as soon as somebody opens a pull request against the production branch.'),
      lane('In flight', inflight,
        'No upgrade is running',
        'The reconciler is idle. An upgrade shows its progress here, one upgrade domain at a time.'),
      lane('Recent', recent,
        'No deployment has finished yet',
        'Completed and rolled-back deployments stay here so you can see what changed and when.')
    ]));
  }

  /* -------------------------------------------------------------- detail --- */

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
      }))
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

  function approveButton(dep) {
    var selfOpened = dep.author === ME;
    return ui.btn('Approve deployment ' + dep.id, {
      variant: 'primary',
      disabled: selfOpened,
      title: selfOpened
        ? 'You opened this deployment. A different Tier 1 person must approve it.'
        : 'Approving needs your security key.',
      onClick: function () {
        A.stepUp('Approving a production deployment needs a second factor.', function () {
          A.flash('ok', 'Approved',
            'Deployment ' + dep.id + ' for ' + appDisplay(dep) + ' ' + dep.version +
            ' is queued. The reconciler verifies the signatures on every artefact, then runs a health-gated rolling upgrade one upgrade domain at a time, and rolls back automatically if a domain fails its health policy.');
        });
      }
    });
  }

  function rejectButton(dep) {
    return ui.btn('Reject deployment ' + dep.id, {
      variant: 'ghost',
      onClick: function () {
        var area = el('textarea.field', {
          id: 'reject-reason', rows: '4', autocomplete: 'off',
          'aria-describedby': 'reject-help'
        });
        // The reject button stays inert until there is a reason, because
        // "rejected, no reason given" is how a queue turns into folklore.
        var rejectOpts = {
          variant: 'danger',
          disabled: true,
          onClick: function () {
            close();
            A.flash('warn', 'Rejected',
              'Deployment ' + dep.id + ' was rejected and ' + personName(dep.author) +
              ' has been told why. The reason is recorded in the audit trail.');
          }
        };
        var go = ui.btn('Reject deployment ' + dep.id, rejectOpts);
        var close = null;

        area.addEventListener('input', function () {
          var ok = area.value.trim().length > 0;
          rejectOpts.disabled = !ok;
          go.classList.toggle('is-disabled', !ok);
          go.setAttribute('aria-disabled', ok ? 'false' : 'true');
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
            A.flash('warn', 'Roll back queued',
              appDisplay(dep) + ' will return to the version before ' + dep.version +
              '. The reconciler applies it one upgrade domain at a time and stops if health fails.');
          }
        });
      }
    });
  }

  function renderDetail(mount, id) {
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

    if (dep.state === 'awaiting' && dep.author === ME) {
      mount.appendChild(el('div.callout.warn', [
        el('strong', { text: 'You opened this deployment.' }),
        el('p', { text: 'Four eyes: a different Tier 1 person has to approve it. You can still reject your own deployment.' })
      ]));
    }
    if (dep.state === 'inflight') mount.appendChild(progressBlock(dep));
    if (dep.state === 'rolledback') mount.appendChild(el('div.callout.bad', { text: 'Rolled back: ' + dep.outcome }));

    mount.appendChild(ui.card(null, ui.tabs([
      { id: 'plan', label: 'Plan', render: function () { return planTab(dep); } },
      { id: 'blast', label: 'Blast radius', render: function () { return blastTab(dep); } },
      { id: 'evidence', label: 'Evidence', render: function () { return evidenceTab(dep); } }
    ], { label: 'Deployment ' + dep.id + ' detail' }), { flush: true }));
  }

  /* -------------------------------------------------------------- screen --- */

  var screen = {
    title: 'Deployments',
    crumb: 'Deployments',
    render: function (mount, ctx) {
      if (ctx.rest && ctx.rest.length) renderDetail(mount, ctx.rest[0]);
      else renderQueue(mount);
    }
  };

  // index.html loads the screens before app.js, so A.screen may not exist yet.
  // Screen files are parsed first, so this listener is queued ahead of the
  // shell's own DOMContentLoaded boot and the route is registered before the
  // first render.
  if (typeof A.screen === 'function') A.screen('deploys', screen);
  else document.addEventListener('DOMContentLoaded', function () { A.screen('deploys', screen); });
})();
