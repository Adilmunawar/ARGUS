(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt, d = A.data;

  function countBy(list, test) {
    return list.filter(test).length;
  }

  function openAlerts() {
    return d.alerts.filter(function (a) { return a.state === 'open'; });
  }

  var SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  function rank(sev) {
    return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, sev) ? SEVERITY_RANK[sev] : 9;
  }
  function bySeverity(a, b) { return rank(a.severity) - rank(b.severity); }

  function oldestBackup() {
    return d.backups.slice().sort(function (a, b) { return a.last - b.last; })[0];
  }

  function awaitingDeployments() {
    return d.deployments.filter(function (p) { return p.state === 'awaiting'; });
  }

  function personName(upn) {
    var p = d.personByUpn(upn);
    if (p) return p.name;
    if (upn === 'reconciler') return 'The reconciler';
    if (upn === 'system') return 'The monitoring system';
    return upn ? upn.charAt(0).toUpperCase() + upn.slice(1) : 'Somebody';
  }

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
      case 'alert.acknowledge': return who + ' acknowledged alert ' + row.target + '.';
      case 'reconciler.pause': return who + ' paused the reconciler: ' + row.target + '.';
      case 'deployment.rollback': return who + ' asked for a roll back of ' + row.target + (row.pr ? ', deployment ' + row.pr : '') + '.';
      case 'grant.deny': return who + ' declined an elevation: ' + row.target + '.';
      case 'grant.revoke': return who + ' revoked ' + row.target + '.';
      case 'elevation.request': return who + ' elevated ' + row.target + '.';
      case 'elevation.release': return who + ' released the elevation of ' + row.target + '.';
      case 'elevation.extend': return who + ' extended an elevation: ' + row.target + '.';
      case 'incident.open': return who + ' opened incident ' + row.target + '.';
      case 'incident.note': return who + ' wrote on incident ' + row.target + '.';
      case 'incident.mitigated': return who + ' marked incident ' + row.target + ' mitigated.';
      case 'incident.resolved': return who + ' resolved incident ' + row.target + '.';
      case 'incident.reopen': return who + ' reopened incident ' + row.target + '.';
      case 'session.lock': return 'The console locked, ' + row.target + '.';
      case 'session.unlock': return who + ' unlocked the console.';
      case 'secret.revoke-leases': return who + ' revoked every lease on ' + row.target + '.';
      case 'vuln.waive': return who + ' waived ' + row.target + '.';
      case 'model.promote': return who + ' promoted model ' + row.target + '.';
      case 'canary.set': return who + ' set the canary on ' + row.target + '.';
      case 'asset.materialise': return who + ' queued a materialisation of ' + row.target + '.';
      case 'runbook.run': return who + ' ran runbook ' + row.target + '.';
      case 'app.restart': return who + ' asked for a restart of ' + row.target + '.';
      case 'instance.restart': return who + ' restarted ' + row.target + '.';
      case 'host.drain': return who + ' asked to drain ' + row.target + '.';
      case 'host.quarantine': return who + ' quarantined ' + row.target + '.';
      case 'person.offboard': return who + ' offboarded ' + row.target + '.';
      case 'evidence.generate': return who + ' generated the ' + row.target + '.';
      default: return who + ' ran ' + row.action.split('.').join(' ') + ' on ' + row.target + '.';
    }
  }

  function needsYouRow(text, link) {
    return el('div.row', [el('span', { text: text }), link]);
  }

  function heroBand() {
    var critical = openAlerts().filter(function (a) { return a.severity === 'critical'; });
    if (critical.length) {
      var a = critical[0];
      var more = critical.length > 1
        ? ' ' + fmt.num(critical.length - 1) + ' other critical alert' + (critical.length === 2 ? ' is' : 's are') + ' also open.'
        : '';
      return el('div.callout.bad', [
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
    var items = typeof A.needsYou === 'function' ? A.needsYou() : [];
    var rows = items.slice(0, 8).map(function (it) {
      return needsYouRow(it.kind + ': ' + it.text, A.link(it.label, it.route, it.rest, it.params));
    });
    if (items.length > 8) {
      rows.push(el('div.row', [
        el('span.muted', { text: fmt.num(items.length - 8) + ' more in the inbox.' }),
        ui.btn('Open the inbox', { variant: 'ghost', onClick: function () { A.inbox(); } })
      ]));
    }

    return ui.card('Needs you', rows.length
      ? el('div.stack', rows)
      : ui.emptyState(
        'Nothing is waiting for you',
        'No incident is open, no deployment needs an approver, no elevation has been requested, no waiver has expired, no secret is past its policy and no critical or high alert is open. This list fills itself, so there is nothing to refresh.',
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

  function linkHistory(site) {
    var beats = site.checks || [];
    var day = ui.uptimeOf(beats, { windowMs: 86400000, now: d.now.getTime() });
    var sentence = ui.heartbeatSentence(beats, {
      name: site.name + ' link',
      windowMs: 86400000,
      windowWord: 'the last 24 hours',
      now: d.now.getTime()
    });
    var incidents = ui.incidentsOf(beats).filter(function (i) { return i.to === 0; });
    return el('div.stack', [
      ui.heartbeatBar(beats, { slots: beats.length || 48, width: 240, label: sentence }),
      el('div.hbscale', [
        el('span', { text: '24 h ago' }),
        el('span', { text: 'now' })
      ]),
      el('span', {
        text: day.ratio === null
          ? 'No link check has been recorded.'
          : fmt.pct(day.ratio * 100, 1) + ' of ' + fmt.num(day.counted) + ' checks up' +
            (incidents.length
              ? ', ' + fmt.num(incidents.length) + ' drop' + (incidents.length === 1 ? '' : 's') +
                ', last ' + fmt.ago(new Date(incidents[incidents.length - 1].at))
              : ', no drop')
      })
    ]);
  }

  function sitesCard() {
    return ui.card('Sites', [
      el('div.sitemap', d.sites.map(function (s) {
        return el('div.site', [
          el('h3', { text: s.name }),
          ui.dl([
            ['Location', s.location],
            ['Role', s.role],
            ['Link', ui.pill(s.link === 'up' ? 'Up' : 'Down', s.link === 'up' ? 'ok' : 'bad')],
            ['Latency', fmt.ms(s.latencyMs)],
            ['Replication lag', fmt.dur(s.replicationLagS)],
            ['Link checks', linkHistory(s)]
          ])
        ]);
      })),
      el('p.hint', {
        text: 'Every figure on this screen, these link checks included, comes from the bundled sample ' +
          'dataset. Nothing here has been measured. The Stack screen reads the live estate.'
      })
    ]);
  }

  function trafficCard() {
    var top = d.apps.slice().sort(function (a, b) { return b.rps - a.rps; }).slice(0, 4);
    var rows = top.map(function (app) {
      return el('div.row', [
        A.link(app.display, 'apps', [app.name]),
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

  if (typeof A.screen === 'function') A.screen('overview', screen);
  else document.addEventListener('DOMContentLoaded', function () { A.screen('overview', screen); });
})();
