const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const OPTS = { ecmaVersion: 2023, allowReturnOutsideFunction: true, allowHashBang: true };
const SKIP = ['node_modules/', '.git/'];
const FIX = process.argv.includes('--fix');
const SELF_TEST_ONLY = process.argv.includes('--self-test');
const NAMED = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const MARK = String.fromCharCode(0);

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((name) => name.endsWith('.js') && !SKIP.some((part) => name.includes(part)));
}

function selected() {
  if (!NAMED.length) return tracked();
  const out = [];
  for (const name of NAMED) {
    const stat = fs.statSync(name);
    if (stat.isDirectory()) {
      for (const file of tracked()) {
        if (path.relative(name, file).startsWith('..')) continue;
        out.push(file);
      }
      continue;
    }
    out.push(name);
  }
  return out.filter((name) => name.endsWith('.js'));
}

function parseWith(source) {
  let failure = null;
  for (const sourceType of ['script', 'module']) {
    try {
      const comments = [];
      acorn.parse(source, Object.assign({}, OPTS, { sourceType, onComment: comments }));
      return { sourceType, comments };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function tokenStream(source, sourceType) {
  const out = [];
  for (const token of acorn.tokenizer(source, Object.assign({}, OPTS, { sourceType }))) {
    out.push(token.type.label + '' + String(token.value));
  }
  return out.join('');
}

function strip(source, parsed) {
  const chars = source.split('');
  for (const comment of parsed.comments) {
    for (let i = comment.start; i < comment.end; i++) {
      if (chars[i] !== '\n') chars[i] = MARK;
    }
  }
  const kept = [];
  for (const line of chars.join('').split('\n')) {
    const had = line.indexOf(MARK) !== -1;
    const code = line.split(MARK).join('');
    if (had && code.trim() === '') continue;
    kept.push(code.replace(/[ \t]+$/, ''));
  }
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  if (source.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  const before = tokenStream(source, parsed.sourceType);
  if (tokenStream(out, parsed.sourceType) !== before) throw new Error('token stream changed');
  return out;
}

const SELF_TEST_KEEP = [
  'const url = "https://example.invalid/x";\n',
  'const pattern = /a\\/\\/b/;\n',
  'const text = "/* not a comment */";\n',
  'const ratio = 8 / 2 / 2;\n',
];

const SELF_TEST_STRIP = [
  ['const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 2;\n'],
  ['const a = 1; // trailing\nconst b = 2;\n', 'const a = 1;\nconst b = 2;\n'],
  ['/* leading */\nconst a = 1;\n', 'const a = 1;\n'],
];

function selfTest() {
  const failures = [];
  for (const source of SELF_TEST_KEEP) {
    const parsed = parseWith(source);
    if (parsed.comments.length) failures.push(['saw a comment where there is none', source, '']);
  }
  for (const [source, expected] of SELF_TEST_STRIP) {
    const parsed = parseWith(source);
    const result = parsed.comments.length ? strip(source, parsed) : source;
    if (result !== expected) failures.push(['did not strip to the expected text', source, result]);
  }
  for (const [why, source, result] of failures) {
    console.log(`self-test ${why}:`);
    console.log(`  before: ${JSON.stringify(source)}`);
    console.log(`  after:  ${JSON.stringify(result)}`);
  }
  const total = SELF_TEST_KEEP.length + SELF_TEST_STRIP.length;
  console.log(`self-test: ${total - failures.length}/${total} samples stripped exactly as intended`);
  return failures.length ? 1 : 0;
}

if (SELF_TEST_ONLY) process.exit(selfTest());
if (selfTest()) {
  console.log('::error::the comment stripper failed its own self-test');
  process.exit(2);
}

let offenders = 0;
let fixed = 0;
let scanned = 0;

for (const file of selected()) {
  const source = fs.readFileSync(file, 'utf8');
  scanned++;
  let parsed;
  try {
    parsed = parseWith(source);
  } catch (error) {
    console.log(`::error file=${file}::does not parse as JavaScript: ${error.message}`);
    offenders++;
    continue;
  }
  if (!parsed.comments.length) continue;
  if (FIX) {
    try {
      fs.writeFileSync(file, strip(source, parsed));
      fixed++;
      console.log(`  ${file}  -${parsed.comments.length} comments`);
    } catch (error) {
      console.log(`::error file=${file}::could not be stripped safely: ${error.message}`);
      offenders++;
    }
    continue;
  }
  const first = parsed.comments[0];
  const line = source.slice(0, first.start).split('\n').length;
  console.log(`::error file=${file},line=${line}::${parsed.comments.length} comment(s); this repository carries none`);
  offenders++;
}

if (FIX) {
  console.log(`${fixed} file(s) rewritten, ${offenders} failed, ${scanned} scanned`);
} else if (offenders) {
  console.log(`${offenders} of ${scanned} JavaScript file(s) carry comments. Run: node .github/scripts/check-comments.js --fix`);
} else {
  console.log(`clean: ${scanned} JavaScript files carry no comments`);
}

process.exit(offenders ? 1 : 0);
