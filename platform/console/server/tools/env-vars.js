'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const README = path.resolve(__dirname, '..', 'README.md');

const PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /\benv\.([A-Z][A-Z0-9_]*)/g,
  /\b(?:positiveInt|int|msFromEnv|bool|headerName|positive)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function collect() {
  const found = new Map();
  for (const file of walk(SRC, [])) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const pattern of PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(line)) !== null) {
          const name = m[1];
          if (!/^(ARGUS|AWS)_/.test(name)) continue;
          const where = `${path.relative(path.dirname(SRC), file).replace(/\\/g, '/')}:${index + 1}`;
          if (!found.has(name)) found.set(name, []);
          if (!found.get(name).includes(where)) found.get(name).push(where);
        }
      }
    });
  }
  return new Map([...found.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

const found = collect();

if (process.argv.includes('--check')) {
  const readme = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : '';
  const missing = [...found.keys()].filter((name) => name.startsWith('ARGUS_') && !readme.includes('`' + name + '`'));
  if (missing.length) {
    process.stdout.write(`README.md does not document: ${missing.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`README.md documents all ${[...found.keys()].filter((n) => n.startsWith('ARGUS_')).length} ARGUS_ variables.\n`);
  process.exit(0);
}

for (const [name, places] of found) {
  process.stdout.write(`${name}\t${places.join(', ')}\n`);
}
