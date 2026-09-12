/*
 * The Argus console API.
 *
 *   node src/index.js          # http://127.0.0.1:8787
 *
 * Serves real host telemetry, a real AWS inventory, and the console's own
 * static files, from one process with no build step.
 *
 * Deliberate choices:
 *
 *  - Node's own http module, no framework. The console runs inside an
 *    egress-restricted network (ADR-0027) and every dependency is a thing that
 *    has to be reviewed and patched there. The only dependencies are the AWS
 *    clients, which are doing work nothing in the standard library does.
 *  - Binds to loopback unless told otherwise. An estate inventory should not
 *    appear on a network interface because somebody ran `npm start`.
 *  - Read-only unless ARGUS_ALLOW_WRITES is set. The route table refuses
 *    mutating verbs outright, so evaluating the dashboard cannot terminate an
 *    instance.
 *  - Every payload carries `stale` and `cachedAt`. A number without an age is
 *    a number an operator will trust for longer than they should.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const config = require('./config');
const env = require('./env');
const host = require('./host');
const aws = require('./aws');
const storage = require('./storage');
const pg = require('./pg');
const garnet = require('./garnet');
const queues = require('./queues');
const secrets = require('./secrets');

const headers = require('./headers');
const authConfig = require('./auth/config');
const operators = require('./auth/operators');
const authGate = require('./auth/gate');
const authRoutes = require('./auth/routes');
const originGate = require('./auth/origin');
const proxyAuth = require('./auth/proxy');
const { audit } = require('./auth/audit');

const { EventStream, RingBuffer, startEventStream, replayPlan } = require('./sse');
const logs = require('./logs');
const metrics = require('./metrics');
const alerts = require('./alerts');
const containers = require('./containers');
const heartbeats = require('./heartbeats');

env.reportRejections();

for (const note of authConfig.notes) process.stderr.write(`argus: ${note}\n`);

const bootFailures = authConfig.bootFailures(operators.count());
if (bootFailures.length > 0) {
  for (const failure of bootFailures) {
    process.stderr.write(`argus: REFUSING TO START: ${failure}\n`);
    audit('auth.config.rejected', { outcome: 'failure', reason: 'boot-refused', detail: failure });
  }
  process.exit(1);
}

for (const problem of operators.load().problems) process.stderr.write(`argus: ${problem}\n`);

if (authConfig.mode === 'off') {
  audit('auth.config.rejected', {
    outcome: 'defer',
    reason: 'auth-disabled',
    detail: 'ARGUS_AUTH=off. Every API route answers as a local development administrator. ' +
      'This is permitted only on a loopback bind.'
  });
}

const STARTED = new Date();

/* A handler returns one of these when the response is not JSON -- object
   preview is the only case today. Without an escape hatch the alternative is a
   second server or a base64 blob inside a JSON envelope, and the second one
   quietly triples the memory cost of every image an operator opens. */
class RawResponse {
  constructor({ status = 200, headers = {}, body = null, stream = null }) {
    this.status = status;
    this.headers = headers;
    this.body = body;
    this.stream = stream;
  }
}

/* Map a thrown error onto the status it deserves.
 *
 * The console renders retry affordances off these, so getting them wrong means
 * offering Try Again for something that will never succeed. */
const STATUS_FOR = {
  ValidationError: 400,
  UnsupportedType: 415,
  TooLarge: 413,
  Busy: 429
};

function statusForError(err) {
  if (err && STATUS_FOR[err.name]) return STATUS_FOR[err.name];
  const c = storage.classify(err);
  if (c.reason === 'not-found' || c.reason === 'no-such-bucket') return 404;
  if (c.reason === 'denied') return 403;
  if (c.reason === 'timeout') return 504;
  if (c.reason === 'unreachable') return 503;
  return 500;
}

/* decodeURIComponent throws URIError on a malformed escape such as "%" or
   "%zz". A request for one of those must be a 404, not an unhandled throw. */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (err) { return s; }
}

const PG_NAME_MAX_BYTES = 63;

function rejected(message) {
  return Object.assign(new Error(message), { name: 'ValidationError' });
}

async function pgTableOptions(q) {
  const requested = q && typeof q.database === 'string' ? q.database.trim() : '';
  if (!requested) return {};

  if (Buffer.byteLength(requested) > PG_NAME_MAX_BYTES) {
    throw rejected(`A PostgreSQL database name is at most ${PG_NAME_MAX_BYTES} bytes, so this one names nothing.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(requested)) {
    throw rejected('A PostgreSQL database name cannot contain control characters.');
  }

  const known = await pg.databases();
  const answered = known && known.ok === true && known.stale !== true;
  const visible = answered && Array.isArray(known.databases) ? known.databases : null;
  if (visible && !visible.some((d) => d && d.name === requested)) {
    throw rejected(`This cluster has no database called "${requested}". ` +
      'GET /api/pg/databases lists the ones it does have.');
  }
  return { database: requested };
}

const logRing = new RingBuffer(config.logRingLines);

function streamUnavailable(reason) {
  return new RawResponse({
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify({ ok: false, ...reason, streaming: false }, null, 2)
  });
}

/* ------------------------------------------------------------------ routes --- */

const routes = {
  'GET /api/health': async (q, ctx) => ({
    status: 'ok',
    startedAt: STARTED.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    ...(ctx && ctx.principal ? { version: require('../package.json').version } : {})
  }),

  /* One call the UI can make on load to learn what this deployment can do,
     instead of discovering it from a series of failures. */
  'GET /api/capabilities': async (q, ctx) => {
    const principal = ctx && ctx.principal;
    if (!principal) {
      return {
        auth: { mode: authConfig.mode, authenticated: false },
        writesAllowed: false
      };
    }
    const id = await aws.identity();
    return {
      auth: {
        mode: authConfig.mode,
        authenticated: true,
        subject: principal.subject,
        displayName: principal.displayName,
        roles: principal.roles,
        expiresAt: principal.expiresAt || null,
        idleExpiresAt: principal.idleExpiresAt || null
      },
      region: config.region,
      writesAllowed: config.allowWrites,
      costEnabled: config.costEnabled,
      streams: {
        logs: logs.configured(),
        metrics: metrics.configured(),
        alerts: alerts.configured(),
        containers: containers.configured(),
        heartbeats: true
      },
      aws: id.ok
        ? { connected: true, account: id.account, arn: id.arn }
        : { connected: false, reason: id.reason, message: id.message }
    };
  },

  'GET /api/host': async () => host.snapshot(),

  'GET /api/aws/identity': async () => aws.identity(),
  'GET /api/aws/instances': async () => aws.instances(),
  'GET /api/aws/buckets': async () => aws.buckets(),
  'GET /api/aws/databases': async () => aws.databases(),
  'GET /api/aws/alarms': async () => aws.alarms(),
  'GET /api/aws/cost': async () => aws.cost(),

  /* ---------------------------------------------------------- object store ---
     The S3 replacement. Unlike the /api/aws/* routes above, these read a
     service this project runs itself, so "not configured" is not an expected
     answer -- if these fail, something is actually wrong, and the reason says
     which part. */

  'GET /api/storage/health': async () => storage.health(),
  'GET /api/storage/capacity': async () => storage.capacity(),
  'GET /api/storage/buckets': async () => storage.buckets(),
  'GET /api/storage/lock-status': async () => storage.lockStatus(),

  'GET /api/storage/objects': async (q) =>
    storage.listObjects({ bucket: q.bucket, prefix: q.prefix || '', cursor: q.cursor || null }),

  'GET /api/storage/object': async (q) =>
    storage.describeObject({ bucket: q.bucket, key: q.key }),

  /* Budgeted, serialised, and only ever reached from a button. See storage.js. */
  'GET /api/storage/prefix-size': async (q) =>
    storage.prefixSize({ bucket: q.bucket, prefix: q.prefix || '' }),

  /* The one non-JSON route. Every header here is load-bearing: these are
     user-uploaded survey photographs served from the console's own origin, so
     without the sandbox and a content type chosen by allowlist rather than by
     the uploader, an .html in a bucket is stored XSS against the control
     plane. */
  'GET /api/storage/preview': async (q) => {
    const { body, contentType, contentLength } = await storage.previewObject({ bucket: q.bucket, key: q.key });
    return new RawResponse({
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': contentLength,
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=60',
        'referrer-policy': 'no-referrer'
      },
      body
    });
  },

  /* ------------------------------------------------------ the rest of the stack ---
     Postgres, the cache, the queues and the vault. Each module reports an
     unreachable service as a normal state with a reason, so a route here
     answering 200 with ok:false is the expected shape while that service's
     profile is not started -- not a failure to handle. */

  'GET /api/pg/server': async () => pg.server(),
  'GET /api/pg/databases': async () => pg.databases(),
  'GET /api/pg/roles': async () => pg.roles(),
  'GET /api/pg/activity': async () => pg.activity(),
  'GET /api/pg/statements': async () => pg.statements(),
  'GET /api/pg/replication': async () => pg.replication(),
  'GET /api/pg/tables': async (q) => pg.tables(await pgTableOptions(q)),
  'GET /api/pg/health': async () => pg.health(),

  'GET /api/cache/server': async () => garnet.serverInfo(),
  'GET /api/cache/memory': async () => garnet.memory(),
  'GET /api/cache/clients': async () => garnet.clients(),
  'GET /api/cache/keyspace': async () => garnet.keyspace(),
  'GET /api/cache/health': async () => garnet.health(),

  'GET /api/queues/server': async () => queues.server(),
  'GET /api/queues/account': async () => queues.account(),
  'GET /api/queues/streams': async () => queues.streams(),
  'GET /api/queues/consumers': async (q) => queues.consumers({ stream: q && q.stream }),
  'GET /api/queues/health': async () => queues.health(),

  'GET /api/secrets/health': async () => secrets.health(),
  'GET /api/secrets/seal-status': async () => secrets.sealStatus(),
  'GET /api/secrets/ha': async () => secrets.ha(),
  'GET /api/secrets/sandbox': async () => secrets.sandbox(),

  /* -------------------------------------------------------------- streams ---
     Loki, Prometheus, Alertmanager and the Docker socket proxy all sit behind
     the `observability` Compose profile, which the core stack does not start.
     Every route here answers "not configured" as data, the way the AWS layer
     does, because a console that 500s when an optional profile is down is a
     console nobody trusts during the outage it was built for. */

  'GET /api/logs/health': async () => logs.health(),
  'GET /api/logs/labels': async () => logs.labels(),
  'GET /api/logs/label-values': async (q) => logs.labelValues(String(q.name || '')),

  'GET /api/logs/query': async (q) => logs.query({
    query: logs.selector(q.query),
    limit: logs.boundedLimit(q.limit, config.logTailLimit),
    start: q.start,
    end: q.end,
    since: q.since,
    direction: q.direction === 'forward' ? 'forward' : 'backward'
  }),

  'GET /api/logs/volume': async (q) => logs.volume({ query: logs.selector(q.query), start: q.start, end: q.end }),

  'GET /api/logs/patterns': async (q) =>
    logs.patterns({ query: logs.selector(q.query), start: q.start, end: q.end, step: q.step }),

  'GET /api/logs/stream': async (q) => {
    if (!logs.configured()) {
      return streamUnavailable({
        reason: 'not-configured',
        message: `${logs.LABEL} is not configured. Set ${logs.VARIABLE} to stream logs, or leave it unset ` +
          'and this panel stays empty rather than pretending the service is down.'
      });
    }
    const selector = logs.selector(q.query);
    const limit = logs.boundedLimit(q.limit, config.logTailLimit);

    return new EventStream({
      label: 'logs',
      onOpen: (sink, req) => {
        const plan = replayPlan(logRing, req.headers['last-event-id']);
        if (plan.resumed) {
          if (plan.missed > 0) {
            sink.note('gap', {
              missed: plan.missed,
              reason: 'the replay buffer does not go back that far',
              message: `${plan.missed} lines were dropped between this connection and the last one. ` +
                'Query the range directly with GET /api/logs/query to see them.'
            });
          }
          for (const entry of plan.entries) sink.send('line', entry.value, entry.id);
        }

        sink.note('open', { query: selector, limit, replayedFrom: plan.from });

        return logs.openTail({ query: selector, limit }, {
          onLine: (line) => sink.send('line', line, logRing.push(line)),
          onDropped: (count) => sink.note('dropped', {
            lines: count,
            reason: 'loki reported dropped entries for this tail'
          }),
          onUnavailable: (reason) => sink.note('unavailable', reason),
          onClose: (code) => sink.note('closed', { code: code === undefined ? null : code })
        });
      }
    });
  },

  'GET /api/metrics/health': async () => metrics.health(),
  'GET /api/metrics/targets': async () => metrics.targets(),
  'GET /api/metrics/rules': async () => metrics.rules(),
  'GET /api/metrics/tsdb': async () => metrics.tsdb(),
  'GET /api/metrics/instant': async (q) => metrics.instant(String(q.name || '')),

  'GET /api/metrics/series': async (q) => metrics.series({
    name: String(q.name || ''),
    windowMs: metrics.windowMs(q.window, 3600000),
    points: metrics.points(q.points, 120)
  }),

  'GET /api/alerts/active': async () => alerts.active(),
  'GET /api/alerts/groups': async () => alerts.groups(),
  'GET /api/alerts/silences': async () => alerts.silences(),
  'GET /api/alerts/receivers': async () => alerts.receivers(),
  'GET /api/alerts/health': async () => alerts.health(),

  'GET /api/containers': async () => containers.list(),
  'GET /api/containers/health': async () => containers.health(),
  'GET /api/containers/inspect': async (q) => containers.inspect(containers.containerId(q.id)),
  'GET /api/containers/stats': async (q) => containers.stats(containers.containerId(q.id)),

  'GET /api/containers/logs': async (q) => {
    if (!containers.configured()) {
      return streamUnavailable({
        reason: 'not-configured',
        message: `${containers.LABEL} is not configured. Set ${containers.VARIABLE} to stream container logs. ` +
          'It sits behind the `observability` Compose profile and the console is core, so it is read ' +
          'opportunistically and never depended on.'
      });
    }
    const id = containers.containerId(q.id);
    const tail = containers.boundedTail(q.tail, 200);

    return new EventStream({
      label: 'container-logs',
      onOpen: (sink) => {
        let stop = () => {};
        sink.note('open', { id, tail });
        containers.openLogs({ id, tail, since: q.since }, {
          onLine: (line) => sink.send('line', line),
          onUnavailable: (reason) => sink.note('unavailable', reason),
          onClose: () => sink.note('closed', { id })
        }).then((fn) => { stop = fn; }, () => {});
        return () => stop();
      }
    });
  },

  'GET /api/containers/events': async () => {
    if (!containers.configured()) {
      return streamUnavailable({
        reason: 'not-configured',
        message: `${containers.LABEL} is not configured. Set ${containers.VARIABLE} to follow container events.`
      });
    }
    return new EventStream({
      label: 'container-events',
      onOpen: (sink) => {
        let stop = () => {};
        sink.note('open', {});
        containers.openEvents({
          onEvent: (event) => sink.send('event', event),
          onUnavailable: (reason) => sink.note('unavailable', reason),
          onClose: () => sink.note('closed', {})
        }).then((fn) => { stop = fn; }, () => {});
        return () => stop();
      }
    });
  },

  'GET /api/heartbeats': async (q) => heartbeats.snapshot(Number(q.slots)),
  'GET /api/heartbeats/uptime': async () => heartbeats.uptime(),
  'GET /api/heartbeats/incidents': async (q) => heartbeats.incidents(Number(q.limit)),

  'GET /api/heartbeats/stream': async () => new EventStream({
    label: 'heartbeats',
    onOpen: (sink) => {
      sink.note('open', heartbeats.snapshot(50));
      const onBeat = (beat) => sink.send('beat', {
        monitorId: beat.monitorId,
        label: beat.label,
        at: new Date(beat.at).toISOString(),
        status: beat.status,
        statusName: beat.statusName,
        pingMs: beat.pingMs,
        important: beat.important,
        message: beat.message || null
      });
      heartbeats.events.on('beat', onBeat);
      return () => heartbeats.events.removeListener('beat', onBeat);
    }
  }),

  /* The estate in one call, for the overview screen. Partial failure is the
     normal case -- an account may allow EC2 and deny RDS -- so each section
     carries its own ok/reason and one denial does not blank the page. */
  'GET /api/overview': async () => {
    const [identity, instances, buckets, databases, alarms, h] = await Promise.all([
      aws.identity(), aws.instances(), aws.buckets(), aws.databases(), aws.alarms(), host.snapshot()
    ]);
    return { identity, instances, buckets, databases, alarms, host: h, at: new Date().toISOString() };
  }
};

/* ------------------------------------------------------------------- serve --- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

const WEB_ROOT = path.resolve(__dirname, config.webRoot);

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/capabilities',
  authRoutes.LOGIN_PATH,
  authRoutes.LOGOUT_PATH
]);

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // Resolve, then verify containment. Joining user input onto a root without
  // this check allows path traversal.
  const target = path.resolve(WEB_ROOT, '.' + rel);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'x-content-type-options': 'nosniff'
    });
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    sendJson(res, 404, { error: 'not found', path: rel });
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();

  headers.apply(res);
  res.setHeader('x-argus-request-id', requestId);

  /* WHATWG URL, not url.parse. Node deprecated the legacy parser precisely
     because its behaviour is not standardised and gets security decisions
     wrong -- and the value it produces here is fed straight into a path
     resolution. A parse that throws on a malformed request is the correct
     outcome; it becomes a 400 rather than an ambiguous path. */
  let parsed;
  try {
    parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    return sendJson(res, 400, { error: 'bad request', message: 'The request URL could not be parsed.' });
  }
  const pathname = safeDecode(parsed.pathname);
  const sourceAddress = proxyAuth.sourceAddress(req);
  const context = { requestId, pathname, sourceAddress };

  const stateChanging = authRoutes.WRITE_PATHS.has(pathname) || config.allowWrites;
  const verdict = originGate.decide(req, pathname, { stateChanging });
  if (!verdict.allowed) {
    audit('auth.csrf.rejected', {
      outcome: authConfig.originEnforce ? 'failure' : 'defer',
      reason: verdict.reason,
      method: req.method,
      path: pathname,
      sourceAddress,
      requestId,
      userAgent: req.headers['user-agent'],
      enforced: authConfig.originEnforce
    });
    if (authConfig.originEnforce) {
      log('info', `${req.method} ${pathname} 403 cross-site ${verdict.reason}`);
      return sendJson(res, 403, {
        ok: false,
        error: 'cross-site',
        message: 'This request did not come from the console itself. The console refuses requests that a ' +
          'browser did not originate on its own origin.'
      });
    }
  }

  if (pathname === authRoutes.LOGIN_PATH && req.method === 'POST') {
    try {
      return await authRoutes.login(req, res, context, sendJson);
    } catch (err) {
      log('error', `login failed: ${err && err.message}`);
      return sendJson(res, 500, { ok: false, error: 'internal', message: 'Sign-in could not be processed.' });
    } finally {
      log('info', `${req.method} ${pathname} ${Date.now() - started}ms`);
    }
  }

  if (pathname === authRoutes.LOGOUT_PATH && req.method === 'POST') {
    try {
      return await authRoutes.logout(req, res, context, sendJson);
    } finally {
      log('info', `${req.method} ${pathname} ${Date.now() - started}ms`);
    }
  }

  const resolved = authGate.resolvePrincipal(req, res, context);
  const principal = resolved.principal;

  if (pathname === authRoutes.SESSION_PATH) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: 'GET this endpoint.' });
    }
    log('info', `${req.method} ${pathname} ${Date.now() - started}ms`);
    return authRoutes.session(req, res, context, sendJson, principal);
  }

  const isApi = pathname.startsWith('/api/');

  if (isApi && !principal && !PUBLIC_API_PATHS.has(pathname)) {
    audit('auth.denied', {
      outcome: 'failure',
      reason: resolved.reason,
      method: req.method,
      path: pathname,
      sourceAddress,
      requestId,
      userAgent: req.headers['user-agent']
    });
    log('info', `${req.method} ${pathname} 401 ${resolved.reason}`);
    return sendJson(res, 401, {
      ok: false,
      error: 'unauthenticated',
      message: authConfig.mode === 'proxy'
        ? 'This console takes its identity from a trusted reverse proxy, and this request did not arrive through one.'
        : 'Sign in to read this. POST /api/auth/login with an operator name and password.'
    });
  }

  // Mutating verbs are refused unless writes are explicitly enabled, before
  // any route is even looked up. Sign-in and sign-out are carved out: they are
  // authentication, not a change to the estate, and refusing them here would
  // make the default read-only deployment impossible to log into.
  if (!config.allowWrites && !authRoutes.WRITE_PATHS.has(pathname)
      && req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, {
      error: 'read-only',
      message: 'This console is running read-only. Set ARGUS_ALLOW_WRITES=1 to permit changes.'
    });
  }

  const key = req.method + ' ' + pathname;
  const handler = routes[key];

  try {
    if (handler) {
      const body = await handler(Object.fromEntries(parsed.searchParams), { principal, requestId, sourceAddress });
      if (body instanceof EventStream) {
        startEventStream(req, res, body, log);
      } else if (body instanceof RawResponse) {
        res.writeHead(body.status, body.headers);
        if (body.stream) {
          /* Destroy the upstream body if the browser goes away mid-download,
             so an operator closing a tab does not leave the S3 connection open
             until it times out. */
          res.on('close', () => { if (typeof body.stream.destroy === 'function') body.stream.destroy(); });
          body.stream.on('error', (err) => {
            log('error', `${key} stream failed: ${err && err.message}`);
            res.destroy();
          });
          body.stream.pipe(res);
        } else {
          res.end(body.body);
        }
      } else {
        sendJson(res, 200, body);
      }
    } else if (isApi) {
      sendJson(res, 404, { error: 'no such endpoint', path: pathname });
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    log('error', `${key} failed: ${err && err.message}`);
    if (res.headersSent) { res.destroy(); return; }
    const status = statusForError(err);
    /* A 4xx is the caller's fault and the caller can fix it, so it gets the
       real reason. A 5xx is ours: the client gets a shape and the stack stays
       in the log, because an internal stack in an HTTP body is a map of the
       filesystem. */
    if (status < 500) {
      const c = storage.classify(err);
      sendJson(res, status, { ok: false, error: err.name || c.reason, message: err.message || c.message });
    } else {
      sendJson(res, status, {
        ok: false, error: 'internal',
        message: 'The request failed. The reason is in the server log.'
      });
    }
  } finally {
    log('info', `${req.method} ${pathname} ${Date.now() - started}ms`);
  }
});

/* Without these a console reachable from anything but a reverse proxy can be
   held open by a client that never finishes a request. The Node docs are
   explicit that requestTimeout must be non-zero when there is no proxy in
   front, and this one is designed to run standalone. */
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 20000;
server.maxHeadersCount = 64;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function escapeControl(ch) {
  return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
}

function log(level, msg) {
  if ((LEVELS[level] ?? 2) > (LEVELS[config.logLevel] ?? 2)) return;
  process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} ${String(msg).replace(CONTROL_CHARS, escapeControl)}\n`);
}

function probeOf(reader) {
  return async () => {
    const answer = await reader();
    if (!answer || answer.ok !== true) {
      return { up: false, message: (answer && answer.message) || 'The reader gave no reason.' };
    }
    if (answer.healthy === false || answer.reachable === false || answer.ready === false) {
      return { up: false, message: answer.detail || 'The service answered but reported itself unhealthy.' };
    }
    return { up: true, message: null };
  };
}

function registerMonitors() {
  const specs = [
    { id: 'storage', label: 'Object store', probe: probeOf(storage.health) },
    { id: 'postgres', label: 'PostgreSQL', probe: probeOf(pg.health) },
    { id: 'cache', label: 'Garnet', probe: probeOf(garnet.health) },
    { id: 'queues', label: 'NATS', probe: probeOf(queues.health) },
    { id: 'secrets', label: 'OpenBao', probe: probeOf(secrets.health) },
    { id: 'logs', label: 'Loki', probe: probeOf(logs.health) },
    { id: 'metrics', label: 'Prometheus', probe: probeOf(metrics.health) },
    { id: 'alerts', label: 'Alertmanager', probe: probeOf(alerts.health) },
    { id: 'containers', label: 'Docker socket proxy', probe: probeOf(containers.health) }
  ];
  for (const spec of specs) heartbeats.register(spec);
}

registerMonitors();

/* Shut down on a signal rather than being killed mid-response, so a rolling
   restart does not drop the request somebody is waiting on. */
function shutdown(signal) {
  log('info', `${signal} received, closing`);
  heartbeats.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    log('info', `argus console api on http://${config.host}:${config.port}`);
    log('info', `region ${config.region}, writes ${config.allowWrites ? 'ENABLED' : 'read-only'}, web root ${WEB_ROOT}`);
    log('info', `auth ${authConfig.mode}${authConfig.mode === 'off' ? ' (LOCAL DEVELOPMENT, LOOPBACK ONLY)' : ''}, ` +
      `cookies ${authConfig.secureCookies ? 'secure' : 'plain-http'}`);
    heartbeats.start();
  });
}

module.exports = { server, routes, RawResponse, EventStream, logRing };
