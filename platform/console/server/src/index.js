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

const config = require('./config');
const env = require('./env');
const host = require('./host');
const aws = require('./aws');
const storage = require('./storage');
const pg = require('./pg');
const garnet = require('./garnet');
const queues = require('./queues');
const secrets = require('./secrets');

env.reportRejections();

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

/* ------------------------------------------------------------------ routes --- */

const routes = {
  'GET /api/health': async () => ({
    status: 'ok',
    startedAt: STARTED.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    version: require('../package.json').version
  }),

  /* One call the UI can make on load to learn what this deployment can do,
     instead of discovering it from a series of failures. */
  'GET /api/capabilities': async () => {
    const id = await aws.identity();
    return {
      region: config.region,
      writesAllowed: config.allowWrites,
      costEnabled: config.costEnabled,
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

  // Mutating verbs are refused unless writes are explicitly enabled, before
  // any route is even looked up.
  if (!config.allowWrites && req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, {
      error: 'read-only',
      message: 'This console is running read-only. Set ARGUS_ALLOW_WRITES=1 to permit changes.'
    });
  }

  const key = req.method + ' ' + pathname;
  const handler = routes[key];

  try {
    if (handler) {
      const body = await handler(Object.fromEntries(parsed.searchParams));
      if (body instanceof RawResponse) {
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
    } else if (pathname.startsWith('/api/')) {
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

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function escapeControl(ch) {
  return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
}

function log(level, msg) {
  if ((LEVELS[level] ?? 2) > (LEVELS[config.logLevel] ?? 2)) return;
  process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} ${String(msg).replace(CONTROL_CHARS, escapeControl)}\n`);
}

/* Shut down on a signal rather than being killed mid-response, so a rolling
   restart does not drop the request somebody is waiting on. */
function shutdown(signal) {
  log('info', `${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    log('info', `argus console api on http://${config.host}:${config.port}`);
    log('info', `region ${config.region}, writes ${config.allowWrites ? 'ENABLED' : 'read-only'}, web root ${WEB_ROOT}`);
  });
}

module.exports = { server, routes };
