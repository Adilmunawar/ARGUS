'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const COMPOSE_FILE = path.join(HERE, 'docker-compose.yml');
const PORTS_FILE = path.join(HERE, 'docker-compose.ports.yml');
const ENV_FILE = path.join(HERE, '.env');
const EXAMPLE_FILE = path.join(HERE, '.env.example');
const SECRETS = path.join(HERE, 'secrets');
const ALERT_TEMPLATE = path.join(HERE, 'services', 'observability', 'alertmanager', 'alertmanager.yml.tmpl');
const HASH_TOOL = path.join(REPO, 'platform', 'console', 'server', 'src', 'auth', 'hash-password.js');
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_PROFILES = ['cache', 'queues', 'secrets', 'observability'];
const DEFAULT_OPERATOR_ROLES = ['admin'];
const LEGACY_OPERATOR_ROLES = ['operator', 'tier-1'];
const WAIT_TIMEOUT_S = 900;

const SYSTEM_SID = 'S-1-5-18';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const winTool = (name) => path.join(SYSTEM32, name);
const ADMINISTRATORS_SID = 'S-1-5-32-544';

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const b64 = (bytes) => crypto.randomBytes(bytes).toString('base64');

const ENV_GENERATORS = {
  ARGUS_S3_ADMIN_SECRET: () => hex(24),
  ARGUS_S3_CONSOLE_SECRET: () => hex(24),
  ARGUS_S3_APP_SECRET: () => hex(24),
  ARGUS_S3_LOKI_SECRET: () => hex(24),
  ARGUS_S3_GUAC_SECRET: () => hex(24),
  ARGUS_S3_PARITY_SECRET: () => hex(24),
  ARGUS_S3_PARITY_DENY_SECRET: () => hex(24),
  ARGUS_S3_PARITY_ADMIN_SECRET: () => hex(24),
  ARGUS_PG_APP_PASSWORD: () => hex(24),
  ARGUS_PG_CONSOLE_PASSWORD: () => hex(24),
  ARGUS_PG_EXPORTER_PASSWORD: () => hex(24),
  ARGUS_PG_GUAC_PASSWORD: () => hex(24),
  ARGUS_PG_GRAFANA_PASSWORD: () => hex(24),
  ARGUS_PG_PARITY_PASSWORD: () => hex(24),
  GARNET_CONSOLE_PASSWORD: () => hex(24),
  NATS_ARGUS_PASSWORD: () => hex(24),
  NATS_AGENT_PASSWORD: () => hex(24),
  CONSOLE_OPERATOR_PASSWORD: () => hex(24),
  GUAC_JSON_SECRET_KEY: () => hex(16),
  TARGET_SSH_PASSWORD: () => hex(16),
  AZURITE_ACCOUNT_KEY: () => b64(32)
};

const BREAKGLASS_KEYS = ['GUAC_BREAKGLASS_SALT_HEX', 'GUAC_BREAKGLASS_HASH_HEX'];

const INDEPENDENT_FILES = {
  pg_superuser_password: () => hex(24),
  grafana_admin_password: () => hex(16),
  console_alert_token: () => hex(24),
  console_metrics_token: () => hex(32)
};

const MOUNTED_FILES = [
  'pg_superuser_password', 'pg_exporter_password', 'grafana_admin_password', 'grafana_db_password',
  'console_alert_token', 'console_metrics_token', 'operators.json', 'alertmanager.yml', 'garnet/users.acl'
];
const HOST_ONLY_FILES = ['console_operator_password', 'guac_breakglass_password'];
const PRIVATE_MOUNTED_FILES = ['nomad_token'];

const VOLUME_NOTES = {
  argus_seaweed_master: 'SeaweedFS volume topology',
  argus_seaweed_volume: 'every object in every bucket',
  argus_seaweed_filer: 'filer metadata; without it the objects are unreadable',
  argus_seaweed_conf: 'filer.toml and the gateway identities (s3.json, root only)',
  argus_seaweed_public: 's3-public.json: identity names, access keys and actions, no secret keys',
  argus_pg_data: 'every database, table and row',
  argus_garnet_data: 'the cache (safe to lose)',
  argus_nats_data: 'every stream and every unacknowledged message',
  argus_openbao_data: 'every secret, and the raft that holds them',
  argus_openbao_logs: 'the OpenBao audit log',
  argus_openbao_seal: 'the sandbox unseal key; without it the secrets are unrecoverable',
  argus_console_state: 'bucket and WORM verdicts written by storage-init',
  argus_console_audit: 'the console security audit trail (once the server reads ARGUS_AUDIT_DIR)',
  argus_prometheus_data: 'metric history',
  argus_mailpit_data: 'captured alert mail',
  argus_alertmanager_data: 'silences and notification log',
  argus_loki_data: 'log history',
  argus_alloy_data: 'Alloy positions and WAL',
  argus_grafana_data: 'Grafana plugins and local state',
  argus_guac_recordings: 'recorded RDP and SSH sessions (audit evidence)',
  argus_guac_drives: 'files transferred through Guacamole',
  argus_nomad_data: 'Nomad server raft and client state',
  argus_azurite_data: 'Azurite blobs, queues and tables',
  argus_parity_results: 'parity reports'
};

let warnings = 0;
let jsonMode = false;

function say(message) { if (!jsonMode) process.stdout.write(`  ${message}\n`); }
function head(message) { if (!jsonMode) process.stdout.write(`\n${message}\n`); }
function warn(message) { warnings += 1; if (!jsonMode) process.stdout.write(`  ! ${message}\n`); }
function die(message, code) {
  process.stderr.write(`\n  x ${message}\n\n`);
  process.exit(code === undefined ? 1 : code);
}

const VALUE_FLAGS = ['profiles', 'timeout', 'tail'];

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
      const name = arg.slice(2);
      if (VALUE_FLAGS.includes(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { flags[name] = argv[i + 1]; i += 1; continue; }
      flags[name] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function locateDocker() {
  const probe = spawnSync('docker', ['--version'], { encoding: 'utf8', shell: false });
  if (!probe.error && probe.status === 0) return 'docker';
  if (IS_WINDOWS && process.env.ProgramFiles) {
    const known = path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
    if (fs.existsSync(known)) return known;
  }
  return null;
}

let dockerBin;
function docker(args, options) {
  if (dockerBin === undefined) dockerBin = locateDocker();
  if (!dockerBin) return { status: 127, stdout: '', stderr: 'docker is not installed or not on PATH', error: new Error('no docker') };
  const opts = Object.assign({ cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, options || {});
  const result = spawnSync(dockerBin, args, opts);
  return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
}

function readEnvFile(file) {
  const values = new Map();
  if (!fs.existsSync(file)) return values;
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(raw);
    if (m) values.set(m[1], m[2].trim());
  }
  return values;
}

function exampleLines() {
  if (!fs.existsSync(EXAMPLE_FILE)) die('.env.example is missing. It is the template bootstrap fills in.');
  return fs.readFileSync(EXAMPLE_FILE, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
}

function isPlaceholder(value) {
  return value === undefined || value === null || value === '' || /^replace-me/i.test(value);
}

function declaredProfiles() {
  const text = fs.readFileSync(COMPOSE_FILE, 'utf8');
  const out = new Set();
  const re = /^\s*profiles:\s*\[([^\]]*)\]\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    for (const entry of m[1].split(',')) {
      const name = entry.trim().replace(/^["']|["']$/g, '');
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

function chosenProfiles(flags) {
  if (typeof flags.profiles === 'string') {
    return flags.profiles.split(',').map((p) => p.trim()).filter(Boolean);
  }
  const env = readEnvFile(ENV_FILE);
  const fromEnv = env.get('COMPOSE_PROFILES');
  if (fromEnv !== undefined) return fromEnv.split(',').map((p) => p.trim()).filter(Boolean);
  return DEFAULT_PROFILES.slice();
}

function composeArgs(profiles, withPorts) {
  const args = ['compose', '--project-directory', HERE, '-f', COMPOSE_FILE];
  if (withPorts) args.push('-f', PORTS_FILE);
  for (const p of profiles) args.push('--profile', p);
  return args;
}

function composeEnv(profiles) {
  return Object.assign({}, process.env, { COMPOSE_PROFILES: profiles.join(',') });
}

function compose(profiles, withPorts, rest, options) {
  return docker(composeArgs(profiles, withPorts).concat(rest), Object.assign({ env: composeEnv(profiles) }, options || {}));
}

function composeConfig(profiles, withPorts) {
  const r = compose(profiles, withPorts, ['config', '--format', 'json']);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  try {
    return { ok: true, doc: JSON.parse(r.stdout) };
  } catch (err) {
    return { ok: false, error: `docker compose config did not return JSON: ${err.message}` };
  }
}

function isOneShot(service) {
  return String(service.restart || 'no') === 'no';
}

function currentUserSid() {
  const r = spawnSync(winTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /"([^"]*)","(S-[0-9-]+)"/.exec(r.stdout || '');
  return m ? m[2] : null;
}

let cachedSid;
function userSid() {
  if (cachedSid === undefined) cachedSid = currentUserSid();
  return cachedSid;
}

function icacls(args) {
  const r = spawnSync(winTool('icacls.exe'), args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function restrictWindows(target, isDir) {
  const sid = userSid();
  if (!sid) throw new Error('could not read the current user SID with whoami /user');
  const inherit = isDir ? '(OI)(CI)' : '';
  const cleared = icacls([target, "/reset"]);
  if (!cleared.ok) throw new Error(`icacls /reset failed on ${target}: ${cleared.out}`);
  const grant = icacls([target, '/inheritance:r', '/grant:r',
    `*${sid}:${inherit}F`, `*${SYSTEM_SID}:${inherit}F`, `*${ADMINISTRATORS_SID}:${inherit}F`]);
  if (!grant.ok) throw new Error(`icacls could not restrict ${target}: ${grant.out}`);
}

function ensureSecretsDir() {
  const existed = fs.existsSync(SECRETS);
  if (!existed) fs.mkdirSync(SECRETS, { mode: 0o700 });
  if (IS_WINDOWS) {
    restrictWindows(SECRETS, true);
  } else {
    fs.chmodSync(SECRETS, 0o700);
  }
  const garnet = path.join(SECRETS, 'garnet');
  if (!fs.existsSync(garnet)) fs.mkdirSync(garnet, { mode: 0o700 });
  if (IS_WINDOWS) restrictWindows(garnet, true);
  else fs.chmodSync(garnet, 0o700);
  return existed;
}

function modeFor(relative) {
  if (relative === '.env') return 0o600;
  if (HOST_ONLY_FILES.includes(relative) || PRIVATE_MOUNTED_FILES.includes(relative)) return 0o600;
  return 0o644;
}

function protect(file, relative) {
  if (IS_WINDOWS) restrictWindows(file, false);
  else fs.chmodSync(file, modeFor(relative));
}

function writeProtected(file, text, relative) {
  if (fs.existsSync(file)) {
    protect(file, relative);
    if (fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, { encoding: 'utf8' });
    return;
  }
  fs.writeFileSync(file, '', { encoding: 'utf8', mode: 0o600 });
  protect(file, relative);
  fs.writeFileSync(file, text, { encoding: 'utf8' });
}

function secretPath(relative) {
  return path.join(SECRETS, ...relative.split('/'));
}

function readSecret(relative) {
  const file = secretPath(relative);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function writeSecret(relative, text) {
  writeProtected(secretPath(relative), text, relative);
}

function deriveSubnetRegex(subnet) {
  const [address, bitsText] = String(subnet || '172.28.0.0/16').split('/');
  const bits = Number(bitsText || 16);
  const octets = address.split('.');
  const kept = Math.max(1, Math.floor(bits / 8));
  return `^${octets.slice(0, kept).join('\\.')}\\..*$`;
}

function deriveGarnetBytes(limit) {
  const m = /^(\d+)([bkmg]?)$/i.exec(String(limit || ''));
  if (!m) return null;
  const scale = { '': 1, b: 1, k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()];
  return String(Number(m[1]) * scale);
}

function breakglass() {
  const password = hex(16);
  const salt = crypto.randomBytes(32).toString('hex').toUpperCase();
  const digest = crypto.createHash('sha256').update(password + salt, 'utf8').digest('hex').toUpperCase();
  return { password, salt, digest };
}

function renderAlertmanager(values) {
  if (!fs.existsSync(ALERT_TEMPLATE)) {
    throw new Error(`the Alertmanager template is missing: ${ALERT_TEMPLATE}`);
  }
  let text = fs.readFileSync(ALERT_TEMPLATE, 'utf8');
  const aliases = { SMTP_SMARTHOST: ['SMTP_SMARTHOST', 'SMTP_HOST'] };
  const missing = [];
  for (const token of new Set(text.match(/@@[A-Z0-9_]+@@/g) || [])) {
    const name = token.slice(2, -2);
    const keys = aliases[name] || [name];
    const key = keys.find((k) => values.has(k) && values.get(k) !== '');
    if (!key) { missing.push(keys[0]); continue; }
    text = text.split(token).join(values.get(key));
  }
  if (missing.length) throw new Error(`alertmanager.yml.tmpl needs ${missing.sort().join(', ')} in .env.example`);
  if (/@@|\$\{/.test(text)) throw new Error('a placeholder survived rendering alertmanager.yml.tmpl');
  return text;
}

function hashOperatorPassword(password) {
  if (!fs.existsSync(HASH_TOOL)) throw new Error(`${HASH_TOOL} is missing, so no operator record can be produced`);
  const r = spawnSync(process.execPath, [HASH_TOOL], { input: `${password}\n`, encoding: 'utf8' });
  const record = String(r.stdout || '').trim().split(/\r?\n/).pop();
  if (r.status !== 0 || !/^scrypt\$/.test(record || '')) {
    throw new Error(`hash-password.js did not return a scrypt record (${String(r.stderr || '').trim()})`);
  }
  return record;
}

function sameRoles(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((r, i) => r === b[i]);
}

function checkMachine(ci) {
  head('1. This machine');
  if (!fs.existsSync(COMPOSE_FILE)) die('docker-compose.yml is not next to stack.js.');
  const major = Number(process.versions.node.split('.')[0]);
  say(`node            ${process.versions.node}`);
  if (major < 20) warn('Node 20 or later is expected; the console image runs Node 22.');
  const cli = docker(['version', '--format', '{{.Client.Version}}']);
  if (cli.status === 127) {
    if (ci) { warn('docker is not on PATH; the compose file could not be validated.'); return false; }
    die('Docker is not installed. Install Docker Desktop (Windows, macOS) or Docker Engine with the compose plugin (Linux), then run this again.');
  }
  say(`docker cli      ${cli.stdout.trim()}`);
  if (ci) return true;
  const server = docker(['info', '--format', '{{.ServerVersion}} {{.OSType}}']);
  if (server.status !== 0 || !server.stdout.trim()) {
    die('The Docker engine is not running. Start Docker Desktop (or the docker service) and wait until it reports running, then run this again.');
  }
  const [version, osType] = server.stdout.trim().split(/\s+/);
  say(`docker engine   ${version}`);
  if (osType !== 'linux') die(`Docker is in ${osType}-container mode. Every image here is Linux. Switch to Linux containers.`);
  if (IS_WINDOWS) {
    const wslconfig = path.join(os.homedir(), '.wslconfig');
    if (!fs.existsSync(wslconfig)) {
      warn(`No ${wslconfig}. WSL2 takes half this machine's RAM by default; create it with [wsl2] memory=10GB processors=6, then run 'wsl --shutdown'.`);
    } else {
      const mem = /^\s*memory\s*=\s*(.+)$/im.exec(fs.readFileSync(wslconfig, 'utf8'));
      if (mem) say(`wslconfig       memory=${mem[1].trim()}`);
      else warn(`${wslconfig} sets no memory=, so WSL2 takes half this machine's RAM.`);
    }
  }
  return true;
}

function bootstrap(flags) {
  const rotate = !!flags.rotate;
  const ci = !!flags.ci;
  process.stdout.write('\n  Argus stack bootstrap\n');
  say(HERE);
  const haveDocker = checkMachine(ci);

  head('2. Secrets directory');
  try {
    const existed = ensureSecretsDir();
    say(`${existed ? 'kept' : 'created'} secrets/ (${IS_WINDOWS ? 'current user, SYSTEM and Administrators only, inheritance removed' : 'mode 0700'})`);
  } catch (err) {
    die(`secrets/ could not be restricted: ${err.message}. Nothing was written.`);
  }

  head('3. .env');
  const lines = exampleLines();
  const existing = rotate ? new Map() : readEnvFile(ENV_FILE);
  const hadEnv = fs.existsSync(ENV_FILE);
  if (rotate && hadEnv) warn('--rotate: every generated value and file secret is replaced. A stack still running on the old values will break; run reset first.');
  const values = new Map();
  const generated = [];
  const added = [];
  const exampleKeys = [];
  for (const line of lines) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const fallback = m[2].trim();
    exampleKeys.push(key);
    const have = existing.get(key);
    if (ENV_GENERATORS[key]) {
      if (!isPlaceholder(have)) { values.set(key, have); continue; }
      values.set(key, ENV_GENERATORS[key]());
      generated.push(key);
      continue;
    }
    if (BREAKGLASS_KEYS.includes(key)) {
      if (!isPlaceholder(have)) values.set(key, have);
      continue;
    }
    if (have !== undefined) { values.set(key, have); continue; }
    values.set(key, fallback);
    if (hadEnv && !rotate) added.push(key);
  }

  let breakglassPassword = null;
  const breakglassMissing = BREAKGLASS_KEYS.some((k) => isPlaceholder(values.get(k)));
  if (breakglassMissing || rotate) {
    const bg = breakglass();
    values.set('GUAC_BREAKGLASS_SALT_HEX', bg.salt);
    values.set('GUAC_BREAKGLASS_HASH_HEX', bg.digest);
    breakglassPassword = bg.password;
    generated.push(...BREAKGLASS_KEYS);
  }

  const derivedNotes = [];
  const regex = deriveSubnetRegex(values.get('ARGUS_SUBNET'));
  if (values.get('ARGUS_SUBNET_REGEX') !== regex) {
    values.set('ARGUS_SUBNET_REGEX', regex);
    derivedNotes.push('ARGUS_SUBNET_REGEX');
  }
  const bytes = deriveGarnetBytes(values.get('GARNET_MEM_LIMIT'));
  if (bytes === null) warn(`GARNET_MEM_LIMIT is '${values.get('GARNET_MEM_LIMIT')}', which is not a docker size; ARGUS_GARNET_MEM_LIMIT_BYTES is left as it is.`);
  else if (values.get('ARGUS_GARNET_MEM_LIMIT_BYTES') !== bytes) {
    values.set('ARGUS_GARNET_MEM_LIMIT_BYTES', bytes);
    derivedNotes.push('ARGUS_GARNET_MEM_LIMIT_BYTES');
  }

  let alertText;
  try {
    alertText = renderAlertmanager(values);
  } catch (err) {
    die(`${err.message}. No .env and no secret were written.`);
  }

  const out = [];
  for (const line of lines) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && values.has(m[1])) out.push(`${m[1]}=${values.get(m[1])}`);
    else out.push(line);
  }
  const extras = [...existing.keys()].filter((k) => !exampleKeys.includes(k));
  if (extras.length) {
    out.push('');
    for (const k of extras) out.push(`${k}=${existing.get(k)}`);
  }
  let text = out.join('\n').replace(/\n+$/, '');
  text += '\n';
  writeProtected(ENV_FILE, text, '.env');
  if (!hadEnv || rotate) say(`wrote .env       (${generated.length} credentials generated)`);
  else if (generated.length || added.length || derivedNotes.length) {
    say(`updated .env     (kept every existing value; ${generated.length} credentials generated, ${added.length} keys added from .env.example)`);
  } else {
    say('kept .env        (complete; nothing to add)');
  }
  if (generated.length && hadEnv && !rotate) say(`generated        ${generated.join(', ')}`);
  if (added.length) say(`added            ${added.join(', ')}`);
  if (derivedNotes.length) say(`derived          ${derivedNotes.join(', ')}`);

  head('4. File secrets');
  const written = [];
  const kept = [];
  for (const [name, make] of Object.entries(INDEPENDENT_FILES)) {
    const current = readSecret(name);
    if (current && !rotate) { kept.push(name); writeSecret(name, current); continue; }
    writeSecret(name, make());
    written.push(name);
  }
  const derivedFiles = {
    pg_exporter_password: values.get('ARGUS_PG_EXPORTER_PASSWORD'),
    grafana_db_password: values.get('ARGUS_PG_GRAFANA_PASSWORD'),
    console_operator_password: values.get('CONSOLE_OPERATOR_PASSWORD'),
    'garnet/users.acl': `user default off\nuser console on >${values.get('GARNET_CONSOLE_PASSWORD')} ~* -@all +ping +select +info +dbsize +time +acl|whoami +config|get +client|info +client|list +command +command|count +command|docs +command|info +latency|histogram\n`,
    'alertmanager.yml': alertText
  };
  for (const [name, content] of Object.entries(derivedFiles)) {
    const current = readSecret(name);
    writeSecret(name, content);
    if (current === content) kept.push(name); else written.push(name);
  }
  if (breakglassPassword) {
    writeSecret('guac_breakglass_password', breakglassPassword);
    written.push('guac_breakglass_password');
  } else if (readSecret('guac_breakglass_password') !== null) {
    writeSecret('guac_breakglass_password', readSecret('guac_breakglass_password'));
    kept.push('guac_breakglass_password');
  } else {
    warn('GUAC_BREAKGLASS_HASH_HEX is set but secrets/guac_breakglass_password is gone. The break-glass login still works for whoever knows it; run bootstrap --rotate after reset to mint a new one.');
  }
  const nomadToken = readSecret('nomad_token');
  if (nomadToken === null || rotate) { writeSecret('nomad_token', ''); written.push('nomad_token (empty until nomad-acl-init runs)'); }
  else { writeSecret('nomad_token', nomadToken); kept.push('nomad_token'); }

  const operator = values.get('CONSOLE_OPERATOR') || 'argus-admin';
  const operatorsFile = 'operators.json';
  const currentOperators = readSecret(operatorsFile);
  let operatorNote;
  if (currentOperators && !rotate) {
    let doc = null;
    try { doc = JSON.parse(currentOperators); } catch (err) { doc = null; }
    if (!doc || !Array.isArray(doc.operators)) {
      die('secrets/operators.json exists but is not an operators document. Fix or delete it, then run bootstrap again.');
    }
    let migrated = false;
    for (const entry of doc.operators) {
      if (entry && entry.subject === operator && sameRoles(entry.roles, LEGACY_OPERATOR_ROLES)) {
        entry.roles = DEFAULT_OPERATOR_ROLES.slice();
        migrated = true;
      }
    }
    writeSecret(operatorsFile, migrated ? `${JSON.stringify(doc, null, 2)}\n` : currentOperators);
    kept.push(operatorsFile);
    operatorNote = migrated ? `kept operators.json; '${operator}' moved from operator,tier-1 to admin` : 'kept operators.json';
  } else {
    let record;
    try {
      record = hashOperatorPassword(values.get('CONSOLE_OPERATOR_PASSWORD'));
    } catch (err) {
      die(`${err.message}. Install Node 20 or later and run bootstrap again.`);
    }
    const doc = { operators: [{ subject: operator, displayName: 'Argus operator', roles: DEFAULT_OPERATOR_ROLES.slice(), password: record }] };
    writeSecret(operatorsFile, `${JSON.stringify(doc, null, 2)}\n`);
    written.push(operatorsFile);
    operatorNote = `wrote operators.json ('${operator}', roles admin)`;
  }
  if (written.length) say(`wrote            ${written.join(', ')}`);
  if (kept.length) say(`kept             ${kept.join(', ')}`);
  say(operatorNote);

  head('5. Validating the compose file');
  if (!haveDocker) {
    warn('docker is not available, so docker compose config was not run.');
  } else {
    const all = declaredProfiles();
    const check = compose(all, true, ['config', '-q']);
    if (check.status !== 0) die(`docker compose config rejected the file:\n${(check.stderr || check.stdout).trim()}`);
    say(`docker compose config: ok (every profile, with and without docker-compose.ports.yml)`);
  }

  process.stdout.write('\n');
  if (warnings) say(`${warnings} warning${warnings === 1 ? '' : 's'} above; none of them stop the stack.`);
  const port = values.get('CONSOLE_PORT') || '8787';
  process.stdout.write('\n  Ready.\n\n');
  say('node stack.js up --wait        default profiles: cache, queues, secrets, observability');
  say('node stack.js up --profiles cache,queues,secrets,observability,connect --wait');
  say('node stack.js status');
  process.stdout.write('\n');
  say(`Open http://127.0.0.1:${port} and sign in as '${operator}' with the password in secrets/console_operator_password.`);
  say('Use 127.0.0.1, not localhost: the publishes are IPv4 only.');
  process.stdout.write('\n');
}

function requireEnv() {
  if (!fs.existsSync(ENV_FILE)) die('.env does not exist yet. Run: node stack.js bootstrap');
}

function psRows(profiles) {
  const r = compose(profiles, false, ['ps', '-a', '--format', 'json']);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout).trim(), rows: [] };
  const text = r.stdout.trim();
  if (!text) return { ok: true, rows: [] };
  let rows;
  if (text.startsWith('[')) rows = JSON.parse(text);
  else rows = text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return { ok: true, rows };
}

function evaluate(profiles) {
  const config = composeConfig(profiles, false);
  if (!config.ok) return { ok: false, error: config.error, services: [] };
  const expected = config.doc.services || {};
  const ps = psRows(declaredProfiles());
  if (!ps.ok) return { ok: false, error: ps.error, services: [] };
  const byService = new Map();
  for (const row of ps.rows) byService.set(row.Service, row);
  const services = [];
  for (const [name, service] of Object.entries(expected).sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = byService.get(name);
    const oneShot = isOneShot(service);
    const hasHealthcheck = !!(service.healthcheck && !service.healthcheck.disable);
    const entry = {
      service: name,
      kind: oneShot ? 'one-shot' : 'long-running',
      profiles: service.profiles || [],
      state: row ? row.State : 'missing',
      health: row ? (row.Health || null) : null,
      exitCode: row && row.ExitCode !== undefined ? Number(row.ExitCode) : null,
      status: row ? row.Status : 'not created',
      verdict: 'pending'
    };
    if (!row) entry.verdict = 'missing';
    else if (oneShot) {
      if (row.State === 'exited') entry.verdict = entry.exitCode === 0 ? 'ok' : 'failed';
      else if (row.State === 'running' || row.State === 'created' || row.State === 'restarting') entry.verdict = 'pending';
      else entry.verdict = 'failed';
    } else if (row.State === 'running') {
      if (!hasHealthcheck) entry.verdict = 'ok';
      else if (row.Health === 'healthy') entry.verdict = 'ok';
      else if (row.Health === 'unhealthy') entry.verdict = 'unhealthy';
      else entry.verdict = 'pending';
    } else if (row.State === 'restarting' || row.State === 'created') {
      entry.verdict = 'pending';
    } else {
      entry.verdict = 'failed';
    }
    services.push(entry);
  }
  const extra = ps.rows.filter((row) => !expected[row.Service]).map((row) => ({ service: row.Service, state: row.State, status: row.Status }));
  const ok = services.every((s) => s.verdict === 'ok');
  return { ok, services, extra };
}

function operatorName() {
  const text = readSecret('operators.json');
  if (text) {
    try {
      const doc = JSON.parse(text);
      if (doc.operators && doc.operators[0] && doc.operators[0].subject) return doc.operators[0].subject;
    } catch (err) {
      return readEnvFile(ENV_FILE).get('CONSOLE_OPERATOR') || null;
    }
  }
  return readEnvFile(ENV_FILE).get('CONSOLE_OPERATOR') || null;
}

function consoleUrl() {
  return `http://127.0.0.1:${readEnvFile(ENV_FILE).get('CONSOLE_PORT') || '8787'}`;
}

function printStatus(result, profiles) {
  process.stdout.write(`\n  Argus stack: profiles ${profiles.length ? profiles.join(', ') : '(core only)'}\n\n`);
  const width = Math.max(...result.services.map((s) => s.service.length), 8);
  for (const s of result.services) {
    const mark = s.verdict === 'ok' ? 'ok  ' : s.verdict === 'pending' ? '..  ' : 'FAIL';
    process.stdout.write(`  ${mark} ${s.service.padEnd(width)}  ${s.kind.padEnd(12)}  ${s.status}\n`);
  }
  for (const s of result.extra || []) {
    process.stdout.write(`  --   ${s.service.padEnd(width)}  outside the chosen profiles  ${s.status}\n`);
  }
  process.stdout.write('\n');
  say(`console   ${consoleUrl()}`);
  say(`operator  ${operatorName() || '(unknown: run bootstrap)'}; password in secrets/console_operator_password`);
  say(result.ok ? 'every long-running service is healthy and every one-shot exited 0' : 'NOT READY: see the rows not marked ok');
  process.stdout.write('\n');
}

function status(flags) {
  requireEnv();
  jsonMode = !!flags.json;
  const profiles = chosenProfiles(flags);
  const result = evaluate(profiles);
  if (result.error) {
    if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, error: result.error }, null, 2)}\n`);
    else die(result.error);
    process.exit(1);
  }
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, profiles, consoleUrl: consoleUrl(), operator: operatorName(), services: result.services, outsideProfiles: result.extra }, null, 2)}\n`);
  } else {
    printStatus(result, profiles);
  }
  process.exit(result.ok ? 0 : 1);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function up(flags) {
  requireEnv();
  const profiles = chosenProfiles(flags);
  const withPorts = !!flags.ports;
  const args = ['up', '-d', '--remove-orphans'];
  if (flags.build) args.push('--build');
  process.stdout.write(`\n  Starting Argus: profiles ${profiles.join(', ') || '(core only)'}${withPorts ? ', every port published' : ''}\n\n`);
  const r = compose(profiles, withPorts, args, { stdio: 'inherit' });
  if (r.status !== 0) die(`docker compose up failed (exit ${r.status}). Run: node stack.js status, then node stack.js logs <service>`, r.status);
  if (!flags.wait) {
    say('started. node stack.js status shows when every service is healthy.');
    return;
  }
  const timeout = Number(flags.timeout || WAIT_TIMEOUT_S) * 1000;
  const deadline = Date.now() + timeout;
  let last = '';
  let result;
  for (;;) {
    result = evaluate(profiles);
    if (result.error) die(result.error);
    const failed = result.services.filter((s) => s.verdict === 'failed' || s.verdict === 'missing');
    const pending = result.services.filter((s) => s.verdict !== 'ok');
    if (result.ok) break;
    if (failed.length && failed.some((s) => s.kind === 'one-shot' || s.state === 'exited' || s.verdict === 'missing')) {
      printStatus(result, profiles);
      die(`${failed.map((s) => s.service).join(', ')} failed. Run: node stack.js logs ${failed[0].service}`);
    }
    const line = `waiting for ${pending.length} service(s): ${pending.map((s) => s.service).join(', ')}`;
    if (line !== last) { say(line); last = line; }
    if (Date.now() > deadline) {
      printStatus(result, profiles);
      die(`not every service was healthy after ${Math.round(timeout / 1000)}s.`);
    }
    sleep(3000);
  }
  printStatus(result, profiles);
}

function listVolumes() {
  const r = docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', 'label=com.docker.compose.project=argus']);
  const names = new Set(r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []);
  for (const name of Object.keys(VOLUME_NOTES)) {
    const probe = docker(['volume', 'inspect', name, '--format', '{{.Name}}']);
    if (probe.status === 0) names.add(name);
  }
  return [...names].sort();
}

function down(flags) {
  const all = declaredProfiles();
  if (flags.volumes && !flags.yes) {
    const vols = listVolumes();
    process.stdout.write('\n  down --volumes deletes these volumes. There is no backup and no undo:\n\n');
    for (const v of vols) process.stdout.write(`    ${v.padEnd(26)} ${VOLUME_NOTES[v] || ''}\n`);
    die('Add --yes to confirm.');
  }
  const args = ['down', '--remove-orphans'];
  if (flags.volumes) args.push('--volumes');
  process.stdout.write(`\n  Stopping the Argus stack${flags.volumes ? ' and deleting its volumes' : '; volumes are kept'}\n\n`);
  const r = compose(all, true, args, { stdio: 'inherit' });
  if (r.status !== 0) die(`docker compose down failed (exit ${r.status}).`, r.status);
  if (flags.volumes) {
    for (const v of listVolumes()) docker(['volume', 'rm', v]);
  }
  if (flags.images) {
    const built = docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'reference=argus/*']);
    for (const ref of built.stdout.split(/\r?\n/).filter(Boolean)) {
      docker(['image', 'rm', ref]);
      say(`removed image ${ref}`);
    }
  }
  say(flags.volumes ? 'stopped; every argus volume is gone.' : 'stopped. node stack.js up resumes where this left off.');
  process.stdout.write('\n');
}

function reset(flags) {
  if (!flags.yes) {
    die('reset deletes every container, every argus volume, .env and secrets/. Add --yes to confirm.');
  }
  process.stdout.write('\n  Resetting the Argus stack: every container, volume and network of project argus\n\n');
  if (fs.existsSync(ENV_FILE)) {
    const r = compose(declaredProfiles(), true, ['down', '--volumes', '--remove-orphans'], { stdio: 'inherit' });
    if (r.status !== 0) warn('docker compose down failed (often an .env from an older layout); removing by label instead.');
  }
  const listed = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=argus']);
  const ids = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (ids.length) docker(['rm', '-f', ...ids]);
  for (const v of listVolumes()) {
    const rm = docker(['volume', 'rm', v]);
    if (rm.status !== 0) die(`could not remove volume ${v}: ${rm.stderr.trim()}`);
  }
  const nets = docker(['network', 'ls', '--format', '{{.Name}}', '--filter', 'label=com.docker.compose.project=argus']);
  for (const n of nets.stdout.split(/\r?\n/).filter(Boolean)) docker(['network', 'rm', n]);
  fs.rmSync(SECRETS, { recursive: true, force: true });
  fs.rmSync(ENV_FILE, { force: true });
  fs.rmSync(path.join(HERE, 'images.lock'), { force: true });
  say('removed .env and secrets/. Next: node stack.js bootstrap, then node stack.js up --wait');
  process.stdout.write('\n');
}

function logs(flags, positional) {
  requireEnv();
  const args = ['logs', '--tail', String(flags.tail || 200)];
  if (flags.follow || flags.f) args.push('--follow');
  if (positional[0]) args.push(positional[0]);
  const r = compose(declaredProfiles(), false, args, { stdio: 'inherit' });
  process.exit(r.status);
}

function parseCidr(cidr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(String(cidr || '').trim());
  if (!m) return null;
  const ip = ((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4]);
  const bits = Number(m[5]);
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return { start: (ip & mask) >>> 0, end: ((ip & mask) | (~mask >>> 0)) >>> 0 };
}

function overlaps(a, b) {
  return a && b && a.start <= b.end && b.start <= a.end;
}

function portFree(host, port) {
  const script = `const s=require('net').createServer();s.once('error',e=>{process.stdout.write(e.code||'ERR');process.exit(0)});s.listen(${Number(port)},${JSON.stringify(host)},()=>{s.close(()=>{process.stdout.write('FREE');process.exit(0)})})`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  return (r.stdout || '').trim();
}

function parseBytes(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg]?)i?b?$/i.exec(String(value));
  if (!m) return 0;
  return Math.round(Number(m[1]) * { '': 1, b: 1, k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()]);
}

function windowsAcl(paths) {
  const script = "$ErrorActionPreference='Stop'; $out=@(); foreach ($p in ($env:ARGUS_ACL_PATHS -split '\\|')) { $a=Get-Acl -LiteralPath $p; $sids=@($a.Access | ForEach-Object { try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference } }); $out += [pscustomobject]@{ path=$p; protected=$a.AreAccessRulesProtected; sids=$sids } }; ConvertTo-Json -InputObject $out -Compress -Depth 4";
  const r = spawnSync(winTool(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', env: Object.assign({}, process.env, { ARGUS_ACL_PATHS: paths.join('|') })
  });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim() };
  try {
    const parsed = JSON.parse(r.stdout);
    return { ok: true, entries: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { ok: false, error: `could not read ACLs: ${err.message}` };
  }
}

function doctor(flags) {
  jsonMode = !!flags.json;
  const checks = [];
  const add = (area, level, message) => checks.push({ area, level, message });
  const withPorts = !!flags.ports;

  const engine = docker(['info', '--format', '{{json .}}']);
  let info = null;
  if (engine.status === 127) add('docker', 'fail', 'docker is not installed or not on PATH');
  else if (engine.status !== 0) add('docker', 'fail', `the Docker engine is not reachable: ${(engine.stderr || '').trim().split('\n')[0]}`);
  else {
    info = JSON.parse(engine.stdout);
    add('docker', 'ok', `engine ${info.ServerVersion} on ${info.OperatingSystem}, ${info.NCPU} CPUs, ${(info.MemTotal / 1073741824).toFixed(1)} GiB`);
    if (info.OSType !== 'linux') add('docker', 'fail', `the engine runs ${info.OSType} containers; every image here is Linux`);
    else add('docker', 'ok', 'Linux containers');
    const major = Number(String(info.ServerVersion).split('.')[0]);
    if (major < 25) add('docker', 'warn', 'Docker Engine 25 or later is expected (healthcheck start_interval)');
  }
  const composeVersion = docker(['compose', 'version', '--short']);
  if (composeVersion.status === 0) {
    const v = composeVersion.stdout.trim().replace(/^v/, '');
    const [maj, min] = v.split('.').map(Number);
    add('docker', maj > 2 || (maj === 2 && min >= 20) ? 'ok' : 'fail', `docker compose ${v}${maj > 2 || (maj === 2 && min >= 20) ? '' : ' (2.20 or later is required)'}`);
  } else if (info) add('docker', 'fail', 'the docker compose plugin is missing');

  const envExists = fs.existsSync(ENV_FILE);
  const env = readEnvFile(ENV_FILE);
  const profiles = chosenProfiles(flags);
  if (!envExists) add('env', 'fail', '.env does not exist; run node stack.js bootstrap');
  else {
    const exampleValues = readEnvFile(EXAMPLE_FILE);
    const missing = [];
    const placeholders = [];
    const drifted = [];
    for (const [key, sample] of exampleValues) {
      if (!env.has(key)) { missing.push(key); continue; }
      const value = env.get(key);
      if ((ENV_GENERATORS[key] || BREAKGLASS_KEYS.includes(key)) && isPlaceholder(value)) placeholders.push(key);
      if (/_IMAGE$/.test(key) && value !== sample) drifted.push(key);
    }
    if (missing.length) add('env', 'fail', `.env lacks ${missing.join(', ')}; run node stack.js bootstrap (it only adds what is missing)`);
    if (placeholders.length) add('env', 'fail', `.env has no value for ${placeholders.join(', ')}; run node stack.js bootstrap`);
    if (!missing.length && !placeholders.length) add('env', 'ok', `.env has every key in .env.example (${exampleValues.size})`);
    if (drifted.length) add('env', 'warn', `${drifted.join(', ')} differ from .env.example; the stack runs the images .env names`);
    if (env.get('ARGUS_SUBNET_REGEX') !== deriveSubnetRegex(env.get('ARGUS_SUBNET'))) add('env', 'warn', 'ARGUS_SUBNET_REGEX does not match ARGUS_SUBNET; run node stack.js bootstrap to re-derive it');
    const bytes = deriveGarnetBytes(env.get('GARNET_MEM_LIMIT'));
    if (bytes && env.get('ARGUS_GARNET_MEM_LIMIT_BYTES') !== bytes) add('env', 'warn', 'ARGUS_GARNET_MEM_LIMIT_BYTES does not match GARNET_MEM_LIMIT; run node stack.js bootstrap to re-derive it');
  }

  const required = [...MOUNTED_FILES, ...HOST_ONLY_FILES, ...PRIVATE_MOUNTED_FILES];
  if (!fs.existsSync(SECRETS)) add('secrets', 'fail', 'secrets/ does not exist; run node stack.js bootstrap');
  else {
    const absent = required.filter((r) => !fs.existsSync(secretPath(r)));
    const empty = required.filter((r) => r !== 'nomad_token' && fs.existsSync(secretPath(r)) && fs.statSync(secretPath(r)).size === 0);
    if (absent.length) add('secrets', 'fail', `missing: ${absent.join(', ')}; run node stack.js bootstrap`);
    if (empty.length) add('secrets', 'fail', `empty: ${empty.join(', ')}`);
    if (!absent.length && !empty.length) add('secrets', 'ok', `${required.length} file secrets present`);
    const targets = [SECRETS, path.join(SECRETS, 'garnet'), ...required.filter((r) => fs.existsSync(secretPath(r))).map(secretPath)];
    if (envExists) targets.push(ENV_FILE);
    if (IS_WINDOWS) {
      const sid = userSid();
      const allowed = new Set([sid, SYSTEM_SID, ADMINISTRATORS_SID]);
      const acl = windowsAcl(targets);
      if (!acl.ok) add('secrets', 'fail', `could not read ACLs: ${acl.error}`);
      else {
        const loose = [];
        for (const entry of acl.entries) {
          const others = (entry.sids || []).filter((s) => !allowed.has(s));
          if (!entry.protected || others.length) loose.push(`${path.relative(HERE, entry.path) || entry.path}${others.length ? ` (also ${others.join(', ')})` : ' (inherits)'}`);
        }
        if (loose.length) add('secrets', 'fail', `not restricted to the current user, SYSTEM and Administrators: ${loose.join('; ')}. Run node stack.js bootstrap`);
        else add('secrets', 'ok', `ACLs: current user, SYSTEM and Administrators only, inheritance removed (${acl.entries.length} paths)`);
      }
    } else {
      const loose = [];
      for (const target of targets) {
        const mode = fs.statSync(target).mode & 0o777;
        const rel = path.relative(HERE, target);
        const isDir = fs.statSync(target).isDirectory();
        if (isDir && mode !== 0o700) loose.push(`${rel} is ${mode.toString(8)}, want 700`);
        else if (!isDir && (mode & 0o022)) loose.push(`${rel} is ${mode.toString(8)}, writable by others`);
        else if (!isDir && (mode & 0o044) && (rel === '.env' || HOST_ONLY_FILES.includes(path.relative(SECRETS, target)) || PRIVATE_MOUNTED_FILES.includes(path.relative(SECRETS, target)))) loose.push(`${rel} is ${mode.toString(8)}, want 600`);
      }
      if (loose.length) add('secrets', 'fail', `permissions: ${loose.join('; ')}. Run node stack.js bootstrap`);
      else add('secrets', 'ok', 'permissions: secrets/ 700, mounted files 644, host-only files and .env 600');
    }
  }

  if (info && envExists) {
    const all = composeConfig(declaredProfiles(), withPorts);
    const chosen = composeConfig(profiles, withPorts);
    if (!all.ok || !chosen.ok) add('compose', 'fail', `docker compose config failed: ${(all.error || chosen.error || '').split('\n')[0]}`);
    else {
      add('compose', 'ok', 'docker compose config resolves for every profile');
      const budget = new Map();
      let total = 0;
      for (const [name, svc] of Object.entries(chosen.doc.services || {})) {
        const bytes = parseBytes(svc.mem_limit);
        total += isOneShot(svc) ? 0 : bytes;
        const group = (svc.profiles && svc.profiles.length ? svc.profiles.filter((p) => profiles.includes(p))[0] || svc.profiles[0] : 'core');
        budget.set(group, (budget.get(group) || 0) + (isOneShot(svc) ? 0 : bytes));
        if (!bytes && !isOneShot(svc)) add('memory', 'warn', `${name} has no mem_limit`);
      }
      const parts = [...budget.entries()].map(([g, b]) => `${g} ${(b / 1048576).toFixed(0)}M`).join(', ');
      const have = info.MemTotal;
      const ratio = total / have;
      const level = ratio > 1 ? 'fail' : ratio > 0.85 ? 'warn' : 'ok';
      add('memory', level, `limits for ${profiles.join(', ') || 'core'}: ${(total / 1073741824).toFixed(1)} GiB (${parts}) against ${(have / 1073741824).toFixed(1)} GiB in the engine`);

      const running = psRows(declaredProfiles());
      const ours = new Set();
      for (const row of running.rows || []) for (const p of row.Publishers || []) if (p.PublishedPort) ours.add(`${p.URL}:${p.PublishedPort}`);
      const ports = [];
      for (const [name, svc] of Object.entries(chosen.doc.services || {})) {
        for (const p of svc.ports || []) if (p.published) ports.push({ name, host: p.host_ip || '0.0.0.0', port: Number(p.published) });
      }
      const held = [];
      for (const p of ports) {
        const verdict = portFree(p.host, p.port);
        if (verdict === 'FREE') continue;
        if (ours.has(`${p.host}:${p.port}`) || ours.has(`0.0.0.0:${p.port}`)) continue;
        held.push(`${p.host}:${p.port} (${p.name}, ${verdict})`);
      }
      if (held.length) add('ports', 'fail', `already in use by something else: ${held.join('; ')}. Change the matching *_PORT in .env`);
      else add('ports', 'ok', `${ports.length} published port(s) free or held by this stack: ${ports.map((p) => p.port).join(', ')}`);
    }
  }

  if (envExists) {
    const subnet = env.get('ARGUS_SUBNET') || '172.28.0.0/16';
    const mine = parseCidr(subnet);
    const clashes = [];
    if (!mine) add('network', 'fail', `ARGUS_SUBNET '${subnet}' is not an IPv4 CIDR`);
    else {
      if (info) {
        const ids = docker(['network', 'ls', '-q']).stdout.split(/\r?\n/).filter(Boolean);
        if (ids.length) {
          const inspected = docker(['network', 'inspect', ...ids]);
          if (inspected.status === 0) {
            for (const n of JSON.parse(inspected.stdout)) {
              if (n.Name === 'argus') continue;
              for (const c of (n.IPAM && n.IPAM.Config) || []) if (overlaps(mine, parseCidr(c.Subnet))) clashes.push(`docker network ${n.Name} (${c.Subnet})`);
            }
          }
        }
      }
      for (const [nic, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && overlaps(mine, parseCidr(a.cidr))) clashes.push(`host interface ${nic} (${a.cidr})`);
      }
      if (clashes.length) add('network', 'fail', `ARGUS_SUBNET ${subnet} overlaps ${clashes.join('; ')}. Set ARGUS_SUBNET in .env to an unused /16 and rerun bootstrap`);
      else add('network', 'ok', `ARGUS_SUBNET ${subnet} does not clash with any docker network or host interface`);
    }
  }

  const failed = checks.filter((c) => c.level === 'fail').length;
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, profiles, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n  Argus doctor: profiles ${profiles.join(', ') || '(core only)'}\n\n`);
    for (const c of checks) process.stdout.write(`  ${c.level === 'ok' ? 'ok  ' : c.level === 'warn' ? 'warn' : 'FAIL'} ${c.area.padEnd(8)} ${c.message}\n`);
    process.stdout.write(`\n  ${failed ? `${failed} check(s) failed` : 'every check passed'}\n\n`);
  }
  process.exit(failed ? 1 : 0);
}

function usage() {
  process.stdout.write(`
  node stack.js <command>

    bootstrap [--rotate] [--ci]        write .env and secrets/; only what is missing unless --rotate
    up [--profiles a,b] [--ports] [--wait] [--timeout s] [--build]
                                       start the stack; profiles default to COMPOSE_PROFILES in .env
    down [--volumes --yes] [--images]  stop every profile; --volumes also deletes the data,
                                       --images removes the locally built argus/* images
    reset --yes                        down --volumes, then delete .env and secrets/
    status [--json] [--profiles a,b]   health of every service; exit 1 unless all are ready
    logs [service] [--follow] [--tail n]
    doctor [--json] [--ports]          engine, memory, ports, subnet, secrets and .env checks

`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  switch (command) {
    case 'bootstrap': return bootstrap(flags);
    case 'up': return up(flags);
    case 'down': return down(flags);
    case 'reset': return reset(flags);
    case 'status': return status(flags);
    case 'logs': return logs(flags, positional);
    case 'doctor': return doctor(flags);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      return undefined;
    default:
      usage();
      return die(`unknown command '${command}'`);
  }
}

main();
