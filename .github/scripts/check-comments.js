const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');

const OPTS = { ecmaVersion: 2023, allowReturnOutsideFunction: true, allowHashBang: true };
const SKIP = ['node_modules/', '.git/'];
const FIX = process.argv.includes('--fix');
const MARK = String.fromCharCode(0);

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((name) => name.endsWith('.js') && !SKIP.some((part) => name.includes(part)));
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
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  if (source.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  const before = tokenStream(source, parsed.sourceType);
  if (tokenStream(out, parsed.sourceType) !== before) throw new Error('token stream changed');
  return out;
}

let offenders = 0;
let fixed = 0;
let scanned = 0;

for (const file of tracked()) {
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
