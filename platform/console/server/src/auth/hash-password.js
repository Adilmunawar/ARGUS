'use strict';

const readline = require('node:readline');

const hash = require('./hash');
const authConfig = require('./config');

function readPasswordFromStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      process.stderr.write('Password (input is not echoed to a file or to argv): ');
    }
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let first = null;
    rl.on('line', (line) => {
      if (first === null) first = line;
      rl.close();
    });
    rl.on('close', () => {
      if (first === null || first.length === 0) return reject(new Error('No password was supplied on stdin.'));
      resolve(first);
    });
    rl.on('error', reject);
  });
}

async function main() {
  const password = await readPasswordFromStdin();
  const record = await hash.hash(password, authConfig.scrypt);
  process.stdout.write(record + '\n');
}

main().catch((err) => {
  process.stderr.write(`argus: ${err && err.message}\n`);
  process.exit(1);
});
