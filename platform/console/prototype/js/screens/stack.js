/* Argus Console: Stack operations.
 *
 * The screen an operator opens to answer one question -- is the stack healthy,
 * and if not, which part -- and to be told honestly when the answer is "we do
 * not know yet".
 *
 * It aggregates the health summaries the console API exposes: the object store
 * today, and PostgreSQL, the queues and the vault as each reader is wired in.
 * Four rules govern everything below, and each exists because the obvious
 * version of this screen is actively misleading during an incident.
 *
 * NOT DEPLOYED IS NOT A FAILURE. A service whose reader is not mounted answers
 * 404, and an aggregating dashboard that paints 404 red teaches an operator to
 * ignore red. This stack is built in increments; at any moment some of it does
 * not exist yet, and a screen that cannot say so calmly is a screen that lies
 * about the increments that do exist. Every not-deployed panel carries the
 * command that would change the answer.
 *
 * CONTAINER HEALTH IS SECONDARY AND IS LABELLED. Every service here has a
 * liveness probe that answers "the process is listening", and for every one of
 * them there is a real, documented state where that probe is green and the
 * service is useless: a sealed vault, an S3 gateway with no identities loaded,
 * a NATS server with JetStream disabled, a postmaster that accepts TCP while
 * this console's role cannot read a single statistic. So the container-class
 * signal never renders green and never leads. The verdict comes from a
 * measurement of the thing an application actually needs.
 *
 * UNKNOWN STAYS UNKNOWN. `usable: null` from the queues reader means nothing
 * was established either way, and it renders differently from `false`. A stream
 * count of zero taken from a snapshot that failed is not a count. A `writable`
 * flag computed from a topology the master never returned is not a fact. Where
 * the payload cannot distinguish the two, this screen gates the field on the
 * probe that would have measured it, rather than printing the default.
 *
 * TWO WARNINGS ARE PERMANENT, NOT FOOTNOTES. If one key on this machine opens
 * every secret in the estate, that is the first thing on the page and it is
 * red. If the console is read-only, that is stated at the top too, because
 * every disabled control on every screen is explained by it and an operator
 * hunting for a permission problem should not have to find that out by
 * clicking. Neither banner may vanish when a read fails: an absent warning
 * reads as a safe one.
 */
(function () {
  'use strict';

  var A = window.ARGUS, ui = A.ui, el = ui.el, fmt = ui.fmt;

  function registerScreen(id, def) {
    if (typeof A.screen === 'function') { A.screen(id, def); return; }
    document.addEventListener('DOMContentLoaded', function () { A.screen(id, def); });
  }

  /* ------------------------------------------------------------ vocabulary --- */

  /* Six states, not two.
   *
   * "up/down" cannot express the three answers this screen is most often
   * required to give: the service is reachable and cannot do its job, the
   * service was never deployed, and nothing was measured. Each of those leads
   * to a different action, and collapsing them into a red dot destroys the
   * only information the operator came for. */
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

  /* The container-class pill is deliberately never green.
   *
   * Green is reserved on this screen for something that was proved to work.
   * A liveness probe proves a process answered, which is a different and much
   * weaker claim -- and rendering the two in the same colour is exactly how an
   * operator ends up reporting a healthy stack while nothing can write to it. */
  function containerPill(up, why) {
    if (up === null || up === undefined) return ui.pill('container: not probed', 'idle', { title: why || '' });
    return ui.pill('container: ' + (up ? 'answers' : 'silent'), up ? 'idle' : 'warn', { title: why || '' });
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

  /* ------------------------------------------------------------- services ---- */

  /*
   * One descriptor per service.
   *
   * `difference` is the sentence that explains, for this specific service, why
   * "it answered" and "it works" are not the same question. It is the reason
   * the two rows above every components table exist.
   *
   * `containerProbe` quotes the healthcheck this stack actually declares in
   * platform/compose/docker-compose.yml, together with the state it is known to
   * miss. The console cannot read Docker's own health verdict -- it is given no
   * socket, deliberately -- so this is never presented as one; it names the
   * probe so an operator knows what a green container in `docker compose ps`
   * would and would not have established.
   */
  var SERVICES = [
    {
      id: 'storage',
      name: 'Object store',
      unit: 'seaweed-master, seaweed-volume, seaweed-filer, seaweed-s3',
      path: '/api/storage/health',
      start: 'docker compose up -d',
      difference:
        'A SeaweedFS component answering /dir/status or /healthz proves a process is listening on a port. ' +
        'Only a SIGNED S3 call proves the gateway has loaded its identities, accepted this console\'s ' +
        'signature and agreed with it about the clock -- and that is the one an application needs.',
      containerProbe:
        'seaweed-s3 is healthchecked by fetching its /metrics port, and docker-compose.yml labels that ' +
        'LIVENESS ONLY: with identities loaded there is no unauthenticated S3 path that means "ready", so ' +
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
        'and nothing more -- it does not authenticate, so it stays green through a grants file that was ' +
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
        'with JetStream disabled still answers /healthz with 200 ok -- so persistence has to be established ' +
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
        'HEALTHY on purpose -- marking it unhealthy would stop everything gated on it and hand the operator ' +
        'a blank page instead of the words "OpenBao is sealed".',
      read: readSecrets
    }
  ];

  /* ------------------------------------------------------- envelope states --- */

  /*
   * Turn a store envelope into a verdict, before any service-specific reading.
   *
   * The distinction that matters here is between a failure of the SERVICE and a
   * failure of the READ. A 404 says this console build has no reader mounted at
   * that path; it says nothing whatsoever about the service, and rendering it
   * as an outage would send somebody to restart a container that is fine. A
   * timeout talking to the console API is the same class of non-answer. Only a
   * reader that ran and reported a reason is evidence about the service.
   */
  function envelopeVerdict(env, svc) {
    var err = env.error || {};

    /* No body came back at all: this is about the console API, not the stack. */
    if (!env.data) {
      if (err.reason === 'http-404') {
        return {
          state: 'notDeployed',
          headline: 'This console build has no reader for ' + svc.name + ': the API answered 404 for ' +
            svc.path + '.',
          action: 'The service itself is started with `' + svc.start + '` in platform/compose. The route ' +
            'appears here when the console image is rebuilt with its reader mounted; until then nothing ' +
            'about ' + svc.unit + ' has been measured by this screen.'
        };
      }
      return {
        state: 'unknown',
        headline: 'The console API did not answer for ' + svc.name + '.',
        detail: err.message || 'No reason was given.',
        action: 'This is a statement about the console API, not about ' + svc.unit + '. Nothing here has ' +
          'been established about the service itself.'
      };
    }

    /* A reader ran and could not form an answer. Its reason is evidence. */
    if (env.data.ok === false) {
      var reason = env.data.reason || err.reason || 'error';
      var message = env.data.message || err.message || 'No reason was given.';
      if (reason === 'not-configured') {
        return {
          state: 'notDeployed',
          headline: 'The console is not configured to reach ' + svc.name + '.',
          detail: message,
          action: 'Set the environment for it on the console service and restart it. ' +
            'docker-compose.yml already sets these for the in-network stack.'
        };
      }
      if (reason === 'not-deployed') {
        return {
          state: 'notDeployed',
          headline: svc.name + ' is not running on this stack.',
          detail: message,
          action: 'Start it with `' + svc.start + '` in platform/compose.'
        };
      }
      if (reason === 'unreachable' || reason === 'timeout') {
        return {
          state: 'unreachable',
          headline: svc.name + ' did not answer.',
          detail: message,
          action: 'Check `docker compose ps ' + svc.unit.split(',')[0].trim() + '` and its logs in ' +
            'platform/compose.'
        };
      }
      return { state: 'unknown', headline: 'The ' + svc.name + ' reader could not answer.', detail: message };
    }

    return null;   // a real payload: the service-specific reader takes it from here
  }

  /* ---------------------------------------------------------------- storage -- */

  function readStorage(d) {
    var comps = d.components || [];
    var reachable = count(comps, function (c) { return c.reachable; });
    var master = findByName(comps, 'master');
    /* `writable` and `topologyReachable` are computed from the master's
       topology, and both come back false when the master never answered. A
       false that means "we could not read it" is the same defect as a zero
       that means it, so neither is printed unless the master was reached. */
    var topologyKnown = !!(master && master.reachable);
    var s3 = d.s3 || {};

    var state, headline;
    if (s3.signedCallOk) {
      state = 'working';
      headline = 'A signed S3 call succeeded, so the gateway is up, it has loaded its identities and it ' +
        'accepted this console\'s signature.';
    } else if (reachable > 0) {
      state = 'broken';
      headline = reachable + ' of ' + comps.length + ' components answer, but a signed S3 call does not. ' +
        'This is the combination a liveness probe cannot see.';
    } else if (comps.length) {
      state = 'unreachable';
      headline = 'No SeaweedFS component answered, so the object store is not reachable from the console.';
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
          ? 'A signed ListObjectsV2 against a declared bucket returned.'
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
          ? (d.writable ? 'yes, for some collection' : 'no -- the master has no writable volume')
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

  /* --------------------------------------------------------------------- pg -- */

  function readPg(d) {
    var comps = d.components || [];
    var failing = names(comps, function (c) { return c.ok === false; });
    var unmeasured = count(comps, function (c) { return c.ok === null || c.ok === undefined; });

    var state = d.degraded ? 'degraded' : 'working';
    var headline = d.degraded
      ? 'PostgreSQL is answering, but these checks are failing: ' + failing + '.'
      : 'The console opened a connection and the cluster answered its own statistics query.';

    return {
      state: state,
      headline: headline,
      action: null,
      container: {
        /* Reaching this branch at all required a query to return, so the
           TCP-level claim is established -- but it is still shown as the weaker
           signal it is, because it is the one that stays green through every
           failure listed in the table below. */
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
        /* Tri-state, and null is NOT green. The replication check reports null
           on a single-node cluster on purpose: there is no replica, and a
           green tick beside a lag that was never measured is the worst
           possible rendering of that. */
        var tone = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'idle';
        var label = c.ok === true ? 'ok' : c.ok === false ? 'failing' : 'not a verdict';
        return {
          name: c.name,
          tone: tone,
          label: label,
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
        ? [unmeasured + ' of these checks returned no verdict. They are rendered as "not a verdict" rather ' +
           'than as passes: an unknown is not a fault, and it is not a pass either.']
        : []
    };
  }

  /* ----------------------------------------------------------------- queues -- */

  function readQueues(d) {
    var comps = d.components || [];
    var js = d.jetstream || {};
    var streams = d.streams || {};
    var healthz = d.healthz || null;

    /* The reader's own four-state verdict is used as given. Recomputing it here
       from the parts would create a second opinion that drifts from the one the
       alerting will be wired to. */
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
      headline = 'JetStream is enabled server-wide and the ' + (js.account || 'agents') +
        ' account can use it, so a message published here can be stored.';
    } else if (d.verdict === 'degraded') {
      headline = 'The account can store messages, but something under it is not right' +
        (streams.leaderless ? ': ' + fmt.num(streams.leaderless) + ' stream(s) have no leader' : '') + '.';
    } else if (d.verdict === 'jetstream-disabled') {
      headline = 'The broker is running with JetStream disabled, so nothing published here is persisted.';
    } else if (d.verdict === 'account-unusable') {
      headline = 'The broker is up and JetStream is enabled, but the ' + (js.account || 'agents') +
        ' account cannot use it. This is the failure that is invisible from every other signal.';
    } else if (d.verdict === 'unreachable') {
      headline = d.message || 'The broker did not answer its monitoring endpoint.';
    } else {
      headline = 'The broker answered, but the JetStream account could not be read, so whether the queues ' +
        'work was not established either way.';
    }

    /* usable is a THREE-valued field and the reader means it: null is "nothing
       was established", which must not render as the same thing as false. */
    var workingOk = d.usable === null || d.usable === undefined ? null : !!d.usable;

    var notes = [];
    if (d.healthzCaveat) notes.push(d.healthzCaveat);
    if (js.accountMessage) notes.push(js.accountMessage);
    if (healthz && healthz.errors && healthz.errors.length) {
      healthz.errors.forEach(function (e) {
        notes.push('/healthz names a broken asset: ' +
          [e.type, e.account, e.stream, e.consumer].filter(Boolean).join(' / ') +
          (e.error ? ' -- ' + e.error : ''));
      });
    }

    /* Every one of these counters is computed from a stream snapshot that is
       EMPTY when the account could not be read, so each would report a
       confident zero for a list that was never fetched. They are shown only
       when the count itself was measured. */
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
            ? 'The ' + (js.account || 'agents') + ' account reports JetStream enabled with its own limits.'
            : (js.accountMessage || 'The account cannot store messages.')
      },
      components: comps.map(function (c) {
        /* Two different fields, and they are not interchangeable: `reachable`
           is the liveness class, `ok` is the functional verdict. A component
           that carries only reachability never gets a green pill. */
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
          : notMeasured('the account snapshot could not be read, so there is no count -- not a count of zero')],
        ['Streams without a leader', streamsKnown ? fmt.num(streams.leaderless)
          : notMeasured('this is counted from the same unread snapshot')],
        ['Streams with no max_bytes', streamsKnown ? fmt.num(streams.withoutMaxBytes)
          : notMeasured('this is counted from the same unread snapshot')]
      ],
      notes: notes
    };
  }

  /*
   * The container-class signal for the queues, from /healthz if it was read.
   *
   * If neither /healthz nor the monitoring endpoint produced an answer, the
   * signal is null -- not "silent". Those are different claims: one says the
   * broker did not answer, the other says nothing was asked.
   */
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

  /* ---------------------------------------------------------------- secrets -- */

  function readSecrets(d) {
    /* The wording comes from the reader that made the measurement. Composing a
       second set of sentences here would give the console two descriptions of
       one fact, and they would drift. */
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
    var state = map[d.state] || 'unknown';
    var seal = d.seal || {};
    var ha = d.ha || {};

    return {
      state: state,
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
        /* Never "0 of 0". Before `bao operator init` there is no seal, and
           OpenBao reports that absence as n=0, t=0 -- the reader carries null
           for exactly this reason and the screen must not undo it. */
        ['Seal', seal.measured
          ? fmt.num(seal.threshold) + ' of ' + fmt.num(seal.shares) + ' shares' +
            (seal.type ? ' (' + seal.type + ')' : '')
          : notMeasured(seal.measuredReason || 'the seal was not read')],
        ['Unseal progress', seal.measured && seal.unsealProgress !== null && seal.unsealProgress !== undefined
          ? fmt.num(seal.unsealProgress) + ' of ' + fmt.num(seal.threshold) + ' shares submitted'
          : notMeasured('no unseal is in progress, or the seal was not read')],
        ['Version', d.version || notMeasured('the version was not reported')],
        ['Storage backend', ha.storageType || notMeasured(ha.message || 'the storage type was not reported')],
        /* An empty leader address is OpenBao saying there is no leader right
           now, which is a real state and not a missing field -- so it is
           spelled out rather than falling through to "not measured". */
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

  /* ---------------------------------------------------------------- helpers -- */

  /* One phrasing for "we did not measure this", always carrying the reason.
     A dash on its own is indistinguishable from a value of zero at a glance. */
  function notMeasured(why) {
    return el('span.hint', { text: 'not measured -- ' + why });
  }

  function tri(v, why) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    return notMeasured(why);
  }

  /* ----------------------------------------------------------- the banners --- */

  /**
   * The unseal-posture banner.
   *
   * Rendered from the reader's own verdict when there is one, and rendered as
   * an explicit "not verified" when there is not. It never disappears: a banner
   * that is absent while nothing has been checked is read as a statement that
   * everything is fine, which is the opposite of what is known.
   */
  function unsealBanner(sandbox, reasonUnknown) {
    if (!sandbox) {
      return el('div.callout.warn', [
        el('strong', { text: 'The unseal posture of this estate has NOT been verified.' }),
        el('p', {
          text: (reasonUnknown ? reasonUnknown + ' ' : '') +
            'Nothing here is a statement about safety. If this vault was initialised in sandbox mode, one ' +
            'key on this machine opens every secret in the estate and this console has not been able to ' +
            'find out. Unknown is not safe.'
        }),
        el('p.hint', {
          text: 'Read the seal directly: `docker compose exec openbao bao status` in platform/compose. ' +
            'n=1, t=1 is the sandbox seal.'
        })
      ]);
    }

    /* The reader decides whether this warrants a permanent banner, and the one
       case where it says no is a MEASURED multi-share seal -- the good news. It
       is still stated, as one line rather than as a box: a screen that shows
       nothing at all there gives an operator no way to tell "measured, and it
       is a ceremony seal" apart from "this screen forgot to check". */
    if (sandbox.banner === false) {
      return el('p.hint', {
        text: 'Unseal posture: ' + String(sandbox.title || 'measured').replace(/\.$/, '') +
          ' -- ' + (sandbox.basis || 'measured') + '. That rules out the 1-of-1 sandbox seal and nothing ' +
          'more: this console cannot see where those shares are held.'
      });
    }

    /* Tone follows the reader's severity. `critical` is the measured 1-of-1
       seal and it is the only red thing on this screen that is not an outage,
       because it is worse than one: an outage ends. */
    var tone = sandbox.severity === 'critical' ? 'bad'
      : sandbox.severity === 'warning' ? 'warn'
        : sandbox.severity === 'info' ? 'info' : 'ok';

    var box = el('div.callout.' + tone, [
      el('strong', { text: sandbox.title || 'Unseal posture' }),
      sandbox.message ? el('p', { text: sandbox.message }) : null,
      sandbox.action ? el('p', { text: sandbox.action }) : null,
      el('p.hint', {
        text: 'Basis: ' + (sandbox.basis || 'not stated') +
          (sandbox.adr ? '. Required by ' + sandbox.adr : '') +
          '. Configuration asks for ARGUS_UNSEAL_MODE=' + (sandbox.requestedMode || 'unset') +
          (sandbox.requestedModeValid === false ? ', which is not a valid value' : '') + '.'
      }),
      /* The console cannot see the key file itself and says so rather than
         implying the seal numbers were the whole investigation. */
      sandbox.keyAtRest === null && sandbox.keyAtRestReason
        ? el('p.hint', { text: sandbox.keyAtRestReason })
        : null
    ]);
    return box;
  }

  /** Why every control that changes anything is inert, stated once, at the top. */
  function writesBanner(caps) {
    if (caps.writesAllowed === true) {
      return el('div.callout.warn', [
        el('strong', { text: 'This console is permitted to make changes (ARGUS_ALLOW_WRITES is set).' }),
        el('p', {
          text: 'Actions that alter the stack will reach it. The default for this deployment is read-only, ' +
            'so this is a deliberate setting somebody made.'
        })
      ]);
    }
    if (caps.writesAllowed === false) {
      return el('div.callout.info', [
        el('strong', { text: 'This console is read-only, so nothing on this screen can change the stack.' }),
        el('p', {
          text: 'ARGUS_ALLOW_WRITES is not set. The API refuses every non-GET request with 405 before it ' +
            'even looks up a route, so an action here cannot fail halfway -- it never starts. That is why ' +
            'this screen offers diagnosis and commands to run rather than buttons.'
        }),
        el('p.hint', {
          text: 'To change it: set ARGUS_ALLOW_WRITES=1 for the console service in platform/compose and ' +
            'recreate the container. Read the runbook first; it is off by default on purpose.'
        })
      ]);
    }
    return el('div.callout.warn', [
      el('strong', { text: 'Whether this console may make changes is not known.' }),
      el('p', {
        text: '/api/capabilities did not report writesAllowed, so this screen cannot say whether an action ' +
          'would be refused. Treat it as unknown rather than as permitted.'
      })
    ]);
  }

  /* ------------------------------------------------------------ the panels --- */

  function verdictBlock(v, svc) {
    var rows = [
      el('div.row', [statePill(v.state), el('strong', { text: v.headline })])
    ];
    if (v.detail) rows.push(el('p', { text: v.detail }));

    /* Reachable and working, side by side, with the sentence that says why
       this particular service can be one without the other. */
    if (v.container || v.working) {
      rows.push(ui.dl([
        v.container ? ['Reachable', el('div.row', [containerPill(v.container.up, svc.containerProbe),
          el('span', { text: v.container.text })])] : null,
        v.working ? ['Actually working', el('div.row', [
          ui.pill(v.working.ok === null || v.working.ok === undefined ? 'not established'
            : v.working.ok ? 'proved' : 'not working',
          v.working.ok === null || v.working.ok === undefined ? 'idle' : v.working.ok ? 'ok' : 'bad'),
          el('span', { text: v.working.text })
        ])] : null
      ]));
      rows.push(el('p.hint', { text: 'Why these differ: ' + svc.difference }));
      rows.push(el('p.hint', { text: 'Container probe: ' + svc.containerProbe }));
    }

    if (v.action) {
      rows.push(el('div.callout.info', [
        el('strong', { text: 'What to do' }),
        el('p', { text: v.action })
      ]));
    }
    return el('div.stack', rows);
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
        /* fmt.ms renders null as a dash rather than as 0 ms. A component that
           was never timed and a component that answered instantly must not
           look the same. */
        render: function (r) { return fmt.ms(r.latencyMs); }
      },
      { key: 'detail', label: 'Detail', render: function (r) { return r.detail || ''; } }
    ], rows, {
      caption: 'Components of ' + svc.name + ', each with the status this console measured for it',
      rowKey: function (r) { return r.name; },
      empty: 'This reader returned no components.'
    });
  }

  function renderService(body, svc, env) {
    ui.clear(body);

    var v = envelopeVerdict(env, svc);
    if (v) {
      /* A not-deployed or unanswered service gets the same structure as a live
         one -- verdict, reason, next step -- and deliberately not an error box
         with a Try Again button, which would offer to retry something that
         cannot succeed until somebody runs a command. */
      body.appendChild(el('div.row', [statePill(v.state), el('strong', { text: v.headline })]));
      if (v.detail) body.appendChild(el('p', { text: v.detail }));
      if (v.action) {
        body.appendChild(el('div.callout.info', [
          el('strong', { text: 'What to run' }),
          el('p', { text: v.action })
        ]));
      }
      body.appendChild(el('p.hint', {
        text: 'Nothing at all was measured for ' + svc.unit + '. This panel is short because there is ' +
          'nothing to show, not because everything is fine.'
      }));
      return v;
    }

    var d = env.data;
    var r = svc.read(d);

    if (env.stale) {
      body.appendChild(el('div.callout.warn', [
        el('strong', { text: 'Showing the last value that could be read.' }),
        el('p', {
          text: 'A fresh read failed' + (env.error && env.error.message ? ': ' + env.error.message : '.') +
            ' Everything below was measured earlier and may no longer be true.'
        })
      ]));
    }

    body.appendChild(verdictBlock(r, svc));

    body.appendChild(el('div.sectiontitle', { text: 'Components' }));
    body.appendChild(componentsTable(r.components || [], svc));

    if (r.facts && r.facts.length) {
      body.appendChild(el('div.sectiontitle', { text: 'What was read' }));
      body.appendChild(ui.dl(r.facts));
    }

    (r.notes || []).forEach(function (n) { body.appendChild(el('p.hint', { text: n })); });

    /* Every figure on this screen carries the age of the read it came from.
       A number without an age is a number an operator trusts for longer than
       they should. */
    body.appendChild(el('p.hint', {
      text: 'Measured at ' + stamp(d.at) + (d.cachedAt && d.cachedAt !== d.at ? ', cached at ' + stamp(d.cachedAt) : '') +
        '. Source: ' + svc.path + '.'
    }));

    return r;
  }

  function stamp(iso) {
    if (!iso) return 'an unrecorded time';
    return String(iso).replace('T', ' ').slice(0, 19) + 'Z';
  }

  /* ------------------------------------------------------------- the table --- */

  function summaryTable(results) {
    return ui.table([
      { key: 'name', label: 'Service' },
      {
        key: 'state', label: 'Verdict', status: true,
        render: function (r) { return statePill(r.state); }
      },
      {
        key: 'container', label: 'Container', status: true,
        /* Present, because a silent process is worth knowing about -- and last
           but one, small, and never green, because it is the weakest evidence
           on the screen. */
        render: function (r) { return containerPill(r.containerUp, r.containerWhy); }
      },
      { key: 'headline', label: 'What was measured' }
    ], results, {
      caption: 'Every service this screen reads, with the verdict measured for it and its container-level signal',
      rowKey: function (r) { return r.id; },
      empty: 'No service was read.'
    });
  }

  /* ---------------------------------------------------------------- screen --- */

  registerScreen('stack', {
    title: 'Stack operations',
    crumb: 'Operations',
    render: function (mount, ctx) {
      var host = el('div');

      var refresh = ui.btn('Refresh', {
        onClick: function () {
          /* Not A.go('stack'): the hash is already #/ops, assigning the same
             value fires no hashchange, and the button would do nothing at all.
             The screen repaints itself instead, which also works from a deep
             link. */
          A.forget();
          paint();
          /* With no API there is nothing to re-read, and repainting the same
             words is indistinguishable from a frozen console -- so the button
             answers instead of pretending. It stays enabled rather than being
             greyed out, because the reason has to be readable by somebody on a
             touch screen who cannot hover a tooltip. */
          if (A.storeMode() !== A.MODE.LIVE) {
            A.flash('info', 'There is nothing to re-read',
              'The console API is not answering, so this screen has no source to refresh from.');
          }
        }
      });

      mount.appendChild(ui.pageHeader(
        'Stack operations',
        'Is the stack healthy, and if not, which part. Everything here is read live from the console API; ' +
          'a service that is not deployed yet says so rather than showing an empty panel.',
        [refresh]));

      mount.appendChild(host);

      /* A deep link from the fixture console -- the command palette still
         offers ops/runbook/<id> -- lands here. Saying so is better than
         silently ignoring the rest of the URL and letting somebody believe
         they are looking at the runbook they asked for. */
      if (ctx && ctx.rest && ctx.rest.length) {
        mount.insertBefore(el('div.callout.info', [
          el('strong', { text: 'That link points at a screen this one replaced.' }),
          el('p', {
            text: 'This screen now reads the live stack rather than the runbook fixtures, so "' +
              ctx.rest.join('/') + '" no longer resolves to anything. The stack verdict is below.'
          })
        ]), host);
      }

      /* Generation counter, not a single alive flag: Refresh repaints in place,
         and a read still in flight from the previous paint must not write its
         result into nodes that have been replaced. */
      var gen = 0;
      var live = true;
      A.onLeave(function () { live = false; });

      function paint() {
        gen += 1;
        var mine = gen;
        ui.clear(host);
        /* Whether there is an API at all has to be found out, so the screen is
           built after the probe rather than guessing from a mode that is still
           'unknown' on the first paint. */
        A.probe().then(function () {
          if (live && mine === gen) build(host, refresh, function () { return live && mine === gen; });
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
      /* Sample mode is not a degraded version of this screen; there is nothing
         to degrade. Every verdict here is a measurement, and without the API
         not one of them exists -- including the unseal posture, which is said
         out loud so the missing banner is not read as an all-clear. */
      host.appendChild(el('div.callout.warn', [
        el('strong', { text: 'The console API is not running, so nothing on this screen has been measured.' }),
        el('p', {
          text: 'This screen has no fixtures and will not invent any. Start the API with `npm start` in ' +
            'platform/console/server, or bring the stack up with `docker compose up -d` in ' +
            'platform/compose, and reload.'
        }),
        el('p', {
          text: 'That includes the two warnings this screen exists to carry: whether one unseal key on this ' +
            'machine opens every secret in the estate, and whether this console may change anything, are ' +
            'both unknown right now. Neither absence means no.'
        })
      ]));
      return;
    }

    var caps = A.capabilities() || {};

    /* Banners first and always, in a container of their own so a later read
       can replace the unseal one in place without touching anything else. */
    var banners = el('div');
    host.appendChild(banners);
    banners.appendChild(writesBanner(caps));

    var unsealSlot = el('div', [
      el('div.callout.info', [
        el('strong', { text: 'Checking the unseal posture of this estate...' }),
        el('p', { text: 'Reading /api/secrets/health. Until it answers, nothing about the seal is known.' })
      ])
    ]);
    banners.appendChild(unsealSlot);

    var summaryBody = el('div', [ui.skeleton(SERVICES.length + 1)]);
    host.appendChild(ui.card('Stack verdict', summaryBody));

    var results = [];
    var pending = SERVICES.length;

    SERVICES.forEach(function (svc) {
      var body = el('div', [ui.skeleton(3)]);
      host.appendChild(ui.card(svc.name + '  ·  ' + svc.unit, body));

      A.read(svc.path, { ttlMs: 5000 }).then(function (env) {
        if (!stillMine()) return;

        var r;
        /*
         * These readers are still being written, and a payload whose shape has
         * moved must not take the whole screen with it. An exception here is a
         * fault in THIS file, and it is reported as one -- against this panel,
         * with the summary and the other three services left intact. Without
         * the catch, `pending` would never reach zero and the stack verdict
         * would sit on a skeleton for ever with no error anywhere.
         */
        try {
          r = renderService(body, svc, env);
        } catch (err) {
          ui.clear(body);
          body.appendChild(ui.errorState(
            'This console could not read the ' + svc.name + ' health payload',
            'The service may be perfectly healthy: this is a fault in the console screen, not a measurement ' +
              'of ' + svc.unit + '. ' + String(err && err.message ? err.message : err),
            null));
          r = {
            state: 'unknown',
            headline: 'The payload from ' + svc.path + ' could not be rendered, so nothing was established.',
            container: null
          };
        }

        results.push({
          id: svc.id,
          name: svc.name,
          state: r.state,
          headline: r.headline,
          containerUp: r.container ? r.container.up : null,
          containerWhy: svc.containerProbe
        });

        if (svc.id === 'secrets') {
          ui.clear(unsealSlot);
          /* The verdict object the reader publishes for exactly this purpose.
             When the read never produced one -- not deployed, unreachable, or
             a 404 -- the banner states that it was not verified, which is a
             different warning from "it is a sandbox" and is rendered as one. */
          var sandbox = env.data && env.data.ok !== false ? env.data.sandbox : null;
          unsealSlot.appendChild(unsealBanner(sandbox, sandbox ? null : reasonFor(env, svc)));
        }

        pending -= 1;
        if (pending === 0) paintSummary();
      });
    });

    function reasonFor(env, svc) {
      var v = envelopeVerdict(env, svc);
      if (!v) return null;
      return v.headline + (v.detail ? ' ' + v.detail : '');
    }

    function paintSummary() {
      if (!stillMine()) return;
      ui.clear(summaryBody);

      /* Ordered as SERVICES is, so the same screen twice reads the same way
         whatever order the four requests happened to land in. */
      var ordered = [];
      SERVICES.forEach(function (svc) {
        results.forEach(function (r) { if (r.id === svc.id) ordered.push(r); });
      });

      var working = count(ordered, function (r) { return r.state === 'working'; });
      var bad = count(ordered, function (r) { return r.state === 'broken' || r.state === 'unreachable'; });
      var degraded = count(ordered, function (r) { return r.state === 'degraded'; });
      var absent = count(ordered, function (r) { return r.state === 'notDeployed'; });
      var unknown = count(ordered, function (r) { return r.state === 'unknown'; });

      /* One sentence, and it never rounds an unknown into a pass. "All good"
         is only ever said when every service this screen reads was measured
         and measured working. */
      var line;
      if (bad > 0) {
        line = fmt.num(bad) + ' of the ' + fmt.num(ordered.length) + ' services this screen reads ' +
          (bad === 1 ? 'is' : 'are') + ' not working. Start there.' +
          (degraded > 0 ? ' ' + fmt.num(degraded) + ' more ' + (degraded === 1 ? 'is' : 'are') +
            ' degraded.' : '') +
          (unknown > 0 ? ' ' + fmt.num(unknown) + ' could not be measured at all.' : '');
      } else if (degraded > 0) {
        /* "Nothing is down" would be a claim about services this screen never
           reached, so it is scoped to what was actually measured. */
        line = 'Nothing this screen measured is down, but ' + fmt.num(degraded) + ' service' +
          (degraded === 1 ? ' is' : 's are') + ' degraded.' +
          (absent ? ' ' + fmt.num(absent) + ' not deployed in this console build.' : '') +
          (unknown ? ' ' + fmt.num(unknown) + ' could not be measured.' : '');
      } else if (unknown > 0 || absent > 0) {
        line = fmt.num(working) + ' of ' + fmt.num(ordered.length) + ' measured working. ' +
          (absent ? fmt.num(absent) + ' not deployed in this console build. ' : '') +
          (unknown ? fmt.num(unknown) + ' could not be measured. ' : '') +
          'That is not the same as healthy.';
      } else {
        line = 'All ' + fmt.num(ordered.length) + ' services this screen reads were measured, and all ' +
          'of them are working.';
      }

      summaryBody.appendChild(el('p', { text: line }));
      summaryBody.appendChild(summaryTable(ordered));
      summaryBody.appendChild(el('p.hint', {
        text: 'This screen reads ' + fmt.num(SERVICES.length) + ' services. It is not an inventory of the ' +
          'stack: anything without a reader here -- the cache, the observability profile, the connect ' +
          'profile -- is absent from this table and has not been checked by it.'
      }));
      summaryBody.appendChild(el('p.hint', {
        text: 'The container column is the weakest evidence here and is never green. Each of these services ' +
          'has a documented state in which its container probe passes and the service cannot do its job.'
      }));
    }
  }
})();
