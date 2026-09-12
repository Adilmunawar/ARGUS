/*
 * OpenBao, as the console sees it: the STATE of the vault, and never its contents.
 *
 * This is the Secrets Manager + KMS replacement's read side (ADR-0013). It answers
 * four questions -- is it there, is it initialised, is it sealed, and is this
 * estate protected by a real ceremony or by a key sitting on this disk -- and it
 * is built so that it cannot answer any other.
 *
 * ── IT CANNOT READ A SECRET, AND THAT IS ENFORCED BY CONSTRUCTION ────────────
 *
 * Three unauthenticated endpoints are named in SYS_PATHS below, and the only
 * function in this file that performs a request takes a KEY of that table rather
 * than a path. There is therefore no expression here, and none a caller could
 * pass in, that reaches /v1/argus-kv/data/... or any other mount. No exported
 * reader takes an argument at all, so there is nothing to inject.
 *
 * It sends no credential: no Authorization header, no X-Vault-Token, no
 * X-Bao-Token, and no parameter that could carry one. It never spreads an
 * upstream body into its return value either -- every field below is copied out
 * by name -- and it never logs a response body.
 *
 * The raft peer list lives at sys/storage/raft/configuration, which requires a
 * token, so this console cannot count the nodes in the cluster. It reports that
 * as unknown. It does not report one.
 *
 * ── THE SANDBOX WARNING IS THE HEADLINE, NOT A FOOTNOTE ──────────────────────
 *
 * ARGUS_UNSEAL_MODE=sandbox means bao-init initialised the vault with a single
 * Shamir share and wrote that share -- and the root token -- to a volume on the
 * same machine as the raft it opens. Anyone who can read that volume owns every
 * secret in the estate. ADR-0013 forbids it anywhere real. So `sandbox` is a
 * first-class field on every payload this module returns, it carries its own
 * severity and its own banner flag, and the UI is expected to render it
 * permanently while it is set. It is never merely a note in a list.
 *
 * And the verdict is MEASURED, from /v1/sys/seal-status, never taken from
 * ARGUS_UNSEAL_MODE. The variable says what somebody asked for; the seal says
 * what the estate is. They disagree in exactly the case that matters: a vault
 * born in sandbox mode and later booted with ARGUS_UNSEAL_MODE=ceremony is still
 * 1-of-1 with its key on disk, because changing a variable does not re-key a
 * vault. A console that trusted the variable would draw that deployment green.
 * When the seal cannot be read the verdict is `null`, never `false` -- "we could
 * not check" and "we checked and it is safe" are opposite facts.
 *
 * ── A SEALED VAULT IS A NORMAL STATE ─────────────────────────────────────────
 *
 * It is what every vault is after a restart, and it is what a correctly run
 * ceremony vault is until three people are in the room. It is reported as a
 * state with the next action attached -- using the threshold the SERVER reports,
 * never a constant from this file -- and not as an error. Likewise "OpenBao is
 * not deployed": it carries `profiles: [secrets]` in docker-compose.yml, so a
 * plain `docker compose up -d` does not start it, and the honest answer to a
 * screen asking about it is "not started, here is the command".
 *
 * ── ON /v1/sys/health THE STATUS CODE IS THE ANSWER ──────────────────────────
 *
 *   200  initialised, unsealed, active      501  not initialised
 *   429  unsealed, standby                  503  sealed
 *   472  DR secondary, active               473  performance standby
 *
 * A reader that treats anything but 200 as a transport failure turns "sealed"
 * and "not initialised" -- the two states this screen exists to show -- into
 * "unreachable". So nothing here rejects on a status code; the body is parsed
 * whatever it was, and the code is reported alongside it.
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const cache = require('./cache');
const { positiveInt } = require('./env');

/* ------------------------------------------------------------------ config --- */

/* No credential appears in this file and there is nowhere to put one. The
   address is the only configuration, and an address is not a secret. */
const ADDR = (process.env.ARGUS_OPENBAO_ADDR || '').trim();

const msFromEnv = positiveInt;

const TIMEOUT_MS = msFromEnv('ARGUS_UPSTREAM_TIMEOUT_MS', 8000);

/* These are probes on a screen somebody is watching, and a vault that is up
   answers all three in single-digit milliseconds. A long timeout buys nothing
   except a dashboard that hangs for eight seconds while a container is down. */
const PROBE_TIMEOUT_MS = Math.min(4000, TIMEOUT_MS);

/* Short, and deliberately shorter than the console's usual 30 s. The seal is the
   one value here that a human watches CHANGE: during an unseal ceremony three
   people take turns at a prompt, and a cache that reported "sealed" for half a
   minute after the vault opened would have them entering shares into a screen
   that had already stopped telling the truth. */
const TTL_MS = 5000;

const MODE_RAW = process.env.ARGUS_UNSEAL_MODE;
const MODE_SET = MODE_RAW !== undefined && String(MODE_RAW).trim() !== '';

/* The default is the UNSAFE value on purpose. A console on a host where nobody
   set the variable knows nothing about the intended posture, and defaulting to
   "ceremony" would have it print a reassuring sentence it has no evidence for.
   Assuming sandbox errs towards a warning that turns out to be unnecessary,
   which is the only direction this decision is allowed to be wrong in. */
const MODE = MODE_SET ? String(MODE_RAW).trim().toLowerCase() : 'sandbox';
const MODE_VALID = MODE === 'sandbox' || MODE === 'ceremony';
const MODE_SOURCE = MODE_SET
  ? 'ARGUS_UNSEAL_MODE in this console\'s environment: what was ASKED FOR, not what is'
  : 'ARGUS_UNSEAL_MODE is not set for this console, so the unsafe value is assumed rather than guessed';

/* The whole surface. Three paths, all unauthenticated, all of which work while
   the vault is sealed -- which is the property that makes a sealed vault
   reportable at all. Frozen so that nothing can extend it at runtime. */
const SYS_PATHS = Object.freeze({
  health: '/v1/sys/health',
  seal: '/v1/sys/seal-status',
  leader: '/v1/sys/leader'
});

const HEALTH_CODE_MEANING = {
  200: 'initialised, unsealed and active',
  429: 'unsealed, but this node is a standby',
  472: 'DR replication secondary, active',
  473: 'performance standby',
  501: 'not initialised',
  503: 'sealed'
};

/* These bodies are a few hundred bytes. The cap is not about OpenBao: it is
   about ARGUS_OPENBAO_ADDR pointing at something that is not OpenBao, which is
   an ordinary typo and must not be able to exhaust the console's heap. */
const MAX_BODY_BYTES = 256 * 1024;

/* -------------------------------------------------------------------- http --- */

/**
 * GET one of the three sys endpoints.
 *
 * Takes the NAME of an endpoint, never a path. That is the enforcement point
 * for the rule at the top of this file: there is no argument to this function
 * that could address a secret.
 *
 * Resolves for any HTTP status -- see the status-code table in the header --
 * and rejects only when the request could not be completed or the answer was
 * not JSON.
 */
function sysGet(name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const path = SYS_PATHS[name];
    if (!path) return reject(new Error(`secrets.js has no endpoint called "${name}"`));
    if (!ADDR) return reject(Object.assign(new Error('ARGUS_OPENBAO_ADDR is not set.'), { reason: 'not-configured' }));

    let url;
    try {
      /* Concatenated, not `new URL(path, ADDR)`. Used as a base, an address with
         a path prefix -- which is what an OpenBao behind Caddy at /bao looks
         like (ADR-0016) -- has that prefix silently discarded by the absolute
         path, and every probe then 404s against the proxy's root. */
      url = new URL(ADDR.replace(/\/+$/, '') + path);
    } catch (err) {
      return reject(Object.assign(
        new Error(`ARGUS_OPENBAO_ADDR is not a URL: ${ADDR}`), { reason: 'not-configured' }));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(Object.assign(
        new Error(`ARGUS_OPENBAO_ADDR must be http:// or https://, not ${url.protocol}`),
        { reason: 'not-configured' }));
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      timeout: timeoutMs || TIMEOUT_MS,
      headers: { accept: 'application/json' }
    }, (res) => {
      let body = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error(`${url.host} sent more than 256 KB`)); return; }
        body += d;
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (err) { json = null; }
        /* The body is never logged and never returned raw -- only named fields
           are copied out of it below. This is the only place it exists. */
        if (!json || typeof json !== 'object') {
          return reject(Object.assign(
            new Error(`${url.host}${path} answered ${res.statusCode} but not with JSON. ` +
                      'Is ARGUS_OPENBAO_ADDR pointing at OpenBao?'),
            { reason: 'not-openbao' }));
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(
      new Error(`${url.host} did not answer within ${timeoutMs || TIMEOUT_MS} ms`), { reason: 'timeout' })));
    req.on('error', reject);
  });
}

/**
 * Turn a failure into something with a next action attached.
 *
 * "Failed to fetch" is useless here, because on this stack the overwhelmingly
 * most likely reason is not a fault at all: openbao carries `profiles: [secrets]`
 * so it is simply not running, and the fix is one documented command rather than
 * any debugging.
 */
function classify(err) {
  if (err && err.reason) return { reason: err.reason, message: err.message };
  const code = (err && err.code) || '';
  const msg = (err && err.message) || String(err);

  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) {
    return {
      reason: 'not-deployed',
      message: `The host in ARGUS_OPENBAO_ADDR (${ADDR || 'unset'}) does not resolve from the console. ` +
        'OpenBao carries `profiles: [secrets]` in docker-compose.yml, so `docker compose up -d` does not ' +
        'start it. Start it with `docker compose --profile secrets up -d` in platform/compose.'
    };
  }
  if (/ECONNREFUSED/.test(code + msg)) {
    return {
      reason: 'unreachable',
      message: `Nothing is listening at ${ADDR}. The container resolves but is not accepting connections, ` +
        'so it is stopped, restarting, or still binding: `docker compose ps openbao`.'
    };
  }
  if (/ETIMEDOUT|ENETUNREACH|did not answer/.test(code + msg)) {
    return { reason: 'timeout', message: `OpenBao at ${ADDR} did not answer within ${PROBE_TIMEOUT_MS} ms.` };
  }
  if (/ECONNRESET|EPROTO|socket hang up|wrong version number/i.test(code + msg)) {
    return {
      reason: 'unreachable',
      message: 'The connection to OpenBao was reset before it answered. If that listener is terminating TLS ' +
        '(it is plaintext in compose and certificate-backed at Site A), ARGUS_OPENBAO_ADDR has to say https://.'
    };
  }
  return { reason: 'error', message: msg };
}

/** One probe, whose failure is recorded rather than thrown. */
async function probe(name) {
  const t0 = Date.now();
  try {
    const r = await sysGet(name, PROBE_TIMEOUT_MS);
    return {
      name,
      path: SYS_PATHS[name],
      reachable: true,
      httpStatus: r.status,
      httpStatusMeaning: name === 'health' ? (HEALTH_CODE_MEANING[r.status] || null) : null,
      latencyMs: Date.now() - t0,
      json: r.json,
      reason: null,
      error: null
    };
  } catch (err) {
    const c = classify(err);
    return {
      name,
      path: SYS_PATHS[name],
      reachable: false,
      httpStatus: null,
      httpStatusMeaning: null,
      latencyMs: Date.now() - t0,
      json: null,
      reason: c.reason,
      error: c.message
    };
  }
}

/* -------------------------------------------------------------------- seal --- */

function num(v) { return Number.isFinite(v) ? v : null; }
function bool(v) { return typeof v === 'boolean' ? v : null; }

const NO_SEAL = (reason) => ({
  type: null,
  initialised: null,
  sealed: null,
  shares: null,
  threshold: null,
  measured: false,
  measuredReason: reason,
  unsealProgress: null,
  sharesRemaining: null,
  autoUnseal: null,
  recoverySeal: null,
  storageType: null
});

/**
 * The seal, from /v1/sys/seal-status.
 *
 * The one rule that governs this function: before `bao operator init` there is
 * no seal, and OpenBao reports that absence as n=0, t=0. Zero shares is not a
 * fact about a seal, it is the absence of one, and a console rendering "0 of 0"
 * would be stating something false with complete confidence. So the numbers are
 * carried through only when they were actually measured, and `null` otherwise.
 */
function sealFacts(json) {
  if (!json) return NO_SEAL('the seal status could not be read');

  const initialised = bool(json.initialized);
  const sealed = bool(json.sealed);
  const shares = num(json.n);
  const threshold = num(json.t);
  const measured = initialised === true && shares !== null && shares > 0 && threshold !== null;

  const progress = sealed === true && initialised === true ? num(json.progress) : null;

  return {
    type: typeof json.type === 'string' && json.type ? json.type : null,
    initialised,
    sealed,
    shares: measured ? shares : null,
    threshold: measured ? threshold : null,
    measured,
    measuredReason: measured
      ? null
      : (initialised === false
          ? 'this vault has not been initialised, so it has no seal yet and reports n=0, t=0'
          : 'the seal numbers were not present in the answer'),
    unsealProgress: progress,
    /* How many more shares this unseal attempt still needs. Derived, and only
       when both halves were measured. */
    sharesRemaining: measured && progress !== null ? Math.max(0, threshold - progress) : null,
    /* A non-shamir seal means auto-unseal against an external KMS, and then n/t
       describe RECOVERY keys rather than unseal keys. Nothing in this project
       configures one, but saying so is cheaper than a sandbox verdict computed
       from numbers that mean something else. */
    autoUnseal: typeof json.type === 'string' ? json.type !== 'shamir' : null,
    recoverySeal: bool(json.recovery_seal),
    storageType: typeof json.storage_type === 'string' && json.storage_type ? json.storage_type : null
  };
}

/* ----------------------------------------------------------------- sandbox --- */

/**
 * Is this estate protected by a single secret sitting on this machine?
 *
 * Answered from the measured seal first, and from ARGUS_UNSEAL_MODE only to
 * describe what was ASKED FOR when nothing could be measured. The returned
 * object is the one the UI renders permanently: `banner` says whether to render
 * it, `severity` says how loudly, and `verdict` distinguishes "yes" from "we do
 * not know", which are not the same warning.
 *
 * `verdict: false` is the only value that means safe, and it is only ever
 * reached from a measurement.
 */
function sandboxVerdict(seal, unreadableReason) {
  const base = {
    verdict: null,
    banner: true,
    severity: 'warning',
    basis: null,
    requestedMode: MODE,
    requestedModeValid: MODE_VALID,
    requestedModeSource: MODE_SOURCE,
    shares: seal ? seal.shares : null,
    threshold: seal ? seal.threshold : null,
    sealMeasured: !!(seal && seal.measured),
    /* The console does not mount argus_openbao_seal -- deliberately, it has no
       business being able to read a key file -- so it cannot check whether one
       exists. bao-init can, and records it in that volume's status.json. Here
       the 1-of-1 seal is the whole evidence, and claiming otherwise would be
       inventing a measurement. */
    keyAtRest: null,
    keyAtRestReason: 'This console does not mount argus_openbao_seal and cannot see whether an unseal key ' +
      'file exists on this host. The seal it measured is the only evidence it has.',
    adr: 'ADR-0013',
    title: null,
    message: null,
    action: null
  };

  const askedForSandbox = MODE === 'sandbox';

  /* ── measured: one share opens the estate ──────────────────────────────── */
  if (seal && seal.measured && seal.shares === 1) {
    const disagrees = MODE === 'ceremony';
    return Object.assign(base, {
      verdict: true,
      banner: true,
      severity: 'critical',
      basis: 'measured: /v1/sys/seal-status reports a 1-of-1 seal',
      title: disagrees
        ? 'ARGUS_UNSEAL_MODE says ceremony, but this vault is sealed with ONE share.'
        : 'Sandbox unseal: one key, on this machine, opens every secret in this estate.',
      message: (disagrees
        ? 'The seal is the estate and the variable is only an intention. This vault was initialised in ' +
          'sandbox mode, and changing ARGUS_UNSEAL_MODE afterwards does not re-key an existing vault. ' +
          'Treat this deployment as a sandbox whatever the configuration says. '
        : '') +
        'A 1-of-1 Shamir seal means bao-init wrote the single unseal key, and the root token, to the ' +
        'argus_openbao_seal volume on this same machine, beside the raft they open. Anybody who can read ' +
        'that volume -- which is anybody with the Docker socket -- has every secret here, with no ceremony ' +
        'and nobody to notice. A backup of this machine is a backup of the keys.' +
        (seal.autoUnseal === true
          ? ' This seal is not shamir, so these numbers describe recovery keys; one recovery key is the ' +
            'same single secret by another name.'
          : ''),
      action: 'ADR-0013 requires 3 of 5 shares held by three named people, and the GitOps reconciler is ' +
        'required to refuse a plan that sets sandbox mode on a real host. Leaving it is a rebuild, not an ' +
        'edit: destroy argus_openbao_data AND argus_openbao_seal, set ARGUS_UNSEAL_MODE=ceremony and boot ' +
        'again, or re-key in place with `bao operator rekey -init -key-shares=5 -key-threshold=3`.'
    });
  }

  /* ── measured: a multi-share seal ──────────────────────────────────────── */
  if (seal && seal.measured && seal.shares > 1) {
    return Object.assign(base, {
      verdict: false,
      banner: false,
      severity: 'none',
      basis: `measured: /v1/sys/seal-status reports a ${seal.threshold}-of-${seal.shares} seal`,
      title: `Ceremony seal: ${seal.threshold} of ${seal.shares} shares.`,
      /* Precise about what this does and does not establish. It rules out the
         1-of-1 sandbox seal. It says nothing about where those shares are, and
         this console has no way to find out. */
      message: `This vault needs ${seal.threshold} of ${seal.shares} shares to unseal, so it is not the ` +
        '1-of-1 sandbox seal and nothing in this project stores a share for it. That is all this ' +
        'establishes: the console cannot see where those shares are held or who holds them.' +
        (askedForSandbox
          ? ' ARGUS_UNSEAL_MODE=sandbox is pointed at this vault, and the openbao-unseal sidecar holds a ' +
            'single key that cannot open it -- it refuses to submit that key rather than poisoning the ' +
            'unseal progress counter the real key holders need.'
          : ''),
      action: askedForSandbox
        ? 'Set ARGUS_UNSEAL_MODE=ceremony in platform/compose/.env so the sidecar stops trying, or point ' +
          'it at the vault it was meant for.'
        : null
    });
  }

  /* ── not initialised: there is no seal yet ─────────────────────────────── */
  if (seal && seal.initialised === false) {
    return Object.assign(base, {
      verdict: null,
      banner: true,
      severity: askedForSandbox ? 'warning' : 'info',
      basis: 'measured: this vault reports itself as not initialised, so it has no seal to judge',
      title: 'This vault has no seal yet.',
      message: 'It has never been initialised, so there is nothing to protect and nothing to measure.' +
        (askedForSandbox
          ? ' When bao-init next runs in sandbox mode it will create a 1-of-1 seal and write that single ' +
            'share, and the root token, to this machine.'
          : ' In ceremony mode bao-init deliberately will not initialise it; a human runs the ceremony.'),
      action: null
    });
  }

  /* ── nothing measured. Unknown is not safe. ────────────────────────────── */
  return Object.assign(base, {
    verdict: null,
    banner: true,
    severity: 'warning',
    basis: 'not measured',
    title: 'The unseal posture of this vault has NOT been verified.',
    message: (unreadableReason ? unreadableReason + ' ' : '') +
      'Nothing here is a statement about safety: the seal could not be read, so this console does not know ' +
      'whether one key on this machine opens the estate. ' +
      (MODE_VALID
        ? `The configuration asks for ${MODE} mode (${MODE_SOURCE}), which is what somebody intended and ` +
          'not what was measured.'
        : `ARGUS_UNSEAL_MODE is "${MODE}", which is neither "sandbox" nor "ceremony". One of those two ` +
          'values puts an unseal key on this disk and the other does not, so nothing here will guess ' +
          'which was meant.'),
    action: 'Read the seal directly: `docker compose exec openbao bao status`. n=1, t=1 is the sandbox seal.'
  });
}

/* ------------------------------------------------------------------ ha/raft --- */

/**
 * Leader and HA, from /v1/sys/leader plus the storage type from the seal status.
 *
 * A sealed vault does not publish its HA state -- sys/leader answers 503 while
 * sealed -- and that is a normal consequence of a normal state, so it is
 * reported as "not available yet" and not as a failure.
 */
function haFacts(leaderProbe, seal, healthJson) {
  const storageType = seal ? seal.storageType : null;
  const raft = {
    inUse: storageType === null ? null : storageType === 'raft',
    /* Not zero, and not one. sys/storage/raft/configuration is the only place
       the peer list exists and it requires a token, which this console does not
       hold and will not be given for a status screen. */
    peers: null,
    peersReason: 'The raft peer list is at sys/storage/raft/configuration, which requires a token. This ' +
      'console authenticates with nothing, so it cannot count the nodes in this cluster.',
    note: 'ha_enabled describes the storage backend -- raft is HA-capable -- and is not a count of nodes. ' +
      'A single-node raft reports exactly the same value as a three-node one, so it must not be rendered ' +
      'as "highly available".'
  };

  const base = {
    available: false,
    reason: null,
    message: null,
    haEnabled: null,
    isSelf: null,
    leaderAddress: null,
    leaderClusterAddress: null,
    performanceStandby: null,
    /* Only read from /v1/sys/health when the vault is UNSEALED. A sealed node
       reports standby:true, and a console repeating that would tell an operator
       their single node had become a standby when in fact it is simply shut. */
    standby: healthJson && seal && seal.sealed === false ? bool(healthJson.standby) : null,
    storageType,
    raft
  };

  if (!leaderProbe.reachable) {
    return Object.assign(base, { reason: leaderProbe.reason, message: leaderProbe.error });
  }
  if (leaderProbe.httpStatus === 503 || (seal && seal.sealed === true)) {
    return Object.assign(base, {
      reason: 'sealed',
      message: 'A sealed vault does not publish its leader or HA state. This becomes readable the moment ' +
        'it is unsealed; there is nothing to fix.'
    });
  }
  if (leaderProbe.httpStatus !== 200) {
    return Object.assign(base, {
      reason: 'unexpected-status',
      message: `/v1/sys/leader answered ${leaderProbe.httpStatus}, which this console does not have a ` +
        'meaning for. The seal state above was read separately and is unaffected.'
    });
  }

  const j = leaderProbe.json;
  const addr = typeof j.leader_address === 'string' && j.leader_address ? j.leader_address : null;
  return Object.assign(base, {
    available: true,
    haEnabled: bool(j.ha_enabled),
    isSelf: bool(j.is_self),
    /* An empty string here is OpenBao saying "there is no leader right now",
       which is a real and serious state -- an election in progress, or a cluster
       with no quorum. It must not be rendered as an address. */
    leaderAddress: addr,
    leaderKnown: addr !== null,
    leaderClusterAddress: typeof j.leader_cluster_address === 'string' && j.leader_cluster_address
      ? j.leader_cluster_address
      : null,
    performanceStandby: bool(j.performance_standby)
  });
}

/* ----------------------------------------------------------------- summary --- */

function notConfiguredSummary() {
  const seal = NO_SEAL('ARGUS_OPENBAO_ADDR is not set, so nothing was contacted');
  return {
    addr: null,
    configured: false,
    reachable: false,
    state: 'not-configured',
    severity: 'warning',
    summary: 'This console has no OpenBao address.',
    detail: 'ARGUS_OPENBAO_ADDR is empty, so nothing was contacted and nothing below was measured. ' +
      'docker-compose.yml sets it to http://openbao:8200 for the console service.',
    nextAction: 'Set ARGUS_OPENBAO_ADDR to the vault\'s API address and restart the console.',
    usable: null,
    reason: 'not-configured',
    message: 'ARGUS_OPENBAO_ADDR is not set.',
    initialised: null,
    sealed: null,
    version: null,
    clusterName: null,
    seal,
    ha: haFacts({ reachable: false, reason: 'not-configured', error: 'ARGUS_OPENBAO_ADDR is not set.' }, seal, null),
    sandbox: sandboxVerdict(null, 'ARGUS_OPENBAO_ADDR is not set, so no vault was contacted.'),
    endpoints: [],
    notes: [],
    clockSkewSeconds: null,
    at: new Date().toISOString()
  };
}

/** What to do next, in the state we are actually in. */
function actionFor(state, seal) {
  if (state === 'sealed') {
    /* The threshold printed here is the one the SERVER reports, never a
       constant from this file. Printing the number this project wishes for is
       how an operator ends up unsealing three times against a seal that wants
       five. */
    if (seal.measured && seal.threshold === 1 && seal.shares === 1) {
      return 'A 1-of-1 seal is unsealed automatically by the openbao-unseal sidecar, using the key stored ' +
        'on this host. If it stays sealed, that sidecar is where the reason is: ' +
        '`docker compose logs openbao-unseal` in platform/compose.';
    }
    if (seal.measured) {
      const progress = seal.unsealProgress !== null && seal.unsealProgress > 0
        ? ` ${seal.unsealProgress} share${seal.unsealProgress === 1 ? ' has' : 's have'} been submitted so far ` +
          `and ${seal.sharesRemaining} more ${seal.sharesRemaining === 1 ? 'is' : 'are'} needed; ` +
          '`bao operator unseal -reset` clears a part-finished attempt.'
        : '';
      return `${seal.threshold} of the ${seal.shares} key holders must each run ` +
        '`docker compose exec openbao bao operator unseal` and enter their own share.' + progress;
    }
    return 'Unseal it with `docker compose exec openbao bao operator unseal`. This console could not read ' +
      'how many shares that takes.';
  }
  if (state === 'not-initialised') {
    if (!MODE_VALID) {
      return `ARGUS_UNSEAL_MODE is "${MODE}", so bao-init refuses to initialise: one valid value puts an ` +
        'unseal key on this disk and the other does not. Fix it in platform/compose/.env and boot again.';
    }
    return MODE === 'sandbox'
      ? 'bao-init initialises this vault on the next `docker compose --profile secrets up -d`, and in ' +
        'sandbox mode it writes the single unseal key to this machine while doing so.'
      : 'In ceremony mode bao-init will not initialise this vault, deliberately -- initialising prints five ' +
        'shares and a root token, and this container\'s output is a log file on disk. A human runs it from ' +
        'a terminal with the key holders present; `docker compose logs bao-init` prints the exact commands.';
  }
  if (state === 'not-deployed') {
    return 'Start it with `docker compose --profile secrets up -d` in platform/compose.';
  }
  if (state === 'unreachable') {
    return 'Check `docker compose ps openbao` and `docker compose logs openbao` in platform/compose.';
  }
  if (state === 'not-configured') {
    return 'Point ARGUS_OPENBAO_ADDR at the vault\'s API address -- docker-compose.yml sets it to ' +
      'http://openbao:8200 for the console service -- and restart the console.';
  }
  return null;
}

/**
 * Everything, from three requests made in parallel.
 *
 * One read serves every route this module exports. A screen that renders the
 * seal, the HA state and the sandbox banner together therefore probes the vault
 * once, not three times.
 */
async function summary() {
  if (!ADDR) return notConfiguredSummary();

  const [healthProbe, sealProbe, leaderProbe] = await Promise.all([
    probe('health'), probe('seal'), probe('leader')
  ]);

  const notes = [];
  const endpoints = [healthProbe, sealProbe, leaderProbe].map((p) => ({
    name: p.name,
    path: p.path,
    reachable: p.reachable,
    httpStatus: p.httpStatus,
    httpStatusMeaning: p.httpStatusMeaning,
    latencyMs: p.latencyMs,
    error: p.error
  }));

  const healthJson = healthProbe.json;
  const sealJson = sealProbe.json;
  const reachable = healthProbe.reachable || sealProbe.reachable;

  if (!reachable) {
    /* Nothing answered. The headline reason is the SEAL probe's, because the
       seal is what this screen exists for -- and it is only the headline: the
       three probes can fail differently from one another (a slow DNS lookup
       times one out while the others get their NXDOMAIN), so each endpoint row
       below keeps the reason it actually saw rather than being overwritten with
       this one. */
    const c = { reason: sealProbe.reason, message: sealProbe.error };
    const state = c.reason === 'not-deployed' ? 'not-deployed'
      : c.reason === 'not-configured' || c.reason === 'not-openbao' ? 'not-configured'
        : 'unreachable';
    const seal = NO_SEAL(c.message);
    return {
      addr: ADDR,
      configured: true,
      reachable: false,
      state,
      severity: state === 'not-deployed' ? 'info' : 'warning',
      summary: state === 'not-deployed'
        ? 'OpenBao is not running on this stack.'
        : c.reason === 'not-openbao'
          ? 'Something answered at that address, but it was not OpenBao.'
          : 'OpenBao could not be reached.',
      detail: c.message,
      nextAction: actionFor(state, seal),
      usable: false,
      reason: c.reason,
      message: c.message,
      initialised: null,
      sealed: null,
      version: null,
      clusterName: null,
      seal,
      ha: haFacts(leaderProbe, seal, null),
      /* The warning survives the outage. A vault this console cannot see is a
         vault whose posture it cannot vouch for, and the banner says exactly
         that rather than disappearing -- an absent warning reads as a safe one. */
      sandbox: sandboxVerdict(null, c.message),
      endpoints,
      notes,
      clockSkewSeconds: null,
      at: new Date().toISOString()
    };
  }

  const seal = sealFacts(sealJson);

  /* /v1/sys/health carries the same two booleans and is the fallback when the
     seal endpoint is the one that failed. Neither is trusted over the other:
     they come from the same server and disagreeing would itself be news. */
  const initialised = seal.initialised !== null ? seal.initialised : (healthJson ? bool(healthJson.initialized) : null);
  const sealed = seal.sealed !== null ? seal.sealed : (healthJson ? bool(healthJson.sealed) : null);
  const standby = sealed === false && healthJson ? bool(healthJson.standby) : null;

  let state = 'unknown';
  if (initialised === false) state = 'not-initialised';
  else if (sealed === true) state = 'sealed';
  else if (sealed === false) state = standby === true ? 'standby' : 'unsealed';

  const version = (sealJson && typeof sealJson.version === 'string' && sealJson.version) ||
    (healthJson && typeof healthJson.version === 'string' && healthJson.version) || null;

  /* Absent while sealed -- OpenBao does not publish the cluster name until it
     is unsealed -- so null here is expected and is not a fault. */
  const clusterName = (healthJson && typeof healthJson.cluster_name === 'string' && healthJson.cluster_name) ||
    (sealJson && typeof sealJson.cluster_name === 'string' && sealJson.cluster_name) || null;

  /* Includes the round trip, so single-digit seconds are noise. It is worth
     measuring anyway: WSL2 drifts after the host sleeps, and a drifted clock
     silently expires the short-lived leases ADR-0013 buys this vault for. */
  const serverTimeUtc = healthJson && Number.isFinite(healthJson.server_time_utc)
    ? healthJson.server_time_utc : null;
  const clockSkewSeconds = serverTimeUtc === null ? null : Math.round(Date.now() / 1000) - serverTimeUtc;
  if (clockSkewSeconds !== null && Math.abs(clockSkewSeconds) > 120) {
    notes.push(`This console's clock and OpenBao's differ by ${clockSkewSeconds} s. Inside WSL2 that ` +
      'usually means the VM slept: `wsl --shutdown`, or `hwclock -s` in the distro.');
  }
  if (seal.autoUnseal === true) {
    notes.push(`This seal is "${seal.type}", not shamir, so the share counts describe recovery keys rather ` +
      'than unseal keys. Nothing in this project configures an auto-unseal seal.');
  }
  if (MODE === 'sandbox' && seal.measured && seal.shares > 1) {
    notes.push('ARGUS_UNSEAL_MODE=sandbox is set against a multi-share seal. The unseal sidecar holds one ' +
      'key it cannot use and refuses to submit it, because a foreign share is accepted and counted and ' +
      'would break the real ceremony.');
  }
  if (!MODE_VALID) {
    notes.push(`ARGUS_UNSEAL_MODE is "${MODE}". The only values are "sandbox" and "ceremony", and this ` +
      'console will not guess which was meant.');
  }
  if (state === 'standby') {
    notes.push('This node reports itself as a standby, so it is not serving requests. In this compose stack ' +
      'there is only one node, and a lone standby means there is no active leader.');
  }

  const detail = {
    'not-initialised': 'The vault is running but has never been initialised. It holds nothing and can ' +
      'answer nothing until it has a seal.',
    sealed: 'The vault is running and holds its data, but the master key is not in memory, so it will ' +
      'refuse every read until it is unsealed. This is the normal state after any restart.',
    unsealed: 'The vault is initialised, unsealed and serving.',
    standby: 'The vault is unsealed but this node is a standby and forwards rather than serves.',
    unknown: 'The vault answered, but not with the fields this console needs to say what state it is in.'
  }[state];

  return {
    addr: ADDR,
    configured: true,
    reachable: true,
    state,
    severity: state === 'unsealed' ? 'ok' : state === 'standby' ? 'info' : 'warning',
    summary: {
      'not-initialised': 'OpenBao is running but not initialised.',
      sealed: 'OpenBao is sealed.',
      unsealed: 'OpenBao is unsealed and serving.',
      standby: 'OpenBao is unsealed, and this node is a standby.',
      unknown: 'OpenBao answered, but its state could not be determined.'
    }[state],
    detail,
    nextAction: actionFor(state, seal),
    /* "Can this vault answer a secret request right now." Not the same question
       as "is the container healthy": a sealed vault is healthy and useless. */
    usable: state === 'unsealed',
    reason: null,
    message: null,
    initialised,
    sealed,
    version,
    clusterName,
    seal,
    ha: haFacts(leaderProbe, seal, healthJson),
    sandbox: sandboxVerdict(seal, null),
    endpoints,
    notes,
    serverTimeUtc: serverTimeUtc === null ? null : new Date(serverTimeUtc * 1000).toISOString(),
    clockSkewSeconds,
    at: new Date().toISOString()
  };
}

/* --------------------------------------------------------------- endpoints --- */

/** A reader that reports why it could not answer instead of throwing. */
function guarded(key, ttlMs, producer) {
  return async function () {
    try {
      const r = await cache.through(key, ttlMs, producer);
      return { ok: true, ...r.value, cachedAt: r.cachedAt, stale: !!r.stale };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  };
}

/**
 * The reader that everything else projects from.
 *
 * `ok` is about whether this console could form an answer, not about whether the
 * vault is happy. A sealed vault, an uninitialised vault and a vault that is not
 * deployed all return ok:true with a state and a next action, because all three
 * are ordinary and none of them is a failure of this request -- the UI would
 * otherwise draw a red box with a Try Again button over a vault that is working
 * exactly as designed. Only a genuine fault in this module reaches ok:false.
 */
const health = guarded('secrets:health', TTL_MS, summary);

/** Seal and initialisation state, with the version that reported them. */
async function sealStatus() {
  const h = await health();
  if (!h.ok) return h;
  return {
    ok: true,
    addr: h.addr,
    configured: h.configured,
    reachable: h.reachable,
    state: h.state,
    severity: h.severity,
    summary: h.summary,
    detail: h.detail,
    nextAction: h.nextAction,
    usable: h.usable,
    initialised: h.initialised,
    sealed: h.sealed,
    version: h.version,
    clusterName: h.clusterName,
    seal: h.seal,
    reason: h.reason,
    message: h.message,
    /* Carried here as well as on /health on purpose. Any screen that renders the
       seal must be able to render the warning beside it without a second call,
       because the two are the same fact and separating them is how a warning
       ends up on a page nobody opened. */
    sandbox: h.sandbox,
    notes: h.notes,
    cachedAt: h.cachedAt,
    stale: h.stale,
    at: h.at
  };
}

/** Leader, HA and raft state. */
async function ha() {
  const h = await health();
  if (!h.ok) return h;
  return {
    ok: true,
    addr: h.addr,
    reachable: h.reachable,
    state: h.state,
    ...h.ha,
    version: h.version,
    clusterName: h.clusterName,
    cachedAt: h.cachedAt,
    stale: h.stale,
    at: h.at
  };
}

/**
 * The unseal-posture warning on its own, for a global banner.
 *
 * It cannot fail. If the summary itself broke, the verdict is "unknown" with the
 * reason attached -- never "safe", and never absent. A banner that disappears
 * when something goes wrong is a banner that says the deployment is fine at
 * precisely the moment nothing has been checked.
 */
async function sandbox() {
  const h = await health();
  if (h.ok && h.sandbox) {
    return { ok: true, ...h.sandbox, state: h.state, reachable: h.reachable, cachedAt: h.cachedAt,
      stale: h.stale, at: h.at };
  }
  return {
    ok: true,
    ...sandboxVerdict(null, h.message || 'The OpenBao reader itself failed.'),
    state: 'unknown',
    reachable: false,
    at: new Date().toISOString()
  };
}

module.exports = {
  health,      // the summary: state, seal, HA, version and the sandbox warning
  sealStatus,  // seal and initialisation state
  ha,          // leader, HA and raft state
  sandbox,     // the unseal-posture warning alone, for a permanent banner
  classify
};
