'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

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
  const usage = totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
  const windowMs = now.at - previous.at;
  previous = now;
  return {
    cores: os.cpus().length,
    model: (os.cpus()[0] || {}).model || 'unknown',
    usageRatio: Math.max(0, Math.min(1, usage)),
    sampledOverMs: windowMs,
    loadAverage: os.loadavg()
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

function drivesWindows() {
  const found = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      fs.accessSync(root);
      found.push(root);
    } catch (err) {  }
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
