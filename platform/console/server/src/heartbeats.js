'use strict';

const { EventEmitter } = require('node:events');

const config = require('./config');

const STATUS = { DOWN: 0, UP: 1, PENDING: 2, MAINTENANCE: 3 };

const STATUS_NAME = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

const MINUTELY_SLOTS = 24 * 60;
const HOURLY_SLOTS = 30 * 24;
const DAILY_SLOTS = 365;

const started = Date.now();

const events = new EventEmitter();
events.setMaxListeners(0);

class Monitor {
  constructor({ id, label, probe, intervalMs, maxRetries }) {
    this.id = id;
    this.label = label;
    this.probe = probe;
    this.intervalMs = intervalMs || config.heartbeatIntervalMs;
    this.maxRetries = maxRetries === undefined ? config.heartbeatMaxRetries : maxRetries;
    this.consecutiveFailures = 0;
    this.previousStatus = null;
    this.beats = [];
    this.minutely = new Array(MINUTELY_SLOTS).fill(null);
    this.hourly = new Array(HOURLY_SLOTS).fill(null);
    this.daily = new Array(DAILY_SLOTS).fill(null);
    this.lastBeat = null;
    this.timer = null;
  }
}

const monitors = new Map();

function bucket(series, index) {
  if (!series[index]) series[index] = { up: 0, down: 0, avgPing: 0 };
  return series[index];
}

function record(monitor, status, pingMs, at) {
  const flat = status === STATUS.MAINTENANCE ? STATUS.UP
    : status === STATUS.PENDING ? STATUS.DOWN
      : status;

  const minuteIndex = Math.floor(at / 60000) % monitor.minutely.length;
  const hourIndex = Math.floor(at / 3600000) % monitor.hourly.length;
  const dayIndex = Math.floor(at / 86400000) % monitor.daily.length;

  for (const [series, index] of [[monitor.minutely, minuteIndex],
    [monitor.hourly, hourIndex],
    [monitor.daily, dayIndex]]) {
    const b = bucket(series, index);
    if (flat === STATUS.UP) {
      b.up += 1;
      if (Number.isFinite(pingMs)) b.avgPing = (b.avgPing * (b.up - 1) + pingMs) / b.up;
    } else {
      b.down += 1;
    }
  }

  const important = monitor.previousStatus !== null && monitor.previousStatus !== status;
  monitor.previousStatus = status;

  const beat = { monitorId: monitor.id, at, status, statusName: STATUS_NAME[status], pingMs, important };
  monitor.beats.push(beat);
  if (monitor.beats.length > config.heartbeatBeatCap) {
    monitor.beats.splice(0, monitor.beats.length - config.heartbeatBeatCap);
  }
  monitor.lastBeat = beat;
  return beat;
}

function uptimeOver(series, periods) {
  let up = 0;
  let down = 0;
  for (let i = 0; i < Math.min(periods, series.length); i += 1) {
    const b = series[i];
    if (!b) continue;
    up += b.up;
    down += b.down;
  }
  return (up + down) === 0 ? null : up / (up + down);
}

function coverage(windowMs) {
  const observedMs = Date.now() - started;
  return {
    observedMs,
    windowMs,
    complete: observedMs >= windowMs,
    note: observedMs >= windowMs ? null
      : 'This console keeps heartbeats in memory only, so the figure covers the time since the process started, ' +
        'not the whole window. It is not a claim about the window.'
  };
}

async function runOnce(monitor) {
  const at = Date.now();
  let outcome;
  try {
    outcome = await monitor.probe();
  } catch (err) {
    outcome = { up: false, message: (err && err.message) || String(err) };
  }
  const pingMs = Date.now() - at;

  let status;
  if (outcome && outcome.up) {
    monitor.consecutiveFailures = 0;
    status = STATUS.UP;
  } else {
    monitor.consecutiveFailures += 1;
    status = monitor.consecutiveFailures > monitor.maxRetries ? STATUS.DOWN : STATUS.PENDING;
  }

  const beat = record(monitor, status, pingMs, at);
  beat.label = monitor.label;
  beat.message = (outcome && outcome.message) || null;
  events.emit('beat', beat);
  return beat;
}

function register(spec) {
  const monitor = new Monitor(spec);
  monitors.set(monitor.id, monitor);
  return monitor;
}

let running = false;

function start() {
  if (running) return;
  running = true;
  for (const monitor of monitors.values()) {
    runOnce(monitor).catch(() => {});
    monitor.timer = setInterval(() => { runOnce(monitor).catch(() => {}); }, monitor.intervalMs);
    monitor.timer.unref();
  }
}

function stop() {
  running = false;
  for (const monitor of monitors.values()) {
    if (monitor.timer) clearInterval(monitor.timer);
    monitor.timer = null;
  }
}

function describe(monitor) {
  return {
    id: monitor.id,
    label: monitor.label,
    intervalMs: monitor.intervalMs,
    maxRetries: monitor.maxRetries,
    status: monitor.lastBeat ? monitor.lastBeat.status : null,
    statusName: monitor.lastBeat ? monitor.lastBeat.statusName : 'unknown',
    lastCheckedAt: monitor.lastBeat ? new Date(monitor.lastBeat.at).toISOString() : null,
    lastPingMs: monitor.lastBeat ? monitor.lastBeat.pingMs : null,
    message: monitor.lastBeat ? monitor.lastBeat.message || null : null,
    consecutiveFailures: monitor.consecutiveFailures
  };
}

function snapshot(beatSlots) {
  const slots = Number.isInteger(beatSlots) && beatSlots > 0 ? Math.min(beatSlots, config.heartbeatBeatCap) : 50;
  const list = [];
  for (const monitor of monitors.values()) {
    list.push({
      ...describe(monitor),
      beats: monitor.beats.slice(-slots).map((b) => ({
        at: new Date(b.at).toISOString(),
        status: b.status,
        statusName: b.statusName,
        pingMs: b.pingMs,
        important: b.important
      }))
    });
  }
  return {
    monitors: list,
    running,
    startedAt: new Date(started).toISOString(),
    persistence: 'memory',
    at: new Date().toISOString()
  };
}

function uptime() {
  const list = [];
  for (const monitor of monitors.values()) {
    list.push({
      id: monitor.id,
      label: monitor.label,
      day: { ratio: uptimeOver(monitor.minutely, MINUTELY_SLOTS), ...coverage(24 * 3600 * 1000) },
      week: { ratio: uptimeOver(monitor.hourly, 24 * 7), ...coverage(7 * 24 * 3600 * 1000) },
      month: { ratio: uptimeOver(monitor.daily, 30), ...coverage(30 * 24 * 3600 * 1000) }
    });
  }
  return { uptime: list, persistence: 'memory', startedAt: new Date(started).toISOString() };
}

function incidents(limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const all = [];
  for (const monitor of monitors.values()) {
    for (let i = monitor.beats.length - 1; i >= 0; i -= 1) {
      const beat = monitor.beats[i];
      if (!beat.important) continue;
      all.push({
        monitorId: monitor.id,
        label: monitor.label,
        at: new Date(beat.at).toISOString(),
        status: beat.status,
        statusName: beat.statusName,
        message: beat.message || null
      });
    }
  }
  all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { incidents: all.slice(0, cap), count: all.length, persistence: 'memory' };
}

function reset() {
  stop();
  monitors.clear();
}

module.exports = {
  STATUS,
  STATUS_NAME,
  Monitor,
  register,
  start,
  stop,
  runOnce,
  record,
  uptimeOver,
  snapshot,
  uptime,
  incidents,
  events,
  reset,
  monitors
};
