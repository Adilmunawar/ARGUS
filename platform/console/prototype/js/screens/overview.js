(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt, d = A.data;

  var SHOW = 5;
  var SHOW_LIVE = 8;
  var NEED_WORD = { bad: 'Urgent', warn: 'Attention', info: 'Review' };

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

  function mono(text) { return el('span.mono', { text: String(text) }); }

  function plural(n, one, many) { return fmt.num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }

  function nb(t) { return String(t).replace(/ /g, '\u00a0'); }

  function sentence(t) { return t.charAt(0).toUpperCase() + t.slice(1) + '.'; }

  function grid() {
    return el('div.grid', Array.prototype.slice.call(arguments));
  }

  function setCounter(card, n) {
    var row = card.querySelector('.card-titlerow');
    if (!row) return;
    var c = row.querySelector('.card-counter');
    if (!c) { c = el('span.card-counter'); row.appendChild(c); }
    c.textContent = '(' + fmt.num(n) + ')';
  }

  function heroLine(tone, kind, title, rest, link) {
    return el('div.callout.' + tone, { 'data-hero': kind }, [
      el('span', [el('b', { text: title }), rest ? ' ' + rest : null]),
      link ? ' ' : null,
      link || null
    ]);
  }

  function heroBand() {
    var critical = openAlerts().filter(function (a) { return a.severity === 'critical'; });
    if (!critical.length) return null;
    var a = critical[0];
    return heroLine('bad', 'critical', 'Critical alert: ' + a.rule,
      'on ' + a.host + ', fired ' + plural(a.count, 'time') + (critical.length > 1 ? ', ' + fmt.num(critical.length - 1) + ' more critical' : '') + '.',
      A.link('View alerts', 'security', ['alerts'], { id: a.id }));
  }

  function tiles() {
    var healthy = countBy(d.apps, function (app) { return app.health === 'ok'; });
    var degraded = d.apps.length - healthy;
    var back = oldestBackup();
    var open = openAlerts().slice().sort(bySeverity);
    var critical = countBy(open, function (a) { return a.severity === 'critical'; });
    var awaiting = awaitingDeployments();
    var oldest = awaiting.slice().sort(function (a, b) { return a.opened - b.opened; })[0];

    return el('div.tiles', [
      ui.statTile('Applications', fmt.num(healthy) + ' of ' + fmt.num(d.apps.length), {
        status: degraded ? { tone: 'warn', text: plural(degraded, 'degraded', 'degraded') } : { tone: 'ok', text: 'All healthy' },
        link: 'View applications', href: A.href('apps'), title: 'Open Applications'
      }),
      ui.statTile('Open alerts', fmt.num(open.length), {
        status: critical ? { tone: 'bad', text: fmt.num(critical) + ' critical' } : open.length ? { tone: 'warn', text: 'Worst: ' + open[0].severity } : { tone: 'ok', text: 'None open' },
        link: 'View alerts', href: A.href('security', ['alerts']), title: 'Open the alerts'
      }),
      ui.statTile('Awaiting approval', fmt.num(awaiting.length), {
        status: awaiting.length ? { tone: 'pending', text: 'Oldest ' + fmt.ago(oldest.opened) } : { tone: 'ok', text: 'Queue empty' },
        link: 'View deployments', href: A.href('deploys'), title: 'Open the deployment queue'
      }),
      ui.statTile('Oldest backup', fmt.ago(back.last), {
        note: back.store + ', ' + back.cadence,
        link: 'View backups', href: A.href('ops', ['backups']), title: 'Open backups and drills'
      })
    ]);
  }

  function needsTable(items, caption) {
    return ui.table([
      { key: 'text', label: 'Item', sortable: false, render: function (r) { return el('a.rlink', { href: A.href(r.route, r.rest, r.params), title: r.label, 'data-action': r.label, text: r.text.replace(/.$/, '') }); } },
      { key: 'tone', label: 'Severity', status: true, sortable: false, render: function (r) { return ui.status(r.tone, NEED_WORD[r.tone] || 'Review'); } },
      { key: 'kind', label: 'Source', sortable: false }
    ], items, {
      caption: caption,
      rowKey: function (r) { return r.kind + ':' + r.text; },
      emptyTitle: 'Nothing needs attention',
      empty: 'No incident, approval, alert or expiry is waiting.'
    });
  }

  function inboxFooter(total) {
    if (total <= SHOW) return null;
    return [ui.btn('View all ' + fmt.num(total) + ' in the inbox', { variant: 'link', onClick: function () { A.inbox(); } })];
  }

  function needsCard() {
    var items = typeof A.needsYou === 'function' ? A.needsYou() : [];
    var shown = openAlerts().filter(function (a) { return a.severity === 'critical'; })[0];
    if (shown) {
      var skipped = false;
      items = items.filter(function (it) {
        if (!skipped && it.kind === 'Alert' && it.label === 'Open ' + shown.id) { skipped = true; return false; }
        return true;
      });
    }
    items = dedupe(items);
    var card = ui.card('Needs attention', needsTable(items.slice(0, SHOW), 'Items that need an operator, most urgent first'), {
      counter: items.length, footer: inboxFooter(items.length)
    });
    card.setAttribute('data-panel', 'needs');
    return card;
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
      return { app: app, beats: beats, uptime: ui.uptimeOf(beats, {}).ratio };
    });
    var card = ui.card('Service health', ui.table([
      { key: 'name', label: 'Name', sortable: false, render: function (r) { return A.link(r.app.display, 'apps', [r.app.name]); } },
      { key: 'health', label: 'Status', status: true, sortable: false, render: function (r) { return ui.status(r.app.health === 'ok' ? 'ok' : 'warn', r.app.health === 'ok' ? 'Healthy' : 'Degraded'); } },
      { key: 'beats', label: 'Last 30 days', sortable: false, render: function (r) { return ui.heartbeatBar(r.beats, { slots: 30, width: 150, height: 16, label: r.app.display + ': ' + ui.heartbeatSentence(r.beats, { windowWord: 'the last 30 days' }) }); } },
      { key: 'uptime', label: 'Uptime', align: 'right', sortable: false, render: function (r) { return fmt.pct(r.uptime * 100, 1); } },
      { key: 'rps', label: 'Req/s', align: 'right', sortable: false, render: function (r) { return fmt.num(r.app.rps); } }
    ], rows, {
      caption: 'Service health over 30 days, worst first',
      rowKey: function (r) { return r.app.name; }
    }), { counter: rows.length, footer: [A.link('View applications', 'apps')] });
    card.setAttribute('data-panel', 'health');
    return card;
  }

  function activityCard() {
    var rows = d.audit.slice(0, 4);
    var card = ui.card('Recent activity', ui.table([
      { key: 'at', label: 'Time', sortable: false, render: function (r) { return el('time', { datetime: r.at.toISOString(), title: fmt.stamp(r.at), text: nb(fmt.ago(r.at)) }); } },
      { key: 'actor', label: 'Operator', sortable: false, render: function (r) { return A.personName(r.actor); } },
      { key: 'action', label: 'Event', sortable: false, render: function (r) { return el('div.col', [eventNode(r.action), el('span.muted', { text: r.target + (r.pr ? ' (' + r.pr + ')' : '') })]); } }
    ], rows, {
      caption: 'The four most recent audit events',
      rowKey: function (r) { return String(r.at.getTime()) + r.action + r.target; },
      emptyTitle: 'No events'
    }), { footer: [A.link('View audit log', 'audit')] });
    card.setAttribute('data-panel', 'activity');
    return card;
  }

  function platformCard() {
    var r = d.reconciler;
    var worstSlo = d.apps.slice().sort(function (a, b) { return a.slo - b.slo; })[0];
    var findings = typeof A.advisorFindings === 'function' ? A.advisorFindings().filter(function (f) { return !f.suppressed; }) : [];
    var urgent = countBy(findings, function (f) { return f.severity === 'critical' || f.severity === 'high'; });
    var card = ui.card('Platform', ui.dl([
      ['Reconciler', ui.status(r.state === 'running' ? 'ok' : 'warn', r.state === 'running' ? 'Running' : r.state)],
      ['Last sync', fmt.time(r.lastSync)],
      ['Drift', r.drift > 0 ? ui.status('warn', plural(r.drift, 'resource') + ' adrift') : ui.status('ok', 'None')],
      ['Pending plans', fmt.num(r.pendingPlans)],
      ['Lowest SLO', A.link(fmt.pct(worstSlo.slo, 2) + ', ' + worstSlo.display, 'apps', [worstSlo.name, 'budget'])],
      ['Advisor findings', A.link(fmt.num(findings.length) + (urgent ? ', ' + fmt.num(urgent) + ' critical or high' : ''), 'advisor')]
    ]));
    card.setAttribute('data-panel', 'platform');
    return card;
  }

  function linkUptime(site) {
    var day = ui.uptimeOf(site.checks || [], { windowMs: 86400000, now: d.now.getTime() });
    return day.ratio === null ? null : day.ratio;
  }

  function sitesCard() {
    var card = ui.card('Sites', ui.table([
      { key: 'name', label: 'Name', sortable: false, render: function (s) { return el('span', { title: s.location + ', ' + s.role, text: s.name }); } },
      { key: 'link', label: 'Link', status: true, sortable: false, render: function (s) { return ui.status(s.link === 'up' ? 'ok' : 'bad', s.link === 'up' ? 'Up' : 'Down'); } },
      { key: 'latencyMs', label: 'Latency', align: 'right', sortable: false, render: function (s) { return fmt.ms(s.latencyMs); } },
      { key: 'replicationLagS', label: 'Lag', align: 'right', sortable: false, render: function (s) { return fmt.dur(s.replicationLagS); } },
      {
        key: 'checks', label: 'Link, 24 h', align: 'right', sortable: false,
        render: function (s) {
          var beats = s.checks || [];
          var up = linkUptime(s);
          return el('span.num', { title: ui.heartbeatSentence(beats, { name: s.name + ' link', windowMs: 86400000, windowWord: 'the last 24 hours', now: d.now.getTime() }), text: up === null ? '-' : fmt.pct(up * 100, 1) });
        }
      }
    ], d.sites, {
      caption: 'Sites, their link and replication lag',
      rowKey: function (s) { return s.id; }
    }), { counter: d.sites.length });
    card.setAttribute('data-panel', 'sites');
    return card;
  }

  function recentCard() {
    var here = window.location.hash;
    var items = typeof A.recents === 'function' ? A.recents().filter(function (r) { return r.hash !== here && r.hash !== '#/overview'; }).slice(0, 4) : [];
    var card = ui.card('Recently visited', items.length
      ? el('div.stack', items.map(function (r) {
        return el('div.row', [
          el('a.rlink', { href: r.hash, text: r.label }),
          el('span.muted', { text: r.kind })
        ]);
      }))
      : el('p.muted', { text: 'Nothing yet.' }));
    card.setAttribute('data-panel', 'recent');
    return card;
  }

  function renderSample(mount) {
    mount.appendChild(ui.pageHeader('Overview'));
    var hero = heroBand();
    if (hero) mount.appendChild(hero);
    mount.appendChild(tiles());
    mount.appendChild(grid(
      needsCard(),
      el('div.grid.grid-2', [healthCard(), grid(activityCard(), recentCard())]),
      el('div.grid.grid-2', [platformCard(), sitesCard()])));
  }

  function readWord(env) {
    return env && env.at ? 'Read ' + fmt.clock(new Date(env.at)) : 'Not read';
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
    var node = ui.statTile(label, '-', { note: 'Reading', href: opts.href, title: opts.title, link: opts.link });
    var alive = stillHere();
    node.setAttribute('data-state', 'loading');
    A.settling(readAll(paths).then(function (envs) {
      if (!alive() || !node.parentNode) return;
      var failed = null;
      envs.forEach(function (env) { if (!failed && !env.ok) failed = env; });
      var spec;
      if (failed) {
        var e = failed.error || {};
        var st = A.envelopeState(failed);
        spec = st === 'notConfigured'
          ? { value: '-', status: { tone: 'idle', text: 'Not configured', title: opts.notConfigured || e.message || '' } }
          : st === 'forbidden'
            ? { value: '-', status: { tone: 'warn', text: 'No access' } }
            : { value: '-', status: { tone: 'bad', text: 'Read failed', title: e.message || '' } };
      } else {
        spec = build(envs.map(function (env) { return env.data || {}; }), envs);
      }
      var fresh = ui.statTile(label, spec.value, {
        unit: spec.unit,
        status: spec.status,
        note: (spec.note ? spec.note + ' · ' : '') + readWord(failed || envs[0]),
        href: opts.href,
        title: opts.title,
        link: opts.link
      });
      fresh.setAttribute('data-state', failed ? A.envelopeState(failed) : 'ok');
      node.parentNode.replaceChild(fresh, node);
    }));
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
  function monitorWord(m) {
    var w = m.statusName || 'unknown';
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function exitOf(c) {
    if (c && typeof c.exitCode === 'number') return c.exitCode;
    var m = /Exited \((-?\d+)\)/i.exec((c && c.status) || '');
    return m ? Number(m[1]) : null;
  }

  var TONE_RANK = { bad: 0, warn: 1, info: 2 };

  function subjectOf(it) {
    var t = String(it.text || '');
    var at = t.indexOf(':');
    return (at > 0 ? t.slice(0, at) : t).trim().toLowerCase();
  }

  function dedupe(items) {
    var out = [];
    var bySubject = {};
    items.forEach(function (it) {
      var key = subjectOf(it);
      var have = Object.prototype.hasOwnProperty.call(bySubject, key) ? bySubject[key] : null;
      if (have === null) { bySubject[key] = out.length; out.push(it); return; }
      var cur = out[have];
      var keep = (TONE_RANK[it.tone] === undefined ? 3 : TONE_RANK[it.tone]) < (TONE_RANK[cur.tone] === undefined ? 3 : TONE_RANK[cur.tone]) ? it : cur;
      var other = keep === it ? cur : it;
      out[have] = Object.assign({}, keep, { kind: keep.kind === other.kind ? keep.kind : keep.kind + ', ' + other.kind });
    });
    return out;
  }

  var EVENT_LABEL = {
    'auth.login.succeeded': 'Signed in',
    'auth.login.failed': 'Sign-in failed',
    'auth.login.throttled': 'Sign-in throttled',
    'auth.logout': 'Signed out',
    'auth.account.locked': 'Account locked',
    'auth.denied': 'Request refused',
    'auth.csrf.rejected': 'Request rejected',
    'auth.session.expired.idle': 'Session expired, idle',
    'auth.session.expired.absolute': 'Session expired',
    'auth.session.renewed': 'Session renewed',
    'auth.session.evicted': 'Session evicted',
    'auth.session.rejected': 'Session rejected',
    'auth.session.anomaly': 'Session anomaly',
    'auth.config.rejected': 'Configuration rejected'
  };

  var VERB = {
    approve: 'approved', open: 'opened', reject: 'rejected', start: 'started', end: 'ended', apply: 'applied',
    rollback: 'rolled back', rotate: 'rotated', raise: 'raised', acknowledge: 'acknowledged', pause: 'paused',
    deny: 'denied', revoke: 'revoked', request: 'requested', release: 'released', extend: 'extended', note: 'noted',
    mitigated: 'mitigated', resolved: 'resolved', reopen: 'reopened', lock: 'locked', unlock: 'unlocked',
    silence: 'silenced', unsilence: 'unsilenced', declare: 'declared', lift: 'lifted', override: 'overridden',
    verify: 'verified', update: 'updated', accept: 'accepted', create: 'created', delete: 'deleted', stop: 'stopped',
    restart: 'restarted', resize: 'resized', checkpoint: 'checkpointed', protect: 'protected', patch: 'patched',
    promote: 'promoted', set: 'set', materialise: 'materialised', run: 'run', drain: 'drained', quarantine: 'quarantined',
    offboard: 'offboarded', generate: 'generated'
  };

  function eventLabel(raw) {
    var name = String(raw || 'event');
    if (Object.prototype.hasOwnProperty.call(EVENT_LABEL, name)) return EVENT_LABEL[name];
    var parts = name.split('.');
    if (parts.length !== 2) return name;
    var noun = parts[0].replace(/-/g, ' ');
    var verb = Object.prototype.hasOwnProperty.call(VERB, parts[1]) ? VERB[parts[1]] : parts[1].replace(/-/g, ' ');
    return noun.charAt(0).toUpperCase() + noun.slice(1) + ' ' + verb;
  }

  function eventNode(raw) { return el('span', { title: String(raw || ''), 'data-event': String(raw || ''), text: eventLabel(raw) }); }

  function monitorsOf(data) { return (data && data.monitors) || []; }
  function monitorsDown(data) { return monitorsOf(data).filter(function (m) { return m.status === 0; }); }
  function names(list) { return list.map(function (m) { return m.label || m.id; }).join(', '); }

  function liveTiles() {
    return el('div.tiles', [
      liveTile('Services', ['/api/heartbeats'], function (datas) {
        var all = monitorsOf(datas[0]);
        var up = all.filter(function (m) { return m.status === 1 || m.status === 3; });
        var down = monitorsDown(datas[0]);
        var pending = all.filter(function (m) { return m.status === 2; });
        var status = down.length ? { tone: 'bad', text: fmt.num(down.length) + ' down', title: names(down) }
          : pending.length ? { tone: 'warn', text: fmt.num(pending.length) + ' retrying', title: names(pending) }
            : up.length === all.length ? { tone: 'ok', text: 'All up' } : { tone: 'idle', text: fmt.num(all.length - up.length) + ' not checked' };
        return { value: fmt.num(up.length) + ' of ' + fmt.num(all.length), status: status };
      }, { href: A.href('stack'), title: 'Open the Services heartbeats', link: 'View services' }),
      liveTile('Open alerts', ['/api/alerts/active'], function (datas) {
        var open = A.openAlerts(datas[0]) || { total: 0, groups: [], pagingCount: 0 };
        var worst = open.groups[0];
        return {
          value: fmt.num(open.total),
          status: !worst ? { tone: 'ok', text: 'None firing' }
            : open.pagingCount ? { tone: 'bad', text: fmt.num(open.pagingCount) + ' paging' } : { tone: 'warn', text: fmt.num(open.total) + ' firing' },
          note: worst ? 'Worst: ' + worst.name : null
        };
      }, { href: A.href('security', ['alerts']), title: 'Open the alerts', link: 'View alerts', notConfigured: 'Alertmanager is not configured for this console' }),
      liveTile('Containers', ['/api/containers'], function (datas) {
        var list = datas[0].containers || [];
        var running = datas[0].running === undefined ? list.filter(function (c) { return c.state === 'running'; }).length : datas[0].running;
        var done = list.filter(function (c) { return c.state === 'exited' && exitOf(c) === 0; }).length;
        var failed = list.filter(function (c) { return c.state !== 'running' && !(c.state === 'exited' && exitOf(c) === 0); }).length;
        return {
          value: fmt.num(running), unit: 'running',
          status: failed ? { tone: 'bad', text: fmt.num(failed) + ' stopped or failed' } : { tone: 'ok', text: 'None failed' },
          note: done ? fmt.num(done) + ' completed' : null
        };
      }, { href: A.href('stack'), title: 'Open Services', link: 'View containers', notConfigured: 'The Docker socket proxy is not configured for this console' }),
      liveTile('Host CPU', ['/api/host'], function (datas) {
        var c = datas[0].cpu || {};
        var m = datas[0].memory || {};
        var ratio = c.usageRatio || 0;
        return {
          value: fmt.pct(ratio * 100, 0),
          status: ratio >= 0.9 ? { tone: 'bad', text: 'Saturated' } : ratio >= 0.75 ? { tone: 'warn', text: 'Busy' } : null,
          note: 'Memory ' + fmt.pct((m.usageRatio || 0) * 100, 0) + ' on ' + (datas[0].hostname || 'this host')
        };
      }, { href: A.href('system'), title: 'Open the host', link: 'View host' })
    ]);
  }

  function liveHero() {
    var box = el('div');
    var alive = stillHere();
    A.settling(readAll(['/api/alerts/active', '/api/heartbeats']).then(function (envs) {
      if (!alive()) return;
      var alerts = envs[0], beats = envs[1];
      var open = A.openAlerts(alerts);
      var paging = open ? open.paging : [];
      var firing = open ? open.groups : [];
      var down = beats.ok ? monitorsDown(beats.data) : [];
      var out;
      function groupWord(g) { return g.name + (g.count > 1 ? ' (' + fmt.num(g.count) + ' firing)' : ''); }
      if (paging.length) {
        var parts = [];
        if (paging.length > 1) parts.push(fmt.num(paging.length - 1) + ' more paging');
        if (down.length) parts.push(plural(down.length, 'service') + ' down');
        out = heroLine('bad', 'paging', 'Paging: ' + groupWord(paging[0]), parts.length ? sentence(parts.join(', ')) : null,
          A.link('View alerts', 'security', ['alerts'], { alert: paging[0].name }));
      } else if (down.length) {
        var m = down[0];
        out = heroLine('bad', 'down', (m.label || m.id) + ' is down', down.length > 1 ? fmt.num(down.length - 1) + ' more down.' : null, A.link('View services', 'stack'));
      } else if (firing.length) {
        out = heroLine('warn', 'firing', 'Firing: ' + groupWord(firing[0]), firing.length > 1 ? fmt.num(firing.length - 1) + ' more, none paging.' : 'Not paging.',
          A.link('View alerts', 'security', ['alerts'], { alert: firing[0].name }));
      } else if (!beats.ok && !alerts.ok) {
        out = heroLine('warn', 'unchecked', 'Nothing could be checked', 'Neither the heartbeats nor Alertmanager answered.', null);
      } else if (!open) {
        var astate = A.envelopeState(alerts);
        out = heroLine('info', 'unchecked', 'No monitor is down, but alerts were not checked',
          'Alertmanager is ' + (astate === 'notConfigured' ? 'not configured' : astate === 'forbidden' ? 'closed to your role' : 'unreadable') + '.', null);
      } else {
        out = heroLine('ok', 'ok', 'Nothing is failing', fmt.num(monitorsOf(beats.data).length) + ' services up, no alert firing.', null);
      }
      ui.clear(box);
      box.appendChild(out);
    }));
    return box;
  }

  function liveNeedsYou() {
    var card = ui.card('Needs attention', ui.skeleton(3));
    var body = card.querySelector('.card-body');
    card.setAttribute('data-panel', 'needs');
    var alive = stillHere();
    A.settling(A.liveNeedsYou().then(function (r) {
      if (!alive()) return;
      ui.clear(body);
      var items = dedupe(r.items);
      setCounter(card, items.length);
      body.appendChild(needsTable(items.slice(0, SHOW_LIVE), 'Items that need an operator, most urgent first'));
      var foot = el('div.card-foot', [
        el('span.readstamp', { text: readWord(r.envs.filter(function (e) { return e.ok; })[0] || r.envs[0]) }),
        r.unchecked.length ? el('span.muted', { 'data-unchecked': r.unchecked.join('; '), text: ' · Not checked: ' + r.unchecked.join('; ') }) : null,
        items.length > SHOW_LIVE ? el('span', [' ', ui.btn('View all ' + fmt.num(items.length) + ' in the inbox', { variant: 'link', onClick: function () { A.inbox(); } })]) : null
      ]);
      card.appendChild(foot);
    }));
    return card;
  }

  function liveActivity() {
    var card = A.livePanel('Recent activity', '/api/audit/recent?limit=8', function (body, data) {
      var events = data.events || [];
      setCounter(card, data.total || events.length);
      body.appendChild(ui.table([
        { key: 'ts', label: 'Time', sortable: false, render: function (ev) { return el('time', { datetime: ev.ts, title: ev.ts, text: nb(agoLive(ev.ts)) }); } },
        { key: 'subject', label: 'Operator', sortable: false, render: function (ev) { return ev.subject || el('span.muted', { text: 'none' }); } },
        { key: 'event', label: 'Event', sortable: false, render: function (ev) { return eventNode(ev.event); } },
        { key: 'sourceAddress', label: 'Source', sortable: false, render: function (ev) { return ev.sourceAddress ? mono(ev.sourceAddress) : el('span.muted', { text: '-' }); } }
      ], events, {
        caption: 'The eight most recent audit events',
        rowKey: function (ev) { return String(ev.ts) + ev.event; },
        emptyTitle: 'No events',
        empty: 'Nothing has been recorded since the API started.'
      }));
      body.appendChild(el('p.hint', {
        text: 'In memory since the API started ' + (data.since ? agoLive(data.since) : '') + (data.dropped ? ', ' + fmt.num(data.dropped) + ' dropped' : '') + '.'
      }));
    }, { ttlMs: 5000, skeletonRows: 8, errorTitle: 'The audit ring could not be read', card: { footer: [A.link('View audit log', 'audit')] } });
    card.setAttribute('data-panel', 'activity');
    return card;
  }

  function liveHealth() {
    var card = A.livePanel('Service health', '/api/heartbeats', function (body, data) {
      var monitors = monitorsOf(data).slice().sort(function (a, b) { return monitorRank(a) - monitorRank(b); });
      setCounter(card, monitors.length);
      body.appendChild(ui.table([
        { key: 'label', label: 'Name', sortable: false, render: function (m) { return A.link(m.label || m.id, 'stack'); } },
        { key: 'status', label: 'Status', status: true, sortable: false, render: function (m) { return ui.status(monitorTone(m.status), monitorWord(m)); } },
        { key: 'beats', label: 'Recent checks', sortable: false, render: function (m) { var beats = m.beats || []; return ui.heartbeatBar(beats, { slots: 30, width: 150, height: 16, label: ui.heartbeatSentence(beats, { name: m.label || m.id }) }); } }
      ], monitors, {
        caption: 'Service heartbeats, worst first',
        rowKey: function (m) { return String(m.id); },
        emptyTitle: 'No monitors',
        empty: 'The console API is watching nothing.'
      }));
    }, { ttlMs: 5000, skeletonRows: 5, errorTitle: 'The heartbeats could not be read', card: { footer: [A.link('View services', 'stack')] } });
    card.setAttribute('data-panel', 'health');
    return card;
  }

  function livePlatform() {
    var card = ui.card('Platform', ui.skeleton(4));
    var body = card.querySelector('.card-body');
    card.setAttribute('data-panel', 'platform');
    var alive = stillHere();
    var paths = ['/api/gitops/apps', '/api/host', '/api/health', '/api/capabilities'];
    A.settling(readAll(paths).then(function (envs) {
      if (!alive()) return;
      var apps = envs[0], host = envs[1], health = envs[2], caps = envs[3];
      function unread(env) {
        var st = A.envelopeState(env);
        return ui.status(st === 'notConfigured' ? 'idle' : st === 'forbidden' ? 'warn' : 'bad', st === 'notConfigured' ? 'Not configured' : st === 'forbidden' ? 'No access' : 'Read failed');
      }
      var appList = apps.ok ? (apps.data.apps || []) : [];
      var tiers = {};
      appList.forEach(function (a) { var t = a.tier === null || a.tier === undefined ? 'untiered' : 'tier ' + a.tier; tiers[t] = (tiers[t] || 0) + 1; });
      var breakdown = Object.keys(tiers).sort().map(function (t) { return t + ': ' + fmt.num(tiers[t]); }).join(', ');
      var count = apps.ok ? (apps.data.count === undefined ? appList.length : apps.data.count) : null;
      var problems = apps.ok ? (apps.data.problems || []).length : 0;
      var h = host.ok ? host.data : {};
      var mem = h.memory || {};
      ui.clear(body);
      body.appendChild(ui.dl([
        ['Declared applications', apps.ok ? el('span', { 'data-count': String(count) }, [A.link(fmt.num(count), 'apps'), breakdown ? ' (' + breakdown + ')' : null]) : unread(apps)],
        ['Specs missing', apps.ok ? (problems ? ui.status('warn', fmt.num(problems)) : '0') : unread(apps)],
        ['Host', host.ok ? mono(h.hostname || 'this host') : unread(host)],
        ['CPU cores', host.ok ? fmt.num((h.cpu || {}).cores) : unread(host)],
        ['Memory', host.ok ? gb(mem.usedBytes) + ' of ' + gb(mem.totalBytes) : unread(host)],
        ['Console API uptime', health.ok ? fmt.dur(health.data.uptimeSeconds || 0) : unread(health)],
        ['Writes', caps.ok ? (caps.data.writesAllowed ? ui.status('ok', 'Allowed') : ui.status('idle', 'Read-only')) : unread(caps)]
      ]));
      body.appendChild(el('p.readstamp', { text: readWord(envs.filter(function (e) { return e.ok; })[0] || envs[0]) }));
    }));
    return card;
  }

  function liveAbsent() {
    return ui.notInStackStrip([
      { what: 'Sites.', detail: 'This stack is one machine: no second site, link check or replication lag.' },
      { what: 'Traffic.', detail: 'Per-application request rates are not measured; the declared applications are not deployed here.' },
      { what: 'Reconciler.', detail: 'Nothing applies the GitOps declarations in this stack.' }
    ]);
  }

  function renderLive(mount) {
    mount.appendChild(ui.pageHeader('Overview'));
    mount.appendChild(liveHero());
    mount.appendChild(liveTiles());
    mount.appendChild(grid(
      liveNeedsYou(),
      el('div.grid.grid-2', [liveHealth(), liveActivity()]),
      el('div.grid.grid-2', [livePlatform(), recentCard()]),
      liveAbsent()));
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

  A.screen('overview', screen);
})();
