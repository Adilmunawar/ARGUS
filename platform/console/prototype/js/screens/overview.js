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
      case 'session.end': return who + ' ended a recorded session on ' + row.target + '.';
      case 'alert.silence': return who + ' silenced alert ' + row.target + '.';
      case 'alert.unsilence': return who + ' lifted the silence on ' + row.target + '.';
      case 'freeze.declare': return who + ' declared a change freeze: ' + row.target + '.';
      case 'freeze.lift': return who + ' lifted the change freeze: ' + row.target + '.';
      case 'freeze.override': return who + ' signed off a deployment during the freeze: ' + row.target + '.';
      case 'audit.verify': return who + ' verified the audit chain: ' + row.target + '.';
      case 'tags.update': return who + ' changed tags on ' + row.target + '.';
      case 'advisor.accept': return who + ' accepted an advisor finding: ' + row.target + '.';
      case 'advisor.reopen': return who + ' reopened advisor finding ' + row.target + '.';
      case 'alarm.create': return who + ' created alarm ' + row.target + '.';
      case 'alarm.update': return who + ' changed alarm ' + row.target + '.';
      case 'alarm.delete': return who + ' deleted alarm ' + row.target + '.';
      case 'vm.stop': return who + ' stopped ' + row.target + '.';
      case 'vm.start': return who + ' started ' + row.target + '.';
      case 'vm.restart': return who + ' restarted ' + row.target + '.';
      case 'vm.resize': return who + ' resized ' + row.target + '.';
      case 'vm.checkpoint': return who + ' took a checkpoint of ' + row.target + '.';
      case 'vm.protect': return who + ' enabled replication for ' + row.target + '.';
      case 'host.patch': return who + ' patched ' + row.target + '.';
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
    return el('div.feed-row', [el('span', { text: text }), link]);
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

    var findings = typeof A.advisorFindings === 'function' ? A.advisorFindings().filter(function (f) { return !f.suppressed; }) : [];
    var urgent = findings.filter(function (f) { return f.severity === 'critical' || f.severity === 'high'; }).length;

    return el('div.tiles', [
      ui.statTile('Applications healthy', fmt.num(healthy) + ' of ' + fmt.num(d.apps.length), {
        note: degraded.length
          ? degraded.map(function (app) { return app.display; }).join(', ') + ' not healthy'
          : 'Every application is serving normally',
        href: A.href('apps'), title: 'Open Applications'
      }),
      ui.statTile('Lowest SLO this month', fmt.pct(worstSlo.slo, 2), {
        note: worstSlo.display + ' is the worst of ' + fmt.num(d.apps.length),
        href: A.href('apps', [worstSlo.name, 'budget']), title: 'Open the error budget of ' + worstSlo.display
      }),
      ui.statTile('Oldest backup', fmt.ago(back.last), {
        note: back.store + ', ' + back.kind + ', ' + back.cadence,
        href: A.href('ops', ['backups']), title: 'Open backups and drills'
      }),
      ui.statTile('Open alerts', fmt.num(open.length), {
        note: open.length ? 'Worst severity: ' + open[0].severity : 'Nothing open',
        href: A.href('security', ['alerts']), title: 'Open the alerts'
      }),
      ui.statTile('Deployments awaiting approval', fmt.num(awaiting.length), {
        note: awaiting.length
          ? 'Oldest opened ' + fmt.ago(awaiting.slice().sort(function (a, b) { return a.opened - b.opened; })[0].opened)
          : 'The queue is empty',
        href: A.href('deploys'), title: 'Open the deployment queue'
      }),
      ui.statTile('Advisor findings', fmt.num(findings.length), {
        note: urgent ? fmt.num(urgent) + ' critical or high' : 'none critical or high',
        href: A.href('advisor'), title: 'Open the Advisor'
      })
    ]);
  }

  function recentCard() {
    var items = typeof A.recents === 'function' ? A.recents().slice(0, 6) : [];
    return ui.card('Recently visited', items.length
      ? el('div.stack', items.map(function (r) {
        return el('div.row', [
          el('a.rlink', { href: r.hash, text: r.label }),
          el('span.muted', { text: r.kind })
        ]);
      }))
      : ui.emptyState('Nothing yet', 'The screens and resources you open appear here, newest first, and in the palette.'));
  }

  function appBeats(app) {
    var seed = 0;
    for (var i = 0; i < app.name.length; i++) seed = (seed * 31 + app.name.charCodeAt(i)) % 100003;
    var out = [];
    for (var day = 29; day >= 0; day--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      var roll = seed / 2147483648;
      var bad = app.health !== 'ok' ? 0.18 : app.slo < 99.95 ? 0.05 : 0.01;
      var status = roll < bad ? 0 : roll < bad + 0.03 ? 2 : 1;
      if (day === 0) status = app.health === 'ok' ? 1 : 2;
      out.push({ at: A.time.daysAgo(day), status: status });
    }
    return out;
  }

  function healthCard() {
    var rows = d.apps.slice().sort(function (a, b) { return a.slo - b.slo; }).map(function (app) {
      var beats = appBeats(app);
      var u = ui.uptimeOf(beats, {});
      return el('div.healthrow', [
        A.link(app.display, 'apps', [app.name]),
        ui.heartbeatBar(beats, { slots: 30, width: 200, height: 16, label: app.display + ': ' + ui.heartbeatSentence(beats, { windowWord: 'the last 30 days' }) }),
        el('span.num', { text: fmt.pct(u.ratio * 100, 1) })
      ]);
    });
    return ui.card('Service health, 30 days', [
      el('div.stack', rows),
      el('p.hint', { text: 'One slot per day, oldest left. Full is up, short is a retry, notched is an outage. Worst at the top.' })
    ]);
  }

  function needsYouCard() {
    var items = typeof A.needsYou === 'function' ? A.needsYou() : [];
    var shown = openAlerts().filter(function (a) { return a.severity === 'critical'; })[0];
    if (shown) {
      var skipped = false;
      items = items.filter(function (it) {
        if (!skipped && it.kind === 'Alert' && it.label === 'Open ' + shown.id) { skipped = true; return false; }
        return true;
      });
    }
    var SHOW = 6;
    var rows = items.slice(0, SHOW).map(function (it) {
      return needsYouRow(it.kind + ': ' + it.text, A.link(it.label, it.route, it.rest, it.params));
    });
    if (items.length > SHOW) {
      rows.push(el('div.row', [
        el('span.muted', { text: fmt.num(items.length - SHOW) + ' more in the inbox.' }),
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
      return el('div.feed-row', [
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
      }))
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

  function renderSample(mount) {
    var summary = 'Figures as of ' + fmt.stamp(new Date(d.now)) + '. The tiles below link to each screen.';

    mount.appendChild(ui.pageHeader('Overview', summary, [
      ui.btn('Open runbooks', {
        variant: 'ghost',
        onClick: function () { A.go('ops'); }
      })
    ]));

    mount.appendChild(heroBand());
    mount.appendChild(tiles());
    mount.appendChild(el('div.grid.grid-3', [needsYouCard(), activityCard(), sitesCard()]));
    mount.appendChild(el('div.grid.grid-4', [trafficCard(), reconcilerCard(), healthCard(), recentCard()]));
  }

  function readWord(env) {
    return env && env.at ? 'read ' + fmt.stamp(new Date(env.at)).slice(11) : 'not read';
  }

  function readSentence(env) {
    var w = readWord(env);
    return w.charAt(0).toUpperCase() + w.slice(1) + '.';
  }

  function agoLive(iso) {
    var t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!isFinite(t)) return 'at an unknown time';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  function gb(bytes) {
    if (typeof bytes !== 'number') return '-';
    return fmt.num(bytes / 1073741824, 1) + ' GB';
  }

  function readAll(paths, ttlMs) {
    return Promise.all(paths.map(function (p) { return A.read(p, { ttlMs: ttlMs === undefined ? 10000 : ttlMs }); }));
  }

  function stillHere() {
    var alive = true;
    A.onLeave(function () { alive = false; });
    return function () { return alive; };
  }

  function liveTile(label, paths, build, opts) {
    opts = opts || {};
    var node = ui.statTile(label, '…', { note: 'Reading the console API', href: opts.href, title: opts.title });
    var alive = stillHere();
    readAll(paths).then(function (envs) {
      if (!alive() || !node.parentNode) return;
      var failed = null;
      envs.forEach(function (env) { if (!failed && !env.ok) failed = env; });
      var spec;
      if (failed) {
        var e = failed.error || {};
        spec = e.reason === 'not-configured'
          ? { value: 'not configured', note: opts.notConfigured || e.message || 'This reader has no upstream in this stack.' }
          : { value: '-', note: 'Could not be read: ' + (e.message || 'the request failed.') };
      } else {
        spec = build(envs.map(function (env) { return env.data || {}; }), envs);
      }
      var fresh = ui.statTile(label, spec.value, {
        unit: spec.unit,
        note: (spec.note ? spec.note + '. ' : '') + readWord(failed || envs[0]),
        href: opts.href,
        title: opts.title
      });
      node.parentNode.replaceChild(fresh, node);
    });
    return node;
  }

  var MONITOR_RANK = { 0: 0, 2: 1, 3: 3, 1: 4 };
  function monitorRank(m) {
    return m.status === null || m.status === undefined ? 2 : MONITOR_RANK[m.status];
  }
  function monitorTone(status) {
    if (status === 1) return 'ok';
    if (status === 0) return 'bad';
    if (status === 3) return 'info';
    if (status === 2) return 'warn';
    return 'idle';
  }
  function monitorsOf(data) { return (data && data.monitors) || []; }
  function monitorsDown(data) { return monitorsOf(data).filter(function (m) { return m.status === 0; }); }
  function names(list) { return list.map(function (m) { return m.label || m.id; }).join(', '); }

  function liveTiles() {
    return el('div.tiles', [
      liveTile('Services working', ['/api/heartbeats'], function (datas) {
        var all = monitorsOf(datas[0]);
        var up = all.filter(function (m) { return m.status === 1 || m.status === 3; });
        var down = monitorsDown(datas[0]);
        var pending = all.filter(function (m) { return m.status === 2; });
        var unknown = all.filter(function (m) { return m.status === null || m.status === undefined; });
        var parts = [];
        if (down.length) parts.push('down: ' + names(down));
        if (pending.length) parts.push('retrying: ' + names(pending));
        if (unknown.length) parts.push(fmt.num(unknown.length) + ' not yet checked');
        return { value: fmt.num(up.length) + ' of ' + fmt.num(all.length), note: parts.length ? parts.join('; ') : 'Every monitored service answered' };
      }, { href: A.href('stack'), title: 'Open the stack heartbeats' }),
      liveTile('Open alerts', ['/api/alerts/active'], function (datas) {
        var list = datas[0].alerts || [];
        var worst = list[0];
        return {
          value: fmt.num(list.length),
          note: !worst ? 'Alertmanager reports nothing active'
            : worst.severity !== 'none' ? 'Worst severity: ' + worst.severity
              : 'Severity label "' + ((worst.labels || {}).severity || 'none') + '", not ranked'
        };
      }, { href: A.href('security', ['alerts']), title: 'Open the alerts', notConfigured: 'Alertmanager is not configured for this console' }),
      liveTile('Declared applications', ['/api/gitops/apps'], function (datas) {
        var apps = datas[0].apps || [];
        var tiers = {};
        apps.forEach(function (a) { var t = a.tier === null || a.tier === undefined ? 'untiered' : 'tier ' + a.tier; tiers[t] = (tiers[t] || 0) + 1; });
        var breakdown = Object.keys(tiers).sort().map(function (t) { return t + ': ' + fmt.num(tiers[t]); }).join(', ');
        var problems = (datas[0].problems || []).length;
        return { value: fmt.num(datas[0].count === undefined ? apps.length : datas[0].count), note: (breakdown || 'no tiers declared') + (problems ? '; ' + fmt.num(problems) + ' directory without a spec' : '') };
      }, { href: A.href('apps'), title: 'Open Applications', notConfigured: 'No GitOps directory is configured for this console' }),
      liveTile('Containers running', ['/api/containers'], function (datas) {
        return { value: fmt.num(datas[0].running) + ' of ' + fmt.num(datas[0].count), note: 'Read through the Docker socket proxy' };
      }, { href: A.href('stack'), title: 'Open the stack', notConfigured: 'The Docker socket proxy is not configured for this console' }),
      liveTile('Host CPU now', ['/api/host'], function (datas) {
        var c = datas[0].cpu || {};
        return { value: fmt.pct((c.usageRatio || 0) * 100, 0), note: fmt.num(c.cores) + ' cores on ' + (datas[0].hostname || 'this host') };
      }, { href: A.href('system'), title: 'Open the host' }),
      liveTile('Host memory now', ['/api/host'], function (datas) {
        var m = datas[0].memory || {};
        return { value: fmt.pct((m.usageRatio || 0) * 100, 0), note: gb(m.usedBytes) + ' of ' + gb(m.totalBytes) + ' in use' };
      }, { href: A.href('system'), title: 'Open the host' }),
      liveTile('Console API up for', ['/api/health', '/api/capabilities'], function (datas) {
        var caps = datas[1] || {};
        return { value: fmt.dur(datas[0].uptimeSeconds || 0), note: caps.writesAllowed ? 'Writes are allowed' : 'Read-only: writes are refused' };
      }, { href: A.href('system'), title: 'Open the host and console' })
    ]);
  }

  function alertSentence(a) {
    var where = (a.labels || {}).host || (a.labels || {}).instance;
    return (a.name || 'an unnamed alert') + (a.summary ? ': ' + a.summary : '') + (where ? ' (' + where + ')' : '') +
      (a.startsAt ? ', firing since ' + agoLive(a.startsAt) : '');
  }

  function liveHero() {
    var box = el('div');
    var alive = stillHere();
    readAll(['/api/alerts/active', '/api/heartbeats']).then(function (envs) {
      if (!alive()) return;
      var alerts = envs[0], beats = envs[1];
      var crit = alerts.ok ? (alerts.data.alerts || []).filter(function (a) { return a.severity === 'critical'; }) : [];
      var down = beats.ok ? monitorsDown(beats.data) : [];
      var out;
      if (crit.length) {
        out = el('div.callout.bad', [
          el('strong', { text: 'A critical alert is active: ' + crit[0].name + '.' }),
          el('p', { text: 'Alertmanager reports ' + alertSentence(crit[0]) + '.' + (crit.length > 1 ? ' ' + fmt.num(crit.length - 1) + ' other critical alert' + (crit.length === 2 ? ' is' : 's are') + ' also active.' : '') + ' Alerts ' + readWord(alerts) + '.' }),
          A.link('Open the alerts in Security', 'security', ['alerts'])
        ]);
      } else if (down.length) {
        var m = down[0];
        out = el('div.callout.bad', [
          el('strong', { text: (m.label || m.id) + ' is down.' }),
          el('p', { text: 'The console heartbeat for ' + (m.label || m.id) + ' has failed ' + fmt.num(m.consecutiveFailures) + ' time' + (m.consecutiveFailures === 1 ? '' : 's') + ' in a row' + (m.message ? ': ' + m.message : '.') + (down.length > 1 ? ' Also down: ' + names(down.slice(1)) + '.' : '') + ' Heartbeats ' + readWord(beats) + '.' }),
          A.link('Open the stack heartbeats', 'stack')
        ]);
      } else if (!beats.ok && !alerts.ok) {
        out = el('div.callout.warn', [
          el('strong', { text: 'Nothing could be checked.' }),
          el('p', { text: 'Neither the heartbeats nor Alertmanager answered: ' + ((beats.error || {}).message || 'no reason given') + ' ' + ((alerts.error || {}).message || '') })
        ]);
      } else {
        var all = beats.ok ? monitorsOf(beats.data) : [];
        var pending = all.filter(function (m) { return m.status === 2; });
        var checked = beats.ok ? fmt.num(all.length) + ' service monitor' + (all.length === 1 ? '' : 's') + (all.length ? ' (' + names(all) + ')' : '') + (pending.length ? ', of which ' + fmt.num(pending.length) + (pending.length === 1 ? ' is' : ' are') + ' still retrying' : '') : 'no heartbeat monitor (' + ((beats.error || {}).message || 'unreadable') + ')';
        var alertWord = alerts.ok
          ? 'Alertmanager, which reports ' + fmt.num((alerts.data.alerts || []).length) + ' active alert' + ((alerts.data.alerts || []).length === 1 ? '' : 's') + ', none critical'
          : 'not Alertmanager, which is ' + ((alerts.error || {}).reason === 'not-configured' ? 'not configured' : 'unreadable');
        out = el('div.callout.ok', [
          el('strong', { text: 'Nothing is failing.' }),
          el('p', { text: 'Checked ' + checked + ' and ' + alertWord + '. ' + readSentence(beats.ok ? beats : alerts) })
        ]);
      }
      ui.clear(box);
      box.appendChild(out);
    });
    box.appendChild(ui.skeleton(2));
    return box;
  }

  function alertWord(a) {
    if (a.severity && a.severity !== 'none') return 'Alert, ' + a.severity;
    var raw = (a.labels || {}).severity;
    return raw ? 'Alert, label "' + raw + '"' : 'Alert';
  }

  function liveNeedsYou() {
    var body = el('div', [ui.skeleton(3)]);
    var alive = stillHere();
    readAll(['/api/alerts/active', '/api/heartbeats', '/api/gitops/apps', '/api/secrets/seal-status']).then(function (envs) {
      if (!alive()) return;
      var alerts = envs[0], beats = envs[1], apps = envs[2], seal = envs[3];
      var urgent = [], rest = [], later = [], unchecked = [], checked = [];
      function skipped(env, what) {
        var e = env.error || {};
        unchecked.push(what + ' (' + (e.reason === 'not-configured' ? 'not configured' : e.message || 'unreadable') + ')');
      }
      if (alerts.ok) {
        checked.push('Alertmanager');
        (alerts.data.alerts || []).forEach(function (a) {
          var row = needsYouRow(alertWord(a) + ': ' + alertSentence(a), A.link('Open alerts', 'security', ['alerts']));
          (a.severity === 'critical' || a.severity === 'high' ? urgent : later).push(row);
        });
      } else skipped(alerts, 'Alertmanager');
      if (beats.ok) {
        checked.push('service heartbeats');
        monitorsDown(beats.data).forEach(function (m) {
          rest.push(needsYouRow('Service: ' + (m.label || m.id) + ' is down' + (m.message ? ', ' + m.message : '.'), A.link('Open the stack', 'stack')));
        });
      } else skipped(beats, 'service heartbeats');
      if (seal.ok && seal.data.configured === false) {
        unchecked.push('the OpenBao seal (not configured)');
      } else if (seal.ok) {
        checked.push('the OpenBao seal');
        var sb = seal.data.sandbox || {};
        if (sb.verdict === true) {
          rest.push(needsYouRow('Secrets: ' + (sb.title || 'the vault has a sandbox seal.') + (sb.basis ? ' (' + sb.basis + ')' : ''), A.link('Open the stack', 'stack')));
        } else if (sb.verdict === null && seal.data.configured !== false) {
          rest.push(needsYouRow('Secrets: ' + (sb.title || 'the unseal posture has not been verified.'), A.link('Open the stack', 'stack')));
        }
      } else skipped(seal, 'the OpenBao seal');
      if (apps.ok) {
        checked.push('GitOps declarations');
        (apps.data.problems || []).forEach(function (p) {
          rest.push(needsYouRow('Declaration: ' + p.directory + ' ' + p.message, A.link('Open Applications', 'apps')));
        });
      } else skipped(apps, 'GitOps declarations');

      var rows = urgent.concat(rest, later);
      var SHOW = 8;
      ui.clear(body);
      if (rows.length) {
        body.appendChild(el('div.stack', rows.slice(0, SHOW)));
        if (rows.length > SHOW) {
          body.appendChild(el('div.row', [
            el('span.muted', { text: fmt.num(rows.length - SHOW) + ' more.' }),
            A.link('Open the alerts', 'security', ['alerts'])
          ]));
        }
      } else {
        body.appendChild(ui.emptyState('Nothing is waiting for you', 'Checked ' + (checked.length ? checked.join(', ') : 'nothing') + ': no active alert, no monitor down, no sandbox seal and no declaration without a spec.'));
      }
      body.appendChild(el('p.hint', {
        text: readSentence(envs.filter(function (e) { return e.ok; })[0] || envs[0]) +
          (unchecked.length ? ' Not checked: ' + unchecked.join('; ') + '.' : '')
      }));
    });
    return ui.card('Needs you', body);
  }

  function auditWho(ev) {
    return ev.subject ? ev.subject : 'Somebody';
  }

  function liveAuditSentence(ev) {
    var who = auditWho(ev);
    var from = ev.sourceAddress ? ' from ' + ev.sourceAddress : '';
    var why = ev.reason ? ' (' + ev.reason + ')' : '';
    switch (ev.event) {
      case 'auth.login.succeeded': return who + ' signed in' + from + '.';
      case 'auth.login.failed': return 'A sign-in as ' + who + from + ' failed' + why + '.';
      case 'auth.login.throttled': return 'A sign-in as ' + who + from + ' was throttled' + why + '.';
      case 'auth.logout': return who + ' signed out' + from + '.';
      case 'auth.account.locked': return 'The account ' + who + ' was locked' + why + '.';
      case 'auth.denied': return 'A request' + (ev.path ? ' to ' + ev.path : '') + from + ' was refused' + why + '.';
      case 'auth.csrf.rejected': return 'A request' + (ev.path ? ' to ' + ev.path : '') + from + ' was rejected without the console header.';
      case 'auth.session.expired.idle': return 'The session of ' + who + ' expired after idling.';
      case 'auth.session.expired.absolute': return 'The session of ' + who + ' reached its absolute limit.';
      case 'auth.session.renewed': return 'The session of ' + who + ' was renewed.';
      case 'auth.session.evicted': return 'A session of ' + who + ' was evicted' + why + '.';
      case 'auth.session.rejected': return 'A session cookie' + from + ' was rejected' + why + '.';
      case 'auth.session.anomaly': return 'A session of ' + who + ' changed address or agent' + why + '.';
      case 'auth.config.rejected': return 'The console started with ' + (ev.detail ? ev.detail : 'an auth configuration it would not accept') + '';
      default: return who + ': ' + String(ev.event || 'event').split('.').join(' ') + (ev.outcome ? ', ' + ev.outcome : '') + '.';
    }
  }

  function liveActivity() {
    return A.livePanel('Recent activity', '/api/audit/recent?limit=8', function (body, data, env) {
      var events = data.events || [];
      if (!events.length) {
        body.appendChild(ui.emptyState('No event yet', 'The console API has recorded nothing since it started.'));
      } else {
        body.appendChild(el('div.stack', events.map(function (ev) {
          return el('div.feed-row', [
            el('span', { text: liveAuditSentence(ev) }),
            el('time', { datetime: ev.ts, title: ev.ts, text: agoLive(ev.ts) })
          ]);
        })));
      }
      body.appendChild(el('p.hint', {
        text: 'Held in memory since the API started ' + (data.since ? agoLive(data.since) : '') + ': ' + fmt.num(data.total || events.length) + ' event' + (data.total === 1 ? '' : 's') +
          (data.dropped ? ', ' + fmt.num(data.dropped) + ' dropped' : '') + '. ' + readSentence(env)
      }));
      body.appendChild(el('div.row', A.link('All audit events', 'audit')));
    }, { ttlMs: 5000, skeletonRows: 8, errorTitle: 'The audit ring could not be read' });
  }

  function liveHealth() {
    return A.livePanel('Service health', '/api/heartbeats', function (body, data, env) {
      var monitors = monitorsOf(data).slice().sort(function (a, b) { return monitorRank(a) - monitorRank(b); });
      if (!monitors.length) {
        body.appendChild(ui.emptyState('No monitor is being recorded', 'The console API is watching nothing.'));
        return;
      }
      body.appendChild(el('div.stack', monitors.map(function (m) {
        var beats = m.beats || [];
        return el('div.healthrow', [
          A.link(m.label || m.id, 'stack'),
          ui.heartbeatBar(beats, { slots: 30, width: 200, height: 16, label: ui.heartbeatSentence(beats, { name: m.label || m.id }) }),
          ui.pill(m.statusName || 'unknown', monitorTone(m.status))
        ]);
      })));
      body.appendChild(el('p.hint', {
        text: 'One slot per check, oldest left, worst at the top. Held in memory since ' + (data.startedAt ? agoLive(data.startedAt) : 'the API started') + '; ' + readWord(env) + '.'
      }));
    }, { ttlMs: 5000, skeletonRows: 5, errorTitle: 'The heartbeats could not be read' });
  }

  function liveSites() {
    return ui.card('Sites', [
      A.notInStack('The two-site topology', 'This stack is one machine. There is no second site, no link check and no replication lag to show.')
    ]);
  }

  function liveTraffic() {
    return ui.card('Traffic, last 24 hours', [
      A.notInStack('Per-application request rates', 'The declared applications are not deployed in this stack, so no request rate is measured for them.')
    ]);
  }

  function liveReconciler() {
    return ui.card('Reconciler', [
      A.notInStack('The reconciler', 'No reconciler runs in this stack. The GitOps directory holds declarations that nothing has applied.')
    ]);
  }

  function renderLive(mount) {
    mount.appendChild(ui.pageHeader('Overview', 'Every panel reads the console API and says when it was read. A panel whose source does not exist in this stack says so instead of showing a figure.', [
      ui.btn('Open runbooks', {
        variant: 'ghost',
        onClick: function () { A.go('ops'); }
      })
    ]));
    mount.appendChild(liveHero());
    mount.appendChild(liveTiles());
    mount.appendChild(el('div.grid.grid-3', [liveNeedsYou(), liveActivity(), liveSites()]));
    mount.appendChild(el('div.grid.grid-4', [liveTraffic(), liveReconciler(), liveHealth(), recentCard()]));
  }

  var screen = {
    title: 'Overview',
    crumb: 'Overview',
    render: function (mount) {
      var mode = A.storeMode();
      if (mode === A.MODE.SAMPLE) { renderSample(mount); return; }
      if (mode === A.MODE.LIVE) { renderLive(mount); return; }
      var host = el('div');
      mount.appendChild(host);
      A.whenProbed(function (now) {
        if (now === A.MODE.LIVE) renderLive(host);
        else renderSample(host);
      });
    }
  };

  if (typeof A.screen === 'function') A.screen('overview', screen);
  else document.addEventListener('DOMContentLoaded', function () { A.screen('overview', screen); });
})();
