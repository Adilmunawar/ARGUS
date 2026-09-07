/* Argus Console: Overview.
 *
 * The morning screen. It answers two questions and nothing else: is anything
 * wrong, and does anything need me. Every sentence on it is computed from the
 * dataset, because a dashboard that reassures you with hardcoded copy is worse
 * than no dashboard.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt, d = A.data;

  /* ------------------------------------------------------------ helpers --- */

  function countBy(list, test) {
    return list.filter(test).length;
  }

  function openAlerts() {
    return d.alerts.filter(function (a) { return a.state === 'open'; });
  }

  // Ordered worst-first so "the worst thing open" is just the head of the list.
  var SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  function bySeverity(a, b) {
    return (SEVERITY_RANK[a.severity] || 9) - (SEVERITY_RANK[b.severity] || 9);
  }

  function oldestBackup() {
    return d.backups.slice().sort(function (a, b) { return a.last - b.last; })[0];
  }

  function awaitingDeployments() {
    return d.deployments.filter(function (p) { return p.state === 'awaiting'; });
  }

  function requestedGrants() {
    return d.grants.filter(function (g) { return g.state === 'requested'; });
  }

  function urgentAlerts() {
    return openAlerts().filter(function (a) {
      return a.severity === 'critical' || a.severity === 'high';
    }).sort(bySeverity);
  }

  function personName(upn) {
    var p = d.people.filter(function (x) { return x.upn === upn; })[0];
    if (p) return p.name;
    if (upn === 'reconciler') return 'The reconciler';
    if (upn === 'system') return 'The monitoring system';
    return upn ? upn.charAt(0).toUpperCase() + upn.slice(1) : 'Somebody';
  }

  /** Audit rows are machine keys; an operator reading them wants a sentence. */
  function auditSentence(row) {
    var who = personName(row.actor);
    var pr = row.pr ? ' ' + row.pr : '';
    switch (row.action) {
      case 'deployment.open': return who + ' opened deployment' + pr + ' for ' + row.target + '.';
      case 'deployment.approve': return who + ' approved deployment' + pr + ' for ' + row.target + '.';
      case 'deployment.reject': return who + ' rejected deployment' + pr + ' for ' + row.target + '.';
      case 'session.start': return who + ' started a recorded session on ' + row.target + '.';
      case 'grant.approve': return who + ' approved an elevation: ' + row.target + '.';
      case 'reconcile.apply': return who + ' applied ' + row.target + (row.pr ? ', deployment ' + row.pr : '') + '.';
      case 'reconcile.rollback': return who + ' rolled back ' + row.target + (row.pr ? ', deployment ' + row.pr : '') + '.';
      case 'secret.rotate': return who + ' rotated the secret ' + row.target + '.';
      case 'alert.raise': return who + ' raised an alert: ' + row.target + '.';
      case 'reconciler.pause': return who + ' paused the reconciler: ' + row.target + '.';
      default: return who + ' ran ' + row.action.split('.').join(' ') + ' on ' + row.target + '.';
    }
  }

  function needsYouRow(text, link) {
    return el('div.row', [el('span', { text: text }), link]);
  }

  /* -------------------------------------------------------------- blocks --- */

  function heroBand() {
    var critical = openAlerts().filter(function (a) { return a.severity === 'critical'; });
    if (critical.length) {
      var a = critical[0];
      var more = critical.length > 1
        ? ' ' + fmt.num(critical.length - 1) + ' other critical alert' + (critical.length === 2 ? ' is' : 's are') + ' also open.'
        : '';
      return el('div.callout.warn', [
        el('strong', { text: 'A critical alert is open on ' + a.host + '.' }),
        el('p', {
          text: a.source + ' reported "' + a.rule + '" on ' + a.host + '. It has fired ' +
            fmt.num(a.count) + ' time' + (a.count === 1 ? '' : 's') + ', most recently ' + fmt.ago(a.last) +
            ', and nobody has acknowledged it.' + more
        }),
        A.link('Open alert ' + a.id + ' in Security', 'security', ['alerts'], { id: a.id })
      ]);
    }

    var degraded = d.apps.filter(function (app) { return app.health !== 'ok'; });
    var back = oldestBackup();
    return el('div.callout.ok', [
      el('strong', { text: 'Nothing critical is open.' }),
      el('p', {
        text: fmt.num(d.apps.length - degraded.length) + ' of ' + fmt.num(d.apps.length) +
          ' applications are healthy, the reconciler last synchronised ' + fmt.ago(d.reconciler.lastSync) +
          ', and the oldest backup, ' + back.store + ', is ' + fmt.ago(back.last) + '.'
      })
    ]);
  }

  function tiles() {
    var healthy = countBy(d.apps, function (app) { return app.health === 'ok'; });
    var degraded = d.apps.filter(function (app) { return app.health !== 'ok'; });
    var worstSlo = d.apps.slice().sort(function (a, b) { return a.slo - b.slo; })[0];
    var back = oldestBackup();
    var open = openAlerts().slice().sort(bySeverity);
    var awaiting = awaitingDeployments();

    return el('div.tiles', [
      ui.statTile('Applications healthy', fmt.num(healthy) + ' of ' + fmt.num(d.apps.length), {
        note: degraded.length
          ? degraded.map(function (app) { return app.display; }).join(', ') + ' not healthy'
          : 'Every application is serving normally'
      }),
      ui.statTile('Lowest SLO this month', fmt.pct(worstSlo.slo, 2), {
        note: worstSlo.display + ' is the worst of ' + fmt.num(d.apps.length)
      }),
      ui.statTile('Oldest backup', fmt.ago(back.last), {
        note: back.store + ', ' + back.kind + ', ' + back.cadence
      }),
      ui.statTile('Open alerts', fmt.num(open.length), {
        note: open.length ? 'Worst severity: ' + open[0].severity : 'Nothing open'
      }),
      ui.statTile('Deployments awaiting approval', fmt.num(awaiting.length), {
        note: awaiting.length
          ? 'Oldest opened ' + fmt.ago(awaiting.slice().sort(function (a, b) { return a.opened - b.opened; })[0].opened)
          : 'The queue is empty'
      }),
      ui.statTile('AWS exit progress', fmt.pct(d.exitProgress.percent, 0), {
        note: 'Phase ' + fmt.num(d.exitProgress.phase) + ' of ' + fmt.num(d.exitProgress.phases)
      })
    ]);
  }

  function needsYouCard() {
    var rows = [];

    awaitingDeployments().forEach(function (dep) {
      var app = d.appByName(dep.app);
      rows.push(needsYouRow(
        (app ? app.display : dep.app) + ' ' + dep.version + ' is waiting for approval into ' +
          dep.env + ', opened by ' + personName(dep.author) + ' ' + fmt.ago(dep.opened) + '.',
        A.link('Review deployment ' + dep.id, 'deploys', [String(dep.id)])
      ));
    });

    requestedGrants().forEach(function (g) {
      rows.push(needsYouRow(
        personName(g.principal) + ' has asked to join ' + g.group + ': ' + g.reason + '.',
        A.link('Review grant ' + g.id, 'identity', ['grants'], { id: g.id })
      ));
    });

    urgentAlerts().forEach(function (a) {
      rows.push(needsYouRow(
        a.severity.charAt(0).toUpperCase() + a.severity.slice(1) + ': ' + a.rule + ' on ' + a.host +
          ', last seen ' + fmt.ago(a.last) + '.',
        A.link('Open alert ' + a.id, 'security', ['alerts'], { id: a.id })
      ));
    });

    return ui.card('Needs you', rows.length
      ? el('div.stack', rows)
      : ui.emptyState(
        'Nothing is waiting for you',
        'No deployment needs an approver, no elevation has been requested, and no critical or high alert is open. This list fills itself, so there is nothing to refresh.',
        A.link('Look at the deployment queue anyway', 'deploys')));
  }

  function activityCard() {
    var rows = d.audit.slice(0, 8).map(function (row) {
      return el('div.row', [
        el('span', { text: auditSentence(row) }),
        fmt.time(row.at)
      ]);
    });
    return ui.card('Recent activity', [
      el('div.stack', rows),
      el('div.row', A.link('All audit events', 'audit'))
    ]);
  }

  function sitesCard() {
    return ui.card('Sites', el('div.sitemap', d.sites.map(function (s) {
      return el('div.site', [
        el('h3', { text: s.name }),
        ui.dl([
          ['Location', s.location],
          ['Role', s.role],
          ['Link', ui.pill(s.link === 'up' ? 'Up' : 'Down', s.link === 'up' ? 'ok' : 'bad')],
          ['Latency', fmt.ms(s.latencyMs)],
          ['Replication lag', fmt.dur(s.replicationLagS)]
        ])
      ]);
    })));
  }

  function trafficCard() {
    var top = d.apps.slice().sort(function (a, b) { return b.rps - a.rps; }).slice(0, 4);
    var rows = top.map(function (app) {
      return el('div.row', [
        A.link(app.display, 'apps', [app.name]),
        // The number is text first: a sparkline is a shape, not a reading.
        el('span.num', { text: fmt.num(app.rps) + ' req/s' }),
        ui.sparkline(app.trend.rps, { label: app.display + ' request rate, last 24 hours' })
      ]);
    });
    return ui.card('Traffic, last 24 hours', [
      el('p.hint', { text: 'The four busiest applications by request rate. Each line covers 24 hourly samples; the figure beside it is the rate right now.' }),
      el('div.stack', rows)
    ]);
  }

  function reconcilerCard() {
    var r = d.reconciler;
    var drifted = r.drift > 0;
    return ui.card('Reconciler', [
      ui.dl([
        ['State', ui.pill(r.state === 'running' ? 'Running' : r.state, r.state === 'running' ? 'ok' : 'warn')],
        ['Last sync', fmt.time(r.lastSync)],
        ['Head', el('code', { text: r.head })],
        ['Drift', drifted
          ? ui.pill(fmt.num(r.drift) + ' resources adrift', 'warn')
          : ui.pill('None', 'ok')],
        ['Pending plans', fmt.num(r.pendingPlans)],
        ['Apply lag', fmt.dur(r.applyLagS)]
      ]),
      el('p.hint', {
        text: drifted
          ? 'Drift means the cluster no longer matches Git. The reconciler will not close the gap on its own while a plan is pending.'
          : 'The cluster matches the desired state in Git. Nothing has been changed by hand.'
      })
    ]);
  }

  /* -------------------------------------------------------------- screen --- */

  var screen = {
    title: 'Overview',
    crumb: 'Overview',
    render: function (mount) {
      var healthy = countBy(d.apps, function (app) { return app.health === 'ok'; });
      var open = openAlerts();
      var awaiting = awaitingDeployments();
      var summary =
        fmt.num(healthy) + ' of ' + fmt.num(d.apps.length) + ' applications healthy, ' +
        fmt.num(open.length) + ' open alert' + (open.length === 1 ? '' : 's') + ', ' +
        fmt.num(awaiting.length) + ' deployment' + (awaiting.length === 1 ? '' : 's') +
        ' waiting for a person.';

      mount.appendChild(ui.pageHeader('Overview', summary, [
        ui.btn('Run a runbook', {
          variant: 'ghost',
          onClick: function () { A.go('ops'); }
        })
      ]));

      mount.appendChild(heroBand());
      mount.appendChild(tiles());
      mount.appendChild(el('div.grid.grid-3', [needsYouCard(), activityCard(), sitesCard()]));
      mount.appendChild(el('div.grid.grid-2', [trafficCard(), reconcilerCard()]));
    }
  };

  // app.js is parsed first and defers its boot, so A.screen exists by now. The
  // queued path stays as a guard against the load order regressing.
  // Screen files are parsed first, so this listener is queued ahead of the
  // shell's own DOMContentLoaded boot and the route is registered before the
  // first render.
  if (typeof A.screen === 'function') A.screen('overview', screen);
  else document.addEventListener('DOMContentLoaded', function () { A.screen('overview', screen); });
})();
