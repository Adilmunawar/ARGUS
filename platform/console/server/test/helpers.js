'use strict';

const net = require('net');

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host || '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function checker() {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, detail: err.message }); }
  };
  return { results, check };
}

function report(results) {
  const failed = results.filter((r) => !r.ok);
  const pad = Math.max(0, ...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(pad)}${r.ok ? '' : '   ' + r.detail}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
  return failed.length > 0 ? 1 : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { listen, freePort, checker, report, sleep };
