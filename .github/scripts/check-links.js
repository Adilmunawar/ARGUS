const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

function maskInlineCode(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (line[i + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    let close = line.indexOf(fence, i + run);
    while (close !== -1 && line[close + run] === '`') {
      let skip = close;
      while (line[skip] === '`') skip += 1;
      close = line.indexOf(fence, skip);
    }
    if (close === -1) {
      out += line.slice(i, i + run);
      i += run;
      continue;
    }
    out += ' '.repeat(close + run - i);
    i = close + run;
  }
  return out;
}

function proseLines(source) {
  const text = source.replace(/<!--[\s\S]*?-->/g, blank);
  const lines = text.split('\n');
  const out = [];
  let fence = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
      }
      out.push(null);
      continue;
    }
    if (open && !(open[1][0] === '`' && line.slice(open.index + open[1].length).includes('`'))) {
      fence = open[1];
      out.push(null);
      continue;
    }
    out.push(maskInlineCode(line));
  }
  return out;
}

function headingText(raw) {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(.+?)_(?![\p{L}\p{N}_])/gu, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
    .trim();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(source) {
  const anchors = new Set();
  const seen = new Map();
  const add = (slug) => {
    const count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  };
  const lines = proseLines(source);
  const rawLines = source.split('\n').map((line) => line.replace(/\r$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === null) continue;
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(rawLines[i]);
    if (atx) {
      add(slugify(headingText(atx[1] || '')));
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && next !== null && /^ {0,3}(=+|-+)[ \t]*$/.test(next) && line.trim() !== '' &&
        !/^ {0,3}([-*+]|\d+[.)])[ \t]/.test(line) && !/^ {0,3}>/.test(line) && !/^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
      add(slugify(headingText(rawLines[i])));
    }
  }
  const html = /<[A-Za-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["'][^>]*>/g;
  for (const line of lines) {
    if (line === null) continue;
    let match;
    while ((match = html.exec(line))) anchors.add(match[1]);
  }
  return anchors;
}

function linksOf(source) {
  const found = [];
  const lines = proseLines(source);
  const inline = /\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
  const html = /<(?:a|img|source)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  lines.forEach((line, index) => {
    if (line === null) return;
    let match;
    while ((match = inline.exec(line))) found.push({ line: index + 1, target: match[1] });
    const def = definition.exec(line);
    if (def) found.push({ line: index + 1, target: def[1] });
    while ((match = html.exec(line))) found.push({ line: index + 1, target: match[1] });
  });
  return found.map((link) => ({ line: link.line, target: link.target.replace(/^<|>$/g, '') }));
}

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function check(files, from, isDir) {
  const problems = [];
  const anchorCache = new Map();
  const anchors = (name) => {
    if (!anchorCache.has(name)) anchorCache.set(name, anchorsOf(files.get(name)));
    return anchorCache.get(name);
  };
  for (const name of from) {
    for (const { line, target } of linksOf(files.get(name))) {
      if (!target || SCHEME.test(target) || target.startsWith('//')) continue;
      const hash = target.indexOf('#');
      const rawPath = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? null : decode(target.slice(hash + 1));
      const cleanPath = decode(rawPath.split('?')[0]);
      let resolved = name;
      if (cleanPath) {
        resolved = cleanPath.startsWith('/')
          ? path.posix.normalize(cleanPath.slice(1))
          : path.posix.normalize(path.posix.join(path.posix.dirname(name), cleanPath));
        resolved = resolved.replace(/\/$/, '');
        if (resolved.startsWith('..')) {
          problems.push({ file: name, line, message: `link ${target} leaves the repository` });
          continue;
        }
        if (!files.has(resolved) && !isDir(resolved)) {
          problems.push({ file: name, line, message: `link ${target} points at ${resolved}, which does not exist` });
          continue;
        }
      }
      if (fragment === null || fragment === '' || !/\.md$/i.test(resolved) || !files.has(resolved)) continue;
      const known = anchors(resolved);
      if (!known.has(fragment) && !known.has(fragment.toLowerCase())) {
        problems.push({ file: name, line, message: `link ${target} names #${fragment}, which is no heading or anchor in ${resolved}` });
      }
    }
  }
  return problems;
}

function repoFiles() {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\0')
    .filter((name) => name && !name.includes('node_modules/') && fs.existsSync(name));
  const dirs = new Set();
  for (const name of listed) {
    let dir = path.posix.dirname(name);
    while (dir && dir !== '.') {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const files = new Map();
  for (const name of listed) files.set(name, /\.md$/i.test(name) ? fs.readFileSync(name, 'utf8') : '');
  return { files, dirs };
}

const SELF_TEST_FILES = new Map([
  ['README.md', [
    '# Argus',
    '',
    'See [decisions](docs/DECISIONS.md#1-decisions--trade-offs) and [the docs](docs/).',
    'Also [twice](docs/DECISIONS.md#notes-1) and [setext](docs/DECISIONS.md#a-setext-heading).',
    'And [custom](docs/DECISIONS.md#custom-anchor), [same file](#argus), [with title](docs/DECISIONS.md "Decisions").',
    'An [encoded](docs/a%20b.md) and an [angled](<docs/a b.md>) and an ![image](docs/logo.png).',
    'A [reference][dec] and [external](https://example.com/#nope) and [mail](mailto:ops@example.com).',
    'Code `[skip](missing-inline.md)` is ignored, as is ``[double](missing-double.md)``.',
    '<!-- [hidden](missing-comment.md) -->',
    '',
    '```',
    '[fenced](missing-fenced.md)',
    '```',
    '',
    '~~~yaml',
    'link: "[tilde](missing-tilde.md)"',
    '~~~',
    '',
    '[dec]: docs/DECISIONS.md#the-config-option',
    '',
  ].join('\n')],
  ['docs/DECISIONS.md', [
    '# 1. Decisions & Trade-offs',
    '',
    '## Notes',
    '',
    '## Notes',
    '',
    '## The `config` option',
    '',
    'A setext heading',
    '----------------',
    '',
    '<a id="custom-anchor"></a>',
    '',
  ].join('\n')],
  ['docs/a b.md', '# Space\n'],
  ['docs/logo.png', ''],
]);

const SELF_TEST_BROKEN = new Map([
  ['BROKEN.md', [
    '[missing file](docs/nope.md)',
    '[missing anchor](docs/DECISIONS.md#no-such-heading)',
    '[missing local anchor](#nowhere)',
    '![missing image](docs/nope.png)',
    '[outside](../outside.md)',
    '[ref]: docs/DECISIONS.md#gone',
    '<a href="docs/missing.md">html</a>',
    '',
  ].join('\n')],
]);

const SELF_TEST_SLUGS = [
  ['1. Decisions & Trade-offs', '1-decisions--trade-offs'],
  ['The `config` option', 'the-config-option'],
  ['ADR-0021: Control surface', 'adr-0021-control-surface'],
  ['What CI does **not** check', 'what-ci-does-not-check'],
  ['[Linked](x.md) heading', 'linked-heading'],
  ['snake_case_name', 'snake_case_name'],
  ['Café déjà vu', 'café-déjà-vu'],
];

function selfTest() {
  const failures = [];
  const dirs = new Set(['docs']);
  const isDir = (name) => dirs.has(name);
  for (const [heading, expected] of SELF_TEST_SLUGS) {
    const got = slugify(headingText(heading));
    if (got !== expected) failures.push(`slug of ${JSON.stringify(heading)} is ${got}, expected ${expected}`);
  }
  const good = check(SELF_TEST_FILES, ['README.md'], isDir);
  for (const problem of good) failures.push(`flagged a valid link: ${problem.message}`);
  const all = new Map([...SELF_TEST_FILES, ...SELF_TEST_BROKEN]);
  const bad = check(all, ['BROKEN.md'], isDir);
  const lines = new Set(bad.map((problem) => problem.line));
  for (let line = 1; line <= 7; line++) {
    if (!lines.has(line)) failures.push(`did not flag the broken link on line ${line} of the broken sample`);
  }
  if (bad.length !== 7) failures.push(`flagged ${bad.length} problems in the broken sample, expected 7`);
  for (const failure of failures) console.log(`self-test: ${failure}`);
  const total = SELF_TEST_SLUGS.length + 2 + 7;
  const passed = total - Math.min(total, failures.length);
  console.log(`self-test: ${passed}/${total} link samples judged correctly`);
  return failures.length ? 1 : 0;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  if (selfTest()) {
    console.log('::error::the link checker failed its own self-test');
    return 2;
  }
  const { files, dirs } = repoFiles();
  const markdown = [...files.keys()].filter((name) => /\.md$/i.test(name)).sort();
  const problems = check(files, markdown, (name) => dirs.has(name));
  for (const problem of problems) {
    console.log(`::error file=${problem.file},line=${problem.line}::${problem.message}`);
  }
  const count = markdown.reduce((sum, name) => sum + linksOf(files.get(name)).length, 0);
  if (problems.length) {
    console.log(`${problems.length} broken link(s) among ${count} in ${markdown.length} Markdown file(s)`);
    return 1;
  }
  console.log(`clean: ${count} link(s) in ${markdown.length} Markdown file(s) resolve`);
  return 0;
}

process.exit(main());
