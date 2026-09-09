/*
 * The Argus console API.
 *
 *   node src/index.js          # http://127.0.0.1:8787
 *
 * Serves real host telemetry, a real AWS inventory, and the console's own
 * static files, from one process with no build step.
 *
 * Deliberate choices, because each has bitten a dashboard somewhere:
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
const host = require('./host');
const aws = require('./aws');

const STARTED = new Date();

/* decodeURIComponent throws URIError on a malformed escape such as "%" or
   "%zz". A request for one of those must be a 404, not an unhandled throw. */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (err) { return s; }
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
  // this check is the oldest file-serving bug there is.
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
      sendJson(res, 200, body);
    } else if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'no such endpoint', path: pathname });
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    // Never leak an internal stack to the client; log it, return a shape.
    log('error', `${key} failed: ${err && err.message}`);
    sendJson(res, 500, { error: 'internal', message: 'The request failed. The reason is in the server log.' });
  } finally {
    log('info', `${req.method} ${pathname} ${Date.now() - started}ms`);
  }
});

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, msg) {
  if ((LEVELS[level] ?? 2) > (LEVELS[config.logLevel] ?? 2)) return;
  process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} ${msg}\n`);
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
