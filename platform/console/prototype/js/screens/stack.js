(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  var UNSEAL_ANCHOR = 'unseal-posture';

  var STATE = {
    working:      { tone: 'ok',   label: 'working' },
    degraded:     { tone: 'warn', label: 'degraded' },
    broken:       { tone: 'bad',  label: 'not working' },
    unreachable:  { tone: 'bad',  label: 'unreachable' },
    notDeployed:  { tone: 'idle', label: 'not deployed' },
    unknown:      { tone: 'idle', label: 'not measured' },
    checking:     { tone: 'idle', label: 'checking' }
  };

  function statePill(key) {
    var s = STATE[key] || STATE.unknown;
    return ui.pill(s.label, s.tone);
  }

  function containerPill(up) {
    if (up === null || up === undefined) return ui.pill('not probed', 'idle');
    return ui.pill(up ? 'answers' : 'silent', up ? 'idle' : 'warn');
  }

  function count(list, fn) {
    var n = 0;
    (list || []).forEach(function (x) { if (fn(x)) n += 1; });
    return n;
  }

  function names(list, fn) {
    return (list || []).filter(fn).map(function (x) { return x.name; }).join(', ');
  }

  function findByName(list, wanted) {
    var hit = null;
    (list || []).forEach(function (c) { if (!hit && c && c.name === wanted) hit = c; });
    return hit;
  }

  var SERVICES = [
    {
      id: 'storage',
      name: 'Object store',
      unit: 'seaweed-master, seaweed-volume, seaweed-filer, seaweed-s3',
      path: '/api/storage/health',
      start: 'docker compose up -d',
      difference:
        'A SeaweedFS component answering /dir/status or /healthz proves a process is listening on a port. ' +
        'Only a signed S3 call proves the gateway has loaded its identities, accepted this console\'s ' +
        'signature and agreed with it about the clock, and that is the one an application needs.',
      containerProbe:
        'seaweed-s3 is healthchecked by fetching its /metrics port, and docker-compose.yml labels that ' +
        'liveness only: with identities loaded there is no unauthenticated S3 path that means "ready", so ' +
        'the probe cannot go red for a gateway that refuses every credential.',
      read: readStorage
    },
    {
      id: 'pg',
      name: 'PostgreSQL',
      unit: 'postgres',
      path: '/api/pg/health',
      start: 'docker compose up -d postgres',
      difference:
        'Accepting a TCP connection is what the container probe establishes. Whether this console\'s role ' +
        'can read the cluster\'s own statistics, whether vacuum is being held back, and how close the ' +
        'transaction id horizon is are separate questions, and every one of them fails silently behind a ' +
        'healthy postmaster.',
      containerProbe:
        'postgres is healthchecked with `pg_isready -h 127.0.0.1`, which proves the postmaster accepts TCP ' +
        'and nothing more. It does not authenticate, so it stays green through a grants file that was ' +
        'never applied.',
      read: readPg
    },
    {
      id: 'queues',
      name: 'Queues',
      unit: 'nats',
      path: '/api/queues/health',
      start: 'docker compose --profile queues up -d',
      difference:
        'The broker being up and the queues working are different facts. Measured on NATS 2.11.4, a server ' +
        'with JetStream disabled still answers /healthz with 200 ok, so persistence has to be established ' +
        'from JetStream itself and from the account the agents actually publish into.',
      containerProbe:
        'nats is healthchecked with /healthz?js-server-only=true: the process is up and JetStream is ' +
        'enabled. Not that a stream leader exists, and not that the account below it can store anything.',
      read: readQueues
    },
    {
      id: 'secrets',
      name: 'Secrets (OpenBao)',
      unit: 'openbao',
      path: '/api/secrets/health',
      start: 'docker compose --profile secrets up -d',
      difference:
        'A sealed vault is a healthy process that answers every read with a refusal. "Reachable" is ' +
        'therefore close to worthless here on its own; the question is whether the master key is in memory.',
      containerProbe:
        'openbao is healthchecked with `bao status`, and docker-compose.yml counts its sealed exit code as ' +
        'healthy on purpose: marking it unhealthy would stop everything gated on it and hand the operator ' +
        'a blank page instead of the words "OpenBao is sealed".',
      read: readSecrets
    }
  ];

  function envelopeVerdict(env, svc) {
    var st = A.envelopeState(env);
    if (st === 'ok' || st === 'stale') return null;
    var e = (env && env.error) || {};
    var fromService = !!(env && env.data);
    if (st === 'notFound') {
      return { state: 'notDeployed', envelope: st, headline: 'This console build has no reader for ' + svc.name + '.' };
    }
    if (st === 'notConfigured') {
      return {
        state: 'notDeployed', envelope: st,
        headline: e.reason === 'not-deployed'
          ? svc.name + ' is not running on this stack.'
          : 'The console is not configured to reach ' + svc.name + '.'
      };
    }
    if (st === 'unreachable' || st === 'timeout') {
      return {
        state: fromService ? 'unreachable' : 'unknown', envelope: st,
        headline: fromService ? svc.name + ' did not answer.' : 'The console API did not answer for ' + svc.name + '.'
      };
    }
    if (st === 'signedOut') return { state: 'unknown', envelope: st, headline: 'Sign in to read ' + svc.name + '.' };
    if (st === 'forbidden') return { state: 'unknown', envelope: st, headline: 'Your role cannot read ' + svc.name + '.' };
    if (st === 'sample') return { state: 'unknown', envelope: st, headline: 'Not read on sample data.' };
    return { state: 'unknown', envelope: st, headline: 'The ' + svc.name + ' reader could not answer.' };
  }

  function readStorage(d) {
    var comps = d.components || [];
    var reachable = count(comps, function (c) { return c.reachable; });
    var master = findByName(comps, 'master');
    var topologyKnown = !!(master && master.reachable);
    var s3 = d.s3 || {};

    var state, headline;
    if (s3.signedCallOk) {
      state = 'working';
      headline = 'A signed S3 call succeeded.';
    } else if (reachable > 0) {
      state = 'broken';
      headline = reachable + ' of ' + comps.length + ' components answer, but a signed S3 call does not.';
    } else if (comps.length) {
      state = 'unreachable';
      headline = 'No SeaweedFS component answered the console.';
    } else {
      state = 'unknown';
      headline = 'The reader returned no components, so nothing was probed.';
    }

    return {
      state: state,
      headline: headline,
      action: s3.signedCallOk ? null : (s3.message || null),
      container: {
        up: comps.length ? reachable > 0 : null,
        text: comps.length
          ? reachable + ' of ' + comps.length + ' components answered a liveness probe' +
            (reachable < comps.length ? ' (' + names(comps, function (c) { return !c.reachable; }) + ' did not)' : '')
          : 'Nothing was probed.'
      },
      working: {
        ok: !!s3.signedCallOk,
        text: s3.signedCallOk
          ? 'A signed ListObjectsV2 against a declared bucket returned, so the gateway has loaded its identities and accepted this console\'s signature.'
          : 'The signed call failed' + (s3.reason ? ' (' + s3.reason + ')' : '') + '. ' + (s3.message || '')
      },
      components: comps.map(function (c) {
        return {
          name: c.name,
          tone: c.reachable ? 'idle' : 'warn',
          label: c.reachable ? 'answers' : 'silent',
          latencyMs: c.latencyMs === undefined ? null : c.latencyMs,
          detail: c.error || (c.version ? 'version ' + c.version : '')
        };
      }),
      facts: [
        ['Free volume slots', topologyKnown ? fmt.num(d.freeVolumes) : notMeasured('the master did not answer')],
        ['A writable volume exists', topologyKnown
          ? (d.writable ? 'yes, for some collection' : 'no: the master has no writable volume')
          : notMeasured('this is read from the master\'s topology, and the master did not answer')],
        ['Every volume server reachable', topologyKnown
          ? (d.topologyReachable ? 'yes' : 'no')
          : notMeasured('the topology could not be read')]
      ],
      notes: [
        'A writable volume existing does not mean this console may write. Its S3 identity holds no Write ' +
          'action anywhere, deliberately.'
      ]
    };
  }

  function readPg(d) {
    var comps = d.components || [];
    var failing = names(comps, function (c) { return c.ok === false; });
    var unmeasured = count(comps, function (c) { return c.ok === null || c.ok === undefined; });

    return {
      state: d.degraded ? 'degraded' : 'working',
      headline: d.degraded
        ? 'PostgreSQL answers, but these checks fail: ' + failing + '.'
        : 'The cluster answered its own statistics query.',
      action: null,
      container: {
        up: true,
        text: 'The postmaster accepted a connection (' + fmt.ms(d.latencyMs) + ' round trip on SELECT 1).'
      },
      working: {
        ok: !d.degraded,
        text: d.degraded
          ? 'The connection works; ' + failing + ' does not.'
          : 'Every check this reader makes returned, and none of them is failing.'
      },
      components: comps.map(function (c) {
        return {
          name: c.name,
          tone: c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'idle',
          label: c.ok === true ? 'ok' : c.ok === false ? 'failing' : 'not a verdict',
          latencyMs: c.latencyMs === undefined ? null : c.latencyMs,
          detail: c.detail || ''
        };
      }),
      facts: [
        ['Server version', d.version || notMeasured('the version was not reported')],
        ['Role', d.role || notMeasured('recovery state was not reported')],
        ['Uptime', d.uptimeSeconds === null || d.uptimeSeconds === undefined
          ? notMeasured('uptime was not reported') : fmt.dur(d.uptimeSeconds)],
        ['Deadlocks since the stats were reset', d.deadlocksSinceStatsReset === null ||
          d.deadlocksSinceStatsReset === undefined
          ? notMeasured('pg_stat_database could not be read') : fmt.num(d.deadlocksSinceStatsReset)]
      ],
      notes: unmeasured
        ? [unmeasured + ' of these checks returned no verdict. They are shown as "not a verdict" rather ' +
           'than as passes: an unknown is not a fault, and it is not a pass either.']
        : []
    };
  }

  function readQueues(d) {
    var comps = d.components || [];
    var js = d.jetstream || {};
    var streams = d.streams || {};
    var healthz = d.healthz || null;
    var account = js.account || 'agents';

    var map = {
      ok: 'working',
      degraded: 'degraded',
      'account-unusable': 'broken',
      'jetstream-disabled': 'broken',
      unreachable: 'unreachable',
      unknown: 'unknown'
    };
    var state = map[d.verdict] || 'unknown';

    var headline;
    if (d.verdict === 'ok') {
      headline = 'JetStream is enabled and the ' + account + ' account can store messages.';
    } else if (d.verdict === 'degraded') {
      headline = 'The account can store messages, but something under it is not right' +
        (streams.leaderless ? ': ' + fmt.num(streams.leaderless) + ' stream(s) have no leader' : '') + '.';
    } else if (d.verdict === 'jetstream-disabled') {
      headline = 'JetStream is disabled, so nothing published here is persisted.';
    } else if (d.verdict === 'account-unusable') {
      headline = 'JetStream is enabled, but the ' + account + ' account cannot use it.';
    } else if (d.verdict === 'unreachable') {
      headline = d.message || 'The broker did not answer its monitoring endpoint.';
    } else {
      headline = 'The broker answered, but the JetStream account could not be read.';
    }

    var workingOk = d.usable === null || d.usable === undefined ? null : !!d.usable;

    var notes = [];
    if (d.healthzCaveat) notes.push(d.healthzCaveat);
    if (js.accountMessage) notes.push(js.accountMessage);
    if (healthz && healthz.errors && healthz.errors.length) {
      healthz.errors.forEach(function (e) {
        notes.push('/healthz names a broken asset: ' +
          [e.type, e.account, e.stream, e.consumer].filter(Boolean).join(' / ') +
          (e.error ? ': ' + e.error : ''));
      });
    }

    var streamsKnown = streams.count !== null && streams.count !== undefined;

    return {
      state: state,
      headline: headline,
      action: d.verdict === 'jetstream-disabled'
        ? 'JetStream is enabled in platform/compose/nats/nats-server.conf; restart the nats container after ' +
          'changing it.'
        : null,
      container: containerFromQueues(healthz, findByName(comps, 'monitoring endpoint')),
      working: {
        ok: workingOk,
        text: workingOk === null
          ? 'Not established. The broker answered but the account snapshot did not, and guessing from the ' +
            'half that answered would report a fault nobody observed.'
          : workingOk
            ? 'The ' + account + ' account reports JetStream enabled with its own limits.'
            : (js.accountMessage || 'The account cannot store messages.')
      },
      components: comps.map(function (c) {
        var tone, label;
        if (c.ok === true) { tone = 'ok'; label = 'ok'; }
        else if (c.ok === false) { tone = 'bad'; label = 'failing'; }
        else if (c.reachable === true) { tone = 'idle'; label = 'answers'; }
        else if (c.reachable === false) { tone = 'warn'; label = 'silent'; }
        else { tone = 'idle'; label = 'not a verdict'; }
        return {
          name: c.name,
          tone: tone,
          label: label,
          latencyMs: c.latencyMs === undefined ? null : c.latencyMs,
          detail: c.error || c.detail || ''
        };
      }),
      facts: [
        ['Server', d.server && d.server.name
          ? d.server.name + (d.server.version ? ' ' + d.server.version : '')
          : notMeasured('the server did not report its name')],
        ['Uptime', d.server && d.server.uptime ? String(d.server.uptime) : notMeasured('uptime was not reported')],
        ['Client connections', d.server && d.server.connections !== null && d.server.connections !== undefined
          ? fmt.num(d.server.connections) : notMeasured('the connection count was not reported')],
        ['JetStream account', js.account ? js.account + ' (' + (js.accountState || 'unknown') + ')'
          : notMeasured('no account was reported')],
        ['Streams', streamsKnown ? fmt.num(streams.count)
          : notMeasured('the account snapshot could not be read, so there is no count, not a count of zero')],
        ['Streams without a leader', streamsKnown ? fmt.num(streams.leaderless)
          : notMeasured('this is counted from the same unread snapshot')],
        ['Streams with no max_bytes', streamsKnown ? fmt.num(streams.withoutMaxBytes)
          : notMeasured('this is counted from the same unread snapshot')]
      ],
      notes: notes
    };
  }

  function containerFromQueues(healthz, monitor) {
    if (healthz && healthz.httpStatus !== null && healthz.httpStatus !== undefined) {
      return {
        up: healthz.httpStatus === 200,
        text: '/healthz answered ' + fmt.num(healthz.httpStatus) +
          (healthz.status ? ' "' + healthz.status + '"' : '') +
          '. That is the probe class the container healthcheck uses.'
      };
    }
    if (monitor && monitor.reachable !== undefined && monitor.reachable !== null) {
      return {
        up: !!monitor.reachable,
        text: monitor.reachable
          ? 'The monitoring endpoint answered. /healthz itself was not read.'
          : 'The monitoring endpoint did not answer, and /healthz was not read either.'
      };
    }
    return { up: null, text: 'No liveness probe was made, so there is no container-level signal to show.' };
  }

  function readSecrets(d) {
    var map = {
      unsealed: 'working',
      standby: 'degraded',
      sealed: 'broken',
      'not-initialised': 'broken',
      'not-configured': 'notDeployed',
      'not-deployed': 'notDeployed',
      unreachable: 'unreachable',
      unknown: 'unknown'
    };
    var seal = d.seal || {};
    var ha = d.ha || {};

    return {
      state: map[d.state] || 'unknown',
      headline: d.summary || 'OpenBao returned no summary.',
      detail: d.detail || null,
      action: d.nextAction || null,
      container: {
        up: d.reachable === undefined ? null : !!d.reachable,
        text: d.reachable
          ? 'The vault answered its HTTP API. Its container healthcheck treats a sealed vault as healthy, ' +
            'so this signal stays green through the state that stops every read.'
          : 'Nothing answered at ' + (d.addr || 'the configured address') + '.'
      },
      working: {
        ok: d.usable === undefined ? null : !!d.usable,
        text: d.usable
          ? 'The vault is unsealed, so it can answer a secret request now.'
          : (d.detail || 'The vault cannot answer a secret request in this state.')
      },
      components: (d.endpoints || []).map(function (e) {
        return {
          name: e.name,
          sub: e.path || null,
          tone: e.reachable ? 'idle' : 'warn',
          label: e.reachable ? 'answers' : 'silent',
          latencyMs: e.latencyMs === undefined ? null : e.latencyMs,
          detail: e.error || e.httpStatusMeaning || (e.httpStatus ? 'HTTP ' + e.httpStatus : '')
        };
      }),
      facts: [
        ['Address', d.addr ? el('code.mono', { text: d.addr }) : notMeasured('no address is configured')],
        ['Initialised', tri(d.initialised, 'the vault could not be read')],
        ['Sealed', tri(d.sealed, 'the vault could not be read')],
        ['Seal', seal.measured
          ? fmt.num(seal.threshold) + ' of ' + fmt.num(seal.shares) + ' shares' +
            (seal.type ? ' (' + seal.type + ')' : '')
          : notMeasured(seal.measuredReason || 'the seal was not read')],
        ['Unseal progress', seal.measured && seal.unsealProgress !== null && seal.unsealProgress !== undefined
          ? fmt.num(seal.unsealProgress) + ' of ' + fmt.num(seal.threshold) + ' shares submitted'
          : notMeasured('no unseal is in progress, or the seal was not read')],
        ['Version', d.version || notMeasured('the version was not reported')],
        ['Storage backend', ha.storageType || notMeasured(ha.message || 'the storage type was not reported')],
        ['Leader', ha.available
          ? (ha.leaderKnown ? el('code.mono', { text: ha.leaderAddress }) : 'none right now')
          : notMeasured(ha.message || 'the leader endpoint was not read')],
        ['Clock skew against this console', d.clockSkewSeconds === null || d.clockSkewSeconds === undefined
          ? notMeasured('the vault did not report its own time')
          : fmt.num(d.clockSkewSeconds) + ' s']
      ],
      notes: (d.notes || []).slice()
    };
  }

  function notMeasured(why) {
    return el('span.hint', { text: 'not measured: ' + why });
  }

  function tri(v, why) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    return notMeasured(why);
  }

  function unsealBanner(sandbox, reasonUnknown) {
    var attrs = { id: UNSEAL_ANCHOR, 'data-unseal': sandbox ? (sandbox.banner === false ? 'measured' : 'banner') : 'unverified' };
    if (!sandbox) {
      return el('div.callout.warn', attrs, [
        el('strong', { text: 'Unseal posture not verified' }),
        el('p', { text: (reasonUnknown ? reasonUnknown + ' ' : '') + 'Unknown is not safe.' }),
        ui.disclosure('Details', [
          el('p', {
            text: 'If this vault was initialised in sandbox mode, one key on this machine opens every secret in ' +
              'the estate. Read the seal directly with `docker compose exec openbao bao status` in ' +
              'platform/compose: n=1, t=1 is the sandbox seal.'
          })
        ])
      ]);
    }

    if (sandbox.banner === false) {
      return el('p.hint', attrs, [
        'Unseal posture: ' + String(sandbox.title || 'measured').replace(/\.$/, '') + ', ' +
          (sandbox.basis || 'measured') + '.'
      ]);
    }

    var tone = sandbox.severity === 'critical' ? 'bad'
      : sandbox.severity === 'warning' ? 'warn'
        : sandbox.severity === 'info' ? 'info' : 'ok';

    return el('div.callout.' + tone, attrs, [
      el('strong', { text: String(sandbox.title || 'Unseal posture').replace(/[.]$/, '') }),
      ui.disclosure('Details', [
        sandbox.message ? el('p', { text: sandbox.message }) : null,
        sandbox.action ? el('p', { text: sandbox.action }) : null,
        el('p.hint', {
          text: 'Basis: ' + (sandbox.basis || 'not stated') +
            (sandbox.adr ? '. Required by ' + sandbox.adr : '') +
            '. Configuration asks for ARGUS_UNSEAL_MODE=' + (sandbox.requestedMode || 'unset') +
            (sandbox.requestedModeValid === false ? ', which is not a valid value' : '') + '.'
        }),
        sandbox.keyAtRest === null && sandbox.keyAtRestReason
          ? el('p.hint', { text: sandbox.keyAtRestReason })
          : null
      ])
    ]);
  }

  function writesTile(caps) {
    var spec = caps.writesAllowed === true
      ? { key: 'allowed', value: 'Read-write', status: { tone: 'warn', text: 'ARGUS_ALLOW_WRITES is set' },
          title: 'Actions that alter the stack will reach it. The default is read-only.' }
      : caps.writesAllowed === false
        ? { key: 'refused', value: 'Read-only', status: { tone: 'ok', text: 'Writes refused with 405' },
            title: 'ARGUS_ALLOW_WRITES is not set, so the API refuses every non-GET request before routing it.' }
        : { key: 'unknown', value: 'Unknown', status: { tone: 'warn', text: 'Not reported' },
            title: '/api/capabilities did not report writesAllowed. Treat it as unknown rather than as permitted.' };
    var tile = ui.statTile('Console access', spec.value, { status: spec.status });
    tile.setAttribute('data-writes', spec.key);
    tile.title = spec.title;
    return tile;
  }


  function componentsTable(rows, svc) {
    return ui.table([
      {
        key: 'name', label: 'Component',
        render: function (r) {
          return r.sub
            ? el('div', [el('div', { text: r.name }), el('code.mono', { text: r.sub })])
            : r.name;
        }
      },
      { key: 'label', label: 'Status', status: true, render: function (r) { return ui.pill(r.label, r.tone); } },
      {
        key: 'latencyMs', label: 'Latency', align: 'right',
        render: function (r) { return fmt.ms(r.latencyMs); }
      },
      { key: 'detail', label: 'Detail', render: function (r) { return r.detail || ''; } }
    ], rows, {
      caption: 'Components of ' + svc.name + ', each with the status this console measured for it',
      rowKey: function (r) { return r.name; },
      empty: 'This reader returned no components.'
    });
  }

  function stamp(iso) {
    if (!iso) return 'an unrecorded time';
    return String(iso).replace('T', ' ').slice(0, 19) + 'Z';
  }

  function renderService(svc) {
    return function (body, d) {
      var r = svc.read(d);
      body.setAttribute('data-verdict', r.state);
      body.appendChild(el('div.row', [statePill(r.state), el('span', { text: r.headline })]));

      if (r.action) {
        body.appendChild(el('div.callout.info', [
          el('strong', { text: 'What to do' }),
          el('p', { text: r.action })
        ]));
      }

      body.appendChild(componentsTable(r.components || [], svc));

      var details = [];
      if (r.detail) details.push(el('p', { text: r.detail }));
      details.push(ui.dl([
        r.container ? ['Reachable', el('div.row', [containerPill(r.container.up), el('span', { text: r.container.text })])] : null,
        r.working ? ['Actually working', el('div.row', [
          ui.pill(r.working.ok === null || r.working.ok === undefined ? 'not established'
            : r.working.ok ? 'proved' : 'not working',
          r.working.ok === null || r.working.ok === undefined ? 'idle' : r.working.ok ? 'ok' : 'bad'),
          el('span', { text: r.working.text })
        ])] : null
      ].concat(r.facts || [])));
      (r.notes || []).forEach(function (n) { details.push(el('p.hint', { text: n })); });
      details.push(el('p.hint', { text: 'Why reachable and working differ: ' + svc.difference }));
      details.push(el('p.hint', { text: 'Container probe: ' + svc.containerProbe }));
      details.push(el('p.hint', {
        text: 'Units: ' + svc.unit + '. Measured at ' + stamp(d.at) +
          (d.cachedAt && d.cachedAt !== d.at ? ', cached at ' + stamp(d.cachedAt) : '') + '. Source: ' + svc.path + '.'
      }));
      body.appendChild(ui.disclosure('Details', details));
    };
  }

  function notDeployedBlock(svc) {
    return function (body, env) {
      var v = envelopeVerdict(env, svc) || {};
      var e = (env && env.error) || {};
      var st = A.envelopeState(env);
      body.appendChild(ui.stateBlock(st, {
        reason: e.reason,
        detail: v.headline + (e.message ? ' ' + e.message : '') + ' Start it with `' + svc.start + '` in platform/compose.'
      }));
    };
  }

  function summaryTable(results) {
    return ui.table([
      { key: 'name', label: 'Service' },
      {
        key: 'state', label: 'Status', status: true,
        render: function (r) { return statePill(r.state); }
      },
      {
        key: 'container', label: 'Container probe', status: true,
        render: function (r) { return containerPill(r.containerUp); }
      },
      { key: 'headline', label: 'Last result' }
    ], results, {
      caption: 'Every service this screen reads, with the verdict measured for it and its container-level signal',
      rowKey: function (r) { return r.id; },
      empty: 'No service was read.'
    });
  }

  function summaryLine(ordered) {
    var working = count(ordered, function (r) { return r.state === 'working'; });
    var bad = count(ordered, function (r) { return r.state === 'broken' || r.state === 'unreachable'; });
    var degraded = count(ordered, function (r) { return r.state === 'degraded'; });
    var absent = count(ordered, function (r) { return r.state === 'notDeployed'; });
    var unknown = count(ordered, function (r) { return r.state === 'unknown'; });
    var total = fmt.num(ordered.length);

    if (bad > 0) {
      return { tone: 'bad', text: fmt.num(bad) + ' of ' + total + ' services ' + (bad === 1 ? 'is' : 'are') + ' not working.' +
        (degraded ? ' ' + fmt.num(degraded) + ' degraded.' : '') + (unknown ? ' ' + fmt.num(unknown) + ' not measured.' : '') };
    }
    if (degraded > 0) {
      return { tone: 'warn', text: fmt.num(degraded) + ' of ' + total + ' services ' + (degraded === 1 ? 'is' : 'are') + ' degraded; none is down.' +
        (absent ? ' ' + fmt.num(absent) + ' not deployed.' : '') + (unknown ? ' ' + fmt.num(unknown) + ' not measured.' : '') };
    }
    if (unknown > 0 || absent > 0) {
      return { tone: 'idle', text: fmt.num(working) + ' of ' + total + ' services measured working.' +
        (absent ? ' ' + fmt.num(absent) + ' not deployed.' : '') + (unknown ? ' ' + fmt.num(unknown) + ' not measured.' : '') };
    }
    return { tone: 'ok', text: 'All ' + total + ' services were measured working.' };
  }

  var UPTIME_WINDOWS = [
    { key: 'h24', windowMs: 86400000, label: 'Last 24 hours' },
    { key: 'd7', windowMs: 604800000, label: 'Last 7 days' },
    { key: 'd30', windowMs: 2592000000, label: 'Last 30 days' }
  ];

  function monitorTone(status) {
    if (status === 1) return 'ok';
    if (status === 0) return 'bad';
    if (status === 3) return 'info';
    if (status === 2) return 'warn';
    return 'idle';
  }

  function monitorWord(status) {
    if (status === 1) return 'up';
    if (status === 0) return 'down';
    if (status === 3) return 'in maintenance';
    if (status === 2) return 'pending';
    return 'not measured';
  }

  function uptimeRows(monitor) {
    var beats = monitor.beats || [];
    var coversMs = typeof monitor.coversMs === 'number'
      ? monitor.coversMs
      : ui.uptimeOf(beats, {}).coveredMs;
    var served = monitor.uptime || {};

    return UPTIME_WINDOWS.map(function (w) {
      if (coversMs < w.windowMs * 0.95) {
        return [w.label, ui.pill('not enough history', 'idle', {
          title: 'This console has only ' + fmt.dur(coversMs / 1000) + ' of heartbeats for ' +
            monitor.label + '. A figure for ' + w.label.toLowerCase() + ' would be an extrapolation.'
        })];
      }
      var ratio = typeof served[w.key] === 'number'
        ? served[w.key]
        : ui.uptimeOf(beats, { windowMs: w.windowMs }).ratio;
      if (ratio === null || ratio === undefined) return [w.label, ui.pill('not measured', 'idle')];
      return [w.label, fmt.pct(ratio * 100, 3)];
    });
  }

  function lastStatus(monitor) {
    var beats = monitor.beats || [];
    return beats.length ? beats[beats.length - 1].status : null;
  }

  function historyTable(monitors) {
    return ui.table([
      { key: 'label', label: 'Monitor', render: function (m) { return m.label || m.id; } },
      {
        key: 'status', label: 'Status', status: true,
        sort: function (m) { var st = lastStatus(m); return st === null || st === undefined ? 9 : st; },
        render: function (m) { var st = lastStatus(m); return ui.pill(monitorWord(st), monitorTone(st)); }
      },
      {
        key: 'beats', label: 'Recent checks', sortable: false,
        render: function (m) {
          return ui.heartbeatBar(m.beats || [], {
            slots: 30, width: 180, height: 20,
            label: ui.heartbeatSentence(m.beats || [], { name: m.label || m.id })
          });
        }
      },
      { key: 'h24', label: 'Last 24 h', align: 'right', render: function (m) { return uptimeRows(m)[0][1]; } },
      { key: 'd7', label: 'Last 7 d', align: 'right', render: function (m) { return uptimeRows(m)[1][1]; } },
      {
        key: 'transition', label: 'Last transition',
        render: function (m) {
          var incidents = ui.incidentsOf(m.beats || []);
          var latest = incidents.length ? incidents[incidents.length - 1] : null;
          return latest
            ? 'went ' + latest.toWord + ' from ' + latest.fromWord + (latest.at ? ' at ' + fmt.stamp(new Date(latest.at)) : '')
            : 'none since this console started';
        }
      }
    ], monitors, {
      caption: 'Each heartbeat monitor with its last status, recent checks, uptime over the windows its history covers, and its last transition',
      rowKey: function (m) { return m.id || m.label; },
      empty: 'No monitor is being recorded.'
    });
  }

  function renderBeats(body, payload) {
    var monitors = payload.monitors || [];
    if (!monitors.length) {
      body.appendChild(ui.emptyState('No monitor is being recorded', 'The console API answered, and it is watching nothing.'));
      return;
    }
    var up = count(monitors, function (m) { return lastStatus(m) === 1; });
    var down = count(monitors, function (m) { return lastStatus(m) === 0; });
    var other = monitors.length - up - down;
    body.appendChild(el('p.hint', {
      text: fmt.num(up) + ' of ' + fmt.num(monitors.length) + ' up at their last check' +
        (down ? ', ' + fmt.num(down) + ' down' : '') + (other ? ', ' + fmt.num(other) + ' pending or not yet checked' : '') + '.'
    }));
    body.appendChild(historyTable(monitors));
    var details = [
      el('p.hint', {
        text: 'One slot per check, oldest on the left. A full bar is up, a short bar is a retry that has ' +
          'not yet been counted as a failure, a notched bar is down and a lozenge is planned maintenance. ' +
          'A check only becomes a failure after the retry gate, so a single missed probe does not open an ' +
          'incident.'
      })
    ];
    if (payload.persisted === false) {
      details.unshift(el('p', {
        text: 'This history is held in memory only: the console state volume is mounted read-only, so every ' +
          'heartbeat is lost when the console restarts. Windows longer than the history covers are withheld ' +
          'rather than extrapolated.'
      }));
    }
    body.appendChild(ui.disclosure('Details', details));
  }

  A.screen('stack', {
    title: 'Services',
    crumb: 'Services',
    render: function (mount, ctx) {
      if (ctx && ctx.rest && ctx.rest.length) {
        mount.appendChild(ui.notFound('part of Services', ctx.rest.join('/'), 'stack', 'Back to Services'));
        return;
      }

      var host = el('div');
      var refresh = ui.btn('Refresh', {
        onClick: function () {
          A.forget();
          paint();
          if (A.storeMode() !== A.MODE.LIVE) {
            A.flash('info', 'There is nothing to re-read',
              'The console API is not answering, so this screen has no source to refresh from.');
          }
        }
      });

      mount.appendChild(ui.pageHeader('Services', 'Health of the platform services this console reads.', [refresh], { counter: SERVICES.length }));
      mount.appendChild(host);

      var gen = 0;
      var live = true;
      var dispose = null;
      A.onLeave(function () { live = false; if (dispose) { dispose(); dispose = null; } });

      function paint() {
        gen += 1;
        var mine = gen;
        if (dispose) { dispose(); dispose = null; }
        ui.clear(host);
        A.probe().then(function () {
          if (!(live && mine === gen)) return;
          dispose = A.scopeLeaveHooks(function () {
            build(host, refresh, function () { return live && mine === gen; });
          });
        });
      }

      paint();
    }
  });

  function build(host, refresh, stillMine) {
    var mode = A.storeMode();

    refresh.title = mode === A.MODE.LIVE
      ? 'Discard every cached read and ask the console API again.'
      : 'There is no console API to re-read. Nothing on this screen came from one.';

    if (mode !== A.MODE.LIVE) {
      host.appendChild(ui.stateBlock('sample', {
        detail: 'Services has no fixtures. Run the console API (`npm start` in platform/console/server, or ' +
          '`docker compose up -d` in platform/compose) to read the unseal posture and every service.'
      }));
      return;
    }

    var caps = A.capabilities() || {};
    var layout = el('div.grid');
    host.appendChild(layout);

    var unsealSlot = el('div', [ui.stateBlock('loading', { detail: 'Reading the unseal posture from /api/secrets/health.' })]);
    layout.appendChild(unsealSlot);

    var servicesTile = ui.statTile('Services working', '-', { status: { tone: 'pending', text: 'Reading' } });
    var monitorsTile = ui.statTile('Heartbeat monitors up', '-', { status: { tone: 'pending', text: 'Reading' } });
    var tiles = el('div.tiles', [servicesTile, monitorsTile, writesTile(caps)]);
    tiles.style.setProperty('margin-bottom', '0');
    layout.appendChild(tiles);

    var summaryBody = el('div.livepanel', { 'data-state': 'loading', 'data-path': 'summary' }, [ui.skeleton(SERVICES.length + 1)]);
    layout.appendChild(ui.card('Service health', summaryBody, { counter: SERVICES.length }));

    SERVICES.forEach(function (svc) {
      var on = { notConfigured: notDeployedBlock(svc) };
      layout.appendChild(A.livePanel(svc.name, svc.path, renderService(svc), { ttlMs: 5000, on: on }));
    });

    layout.appendChild(A.livePanel('Service heartbeats', '/api/heartbeats', renderBeats, { ttlMs: 5000 }));

    var pending = true;
    A.state.pendingPanels += 1;
    function release() {
      if (!pending) return;
      pending = false;
      A.state.pendingPanels = Math.max(0, A.state.pendingPanels - 1);
      A.state.renderedGen += 1;
    }
    A.onLeave(release);

    function replaceTile(old, label, value, status) {
      var next = ui.statTile(label, value, { status: status });
      if (old.parentNode) old.parentNode.replaceChild(next, old);
      return next;
    }

    var paths = SERVICES.map(function (svc) { return svc.path; }).concat(['/api/heartbeats']);
    Promise.all(paths.map(function (p) {
      return A.read(p, { ttlMs: 5000 }).then(null, function (err) {
        return { ok: false, data: null, mode: A.MODE.LIVE, at: Date.now(), error: err || {} };
      });
    })).then(function (all) {
      if (!stillMine()) { release(); return; }
      var envs = all.slice(0, SERVICES.length);
      var beatsEnv = all[SERVICES.length];
      var results = SERVICES.map(function (svc, i) {
        var env = envs[i];
        var r;
        try {
          r = envelopeVerdict(env, svc) || svc.read(env.data);
        } catch (err) {
          r = { state: 'unknown', headline: 'The payload from ' + svc.path + ' could not be drawn, so nothing was established.' };
        }
        return { id: svc.id, name: svc.name, state: r.state, headline: r.headline, containerUp: r.container ? r.container.up : null, env: env };
      });

      var secretsEnv = envs[SERVICES.length - 1];
      var sandbox = secretsEnv && secretsEnv.ok && secretsEnv.data ? secretsEnv.data.sandbox : null;
      var secretsVerdict = envelopeVerdict(secretsEnv, SERVICES[SERVICES.length - 1]);
      ui.clear(unsealSlot);
      unsealSlot.appendChild(unsealBanner(sandbox, sandbox ? null : (secretsVerdict ? secretsVerdict.headline : null)));

      var line = summaryLine(results);
      var working = count(results, function (r) { return r.state === 'working'; });
      replaceTile(servicesTile, 'Services working', fmt.num(working) + ' of ' + fmt.num(results.length), {
        tone: line.tone === 'idle' ? 'idle' : line.tone,
        text: line.tone === 'ok' ? 'All working' : line.tone === 'bad' ? 'Not working' : line.tone === 'warn' ? 'Degraded' : 'Not all measured'
      });

      var monitors = beatsEnv && beatsEnv.ok && beatsEnv.data ? (beatsEnv.data.monitors || []) : null;
      if (monitors) {
        var up = count(monitors, function (m) { return lastStatus(m) === 1; });
        var down = count(monitors, function (m) { return lastStatus(m) === 0; });
        replaceTile(monitorsTile, 'Heartbeat monitors up', fmt.num(up) + ' of ' + fmt.num(monitors.length), {
          tone: down ? 'bad' : up === monitors.length ? 'ok' : 'warn',
          text: down ? fmt.num(down) + ' down' : up === monitors.length ? 'All up' : 'Some pending'
        });
      } else {
        replaceTile(monitorsTile, 'Heartbeat monitors up', '-', { tone: 'idle', text: 'Not read' });
      }

      ui.clear(summaryBody);
      summaryBody.setAttribute('data-state', 'ok');
      summaryBody.setAttribute('data-verdict', line.tone);
      summaryBody.setAttribute('title', line.text);
      summaryBody.appendChild(summaryTable(results));
      summaryBody.appendChild(ui.disclosure('Details', [
        el('p.hint', {
          text: 'This screen reads ' + fmt.num(SERVICES.length) + ' services. It is not an inventory of the ' +
            'stack: anything without a reader here (the cache, the observability profile, the connect ' +
            'profile) is absent from this table and has not been checked by it.'
        }),
        el('p.hint', {
          text: 'The container probe is the weakest evidence here and is never green. Each of these services ' +
            'has a documented state in which its container probe passes and the service cannot do its job.'
        })
      ]));
      var readAt = new Date(Math.min.apply(null, envs.map(function (e) { return (e && e.at) || Date.now(); })));
      summaryBody.appendChild(el('p.readstamp', { 'data-read-at': readAt.toISOString(), text: 'Read ' + fmt.clock(readAt) }));
      release();
    });
  }
})();
