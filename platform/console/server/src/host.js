/*
 * Real telemetry for the machine this process is running on.
 *
 * Everything here comes from the operating system, not from a fixture. It is
 * the half of the dashboard that keeps working when AWS is unreachable, which
 * is exactly when somebody is looking at it.
 *
 * Nothing in this file shells out. Spawning `wmic` or `df` per request is how a
 * monitoring endpoint turns into a fork bomb under load, and the values that
 * matter are all available from `os` and `fs` without one.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

/*
 * CPU usage needs two samples.
 *
 * os.cpus() reports cumulative jiffies since boot, so a single reading gives
 * the average since the machine started -- which is a number that never moves
 * and tells an operator nothing. The previous sample is kept so each call
 * reports the usage over the interval since the last one.
 */
let previous = sampleCpu();

function sampleCpu() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total, at: Date.now() };
}

function cpu() {
  const now = sampleCpu();
  const idleDelta = now.idle - previous.idle;
  const totalDelta = now.total - previous.total;
  // Two calls in the same millisecond would divide by zero; report the last
  // known shape rather than NaN.
  const usage = totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
  const windowMs = now.at - previous.at;
  previous = now;
  return {
    cores: os.cpus().length,
    model: (os.cpus()[0] || {}).model || 'unknown',
    usageRatio: Math.max(0, Math.min(1, usage)),
    sampledOverMs: windowMs,
    loadAverage: os.loadavg()          // zeros on Windows; reported, not faked
  };
}

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: total - free,
    usageRatio: total > 0 ? (total - free) / total : 0
  };
}

/*
 * Disk.
 *
 * statfs is available from Node 18 and gives real block counts without a
 * subprocess. It is asynchronous and can reject for a volume that has gone
 * away, so a failing mount degrades to an error on that row rather than taking
 * the whole response down with it.
 */
async function disks() {
  const roots = process.platform === 'win32'
    ? drivesWindows()
    : ['/'];

  const out = [];
  for (const root of roots) {
    try {
      const s = await fs.promises.statfs(root);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      out.push({
        mount: root,
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - free,
        usageRatio: total > 0 ? (total - free) / total : 0
      });
    } catch (err) {
      out.push({ mount: root, error: err.code || 'unavailable' });
    }
  }
  return out;
}

/** Drive letters that actually exist, without shelling out to wmic. */
function drivesWindows() {
  const found = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      fs.accessSync(root);
      found.push(root);
    } catch (err) { /* not present, which is the normal case for most letters */ }
  }
  return found.length ? found : [path.parse(process.cwd()).root];
}

function network() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.internal) continue;
      out.push({ interface: name, family: addr.family, address: addr.address, mac: addr.mac });
    }
  }
  return out;
}

function process_() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal
  };
}

async function snapshot() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSeconds: Math.round(os.uptime()),
    bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    cpu: cpu(),
    memory: memory(),
    disks: await disks(),
    network: network(),
    process: process_(),
    at: new Date().toISOString()
  };
}

module.exports = { snapshot, cpu, memory, disks, network };
