'use strict';

const path = require('path');
const { spawn } = require('child_process');

const SUITES = ['smoke.js', 'auth.js', 'streams.js', 'storage.js', 'sources.js', 'units.js'];

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code, signal) => {
      const tally = /(\d+)\/(\d+) passed/.exec(out);
      resolve({
        file,
        code: code === null ? 1 : code,
        signal,
        passed: tally ? Number(tally[1]) : null,
        total: tally ? Number(tally[2]) : null,
        ms: Date.now() - started,
        out
      });
    });
  });
}

(async () => {
  const only = process.argv.slice(2);
  const chosen = only.length ? SUITES.filter((s) => only.some((o) => s.startsWith(o))) : SUITES;
  const outcomes = [];
  for (const file of chosen) {
    const outcome = await run(file);
    outcomes.push(outcome);
    const failedLines = outcome.out.split('\n').filter((l) => /^\s+FAIL\b/.test(l));
    process.stdout.write(`\n${file}: ${outcome.code === 0 ? 'ok' : 'FAILED'}` +
      `${outcome.total !== null ? ` ${outcome.passed}/${outcome.total}` : ' (no tally)'} in ${outcome.ms} ms\n`);
    for (const line of failedLines) process.stdout.write(line + '\n');
    if (outcome.code !== 0 && failedLines.length === 0) process.stdout.write(outcome.out.slice(-2000) + '\n');
  }
  const failed = outcomes.filter((o) => o.code !== 0);
  const passed = outcomes.reduce((n, o) => n + (o.passed || 0), 0);
  const total = outcomes.reduce((n, o) => n + (o.total || 0), 0);
  process.stdout.write(`\n${passed}/${total} checks passed across ${outcomes.length} suites; ` +
    `${failed.length ? 'failed: ' + failed.map((o) => o.file).join(', ') : 'every suite passed'}\n`);
  process.exit(failed.length ? 1 : 0);
})();
