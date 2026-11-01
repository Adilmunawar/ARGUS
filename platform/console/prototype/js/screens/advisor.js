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

  var SEV_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info', info: 'idle' };
  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  var GROUPS = [
    { match: /^wdac-/, noun: 'hosts', title: function (n) { return 'WDAC is in audit mode on ' + n + ' hosts'; } },
    { match: /^replica-/, noun: 'machines', title: function (n) { return n + ' machines have no replica at Site B'; } },
    { match: /^lock-(?!missing-|unenforced-|filer-)/, noun: 'buckets', title: function (n) { return n + ' buckets have no object lock'; } },
    { match: /^runbook-/, noun: 'runbooks', title: function (n) { return n + ' runbooks have never been run'; } },
    { match: /^lock-missing-/, noun: 'buckets', title: function (n) { return n + ' buckets are declared with a lock and none is enforced'; } },
    { match: /^no-alerts-/, noun: 'applications', title: function (n) { return n + ' applications have no alert rules'; } },
    { match: /^no-spec-/, noun: 'directories', title: function (n) { return n + ' directories have no spec'; } }
  ];

  var groupedView = true;

  function groupOf(f) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].match.test(f.id)) return GROUPS[i];
    return null;
  }

  function groupRows(list) {
    var buckets = {};
    list.forEach(function (f) {
      var g = f.suppressed ? null : groupOf(f);
      if (!g) return;
      var key = String(g.match) + '|' + f.severity + '|' + f.detail;
      (buckets[key] = buckets[key] || { spec: g, members: [] }).members.push(f);
    });
    var placed = {};
    var out = [];
    list.forEach(function (f) {
      var g = f.suppressed ? null : groupOf(f);
      var key = g ? String(g.match) + '|' + f.severity + '|' + f.detail : null;
      if (!g || buckets[key].members.length < 2) { out.push(f); return; }
      if (placed[key]) return;
      placed[key] = true;
      var members = buckets[key].members;
      out.push({
        id: 'group-' + members[0].id,
        group: true,
        noun: buckets[key].spec.noun,
        members: members,
        category: f.category,
        severity: f.severity,
        title: buckets[key].spec.title(members.length),
        detail: f.detail,
        evidence: f.evidence,
        resource: members.map(function (m) { return m.resource; }).join(', ')
      });
    });
    return out;
  }

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

  var READS = [
    { id: 'capabilities', path: '/api/capabilities', label: 'Console capabilities' },
    { id: 'heartbeats', path: '/api/heartbeats', label: 'Heartbeat monitors' },
    { id: 'seal', path: '/api/secrets/seal-status', label: 'OpenBao seal', nc: 'openbao', ncLabel: 'OpenBao' },
    { id: 'lock', path: '/api/storage/lock-status', label: 'Object lock probe', nc: 'seaweedfs', ncLabel: 'SeaweedFS' },
    { id: 'buckets', path: '/api/storage/buckets', label: 'Buckets', nc: 'seaweedfs', ncLabel: 'SeaweedFS' },
    { id: 'pg', path: '/api/pg/health', label: 'PostgreSQL health', nc: 'postgres', ncLabel: 'PostgreSQL' },
    { id: 'targets', path: '/api/metrics/targets', label: 'Prometheus targets', nc: 'prometheus', ncLabel: 'Prometheus' },
    { id: 'alerts', path: '/api/alerts/active', label: 'Active alerts', nc: 'alertmanager', ncLabel: 'Alertmanager' },
    { id: 'containers', path: '/api/containers', label: 'Containers', nc: 'docker', ncLabel: 'The Docker proxy' },
    { id: 'host', path: '/api/host', label: 'Host' },
    { id: 'principals', path: '/api/identity/principals', label: 'Principals' },
    { id: 'apps', path: '/api/gitops/apps', label: 'Declared apps' },
    { id: 'environments', path: '/api/gitops/environments', label: 'Declared environments' }
  ];

  var STREAMS = [
    { key: 'logs', nc: 'loki', label: 'Loki' },
    { key: 'metrics', nc: 'prometheus', label: 'Prometheus' },
    { key: 'alerts', nc: 'alertmanager', label: 'Alertmanager' },
    { key: 'containers', nc: 'docker', label: 'The Docker proxy' }
  ];

  var STATUS_WORD = { ok: 'read', 'not-configured': 'not configured', failed: 'failed', cancelled: 'cancelled' };

  function stampIso(s) { return String(s).slice(0, 19).replace('T', ' ') + 'Z'; }

  function bytes(n) {
    if (n === null || n === undefined) return '-';
    var gb = n / 1073741824;
    if (gb >= 1024) return fmt.num(gb / 1024, 2) + ' TB';
    if (gb >= 1) return fmt.num(gb, 1) + ' GB';
    return fmt.num(n / 1048576, 0) + ' MB';
  }

  function readStatus(env) {
    if (!env) return 'failed';
    if (env.error && env.error.reason === 'cancelled') return 'cancelled';
    if (!env.ok) return env.error && env.error.reason === 'not-configured' ? 'not-configured' : 'failed';
    var d = env.data || {};
    if (d.reason === 'not-configured' || d.configured === false || d.state === 'not-configured') return 'not-configured';
    return 'ok';
  }

  function liveRules(envs) {
    var out = [], seen = Object.create(null);
    function add(f, env) {
      if (seen[f.id]) return;
      seen[f.id] = true;
      f.evidence = { path: env.path, at: new Date(env.at) };
      out.push(f);
    }
    function get(id) { return envs[id]; }
    function data(id) { var e = get(id); return e && readStatus(e) === 'ok' ? e.data : null; }
    function notConfigured(nc, label, env) {
      add(finding('operations', 'info', 'nc-' + nc, label + ' is not configured',
        'This console has no address for it, so every rule that needs it was skipped rather than guessed. Nothing on this screen is a finding about ' + label + '.',
        nc, 'stack'), env);
    }

    var caps = data('capabilities');
    if (caps) {
      var streams = caps.streams || {};
      STREAMS.forEach(function (s) {
        if (streams[s.key] === false) notConfigured(s.nc, s.label, get('capabilities'));
      });
      if (caps.writesAllowed === true) {
        add(finding('security', 'high', 'writes-allowed', 'Writes are allowed on the console',
          'ARGUS_ALLOW_WRITES is on, so a session on this console can change the estate rather than only read it. A read-only console is what keeps an operator browser from being a blast radius.',
          'console', 'system'), get('capabilities'));
      }
    }

    READS.forEach(function (r) {
      var env = get(r.id);
      if (r.nc && env && readStatus(env) === 'not-configured') notConfigured(r.nc, r.ncLabel, env);
    });

    var seal = data('seal');
    if (seal && seal.sandbox && seal.sandbox.verdict === true) {
      add(finding('security', 'critical', 'seal-sandbox', seal.sandbox.title || 'OpenBao is sealed with a single share',
        (seal.sandbox.basis ? seal.sandbox.basis + '. ' : '') + (seal.sandbox.message || 'One key on this machine opens every secret in the estate.'),
        'openbao', 'stack'), get('seal'));
    }

    var principals = data('principals');
    if (principals && principals.console && principals.console.ok !== false && principals.console.operators) {
      var ops = principals.console.operators;
      if (ops.length === 1) {
        add(finding('security', 'medium', 'operators-single', 'Only one console operator exists',
          ops[0].subject + ' is the only operator in operators.json, so there is no second person for two-person approval. Anything that needs a second pair of eyes has nobody to give it.',
          ops[0].subject, 'identity', ['people']), get('principals'));
      }
    }

    var lock = data('lock');
    if (lock && lock.determined === true) {
      var bypass = String(lock.filerBypass || 'unknown');
      if (/open|bypass|yes|true/i.test(bypass)) {
        add(finding('security', 'high', 'lock-filer-bypass', 'Object lock is bypassable through the filer',
          'The lock probe found that the filer path deletes a locked object version: ' + (lock.filerBypassDetail || bypass) + ' Object Lock lives in the S3 gateway alone.',
          'seaweed-filer', 'storage'), get('lock'));
      } else if (bypass !== 'closed') {
        add(finding('security', 'low', 'lock-filer-unmeasured', 'Whether the filer bypasses object lock is ' + bypass,
          lock.filerBypassDetail || 'This run recorded nothing about the filer path, and an unmeasured filer is not a closed one.',
          'seaweed-filer', 'storage'), get('lock'));
      }
      (lock.missingLock || []).forEach(function (name) {
        add(finding('security', 'high', 'lock-missing-' + name, name + ' is declared with a lock and none is enforced',
          'The bucket declaration asks for object lock and the storage-init probe applied none. A writer identity can delete or overwrite every object.',
          name, 'storage'), get('lock'));
      });
      (lock.buckets || []).forEach(function (b) {
        if (b.enforced && b.enforced !== 'enforced') {
          add(finding('security', 'high', 'lock-unenforced-' + b.name, 'Object lock on ' + b.name + ' is ' + b.enforced,
            'The lock is configured (' + b.mode + ', ' + b.days + ' d) but the probe verdict is "' + b.enforced + '"' + (b.probeError ? ': ' + b.probeError : '.'),
            b.name, 'storage'), get('lock'));
        }
      });
    }

    var buckets = data('buckets');
    if (buckets) {
      (buckets.buckets || []).forEach(function (b) {
        if (b.lockDeclared && !b.lock) {
          add(finding('security', 'high', 'lock-missing-' + b.name, b.name + ' is declared with a lock and none is enforced',
            'Declared ' + b.lockDeclared + ' and the applied state carries no lock. A writer identity can delete or overwrite every object.',
            b.name, 'storage'), get('buckets'));
        } else if (b.lock && b.lockEnforced && b.lockEnforced !== 'enforced') {
          add(finding('security', 'high', 'lock-unenforced-' + b.name, 'Object lock on ' + b.name + ' is ' + b.lockEnforced,
            'The bucket carries a ' + b.lock + ' lock but the WORM probe verdict is "' + b.lockEnforced + '".', b.name, 'storage'), get('buckets'));
        }
      });
    }

    var apps = data('apps');
    if (apps) {
      (apps.apps || []).forEach(function (a) {
        if (a.secretRefs && a.secretRefs.length) {
          add(finding('security', 'info', 'secrets-unresolved-' + a.name, a.name + ' references ' + fmt.num(a.secretRefs.length) + ' secret' + (a.secretRefs.length === 1 ? '' : 's') + ' nothing resolves here',
            'No reconciler runs in this stack, so ' + a.secretRefs.slice(0, 3).join(', ') + (a.secretRefs.length > 3 ? ' and more' : '') + ' are declared paths, not delivered secrets.',
            a.name, 'deploys'), get('apps'));
        }
        if (!a.alertRules || !a.alertRules.length) {
          add(finding('operations', 'low', 'no-alerts-' + a.name, a.name + ' has no alert rules',
            'The app is declared' + (a.alertsFile ? ' with ' + a.alertsFile : '') + ' but no rule would fire for it, so its first outage is reported by a person.',
            a.name, 'deploys'), get('apps'));
        }
      });
      (apps.problems || []).forEach(function (p) {
        add(finding('operations', 'low', 'no-spec-' + p.directory, p.directory + ' has no spec',
          p.message || 'The gitops directory declares nothing the console can read.', p.directory, 'deploys'), get('apps'));
      });
    }

    var environments = data('environments');
    if (environments) {
      (environments.environments || []).forEach(function (e) {
        var unpinned = (e.apps || []).filter(function (x) { return x.pinned === false; });
        if (unpinned.length) {
          add(finding('operations', 'medium', 'unpinned-' + e.name, e.name + ' declares ' + fmt.num(unpinned.length) + ' unpinned digest' + (unpinned.length === 1 ? '' : 's'),
            unpinned.map(function (x) { return x.app + (x.version ? ' ' + x.version : ''); }).join(', ') + (unpinned.length === 1 ? ' carries' : ' carry') + ' no sha256, so what would be deployed is whatever that version resolves to on the day.',
            e.name, 'deploys'), get('environments'));
        }
      });
    }

    var hb = data('heartbeats');
    if (hb) {
      (hb.monitors || []).forEach(function (m) {
        if (m.statusName === 'down') {
          add(finding('resilience', 'high', 'heartbeat-' + m.id, 'Heartbeat ' + (m.label || m.id) + ' is down',
            (m.message || 'The monitor has failed ' + fmt.num(m.consecutiveFailures) + ' times in a row.') + (m.lastCheckedAt ? ' Last checked ' + stampIso(m.lastCheckedAt) + '.' : ''),
            m.id, 'stack'), get('heartbeats'));
        } else if (m.statusName === 'pending') {
          add(finding('resilience', 'medium', 'heartbeat-' + m.id, 'Heartbeat ' + (m.label || m.id) + ' is degraded',
            (m.message || 'The last check failed and the monitor is retrying.') + ' ' + fmt.num(m.consecutiveFailures) + ' consecutive failure' + (m.consecutiveFailures === 1 ? '' : 's') + '.',
            m.id, 'stack'), get('heartbeats'));
        }
      });
    }

    var pgEnv = get('pg');
    if (pgEnv && readStatus(pgEnv) === 'failed') {
      add(finding('resilience', 'high', 'pg-health', 'The PostgreSQL health check fails',
        (pgEnv.error && pgEnv.error.message) || 'The database did not answer.', 'postgres', 'data', ['databases']), pgEnv);
    }
    var pg = data('pg');
    if (pg) {
      (pg.components || []).forEach(function (c) {
        if (c.ok === false) {
          add(finding('resilience', 'high', 'pg-' + String(c.name).replace(/\s+/g, '-'), 'PostgreSQL ' + c.name + ' check fails',
            c.detail || 'The check reported a failure.', 'postgres', 'data', ['databases']), pgEnv);
        }
        if (c.name === 'replication' && /nothing is replicating|no standby/i.test(String(c.detail || ''))) {
          add(finding('resilience', 'medium', 'pg-no-replication', 'PostgreSQL has no replication',
            c.detail, 'postgres', 'data', ['databases']), pgEnv);
        }
      });
    }

    var containers = data('containers');
    if (containers) {
      (containers.containers || []).forEach(function (c) {
        var name = (c.names && c.names[0]) || c.id;
        if (c.state === 'restarting') {
          add(finding('resilience', 'high', 'container-' + name, name + ' is restarting',
            (c.status || 'Docker reports the container restarting') + '. A restart loop is an outage that reports itself as running.', name, 'stack'), get('containers'));
        } else if (c.health === 'unhealthy') {
          add(finding('resilience', 'high', 'container-' + name, name + ' is unhealthy',
            (c.status || 'Its health check fails') + '. The process is up and its own check says it is not serving.', name, 'stack'), get('containers'));
        }
      });
    }

    var targets = data('targets');
    if (targets) {
      (targets.targets || []).forEach(function (t) {
        if (t.health !== 'up') {
          var key = (t.job || 'job') + '/' + (t.instance || 'instance');
          add(finding('resilience', 'medium', 'target-' + key, 'Prometheus target ' + key + ' is ' + t.health,
            (t.lastError || 'The scrape fails') + (t.lastScrape ? '. Last scrape ' + stampIso(t.lastScrape) + '.' : '.'),
            key, 'security', ['alerts']), get('targets'));
        }
      });
    }

    var alerts = data('alerts');
    if (alerts) {
      (alerts.alerts || []).forEach(function (a) {
        if (a.severity === 'critical') {
          add(finding('security', 'critical', 'alert-' + (a.fingerprint || a.name), 'Critical alert ' + a.name + ' is firing',
            (a.summary || 'Alertmanager reports it active') + (a.startsAt ? ', since ' + stampIso(a.startsAt) + '.' : '.'),
            a.name, 'security', ['alerts']), get('alerts'));
        }
      });
    }

    var host = data('host');
    if (host) {
      if (host.memory && host.memory.usageRatio > 0.85) {
        add(finding('operations', 'medium', 'host-memory', 'Host memory is at ' + fmt.pct(host.memory.usageRatio * 100, 0),
          bytes(host.memory.usedBytes) + ' of ' + bytes(host.memory.totalBytes) + ' in use on ' + host.hostname + '. Above 85 percent the next container restart swaps.',
          host.hostname, 'system'), get('host'));
      }
      (host.disks || []).forEach(function (d) {
        if (d.error || !d.totalBytes) return;
        var ratio = d.usageRatio !== undefined ? d.usageRatio : (d.totalBytes - d.freeBytes) / d.totalBytes;
        if (ratio > 0.8) {
          add(finding('operations', 'medium', 'disk-' + d.mount, 'Volume ' + d.mount + ' is ' + fmt.pct(ratio * 100, 0) + ' used',
            bytes(d.freeBytes) + ' free of ' + bytes(d.totalBytes) + '. Raft, WAL and needle volumes stop cleanly at full and not before.',
            d.mount, 'system'), get('host'));
        }
      });
    }

    return out;
  }

  var live = { findings: null, sources: null, at: 0, promise: null };
  var LIVE_TTL_MS = 30000;

  function isLive() { return typeof A.storeMode === 'function' && A.storeMode() === A.MODE.LIVE; }

  function evaluateLive() {
    if (live.promise) return live.promise;
    live.promise = Promise.all(READS.map(function (r) {
      return A.read(r.path, { ttlMs: 15000 }).then(function (env) {
        var copy = {};
        for (var k in env) if (Object.prototype.hasOwnProperty.call(env, k)) copy[k] = env[k];
        copy.path = r.path;
        return copy;
      }, function (err) {
        return { ok: false, data: null, at: Date.now(), path: r.path, error: err || { reason: 'error', message: 'The read failed.' } };
      });
    })).then(function (list) {
      var envs = {};
      var cancelled = false;
      list.forEach(function (env, i) {
        envs[READS[i].id] = env;
        var reason = env.error && env.error.reason;
        if (reason === 'cancelled' || reason === 'unauthenticated') cancelled = true;
      });
      live.findings = liveRules(envs);
      live.sources = READS.map(function (r) {
        var env = envs[r.id];
        return {
          id: r.id, label: r.label, path: r.path, status: readStatus(env), at: env.at ? new Date(env.at) : null,
          message: env.error && env.error.message ? env.error.message : (env.data && env.data.message) || null
        };
      });
      live.at = cancelled ? 0 : Date.now();
      live.promise = null;
      paintAdvisorBadge();
      return live;
    });
    return live.promise;
  }

  function signedOut() {
    return typeof A.storeHealth === 'function' && !!A.storeHealth().signedOut;
  }

  function paintAdvisorBadge() {
    var badge = document.getElementById('nav-advisor-badge');
    if (!badge || typeof A.advisorFindings !== 'function') return;
    var urgent = A.advisorFindings().filter(function (f) { return !f.suppressed && (f.severity === 'critical' || f.severity === 'high'); }).length;
    badge.textContent = urgent ? String(urgent) : '';
    badge.hidden = !urgent;
  }

  function suppressedMap() {
    var map = Object.create(null);
    (A.data.advisorSuppressed || []).forEach(function (s) {
      if (s.until && s.until.getTime() > A.data.now.getTime()) map[s.id] = s;
    });
    return map;
  }

  function withSuppression(list) {
    var sup = suppressedMap();
    return list.map(function (f) {
      f.suppressed = sup[f.id] || null;
      return f;
    });
  }

  A.advisorFindings = function () {
    if (isLive()) return withSuppression(live.findings || []);
    return withSuppression(checks());
  };

  function suppressDialog(f, onDone) {
    var liveMode = isLive();
    var targets = f.group ? f.members : [f];
    var why = el('input.field', { type: 'text', id: 'suppress-why', autocomplete: 'off', spellcheck: 'false', placeholder: 'Accepted until the hardware order lands in November' });
    var days = el('select.field', { id: 'suppress-days' }, [['7', '7 days'], ['30', '30 days'], ['90', '90 days']].map(function (o) {
      return el('option', { value: o[0], text: o[1], selected: o[0] === '30' ? true : null });
    }));
    A.dialog({
      title: 'Accept the risk: ' + f.title,
      body: function () {
        return [
          el('p', { text: f.detail }),
          f.group ? el('p', { text: 'This accepts all ' + fmt.num(targets.length) + ': ' + f.resource + '. To accept one alone, choose Show each finding first.' }) : null,
          liveMode ? el('div.callout.warn', { 'data-client-side': 'advisor' }, [
            el('strong', { text: 'This acceptance stays in this browser.' }),
            el('p', { text: 'This console has no write path, so nothing is recorded on the server. The finding is hidden here until you reload or the time is up, and comes back for every other operator at once.' })
          ]) : null,
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
            targets.forEach(function (t) {
              A.data.advisorSuppressed = (A.data.advisorSuppressed || []).filter(function (s) { return s.id !== t.id; });
              A.data.advisorSuppressed.push({ id: t.id, until: new Date(A.data.now.getTime() + Number(days.value) * 86400000), reason: reason, by: A.me() });
              A.record('advisor.accept', t.id + ' for ' + days.value + ' d: ' + reason);
            });
            A.flash('info', 'Risk accepted for ' + days.value + ' days' + (liveMode ? ' in this browser' : ''), f.title + '. It returns on ' + fmt.stamp(A.data.advisorSuppressed[A.data.advisorSuppressed.length - 1].until) + '.', { timeout: 6000 });
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

  function sourcesCard(sources, at) {
    var rows = sources.map(function (s) {
      var tone = s.status === 'ok' ? 'ok' : s.status === 'not-configured' ? 'idle' : 'warn';
      return [s.label, el('div.col', [
        el('div.row', [ui.pill(STATUS_WORD[s.status] || s.status, tone), el('span.mono', { text: 'GET ' + s.path }), s.at ? el('span.muted', { text: fmt.stamp(s.at) }) : null]),
        s.status !== 'ok' && s.message ? el('div.muted', { text: s.message }) : null
      ])];
    });
    return ui.card('What was read', [
      el('p.hint', { text: 'Every finding above cites one of these reads. A read that is not configured or failed produced no finding, only this line, so nothing on this screen is a guess. Evaluated ' + fmt.stamp(new Date(at)) + '.' }),
      ui.dl(rows)
    ]);
  }

  function paintScreen(mount, ctx, all, opts) {
    opts = opts || {};
    var liveMode = !!opts.live;
    var active = all.filter(function (f) { return !f.suppressed; });
    var byCat = {};
    CATEGORIES.forEach(function (c) { byCat[c.id] = active.filter(function (f) { return f.category === c.id; }); });
    var worst = active.slice().sort(function (a, b) { return SEV_RANK[a.severity] - SEV_RANK[b.severity]; })[0];

    var headActions = [];
    if (liveMode) {
      headActions.push(ui.btn('Re-evaluate', {
        variant: 'ghost', title: 'Read every source again and run the rules',
        onClick: function () { READS.forEach(function (r) { A.forget(r.path); }); live.at = 0; A.refresh(); }
      }));
    }

    mount.appendChild(ui.pageHeader('Advisor',
      fmt.num(active.length) + ' finding' + (active.length === 1 ? '' : 's') + ' across ' + fmt.num(CATEGORIES.length) + ' categories, computed from ' +
      (liveMode ? fmt.num(READS.length) + ' reads of the console API at ' + fmt.stamp(new Date(opts.at)) : 'the estate as it is right now') +
      (all.length - active.length ? ', ' + fmt.num(all.length - active.length) + ' accepted' : '') + '.', headActions));

    mount.appendChild(el('div.callout.' + (worst ? SEV_TONE[worst.severity] : 'ok'), [
      el('strong', { text: worst ? 'Worst finding: ' + worst.title + '.' : 'Nothing to report.' }),
      el('p', { text: worst ? worst.detail : (liveMode ? 'Every rule passed against what the console API answered.' : 'Every check passed against the estate as it is now.') })
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
      var matched = ui.applyTokens(base, tokens || [], accessors);
      return groupedView ? groupRows(matched) : matched;
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
            f.group ? el('div.chips', { 'data-members': String(f.members.length) }, f.members.map(function (m) {
              return el('span.chip', [A.link(m.resource, m.route, m.rest, m.params)]);
            })) : null,
            f.evidence ? el('div.muted', { 'data-evidence': f.evidence.path, text: 'Evidence: GET ' + f.evidence.path + ' read at ' + fmt.stamp(f.evidence.at) + '.' }) : null,
            f.suppressed ? el('div.muted', { text: 'Accepted by ' + f.suppressed.by + ' until ' + fmt.stamp(f.suppressed.until) + ': ' + f.suppressed.reason + (liveMode ? ' (in this browser only)' : '') }) : null
          ]);
        }
      },
      {
        key: 'resource', label: 'Resource',
        render: function (f) { return f.group ? el('span', { text: fmt.num(f.members.length) + ' ' + f.noun }) : el('span.mono', { text: f.resource }); }
      },
      {
        key: 'actions', label: 'Actions', sortable: false,
        render: function (f) {
          if (f.group) {
            var all_ = ui.btn('Accept all', { variant: 'ghost', title: 'Accept the risk on all ' + f.members.length + ' for a fixed time with a reason', onClick: function () { suppressDialog(f, function () { A.refresh(); }); } });
            all_.setAttribute('aria-label', 'Accept risk on all ' + f.members.length + ': ' + f.title);
            return el('div.row.cell-actions', [all_]);
          }
          var open = A.link('Open', f.route, f.rest, f.params);
          open.setAttribute('aria-label', 'Go to ' + f.resource);
          open.title = 'Go to ' + f.resource;
          var accept = ui.btn('Accept risk', { variant: 'ghost', title: 'Accept risk on ' + f.id + ' for a fixed time with a reason', onClick: function () { suppressDialog(f, function () { A.refresh(); }); } });
          accept.setAttribute('aria-label', 'Accept risk on ' + f.id);
          return el('div.row.cell-actions', [
            open,
            f.suppressed
              ? ui.btn('Reopen ' + f.id, { variant: 'ghost', onClick: function () { unsuppress(f, function () { A.refresh(); }); } })
              : accept
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

    var eachToggle = ui.btn(groupedView ? 'Show each finding' : 'Group repeated findings', {
      variant: 'ghost',
      onClick: function () {
        groupedView = !groupedView;
        eachToggle.textContent = groupedView ? 'Show each finding' : 'Group repeated findings';
        eachToggle.setAttribute('aria-pressed', groupedView ? 'false' : 'true');
        if (table) { table.remove(); table = null; }
        paint(filter.tokens());
        A.announce(groupedView ? 'Repeated findings grouped' : 'Every finding on its own row');
      }
    });
    eachToggle.id = 'advisor-each';
    eachToggle.setAttribute('aria-pressed', groupedView ? 'false' : 'true');

    mount.appendChild(el('div.row', [
      filter, el('span.spacer'), eachToggle, toggle,
      ui.columnsButton(function () { return table; }, 'findings'),
      ui.exportButton(function () { return table; }, 'findings')
    ]));
    mount.appendChild(el('p.hint', {
      text: liveMode
        ? 'Every row is a rule evaluated against what the console API answered, and each cites the read and the time it was made, so a finding disappears when the next read differs. Accepting a risk stays in this browser: this console has no write path, so nothing is recorded on the server.'
        : 'Every row is a rule evaluated against the dataset this console holds, so a finding disappears the moment the data changes. Accepting a risk records who, why and until when, and the finding comes back when that passes.'
    }));
    mount.appendChild(acceptedNote);
    mount.appendChild(tableHost);
    paint(filter.tokens());
    if (liveMode && opts.sources) mount.appendChild(sourcesCard(opts.sources, opts.at));
  }

  registerScreen('advisor', {
    title: 'Advisor',
    crumb: 'Advisor',
    render: function (mount, ctx) {
      if (typeof A.storeMode !== 'function' || A.storeMode() === A.MODE.SAMPLE) {
        paintScreen(mount, ctx, A.advisorFindings());
        return;
      }
      var host = el('div');
      mount.appendChild(host);
      var alive = true;
      A.onLeave(function () { alive = false; });
      A.whenProbed(function (mode) {
        if (!alive) return;
        if (mode !== A.MODE.LIVE) {
          paintScreen(host, ctx, A.advisorFindings());
          return;
        }
        if (signedOut()) {
          live.findings = null;
          live.at = 0;
          host.appendChild(ui.pageHeader('Advisor', 'The rules run over what the console API answers, and it answers only to a signed-in operator.'));
          host.appendChild(ui.emptyState('Sign in to read this', 'No rule has been evaluated, so this is not a clean bill of health.'));
          return;
        }
        host.appendChild(ui.pageHeader('Advisor', 'Reading ' + fmt.num(READS.length) + ' sources from the console API and running every rule over them.'));
        host.appendChild(ui.skeleton(6));
        var fresh = live.at && (Date.now() - live.at) < LIVE_TTL_MS && live.findings;
        (fresh ? Promise.resolve(live) : evaluateLive()).then(function () {
          if (!alive) return;
          ui.clear(host);
          paintScreen(host, ctx, A.advisorFindings(), { live: true, at: live.at || Date.now(), sources: live.sources || [] });
        });
      });
    }
  });

  A.refreshAdvisorBadge = function () {
    paintAdvisorBadge();
    if (isLive() && !signedOut() && !live.promise && (!live.at || (Date.now() - live.at) > LIVE_TTL_MS)) evaluateLive();
  };
})();
