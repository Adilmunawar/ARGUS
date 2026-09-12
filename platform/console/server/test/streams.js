'use strict';

const http = require('http');
const crypto = require('node:crypto');
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.STREAMS_PORT || 8951);
const PROM_PORT = PORT + 1;
const DOCKER_PORT = PORT + 2;
const LOKI_PORT = PORT + 3;
const DEAD_PORT = PORT + 4;

process.env.ARGUS_PORT = String(PORT);
process.env.ARGUS_HOST = '127.0.0.1';
process.env.ARGUS_AUTH = 'off';
process.env.ARGUS_LOG_LEVEL = 'error';
process.env.ARGUS_PROM_URL = `http://127.0.0.1:${PROM_PORT}`;
process.env.ARGUS_DOCKER_PROXY_URL = `http://127.0.0.1:${DOCKER_PORT}`;
process.env.ARGUS_LOKI_URL = `http://127.0.0.1:${LOKI_PORT}`;
process.env.ARGUS_ALERTMANAGER_URL = `http://127.0.0.1:${DEAD_PORT}`;
process.env.ARGUS_UPSTREAM_TIMEOUT_MS = '3000';
process.env.ARGUS_LOG_RING_LINES = '50';
process.env.ARGUS_SSE_HEARTBEAT_MS = '30000';
process.env.ARGUS_HEARTBEAT_INTERVAL_MS = '3600000';
process.env.AWS_ACCESS_KEY_ID = '';
process.env.AWS_SECRET_ACCESS_KEY = '';
process.env.AWS_PROFILE = '__argus_streams_no_such_profile__';
process.env.AWS_EC2_METADATA_DISABLED = 'true';

const { server, logRingFor } = require('../src/index.js');
const { RingBuffer, replayPlan } = require('../src/sse.js');
const containers = require('../src/containers.js');
const metrics = require('../src/metrics.js');
const heartbeats = require('../src/heartbeats.js');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: err.message }); }
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin', ...(headers || {}) }
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openStream(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'GET',
      headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin', ...(headers || {}) }
    }, (res) => {
      const stream = {
        status: res.statusCode,
        headers: res.headers,
        text: '',
        close() { req.destroy(); },
        until(predicate, timeoutMs) {
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(
              `the stream never matched: ${JSON.stringify(stream.text).slice(0, 400)}`)), timeoutMs || 5000);
            const tick = () => {
              if (predicate(stream.text)) { clearTimeout(timer); done(stream.text); return true; }
              return false;
            };
            if (tick()) return;
            res.on('data', tick);
            res.on('end', () => { clearTimeout(timer); if (!predicate(stream.text)) fail(new Error('stream ended')); });
          });
        }
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => { stream.text += chunk; });
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}

function frames(text) {
  return text.split('\n\n').filter((block) => block.trim().length > 0).map((block) => {
    const out = { id: null, event: null, data: null, comment: null };
    for (const line of block.split('\n')) {
      if (line.startsWith(': ')) out.comment = line.slice(2);
      else if (line.startsWith('id: ')) out.id = line.slice(4);
      else if (line.startsWith('event: ')) out.event = line.slice(7);
      else if (line.startsWith('data: ')) { try { out.data = JSON.parse(line.slice(6)); } catch (e) { out.data = line.slice(6); } }
      else if (line.startsWith('retry: ')) out.retry = Number(line.slice(7));
    }
    return out;
  });
}

const PROM_QUERY_RANGE = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [{ metric: { instance: 'node-01' }, values: [[1700000000, '0.42'], [1700000015, '0.51']] }]
  }
};

const PROM_TARGETS = {
  status: 'success',
  data: {
    activeTargets: [
      { labels: { job: 'node', instance: 'node-01' }, scrapePool: 'node', health: 'up', lastScrape: '2026-09-12T00:00:00Z' },
      { labels: { job: 'postgres', instance: 'pg-01' }, scrapePool: 'postgres', health: 'down', lastError: 'refused' }
    ]
  }
};

const promStub = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/-/healthy' || url === '/-/ready') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Prometheus Server is Ready.');
  }
  const body = url === '/api/v1/query_range' ? PROM_QUERY_RANGE
    : url === '/api/v1/targets' ? PROM_TARGETS
      : url === '/api/v1/query' ? { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1700000000, '3'] }] } }
        : { status: 'error', errorType: 'bad_data', error: 'no such endpoint' };
  const text = JSON.stringify(body);
  res.writeHead(body.status === 'success' ? 200 : 400,
    { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
});

const CONTAINER_ID = 'a1b2c3d4e5f60000';
const SECRET_IN_ENV = 'hunter2-do-not-render-this';

const dockerStub = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('/_ping')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('OK');
  }
  let body;
  if (url.endsWith('/version')) body = { ApiVersion: '1.43' };
  else if (url.endsWith('/containers/json')) {
    body = [{
      Id: CONTAINER_ID, Names: ['/argus-console'], Image: 'node:22-bookworm-slim',
      State: 'running', Status: 'Up 2 hours (healthy)', Created: 1700000000,
      Ports: [{ IP: '127.0.0.1', PrivatePort: 8787, PublicPort: 8787, Type: 'tcp' }], Labels: { app: 'argus' }
    }];
  } else if (url.endsWith('/json')) {
    body = {
      Id: CONTAINER_ID, Name: '/argus-console', RestartCount: 0,
      Config: { Image: 'node:22', Cmd: ['node', 'src/index.js'], Env: [`POSTGRES_PASSWORD=${SECRET_IN_ENV}`], Labels: {} },
      State: { Status: 'running', Running: true, ExitCode: 0, StartedAt: '2026-09-12T00:00:00Z' },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Memory: 335544320 }
    };
  } else if (url.endsWith('/stats')) {
    body = {
      read: '2026-09-12T00:00:00Z',
      cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 20000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 },
      memory_stats: { usage: 1048576, limit: 335544320 },
      pids_stats: { current: 12 }
    };
  } else body = {};
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
});

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

const lokiSockets = new Set();

const lokiStub = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/ready') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ready\n');
  }
  const text = JSON.stringify({ status: 'success', data: ['container', 'job'] });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
});

lokiStub.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  lokiSockets.add(socket);
  socket.on('close', () => lokiSockets.delete(socket));
  socket.on('error', () => lokiSockets.delete(socket));
});

function pushLokiLine(line, level) {
  const payload = JSON.stringify({
    streams: [{
      stream: { container: 'argus-console', detected_level: level || 'info' },
      values: [[String(Date.now() * 1e6), line]]
    }]
  });
  for (const socket of lokiSockets) socket.write(textFrame(payload));
}

function listen(s, port) {
  return new Promise((resolve) => s.listen(port, '127.0.0.1', resolve));
}

(async () => {
  await listen(server, PORT);
  await listen(promStub, PROM_PORT);
  await listen(dockerStub, DOCKER_PORT);
  await listen(lokiStub, LOKI_PORT);

  const ring = new RingBuffer(4);
  for (const value of ['a', 'b', 'c']) ring.push(value);
  check('a ring buffer numbers entries from one and replays only what came after an id', () => {
    assert.strictEqual(ring.seq, 3);
    assert.deepStrictEqual(ring.since(1).map((e) => e.value), ['b', 'c']);
    assert.deepStrictEqual(ring.since(3).map((e) => e.value), []);
    assert.deepStrictEqual(ring.since(0).map((e) => e.value), ['a', 'b', 'c']);
  });

  for (const value of ['d', 'e', 'f']) ring.push(value);
  check('a ring buffer that has wrapped forgets the oldest entries and says so', () => {
    assert.strictEqual(ring.seq, 6);
    assert.strictEqual(ring.oldestId, 3);
    assert.deepStrictEqual(ring.since(2).map((e) => e.value), ['c', 'd', 'e', 'f']);
  });

  check('a Last-Event-ID inside the buffer replays exactly the gap', () => {
    const plan = replayPlan(ring, '4');
    assert.strictEqual(plan.resumed, true);
    assert.strictEqual(plan.missed, 0);
    assert.deepStrictEqual(plan.entries.map((e) => e.id), [5, 6]);
  });

  check('a Last-Event-ID older than the buffer reports the lines it cannot replay', () => {
    const plan = replayPlan(ring, '1');
    assert.strictEqual(plan.resumed, true);
    assert.strictEqual(plan.missed, 1, `missed ${plan.missed}`);
    assert.deepStrictEqual(plan.entries.map((e) => e.id), [3, 4, 5, 6]);
  });

  check('no Last-Event-ID and a nonsense one both mean "start fresh", never a crash', () => {
    assert.strictEqual(replayPlan(ring, undefined).resumed, false);
    assert.strictEqual(replayPlan(ring, '').resumed, false);
    assert.strictEqual(replayPlan(ring, 'nine').resumed, false);
    assert.strictEqual(replayPlan(ring, '-4').resumed, false);
  });

  const beats = await openStream('/api/heartbeats/stream');
  check('a stream answers as an event stream and forbids buffering', () => {
    assert.strictEqual(beats.status, 200, `status ${beats.status}`);
    assert.match(beats.headers['content-type'], /text\/event-stream/);
    assert.match(beats.headers['cache-control'], /no-store/);
    assert.match(beats.headers['cache-control'], /no-transform/);
    assert.strictEqual(beats.headers['x-accel-buffering'], 'no');
  });
  check('a stream carries the security headers every other response carries', () => {
    assert.ok(beats.headers['content-security-policy']);
    assert.strictEqual(beats.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(beats.headers['referrer-policy'], 'no-referrer');
  });

  await beats.until((t) => t.includes('event: open'), 4000);
  const beatFrames = frames(beats.text);
  check('the server chooses the reconnect delay rather than leaving it to the browser', () => {
    assert.strictEqual(beatFrames[0].retry, 3000, JSON.stringify(beatFrames[0]));
  });
  check('the first named frame is a well-formed open event with a JSON payload', () => {
    const open = beatFrames.find((f) => f.event === 'open');
    assert.ok(open, JSON.stringify(beatFrames).slice(0, 300));
    assert.ok(Array.isArray(open.data.monitors), 'the open frame carried no monitor list');
    assert.strictEqual(open.data.persistence, 'memory');
  });

  const probe = heartbeats.register({
    id: 'streams-probe',
    label: 'A probe this test controls',
    probe: async () => ({ up: false, message: 'deliberately down' }),
    intervalMs: 3600000,
    maxRetries: 2
  });
  await heartbeats.runOnce(probe);
  await beats.until((t) => t.includes('event: beat'), 4000);
  check('a heartbeat reaches the stream as a named event with an id-free payload', () => {
    const beat = frames(beats.text).find((f) => f.event === 'beat' && f.data.monitorId === 'streams-probe');
    assert.ok(beat, 'no beat frame for the test monitor');
    assert.strictEqual(beat.data.statusName, 'pending');
    assert.strictEqual(beat.data.message, 'deliberately down');
  });
  beats.close();

  await heartbeats.runOnce(probe);
  check('a failing check stays pending until it has failed more than maxRetries times', () => {
    assert.strictEqual(probe.lastBeat.statusName, 'pending', `status ${probe.lastBeat.statusName}`);
    assert.strictEqual(probe.consecutiveFailures, 2);
  });
  await heartbeats.runOnce(probe);
  check('the third consecutive failure is what opens an incident', () => {
    assert.strictEqual(probe.lastBeat.statusName, 'down', `status ${probe.lastBeat.statusName}`);
    assert.strictEqual(probe.lastBeat.important, true, 'the transition was not marked important');
  });

  probe.probe = async () => ({ up: true, message: null });
  await heartbeats.runOnce(probe);
  check('one pass resets the failure count and marks the recovery important', () => {
    assert.strictEqual(probe.lastBeat.statusName, 'up');
    assert.strictEqual(probe.consecutiveFailures, 0);
    assert.strictEqual(probe.lastBeat.important, true);
  });
  await heartbeats.runOnce(probe);
  check('a steady state is not an incident', () => {
    assert.strictEqual(probe.lastBeat.important, false);
  });

  check('uptime is a ratio of what was actually observed, or null when nothing was', () => {
    assert.strictEqual(heartbeats.uptimeOver([null, null], 2, 0), null);
    assert.strictEqual(heartbeats.uptimeOver([{ period: 0, up: 3, down: 1 }], 1, 0), 0.75);
  });
  check('an uptime window reads the slots the window covers, not the first slots in the ring', () => {
    const ring = new Array(4).fill(null);
    ring[2] = { period: 102, up: 1, down: 0 };
    ring[3] = { period: 99, up: 0, down: 1 };
    assert.strictEqual(heartbeats.uptimeOver(ring, 2, 102), 1);
    assert.strictEqual(heartbeats.uptimeOver(ring, 4, 102), 0.5);
    assert.strictEqual(heartbeats.uptimeOver(ring, 4, 99), 0);
  });
  check('a ring slot reused by a later period does not carry the older period forward', () => {
    const reused = new heartbeats.Monitor({ id: 'streams-wrap', label: 'Wrap', probe: async () => ({ up: true }) });
    const at = Date.now();
    heartbeats.record(reused, heartbeats.STATUS.UP, 1, at);
    heartbeats.record(reused, heartbeats.STATUS.UP, 1, at + 24 * 3600 * 1000);
    const slot = reused.minutely[Math.floor((at + 24 * 3600 * 1000) / 60000) % reused.minutely.length];
    assert.strictEqual(slot.up, 1, `a wrapped slot accumulated ${slot.up} beats from earlier days`);
  });

  const uptime = JSON.parse((await get('/api/heartbeats/uptime')).body);
  check('a 30-day uptime figure from minutes of data says so rather than lying', () => {
    const entry = uptime.uptime.find((u) => u.id === 'streams-probe');
    assert.ok(entry, 'the test monitor is missing from the uptime report');
    assert.strictEqual(entry.month.complete, false);
    assert.match(entry.month.note, /in memory only/);
    assert.strictEqual(uptime.persistence, 'memory');
  });

  const incidents = JSON.parse((await get('/api/heartbeats/incidents')).body);
  check('the transitions are the incident history, newest first', () => {
    const mine = incidents.incidents.filter((i) => i.monitorId === 'streams-probe');
    assert.strictEqual(mine.length, 2, `${mine.length} transitions`);
    assert.strictEqual(mine[0].statusName, 'up');
    assert.strictEqual(mine[1].statusName, 'down');
  });

  const tail = await openStream('/api/logs/stream?query=' + encodeURIComponent('{container="argus-console"}'));
  check('the log stream opens against a reachable Loki', () => {
    assert.strictEqual(tail.status, 200, `status ${tail.status}`);
    assert.match(tail.headers['content-type'], /text\/event-stream/);
  });
  await tail.until((t) => t.includes('event: open'), 4000);
  await sleep(300);

  pushLokiLine('the first line', 'info');
  pushLokiLine('the second line', 'warn');
  pushLokiLine('the third line', 'error');
  await tail.until((t) => t.includes('the third line'), 5000);

  const tailFrames = frames(tail.text).filter((f) => f.event === 'line');
  check('a Loki tail frame becomes one SSE line event per log line, with its level', () => {
    assert.strictEqual(tailFrames.length, 3, `${tailFrames.length} line frames`);
    assert.strictEqual(tailFrames[0].data.line, 'the first line');
    assert.strictEqual(tailFrames[1].data.level, 'warn');
    assert.strictEqual(tailFrames[2].data.level, 'error');
    assert.ok(Date.parse(tailFrames[0].data.at) > 0, 'the line carried no readable timestamp');
  });
  check('every streamed line carries a monotonic id, or resume is impossible', () => {
    const ids = tailFrames.map((f) => Number(f.id));
    assert.deepStrictEqual(ids, [ids[0], ids[0] + 1, ids[0] + 2], `ids ${ids.join(',')}`);
  });

  const firstId = Number(tailFrames[0].id);
  tail.close();
  await sleep(200);

  const resumed = await openStream(
    '/api/logs/stream?query=' + encodeURIComponent('{container="argus-console"}'),
    { 'last-event-id': String(firstId) }
  );
  await resumed.until((t) => t.includes('event: open'), 4000);
  check('reconnecting with Last-Event-ID replays the lines that were missed, and only those', () => {
    const replayed = frames(resumed.text).filter((f) => f.event === 'line');
    assert.strictEqual(replayed.length, 2, `${replayed.length} replayed lines`);
    assert.strictEqual(replayed[0].data.line, 'the second line');
    assert.strictEqual(replayed[1].data.line, 'the third line');
    assert.deepStrictEqual(replayed.map((f) => Number(f.id)), [firstId + 1, firstId + 2]);
  });

  const byQuery = await openStream(
    '/api/logs/stream?query=' + encodeURIComponent('{container="argus-console"}')
      + '&lastEventId=' + String(firstId)
  );
  await byQuery.until((t) => t.includes('event: open'), 4000);
  check('a resume carried in the query string replays the same lines as the header', () => {
    const replayed = frames(byQuery.text).filter((f) => f.event === 'line');
    assert.strictEqual(replayed.length, 2, `${replayed.length} replayed lines`);
    assert.deepStrictEqual(replayed.map((f) => Number(f.id)), [firstId + 1, firstId + 2]);
    const open = frames(byQuery.text).find((f) => f.event === 'open');
    assert.strictEqual(open.data.replayedFrom, firstId,
      'the client sent its position and the server started from the top anyway');
  });
  byQuery.close();
  await sleep(100);

  const bothCarriers = await openStream(
    '/api/logs/stream?query=' + encodeURIComponent('{container="argus-console"}') + '&lastEventId=0',
    { 'last-event-id': String(firstId) }
  );
  await bothCarriers.until((t) => t.includes('event: open'), 4000);
  check('the browser header wins over a query value the page may have left behind', () => {
    const open = frames(bothCarriers.text).find((f) => f.event === 'open');
    assert.strictEqual(open.data.replayedFrom, firstId, 'a stale query parameter overrode the live header');
  });
  bothCarriers.close();
  await sleep(100);

  const farBehind = await openStream(
    '/api/logs/stream?query=' + encodeURIComponent('{container="argus-console"}'),
    { 'last-event-id': '0' }
  );
  await farBehind.until((t) => t.includes('event: open'), 4000);
  check('a resume from before the buffer begins is answered with a gap, not silence', () => {
    const replayed = frames(farBehind.text).filter((f) => f.event === 'line');
    assert.strictEqual(replayed.length, logRingFor('{container="argus-console"}').size,
      'the whole buffer was not replayed');
    const open = frames(farBehind.text).find((f) => f.event === 'open');
    assert.strictEqual(open.data.replayedFrom, 0);
  });
  farBehind.close();
  resumed.close();
  await sleep(100);

  const badQuery = await get('/api/logs/stream');
  check('a stream without a query is a 400 with an actionable message, not a dangling connection', () => {
    assert.strictEqual(badQuery.status, 400, `status ${badQuery.status}`);
    assert.match(JSON.parse(badQuery.body).message, /log query is required/);
  });

  const lokiLabels = JSON.parse((await get('/api/logs/labels')).body);
  check('the log label index is read over plain HTTP, not the tail socket', () => {
    assert.strictEqual(lokiLabels.ok, true, JSON.stringify(lokiLabels).slice(0, 200));
    assert.deepStrictEqual(lokiLabels.labels, ['container', 'job']);
  });

  const cpu = JSON.parse((await get('/api/metrics/series?name=hostCpuBusyRatio&window=3600000&points=120')).body);
  check('a named series comes back as points a sparkline can draw', () => {
    assert.strictEqual(cpu.ok, true, JSON.stringify(cpu).slice(0, 300));
    assert.strictEqual(cpu.series.length, 1);
    assert.deepStrictEqual(cpu.series[0].points.map((p) => p.value), [0.42, 0.51]);
    assert.strictEqual(cpu.isRatio, true, 'a ratio series must say so or it will be auto-scaled into a lie');
  });
  check('the step is derived from the picture, so a long window is not a denial of service', () => {
    assert.strictEqual(cpu.stepSeconds, 30, `step ${cpu.stepSeconds}`);
    assert.strictEqual(metrics.stepFor(0, 30 * 24 * 3600 * 1000, 120), 21600);
    assert.strictEqual(metrics.stepFor(0, 300 * 1000, 120), 15);
  });
  check('a window or point count far outside the ladder is clamped, not obeyed', () => {
    assert.strictEqual(metrics.windowMs('999999999999999', 3600000), 366 * 24 * 3600 * 1000);
    assert.strictEqual(metrics.points('100000', 120), 1000);
    assert.strictEqual(metrics.points('nonsense', 120), 120);
  });

  const freeText = JSON.parse((await get('/api/metrics/series?name=' + encodeURIComponent('up{job="x"}'))).body);
  check('free-text PromQL is refused and the answer names the series it does accept', () => {
    assert.strictEqual(freeText.ok, false);
    assert.strictEqual(freeText.reason, 'invalid-request');
    assert.match(freeText.message, /hostCpuBusyRatio/);
  });

  const promTargets = JSON.parse((await get('/api/metrics/targets')).body);
  check('scrape targets are summarised with a count of what is down', () => {
    assert.strictEqual(promTargets.ok, true);
    assert.strictEqual(promTargets.total, 2);
    assert.strictEqual(promTargets.down, 1);
  });

  const list = JSON.parse((await get('/api/containers')).body);
  check('the container inventory reads through the socket proxy', () => {
    assert.strictEqual(list.ok, true, JSON.stringify(list).slice(0, 300));
    assert.strictEqual(list.count, 1);
    assert.strictEqual(list.running, 1);
    assert.deepStrictEqual(list.containers[0].names, ['argus-console']);
    assert.strictEqual(list.containers[0].health, 'healthy');
  });

  const indexed = JSON.parse((await get('/api/search/index')).body);
  check('a live resource reaches the search index with the route that opens it', () => {
    assert.strictEqual(indexed.ok, true, JSON.stringify(indexed).slice(0, 300));
    const entry = indexed.items.find((i) => i.label === 'argus-console');
    assert.ok(entry, `the running container is not indexed: ${JSON.stringify(indexed.items).slice(0, 300)}`);
    assert.strictEqual(entry.kind, 'Container');
    assert.strictEqual(entry.route, 'stack');
    assert.match(entry.hint, /running/);
  });
  check('a reader that is down is a named unavailable source, not a silently short list', () => {
    const down = indexed.sources.find((s) => s.kind === 'alert');
    assert.strictEqual(down.ok, false, 'Alertmanager points at a dead port in this harness');
    assert.ok(down.message && down.message.length > 10, 'the dead source carries no explanation');
    const up = indexed.sources.find((s) => s.kind === 'container');
    assert.strictEqual(up.ok, true);
    assert.strictEqual(up.count, 1);
  });

  const inspected = await get('/api/containers/inspect?id=' + CONTAINER_ID);
  check('container environment is stripped server-side, never rendered', () => {
    assert.strictEqual(inspected.body.includes(SECRET_IN_ENV), false,
      'a container environment variable reached the response body');
    const body = JSON.parse(inspected.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.environmentWithheld, 1, 'the withheld count is wrong, so the strip may be accidental');
  });

  const stats = JSON.parse((await get('/api/containers/stats?id=' + CONTAINER_ID)).body);
  check('container stats are converted to ratios rather than raw jiffies', () => {
    assert.strictEqual(stats.ok, true);
    assert.strictEqual(stats.cpuRatio, 0.4);
    assert.strictEqual(stats.memoryUsedBytes, 1048576);
  });

  const badId = await get('/api/containers/inspect?id=' + encodeURIComponent('../../secrets'));
  check('a container id that is not a container id is refused before it becomes a path', () => {
    assert.strictEqual(badId.status, 400, `status ${badId.status}`);
    const body = JSON.parse(badId.body);
    assert.strictEqual(body.ok, false);
    assert.match(body.message, /container id or name/);
  });

  check('docker multiplexed log framing is decoded, headers and all', () => {
    const collected = [];
    const feed = containers.demultiplex((type, payload) => collected.push([type, payload.toString('utf8')]));
    const frame = (type, text) => {
      const payload = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(8);
      header[0] = type;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const whole = Buffer.concat([frame(1, 'out line\n'), frame(2, 'err line\n')]);
    feed(whole.subarray(0, 5));
    feed(whole.subarray(5, 12));
    feed(whole.subarray(12));
    assert.deepStrictEqual(collected, [[1, 'out line\n'], [2, 'err line\n']]);
  });

  const unreachable = ['/api/alerts/active', '/api/alerts/groups', '/api/alerts/silences',
    '/api/alerts/receivers', '/api/alerts/health'];
  for (const path of unreachable) {
    const r = await get(path);
    check(`${path} reports an unreachable Alertmanager as data, not a 500`, () => {
      assert.strictEqual(r.status, 200, `status ${r.status}`);
      const body = JSON.parse(r.body);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.reason, 'unreachable', `reason ${body.reason}`);
      assert.ok(body.message.length > 20, 'no human-readable message');
    });
  }

  process.env.ARGUS_LOKI_URL = '';
  process.env.ARGUS_PROM_URL = '';
  process.env.ARGUS_ALERTMANAGER_URL = '';
  process.env.ARGUS_DOCKER_PROXY_URL = '';
  for (const name of ['../src/config.js', '../src/logs.js', '../src/metrics.js',
    '../src/alerts.js', '../src/containers.js', '../src/upstream.js', '../src/cache.js']) {
    delete require.cache[require.resolve(name)];
  }
  const bare = {
    logs: require('../src/logs.js'),
    metrics: require('../src/metrics.js'),
    alerts: require('../src/alerts.js'),
    containers: require('../src/containers.js')
  };

  check('every reader knows whether it is configured at all', () => {
    for (const [name, reader] of Object.entries(bare)) {
      assert.strictEqual(reader.configured(), false, `${name} thinks it is configured`);
    }
  });

  const readers = [
    ['logs.health', bare.logs.health], ['logs.labels', bare.logs.labels],
    ['logs.query', () => bare.logs.query({ query: '{a="b"}', limit: 10 })],
    ['metrics.health', bare.metrics.health], ['metrics.targets', bare.metrics.targets],
    ['metrics.rules', bare.metrics.rules], ['metrics.tsdb', bare.metrics.tsdb],
    ['metrics.series', () => bare.metrics.series({ name: 'hostCpuBusyRatio', windowMs: 3600000, points: 120 })],
    ['alerts.active', bare.alerts.active], ['alerts.groups', bare.alerts.groups],
    ['alerts.silences', bare.alerts.silences], ['alerts.receivers', bare.alerts.receivers],
    ['alerts.health', bare.alerts.health],
    ['containers.list', bare.containers.list], ['containers.health', bare.containers.health],
    ['containers.stats', () => bare.containers.stats('abc')]
  ];

  for (const [name, reader] of readers) {
    const answer = await Promise.race([
      reader(),
      sleep(4000).then(() => ({ ok: null, reason: 'the reader hung' }))
    ]);
    check(`${name} answers "not configured" rather than failing or hanging`, () => {
      assert.strictEqual(answer.ok, false, `ok was ${answer.ok} (${answer.reason})`);
      assert.strictEqual(answer.reason, 'not-configured', `reason ${answer.reason}`);
      assert.ok(answer.message && answer.message.length > 20, 'no human-readable message');
      assert.match(answer.message, /ARGUS_/, 'the message does not name the variable that would fix it');
    });
  }

  const unconfiguredTail = await new Promise((resolve) => {
    const stop = bare.logs.openTail({ query: '{a="b"}', limit: 10 }, {
      onLine: () => {},
      onUnavailable: resolve,
      onClose: () => {}
    });
    stop();
  });
  check('an unconfigured Loki tail reports itself instead of opening a socket to nowhere', () => {
    assert.strictEqual(unconfiguredTail.reason, 'not-configured');
  });

  const unconfiguredLogs = await bare.containers.openLogs({ id: 'x', tail: 10 }, {
    onLine: () => {}, onUnavailable: () => {}, onClose: () => {}
  });
  check('an unconfigured container log tail returns a no-op teardown rather than throwing', () => {
    assert.strictEqual(typeof unconfiguredLogs, 'function');
  });

  const bareServer = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      ARGUS_PORT: String(DEAD_PORT + 1),
      ARGUS_HOST: '127.0.0.1',
      ARGUS_AUTH: 'off',
      ARGUS_LOG_LEVEL: 'error',
      ARGUS_LOKI_URL: '',
      ARGUS_PROM_URL: '',
      ARGUS_ALERTMANAGER_URL: '',
      ARGUS_DOCKER_PROXY_URL: '',
      ARGUS_HEARTBEAT_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });

  function askBare(requestPath) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${requestPath} never answered`)), 4000);
      const req = http.request({
        host: '127.0.0.1', port: DEAD_PORT + 1, path: requestPath,
        headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' }
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body }); });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.end();
    });
  }

  for (let i = 0; i < 50; i += 1) {
    try { await askBare('/api/health'); break; } catch (err) { await sleep(100); }
  }

  for (const requestPath of ['/api/logs/stream?query=' + encodeURIComponent('{a="b"}'),
    '/api/containers/logs?id=abc', '/api/containers/events']) {
    let answer = null;
    let failure = null;
    try { answer = await askBare(requestPath); } catch (err) { failure = err; }
    check(`${requestPath} closes with a reason when its upstream is absent, rather than holding the connection`, () => {
      assert.strictEqual(failure, null, failure && failure.message);
      assert.strictEqual(answer.status, 200, `status ${answer.status}`);
      assert.match(answer.headers['content-type'], /application\/json/,
        'an unconfigured stream answered as an event stream, so the browser would reconnect for ever');
      const body = JSON.parse(answer.body);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.reason, 'not-configured');
      assert.strictEqual(body.streaming, false);
      assert.ok(body.message.length > 20, 'no human-readable message');
    });
  }

  bareServer.kill('SIGKILL');

  const deadUpstreamServer = spawn(process.execPath, [path.resolve(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      ARGUS_PORT: String(DEAD_PORT + 2),
      ARGUS_HOST: '127.0.0.1',
      ARGUS_AUTH: 'off',
      ARGUS_LOG_LEVEL: 'error',
      ARGUS_LOKI_URL: `http://127.0.0.1:${DEAD_PORT}`,
      ARGUS_DOCKER_PROXY_URL: `http://127.0.0.1:${DEAD_PORT}`,
      ARGUS_SSE_HEARTBEAT_MS: '1000',
      ARGUS_UPSTREAM_TIMEOUT_MS: '2000',
      ARGUS_HEARTBEAT_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });

  function askDeadUpstream(requestPath) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${requestPath} was still open after 6 seconds`)), 6000);
      const req = http.request({
        host: '127.0.0.1', port: DEAD_PORT + 2, path: requestPath,
        headers: { accept: 'text/event-stream', 'sec-fetch-site': 'same-origin' }
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.end();
    });
  }

  for (let i = 0; i < 50; i += 1) {
    try { await askDeadUpstream('/api/health'); break; } catch (err) { await sleep(100); }
  }

  for (const requestPath of ['/api/logs/stream?query=' + encodeURIComponent('{a="b"}'),
    '/api/containers/logs?id=abc', '/api/containers/events']) {
    let answer = null;
    let failure = null;
    try { answer = await askDeadUpstream(requestPath); } catch (err) { failure = err; }
    check(`${requestPath} ends the event stream when its upstream is configured but dead`, () => {
      assert.strictEqual(failure, null, failure && failure.message);
      assert.match(answer.body, /event: unavailable/,
        'the stream ended without saying why its upstream was unreachable');
    });
  }

  deadUpstreamServer.kill('SIGKILL');

  server.close();
  promStub.close();
  dockerStub.close();
  for (const socket of lokiSockets) socket.destroy();
  lokiStub.close();
  heartbeats.stop();

  const failed = results.filter((r) => !r.ok);
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : '   ' + r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length);
})().catch((err) => {
  console.error('streams harness failed:', err);
  process.exit(1);
});
