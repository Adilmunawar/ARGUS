'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { pipeline } = require('stream');

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
const hosts = require('./auth/hosts');
const authorize = require('./auth/authorize');
const scrape = require('./auth/scrape');
const sessions = require('./auth/sessions');
const { audit } = require('./auth/audit');
const { sendJson, sendError, describeError, classifiedAs, levelFor } = require('./errors');

const { EventStream, RingBuffer, startEventStream, replayPlan, openStreamCount } = require('./sse');
const telemetry = require('./telemetry');
const logs = require('./logs');
const metrics = require('./metrics');
const alerts = require('./alerts');
const containers = require('./containers');
const heartbeats = require('./heartbeats');
const search = require('./search');
const sources = require('./sources');

env.reportRejections();

for (const note of authConfig.notes) process.stderr.write(`argus: ${note}\n`);
for (const note of hosts.notes) process.stderr.write(`argus: ${note}\n`);
if (scrape.bootNote()) process.stderr.write(`argus: ${scrape.bootNote()}\n`);

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

class RawResponse {
  constructor({ status = 200, headers: responseHeaders = {}, body = null, stream = null }) {
    this.status = status;
    this.headers = responseHeaders;
    this.body = body;
    this.stream = stream;
  }
}

const storageFailure = classifiedAs(storage.classify);

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

const logRings = new Map();

function logRingFor(query) {
  const existing = logRings.get(query);
  if (existing) {
    logRings.delete(query);
    logRings.set(query, existing);
    return existing;
  }
  while (logRings.size >= config.logRingQueries) logRings.delete(logRings.keys().next().value);
  const ring = new RingBuffer(config.logRingLines);
  logRings.set(query, ring);
  return ring;
}

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

const routes = {
  'GET /api/health': async (q, ctx) => ({
    status: 'ok',
    startedAt: STARTED.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    ...(ctx && ctx.principal ? { version: require('../package.json').version } : {})
  }),

  'GET /api/capabilities': async (q, ctx) => {
    const principal = ctx && ctx.principal;
    if (!principal) {
      return {
        auth: { mode: authConfig.mode, authenticated: false },
        writesAllowed: false
      };
    }
    return {
      auth: {
        mode: authConfig.mode,
        authenticated: true,
        subject: principal.subject,
        displayName: principal.displayName,
        roles: principal.roles,
        tier: authorize.tierOf(principal.roles),
        expiresAt: principal.expiresAt || null,
        idleExpiresAt: principal.idleExpiresAt || null
      },
      region: config.region,
      writesAllowed: config.allowWrites,
      environment: config.environment || null,
      costEnabled: config.costEnabled,
      streams: {
        logs: logs.configured(),
        metrics: metrics.configured(),
        alerts: alerts.configured(),
        containers: containers.configured(),
        heartbeats: true
      },
      aws: aws.configured()
    };
  },

  'GET /api/host': async () => host.snapshot(),

  'GET /api/aws/identity': async () => aws.identity(),
  'GET /api/aws/instances': async () => aws.instances(),
  'GET /api/aws/buckets': async () => aws.buckets(),
  'GET /api/aws/databases': async () => aws.databases(),
  'GET /api/aws/alarms': async () => aws.alarms(),
  'GET /api/aws/cost': async () => aws.cost(),

  'GET /api/storage/health': async () => storage.health(),
  'GET /api/storage/capacity': async () => storage.capacity(),
  'GET /api/storage/buckets': async () => storage.buckets(),
  'GET /api/storage/lock-status': async () => storage.lockStatus(),

  'GET /api/storage/objects': async (q) =>
    storage.listObjects({ bucket: q.bucket, prefix: q.prefix || '', cursor: q.cursor || null }).catch(storageFailure),

  'GET /api/storage/object': async (q) =>
    storage.describeObject({ bucket: q.bucket, key: q.key }).catch(storageFailure),

  'GET /api/storage/prefix-size': async (q) =>
    storage.prefixSize({ bucket: q.bucket, prefix: q.prefix || '' }).catch(storageFailure),

  'GET /api/storage/preview': async (q) => {
    const { body, contentType, contentLength } = await storage.previewObject({ bucket: q.bucket, key: q.key })
      .catch(storageFailure);
    return new RawResponse({
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': contentLength,
        'content-security-policy': headers.PREVIEW_CSP,
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
        'cache-control': 'private, max-age=60',
        'referrer-policy': 'no-referrer'
      },
      body
    });
  },

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
        const ring = logRingFor(selector);
        const plan = replayPlan(ring, req.headers['last-event-id'] || q.lastEventId);
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
          onLine: (line) => sink.send('line', line, ring.push(line)),
          onDropped: (count) => sink.note('dropped', {
            lines: count,
            reason: 'loki reported dropped entries for this tail'
          }),
          onUnavailable: (reason) => { sink.note('unavailable', reason); sink.close(); },
          onClose: (code) => {
            sink.note('closed', { code: code === undefined ? null : code });
            sink.close();
          }
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

  'GET /api/containers': async (q) => (q && q.detail === '1' ? containers.summary() : containers.list()),
  'GET /api/containers/summary': async () => containers.summary(),
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
        let stop = null;
        let stopped = false;
        sink.note('open', { id, tail });
        containers.openLogs({ id, tail, since: q.since }, {
          onLine: (line) => sink.send('line', line),
          onUnavailable: (reason) => { sink.note('unavailable', reason); sink.close(); },
          onClose: () => { sink.note('closed', { id }); sink.close(); }
        }).then((fn) => { stop = fn; if (stopped) fn(); }, () => {});
        return () => { stopped = true; if (stop) stop(); };
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
        let stop = null;
        let stopped = false;
        sink.note('open', {});
        containers.openEvents({
          onEvent: (event) => sink.send('event', event),
          onUnavailable: (reason) => { sink.note('unavailable', reason); sink.close(); },
          onClose: () => { sink.note('closed', {}); sink.close(); }
        }).then((fn) => { stop = fn; if (stopped) fn(); }, () => {});
        return () => { stopped = true; if (stop) stop(); };
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

  'GET /api/search/index': async () => search.index(),

  'GET /api/gitops/apps': async () => sources.apps(),
  'GET /api/gitops/environments': async () => sources.environments(),
  'GET /api/gitops/service-accounts': async () => sources.serviceAccounts(),
  'GET /api/identity/principals': async () => sources.principals({ pgRoles: () => pg.roles() }),
  'GET /api/runbooks': async () => sources.runbooks(),
  'GET /api/runbooks/body': async (q) => sources.runbookBody(q.path),
  'GET /api/audit/recent': async (q) => sources.auditRecent(q.limit),

  'GET /metrics': async (q, ctx) => new RawResponse({
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: telemetry.render({
      version: ctx && (ctx.principal || ctx.scrapeAuthenticated) ? require('../package.json').version : null,
      uptimeSeconds: Math.round(process.uptime()),
      openStreams: openStreamCount()
    })
  }),

  'GET /api/overview': async () => {
    const [identity, instances, buckets, databases, alarms, h] = await Promise.all([
      aws.identity(), aws.instances(), aws.buckets(), aws.databases(), aws.alarms(), host.snapshot()
    ]);
    return { identity, instances, buckets, databases, alarms, host: h, at: new Date().toISOString() };
  }
};

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

const STREAM_PATHS = new Set([
  '/api/logs/stream',
  '/api/containers/logs',
  '/api/containers/events',
  '/api/heartbeats/stream'
]);

const REFUSED_STATIC_ROOTS = new Set(['tests']);

function staticRefused(target) {
  const rel = path.relative(WEB_ROOT, target);
  if (!rel) return false;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length && REFUSED_STATIC_ROOTS.has(segments[0].toLowerCase())) return true;
  return segments.some((segment) => segment.startsWith('.'));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.split(/[\\/]+/).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
    return sendError(res, 404, 'not-found', 'There is no such file.');
  }
  const target = path.resolve(WEB_ROOT, '.' + rel);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) {
    return sendError(res, 403, 'forbidden', 'That path leaves the console web root.');
  }
  if (staticRefused(target)) return sendError(res, 404, 'not-found', 'There is no such file.');
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isDirectory()) return sendError(res, 404, 'not-found', 'There is no such file.');
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
      'last-modified': stat.mtime.toUTCString(),
      'x-content-type-options': 'nosniff'
    });
    pipeline(fs.createReadStream(target), res, (err) => {
      if (err) {
        log('warn', `static ${rel} failed: ${err.message}`);
        res.destroy();
      }
    });
  } catch (err) {
    sendError(res, 404, 'not-found', 'There is no such file.', { path: rel });
  }
}

function routeLabel(method, pathname) {
  if (routes[method + ' ' + pathname]) return pathname;
  if (pathname === authRoutes.LOGIN_PATH || pathname === authRoutes.LOGOUT_PATH
      || pathname === authRoutes.SESSION_PATH) return pathname;
  return pathname.startsWith('/api/') ? 'unmatched' : 'static';
}

function streamBinding(principal) {
  if (!principal) return {};
  const binding = { owner: `${principal.source}:${principal.subject}` };
  if (principal.source === 'session' && principal.sessionKey) {
    binding.check = () => sessions.peek(principal.sessionKey);
    const expiresAt = Date.parse(principal.expiresAt);
    if (Number.isFinite(expiresAt)) binding.expiresAt = expiresAt;
  }
  return binding;
}

const UNAUTHENTICATED_MESSAGE = authConfig.mode === 'proxy'
  ? 'This console takes its identity from a trusted reverse proxy, and this request did not arrive through one.'
  : 'Sign in to read this. POST /api/auth/login with an operator name and password.';

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();

  headers.apply(res);
  res.setHeader('x-argus-request-id', requestId);

  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (err) {
    return sendError(res, 400, 'invalid-request', 'The request URL could not be parsed.');
  }
  const pathname = safeDecode(parsed.pathname);
  const sourceAddress = proxyAuth.sourceAddress(req);
  const context = { requestId, pathname, sourceAddress };

  res.on('finish', () => {
    const streamed = String(res.getHeader('content-type') || '').startsWith('text/event-stream');
    telemetry.observe(routeLabel(req.method, pathname), res.statusCode, Date.now() - started, !streamed);
    log(levelFor(res.statusCode), `${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });

  const hostVerdict = hosts.check(req);
  if (!hostVerdict.allowed) {
    audit('auth.host.rejected', {
      outcome: 'failure',
      reason: hostVerdict.reason,
      method: req.method,
      path: pathname,
      sourceAddress,
      requestId
    });
    return sendError(res, 421, 'misdirected',
      'This console does not answer for the host name this request named. Reach it on a loopback address, ' +
      'the host of ARGUS_AUTH_PUBLIC_ORIGIN, or a host listed in ARGUS_ALLOWED_HOSTS.');
  }

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
      return sendError(res, 403, 'cross-site',
        'This request did not come from the console itself. The console refuses requests that a ' +
        'browser did not originate on its own origin.', { signal: verdict.reason });
    }
  }

  if (pathname === authRoutes.LOGIN_PATH && req.method === 'POST') {
    try {
      return await authRoutes.login(req, res, context);
    } catch (err) {
      log('error', `login failed: ${err && err.message}`);
      if (res.headersSent) { res.destroy(); return; }
      return sendError(res, 500, 'internal', 'Sign-in could not be processed.');
    }
  }

  if (pathname === authRoutes.LOGOUT_PATH && req.method === 'POST') {
    return authRoutes.logout(req, res, context);
  }

  const resolved = authGate.resolvePrincipal(req, res, context);
  const principal = resolved.principal;

  if (resolved.reason === 'duplicate-session-cookie') {
    return sendError(res, 401, 'duplicate-session-cookie',
      'This request carried two console session cookies, so neither is trusted. Both are being cleared; ' +
      'reload the page and sign in again.');
  }

  if (pathname === authRoutes.SESSION_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return sendError(res, 405, 'method-not-allowed', 'GET this endpoint.');
    }
    return authRoutes.session(req, res, context, principal);
  }

  const isApi = pathname.startsWith('/api/');
  const handlerContext = { principal, requestId, sourceAddress, scrapeAuthenticated: false };

  if (pathname === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
    const scraped = scrape.decide(req.headers.authorization);
    if (!scraped.allowed) {
      audit('auth.metrics.denied', { outcome: 'failure', reason: scraped.reason, sourceAddress, requestId });
      return sendError(res, 401, scraped.reason, scraped.message, null,
        { 'www-authenticate': 'Bearer realm="argus-metrics"' });
    }
    handlerContext.scrapeAuthenticated = !!scraped.authenticated;
  }

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
    return sendError(res, 401, 'unauthenticated', UNAUTHENTICATED_MESSAGE);
  }

  if (isApi && principal && !PUBLIC_API_PATHS.has(pathname)) {
    const access = authorize.decide(principal, pathname);
    if (!access.allowed) {
      audit('auth.role.denied', {
        outcome: 'failure',
        reason: 'role',
        subject: principal.subject,
        required: access.required,
        held: access.held,
        method: req.method,
        path: pathname,
        sourceAddress,
        requestId
      });
      return sendError(res, 403, 'forbidden',
        `This needs the ${access.required} role or above, and this session holds ${access.held}.`,
        { reason: 'role', required: access.required, held: access.held });
    }
  }

  if (!config.allowWrites && !authRoutes.WRITE_PATHS.has(pathname)
      && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return sendError(res, 405, 'read-only',
      'This console is running read-only. Set ARGUS_ALLOW_WRITES=1 to permit changes.');
  }

  if (req.method === 'HEAD' && STREAM_PATHS.has(pathname)) {
    res.setHeader('allow', 'GET');
    return sendError(res, 405, 'method-not-allowed', 'A live stream is opened with GET; HEAD would hold a connection for nothing.');
  }

  const key = (req.method === 'HEAD' ? 'GET' : req.method) + ' ' + pathname;
  const handler = routes[key];

  try {
    if (handler) {
      const body = await handler(Object.fromEntries(parsed.searchParams), handlerContext);
      if (body instanceof EventStream) {
        startEventStream(req, res, body, log, streamBinding(principal));
      } else if (body instanceof RawResponse) {
        res.writeHead(body.status, body.headers);
        if (body.stream) {
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
      sendError(res, 404, 'no-such-endpoint', 'There is no such API endpoint.', { path: pathname });
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    const failure = describeError(err);
    log(levelFor(failure.status), `${key} failed: ${failure.status} ${err && err.message}`);
    if (res.headersSent) { res.destroy(); return; }
    sendError(res, failure.status, failure.reason, failure.message, failure.extra);
  }
});

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

function shutdown(signal) {
  log('info', `${signal} received, closing`);
  heartbeats.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); }, 1000).unref();
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

module.exports = { server, routes, RawResponse, EventStream, logRingFor };
