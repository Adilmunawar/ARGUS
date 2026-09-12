'use strict';

const config = require('./config');

class EventStream {
  constructor({ onOpen, heartbeatMs, retryMs, label }) {
    this.onOpen = onOpen;
    this.heartbeatMs = heartbeatMs || config.sseHeartbeatMs;
    this.retryMs = retryMs || config.sseRetryMs;
    this.label = label || 'stream';
  }
}

class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity);
    this.items = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
    this.seq = 0;
  }

  push(value) {
    this.seq += 1;
    this.items[this.head] = { id: this.seq, value };
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
    return this.seq;
  }

  since(id) {
    const out = [];
    for (let i = 0; i < this.size; i += 1) {
      const at = (this.head - this.size + i + this.capacity) % this.capacity;
      const entry = this.items[at];
      if (entry && entry.id > id) out.push(entry);
    }
    return out;
  }

  get oldestId() {
    return this.seq - this.size + 1;
  }

  clear() {
    this.items = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

function replayPlan(ring, header) {
  const raw = String(header === undefined || header === null ? '' : header).trim();
  if (!raw) return { resumed: false, entries: [], missed: 0, from: null };
  const from = Number(raw);
  if (!Number.isInteger(from) || from < 0) return { resumed: false, entries: [], missed: 0, from: null };
  if (from >= ring.seq) return { resumed: true, entries: [], missed: 0, from };
  if (ring.size === 0) return { resumed: true, entries: [], missed: ring.seq - from, from };
  const missed = from + 1 < ring.oldestId ? ring.oldestId - (from + 1) : 0;
  return { resumed: true, entries: ring.since(from), missed, from };
}

let openStreams = 0;

function startEventStream(req, res, spec, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};

  if (openStreams >= config.sseMaxStreams) {
    const text = JSON.stringify({
      ok: false,
      error: 'too-many-streams',
      message: `This console holds at most ${config.sseMaxStreams} live streams at once. ` +
        'Close a log or metrics panel and open this one again.'
    }, null, 2);
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store'
    });
    res.end(text);
    return;
  }

  openStreams += 1;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`retry: ${spec.retryMs}\n\n`);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  let paused = false;
  let dropped = 0;

  function raw(text) {
    if (closed) return true;
    const ok = res.write(text);
    if (!ok) {
      paused = true;
      res.once('drain', () => { paused = false; });
    }
    return ok;
  }

  const sink = {
    send(event, data, id) {
      if (closed) return;
      if (paused) { dropped += 1; return; }
      let frame = '';
      if (id !== undefined && id !== null) frame += `id: ${id}\n`;
      if (event) frame += `event: ${event}\n`;
      frame += `data: ${JSON.stringify(data)}\n\n`;
      raw(frame);
    },
    note(event, data) {
      if (closed) return;
      raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() { end(); res.end(); },
    get dropped() { return dropped; },
    resetDropped() { const n = dropped; dropped = 0; return n; }
  };

  const beat = setInterval(() => {
    if (closed) return;
    raw(': ping\n\n');
    const n = sink.resetDropped();
    if (n > 0) sink.note('dropped', { lines: n, reason: 'the browser could not keep up with this stream' });
  }, spec.heartbeatMs);
  beat.unref();

  let stop = () => {};

  function end() {
    if (closed) return;
    closed = true;
    openStreams -= 1;
    clearInterval(beat);
    try { stop(); } catch (err) { log('warn', `${spec.label} teardown failed: ${err && err.message}`); }
  }

  res.on('close', end);
  res.on('error', end);

  try {
    stop = spec.onOpen(sink, req) || (() => {});
  } catch (err) {
    log('error', `${spec.label} failed to open: ${err && err.message}`);
    sink.note('failed', { reason: 'error', message: 'The stream could not be opened. The reason is in the server log.' });
    end();
    res.end();
  }
}

function openStreamCount() {
  return openStreams;
}

module.exports = { EventStream, RingBuffer, startEventStream, replayPlan, openStreamCount };
