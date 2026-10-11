(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    document.addEventListener('DOMContentLoaded', function () { A.screen(id, def); });
  }

  var CATEGORIES = [
    { id: 'security', label: 'Security', tone: 'bad', what: 'What an attacker or an auditor would find first.' },
    { id: 'resilience', label: 'Fault tolerance', tone: 'warn', what: 'What fails to come back after a host, a disk or a site is lost.' },
    { id: 'cost', label: 'Cost', tone: 'info', what: 'Capacity paid for and not used, and capacity about to run out.' },
    { id: 'performance', label: 'Performance', tone: 'warn', what: 'What is slower than its objective or its queue allows.' },
    { id: 'operations', label: 'Operations', tone: 'idle', what: 'Hygiene: patching, drills, runbooks and stale work.' }
  ];

  var SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info' };
  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

  function finding(category, severity, id, title, detail, resource, route, rest, params) {
    return {
      id: id, category: category, severity: severity, title: title, detail: detail,
      resource: resource, route: route, rest: rest || [], params: params || null
    };
  }

  function checks() {
    var d = A.data, out = [];

    d.hosts.filter(function (h) { return h.wdac === 'audit' && /^hv-/.test(h.name); }).forEach(function (h) {
      out.push(finding('security', 'high', 'wdac-' + h.name, 'WDAC is in audit mode on ' + h.name,
        'Code integrity logs what it would block and blocks nothing. A production hypervisor in audit mode runs any signed or unsigned binary.',
        h.name, 'compute', ['host', h.name]));
    });
    d.people.filter(function (p) { return p.tier <= 1 && p.mfa !== 'FIDO2'; }).forEach(function (p) {
      out.push(finding('security', 'high', 'mfa-' + p.upn, p.name + ' holds Tier ' + p.tier + ' with ' + p.mfa,
        'TOTP is phishable. Tier 0 and Tier 1 require a FIDO2 security key.', p.upn, 'identity', ['people']));
    });
    d.secrets.filter(function (s) { return s.rotatedDays > s.policyDays; }).forEach(function (s) {
      out.push(finding('security', 'medium', 'secret-' + s.path, s.path + ' is past its rotation policy',
        s.rotatedDays + ' days old against a ' + s.policyDays + ' day policy. A copy taken months ago still works.',
        s.path, 'identity', ['secrets'], { path: s.path }));
    });
    d.vulns.filter(function (v) { return v.waiver && v.waiver.until < d.now; }).forEach(function (v) {
      out.push(finding('security', 'high', 'waiver-' + v.id, 'The waiver on ' + v.id + ' has expired',
        'An expired waiver is a suppressed finding with nobody signing for it. Patch ' + v.component + ' or re-sign.',
        v.id, 'security', ['vulns']));
    });
    d.buckets.filter(function (b) { return !b.lock; }).forEach(function (b) {
      out.push(finding('security', b.name === 'argus-survey-pictures' ? 'medium' : 'low', 'lock-' + b.name, b.name + ' has no object lock',
        'Ransomware that reaches a writer identity can delete or overwrite every object. A compliance lock makes the bucket write-once for its retention.',
        b.name, 'data', ['bucket', b.name]));
    });
    d.gmsas.filter(function (g) { return g.rotatedDays > 30; }).forEach(function (g) {
      out.push(finding('security', 'low', 'gmsa-' + g.name, g.name + ' password is ' + g.rotatedDays + ' days old',
        'Active Directory rotates a gMSA password every 30 days. Older than that means the rotation is not happening.',
        g.name, 'identity', ['gmsas']));
    });
    d.alerts.filter(function (a) { return A.alertOpen(a) && a.severity === 'critical' && (d.now - a.first) > 30 * 60000; }).forEach(function (a) {
      out.push(finding('security', 'critical', 'alert-' + a.id, 'Critical alert ' + a.id + ' unacknowledged for ' + fmt.ago(a.first).replace(' ago', ''),
        a.rule + ' on ' + a.host + ' has fired ' + a.count + ' times and nobody has acknowledged it or opened an incident.',
        a.id, 'security', ['alerts'], { id: a.id }));
    });

    d.vms.filter(function (v) { return v.replica === 'off' && !/^dc-/.test(v.name); }).forEach(function (v) {
      out.push(finding('resilience', 'medium', 'replica-' + v.name, v.name + ' has no replica at Site B',
        'If the host or the site is lost this machine is rebuilt from backup at whatever age the backup is, and the failover runbook skips it.',
        v.name, 'compute', ['vm', v.name, 'replica']));
    });
    d.buckets.filter(function (b) { return b.replication === 'none' && b.sizeTB >= 1; }).forEach(function (b) {
      out.push(finding('resilience', 'medium', 'repl-' + b.name, b.name + ' is not replicated to Site B',
        fmt.bytesTB(b.sizeTB) + ' in one site. A site loss loses it, and the RTO for re-ingesting it is not in any drill.',
        b.name, 'data', ['bucket', b.name]));
    });
    d.hosts.filter(function (h) { return h.s2d === 'repairing'; }).forEach(function (h) {
      out.push(finding('resilience', 'high', 's2d-' + h.name, 'Storage Spaces Direct is repairing on ' + h.name,
        'Resiliency is reduced until the repair completes. A second disk failure during it loses data.',
        h.name, 'compute', ['host', h.name]));
    });
    d.backups.filter(function (b) { return b.state !== 'ok'; }).forEach(function (b) {
      out.push(finding('resilience', 'medium', 'backup-' + b.store, 'Backup of ' + b.store + ' is ' + fmt.ago(b.last).replace(' ago', '') + ' old',
        b.kind + ', ' + b.cadence + '. Older than its cadence allows.', b.store, 'ops', ['backups']));
    });
    var restores = d.drills.filter(function (x) { return x.kind === 'Restore'; }).sort(function (a, b) { return b.ran - a.ran; });
    if (!restores.length || (d.now - restores[0].ran) > 30 * 86400000) {
      out.push(finding('resilience', 'medium', 'drill-restore', 'No restore drill in the last 30 days',
        restores.length ? 'The last one ran ' + fmt.ago(restores[0].ran) + '. A backup nobody has restored is a hope.' : 'No restore drill is on record.',
        'umairv3_db', 'ops', ['runbook', 'sql-01-restore-drill']));
    }

    d.gpu.cards.filter(function (c) { return c.util < 20; }).forEach(function (c) {
      out.push(finding('cost', 'low', 'gpu-' + c.id, 'GPU ' + c.id + ' on ' + d.gpu.name + ' is ' + c.util + '% busy',
        c.model + ' held by ' + c.user + ' while ' + d.gpu.queue.length + ' job' + (d.gpu.queue.length === 1 ? '' : 's') + ' wait. Reclaim it or schedule the queue onto it.',
        d.gpu.name, 'compute', ['gpu']));
    });
    d.cost.forecast.filter(function (f) { return f.headroomPct < 30; }).forEach(function (f) {
      out.push(finding('cost', 'medium', 'capacity-' + f.resource, f.resource + ' fills in ' + f.full,
        f.headroomPct + '% headroom left. Hardware has a lead time; order before the forecast, not after.',
        f.resource, 'ops', ['cost']));
    });
    if (d.cache.memoryUsedGB / d.cache.memoryTotalGB >= 0.75) {
      out.push(finding('cost', 'low', 'cache-memory', 'Garnet is at ' + fmt.ratioPct(d.cache.memoryUsedGB / d.cache.memoryTotalGB, 0) + ' of its memory',
        fmt.num(d.cache.evictions) + ' evictions already. Either raise the limit or let the largest prefix expire sooner.',
        'Garnet', 'data', ['cache']));
    }

    d.apps.filter(function (a) { return a.p95 > 500; }).forEach(function (a) {
      out.push(finding('performance', 'medium', 'p95-' + a.name, a.display + ' p95 is ' + fmt.ms(a.p95),
        'Above the 500 ms budget for an interactive application. The trace tab shows where the time goes.',
        a.name, 'apps', [a.name, 'traces']));
    });
    d.apps.filter(function (a) { return a.errorRate > 0.001; }).forEach(function (a) {
      out.push(finding('performance', 'high', 'err-' + a.name, a.display + ' error rate is ' + fmt.ratioPct(a.errorRate, 2),
        'Above the 0.10% budget. The error budget tab says how much of the month is already spent.',
        a.name, 'apps', [a.name, 'budget']));
    });
    d.queues.filter(function (q) { return q.lag > 10; }).forEach(function (q) {
      out.push(finding('performance', 'medium', 'lag-' + q.stream, q.stream + ' has ' + q.lag + ' messages of consumer lag',
        q.consumers + ' consumer' + (q.consumers === 1 ? '' : 's') + ' at ' + q.rate + ' msg/s. Add a consumer or find the slow one.',
        q.stream, 'data', ['queues']));
    });
    d.queues.filter(function (q) { return q.dlq > 0; }).forEach(function (q) {
      out.push(finding('performance', 'low', 'dlq-' + q.stream, q.stream + ' has ' + q.dlq + ' message' + (q.dlq === 1 ? '' : 's') + ' in its dead letter queue',
        'A dead letter is a request somebody made that nothing will act on until a person looks.', q.stream, 'data', ['queues']));
    });

    d.hosts.filter(function (h) { return h.patchAgeDays > 30; }).forEach(function (h) {
      out.push(finding('operations', 'high', 'patch-' + h.name, h.name + ' is ' + h.patchAgeDays + ' days behind on patches',
        'Outside the 30 day window. The next patch window is Tuesday 22:00.', h.name, 'compute', ['host', h.name]));
    });
    d.pipelines.filter(function (p) { return p.state !== 'fresh'; }).forEach(function (p) {
      out.push(finding('operations', p.state === 'failed' ? 'high' : 'medium', 'pipe-' + p.asset, p.asset + ' is ' + p.state,
        'Last run ' + fmt.ago(p.lastRun) + ' against a ' + p.sla + ' h freshness SLA.', p.asset, 'ml', ['pipelines']));
    });
    d.runbooks.filter(function (r) { return !r.lastRun; }).forEach(function (r) {
      out.push(finding('operations', 'low', 'runbook-' + r.id, 'Runbook ' + r.id + ' has never been run',
        'A runbook that has never been exercised is a document, not a procedure. Run it in staging.', r.id, 'ops', ['runbook', r.id]));
    });
    if (d.reconciler.drift > 0) {
      out.push(finding('operations', 'high', 'drift', fmt.num(d.reconciler.drift) + ' resources adrift from Git',
        'The cluster no longer matches the declaration. Somebody changed something by hand.', 'reconciler', 'overview'));
    }
    (d.alarms || []).forEach(function (alarm) {
      var ev = A.evaluateAlarm(alarm);
      if (ev.state === 'INSUFFICIENT') {
        out.push(finding('operations', 'low', 'alarm-' + alarm.id, 'Alarm ' + alarm.name + ' has no data',
          ev.text, alarm.id, 'ops', ['alarms'], { id: alarm.id }));
      }
    });

    return out;
  }

  function suppressedMap() {
    var map = Object.create(null);
    (A.data.advisorSuppressed || []).forEach(function (s) {
      if (s.until && s.until.getTime() > A.data.now.getTime()) map[s.id] = s;
    });
    return map;
  }

  A.advisorFindings = function () {
    var sup = suppressedMap();
    return checks().map(function (f) {
      f.suppressed = sup[f.id] || null;
      return f;
    });
  };

  function suppressDialog(f, onDone) {
    var why = el('input.field', { type: 'text', id: 'suppress-why', autocomplete: 'off', spellcheck: 'false', placeholder: 'Accepted until the hardware order lands in November' });
    var days = el('select.field', { id: 'suppress-days' }, [['7', '7 days'], ['30', '30 days'], ['90', '90 days']].map(function (o) {
      return el('option', { value: o[0], text: o[1], selected: o[0] === '30' ? true : null });
    }));
    A.dialog({
      title: 'Accept the risk: ' + f.title,
      body: function () {
        return [
          el('p', { text: f.detail }),
          el('label.fieldlabel', { for: 'suppress-why', text: 'Why it is accepted (required, audited)' }), why,
          el('label.fieldlabel', { for: 'suppress-days', text: 'For how long' }), days,
          el('p.hint', { text: 'The finding comes back on its own when the time is up. Accepting is not fixing.' })
        ];
      },
      actions: function (close) {
        var go = ui.btn('Accept for ' + days.value + ' days', {
          variant: 'primary', disabled: true,
          onClick: function () {
            var reason = why.value.trim();
            if (!reason) return;
            close();
            A.data.advisorSuppressed = (A.data.advisorSuppressed || []).filter(function (s) { return s.id !== f.id; });
            A.data.advisorSuppressed.push({ id: f.id, until: new Date(A.data.now.getTime() + Number(days.value) * 86400000), reason: reason, by: A.me() });
            A.record('advisor.accept', f.id + ' for ' + days.value + ' d: ' + reason);
            A.flash('info', 'Risk accepted for ' + days.value + ' days', f.title + '. It returns on ' + fmt.stamp(A.data.advisorSuppressed[A.data.advisorSuppressed.length - 1].until) + '.', { timeout: 6000 });
            if (onDone) onDone();
          }
        });
        days.addEventListener('change', function () { go.textContent = 'Accept for ' + days.value + ' days'; });
        why.addEventListener('input', function () { go.setDisabled(!why.value.trim()); });
        return [ui.btn('Cancel', { variant: 'ghost', onClick: close }), go];
      }
    });
    why.focus();
  }

  function unsuppress(f, onDone) {
    A.data.advisorSuppressed = (A.data.advisorSuppressed || []).filter(function (s) { return s.id !== f.id; });
    A.record('advisor.reopen', f.id);
    A.flash('info', 'Finding reopened', f.title + ' counts again.', { timeout: 5000 });
    if (onDone) onDone();
  }

  var FIELDS = [
    { key: 'category', label: 'Category' },
    { key: 'severity', label: 'Severity' },
    { key: 'resource', label: 'Resource' },
    { key: 'title', label: 'Finding' }
  ];

  registerScreen('advisor', {
    title: 'Advisor',
    crumb: 'Advisor',
    render: function (mount, ctx) {
      var all = A.advisorFindings();
      var active = all.filter(function (f) { return !f.suppressed; });
      var byCat = {};
      CATEGORIES.forEach(function (c) { byCat[c.id] = active.filter(function (f) { return f.category === c.id; }); });
      var worst = active.slice().sort(function (a, b) { return SEV_RANK[a.severity] - SEV_RANK[b.severity]; })[0];

      mount.appendChild(ui.pageHeader('Advisor',
        fmt.num(active.length) + ' finding' + (active.length === 1 ? '' : 's') + ' across ' + fmt.num(CATEGORIES.length) + ' categories, computed from the estate as it is right now' +
        (all.length - active.length ? ', ' + fmt.num(all.length - active.length) + ' accepted' : '') + '.'));

      mount.appendChild(el('div.callout.' + (worst ? SEV_TONE[worst.severity] : 'ok'), [
        el('strong', { text: worst ? 'Worst finding: ' + worst.title + '.' : 'Nothing to report.' }),
        el('p', { text: worst ? worst.detail : 'Every check passed against the estate as it is now.' })
      ]));

      mount.appendChild(el('div.tiles', CATEGORIES.map(function (c) {
        var list = byCat[c.id];
        var top = list.slice().sort(function (a, b) { return SEV_RANK[a.severity] - SEV_RANK[b.severity]; })[0];
        return ui.statTile(c.label, fmt.num(list.length), {
          note: top ? 'worst: ' + top.severity : 'clean',
          href: A.href('advisor', [], { f: ui.encodeTokens([{ key: 'category', value: c.label }]) }),
          title: c.what
        });
      })));

      var accessors = {
        category: function (f) { return CATEGORIES.filter(function (c) { return c.id === f.category; })[0].label; },
        severity: function (f) { return f.severity; },
        resource: function (f) { return f.resource; },
        title: function (f) { return f.title; }
      };

      var tableHost = el('div');
      var table = null;
      var showAccepted = false;

      function rowsFor(tokens) {
        var base = showAccepted ? all : active;
        return ui.applyTokens(base, tokens || [], accessors);
      }

      function paint(tokens) {
        var rows = rowsFor(tokens);
        if (table) { table.setRows(rows); return; }
        table = ui.table(cols, rows, {
          id: 'advisor.findings',
          caption: 'Advisor findings with category, severity, the resource concerned and what to do',
          empty: 'No finding matches every filter. Remove a token to widen the search.',
          sortKey: 'severity', sortDir: 'asc',
          rowKey: function (f) { return f.id; }
        });
        tableHost.appendChild(table);
      }

      var cols = [
        {
          key: 'severity', label: 'Severity', status: true,
          sort: function (f) { return SEV_RANK[f.severity]; },
          render: function (f) { return ui.pill(f.severity, SEV_TONE[f.severity]); }
        },
        {
          key: 'category', label: 'Category',
          sort: function (f) { return accessors.category(f); },
          render: function (f) {
            var c = CATEGORIES.filter(function (x) { return x.id === f.category; })[0];
            return el('span.advisor-cat', { title: c.what, text: c.label });
          }
        },
        {
          key: 'title', label: 'Finding',
          render: function (f) {
            return el('div.col', [
              el('strong', { text: f.title }),
              el('div.muted', { text: f.detail }),
              f.suppressed ? el('div.muted', { text: 'Accepted by ' + f.suppressed.by + ' until ' + fmt.stamp(f.suppressed.until) + ': ' + f.suppressed.reason }) : null
            ]);
          }
        },
        { key: 'resource', label: 'Resource', render: function (f) { return el('span.mono', { text: f.resource }); } },
        {
          key: 'actions', label: 'Actions', sortable: false,
          render: function (f) {
            return el('div.row', [
              A.link('Go to ' + f.resource, f.route, f.rest, f.params),
              f.suppressed
                ? ui.btn('Reopen ' + f.id, { variant: 'ghost', onClick: function () { unsuppress(f, function () { A.refresh(); }); } })
                : ui.btn('Accept risk on ' + f.id, { variant: 'ghost', title: 'Accept this finding for a fixed time with a reason', onClick: function () { suppressDialog(f, function () { A.refresh(); }); } })
            ]);
          }
        }
      ];

      var filter = ui.propertyFilter(FIELDS, function (tokens) {
        paint(tokens);
        A.replaceHash(A.href('advisor', [], { f: ui.encodeTokens(tokens) }));
      }, { initial: ui.decodeTokens(ctx && ctx.params && ctx.params.f) });

      var acceptedNote = el('p.hint', { role: 'status', hidden: true });
      var toggle = ui.btn('Show accepted findings', {
        variant: 'ghost',
        onClick: function () {
          showAccepted = !showAccepted;
          toggle.textContent = showAccepted ? 'Hide accepted findings' : 'Show accepted findings';
          toggle.setAttribute('aria-pressed', showAccepted ? 'true' : 'false');
          var accepted = all.length - active.length;
          acceptedNote.textContent = showAccepted
            ? (accepted ? 'Showing ' + fmt.num(accepted) + ' accepted finding' + (accepted === 1 ? '' : 's') + ' alongside the ' + fmt.num(active.length) + ' active ones. Each says who accepted it and until when.' : 'No finding has been accepted, so the list is unchanged.')
            : '';
          acceptedNote.hidden = !showAccepted;
          paint(filter.tokens());
          A.announce(showAccepted ? 'Accepted findings shown' : 'Accepted findings hidden');
        }
      });
      toggle.setAttribute('aria-pressed', 'false');

      mount.appendChild(el('div.row', [
        filter, el('span.spacer'), toggle,
        ui.columnsButton(function () { return table; }, 'findings'),
        ui.exportButton(function () { return table; }, 'findings')
      ]));
      mount.appendChild(el('p.hint', {
        text: 'Every row is a rule evaluated against the dataset this console holds, so a finding disappears the moment the data changes. Accepting a risk records who, why and until when, and the finding comes back when that passes.'
      }));
      mount.appendChild(acceptedNote);
      mount.appendChild(tableHost);
      paint(filter.tokens());
    }
  });

  A.refreshAdvisorBadge = function () {
    var badge = document.getElementById('nav-advisor-badge');
    if (!badge || typeof A.advisorFindings !== 'function') return;
    var urgent = A.advisorFindings().filter(function (f) { return !f.suppressed && (f.severity === 'critical' || f.severity === 'high'); }).length;
    badge.textContent = urgent ? String(urgent) : '';
    badge.hidden = !urgent;
  };
})();
