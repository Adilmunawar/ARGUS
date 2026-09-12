'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  S3Client,
  ListBucketsCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  GetBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  GetObjectLockConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

function positiveIntMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error('[storage-init] !',
      `${name}=${JSON.stringify(raw)} is not a whole number of milliseconds greater than zero. ` +
      `Falling back to ${fallback}; a value that parses as NaN would disable the timeout it names.`);
    return fallback;
  }
  return n;
}

const ENDPOINT    = process.env.ARGUS_S3_ENDPOINT || 'http://seaweed-s3:8333';
const REGION      = process.env.ARGUS_S3_REGION || 'us-east-1';
const BUCKETS_FILE = process.env.ARGUS_BUCKETS_FILE || '/config/buckets.yaml';
const STATE_DIR   = process.env.ARGUS_STATE_DIR || '/state';
const PROFILE     = (process.env.ARGUS_PROFILE || 'dev').toLowerCase();
const PROBE_BUCKET = process.env.ARGUS_WORM_PROBE_BUCKET || 'argus-worm-probe';
const READY_TIMEOUT_MS = positiveIntMs('ARGUS_S3_READY_TIMEOUT_MS', 120000);
const REQUEST_TIMEOUT_MS = positiveIntMs('ARGUS_S3_REQUEST_TIMEOUT_MS', 15000);
const CONNECT_TIMEOUT_MS = positiveIntMs('ARGUS_S3_CONNECT_TIMEOUT_MS', 3000);
const RUN_DEADLINE_MS = positiveIntMs('ARGUS_S3_RUN_DEADLINE_MS', 300000);
const IDENTITIES_FILE = process.env.ARGUS_S3_IDENTITIES_FILE || '/config/s3.json';
const IDENTITIES_FILE_PINNED = !!process.env.ARGUS_S3_IDENTITIES_FILE;
const RUN_STARTED_AT = Date.now();
const runDeadlineAt = () => RUN_STARTED_AT + RUN_DEADLINE_MS;

const DEV_LOCK_DAYS = Number(process.env.ARGUS_OBJECT_LOCK_DAYS || 1);
const DEV_LOCK_MODE = (process.env.ARGUS_DEV_LOCK_MODE || 'GOVERNANCE').toUpperCase();

const log = (...a) => console.log('[storage-init]', ...a);
const warn = (...a) => console.warn('[storage-init] !', ...a);

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: true,
  maxAttempts: 3,
  requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: CONNECT_TIMEOUT_MS }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errName(err) {
  return (err && (err.name || err.Code || (err.$metadata && err.$metadata.httpStatusCode))) || 'Error';
}

function isNotFound(err) {
  const s = err && err.$metadata && err.$metadata.httpStatusCode;
  return s === 404 || /NotFound|NoSuchBucket|NoSuchObjectLockConfiguration|NoSuchLifecycleConfiguration/i.test(errName(err));
}

const LOCK_MODES = new Set(['GOVERNANCE', 'COMPLIANCE']);

function isRetentionDays(v) {
  return Number.isInteger(v) && v > 0;
}

function describeLock(state) {
  if (!state || !state.enabled) return 'no object lock';
  if (state.years !== null && state.years !== undefined) {
    return `${state.mode || 'unknown mode'}/${state.years}y`;
  }
  if (state.days === null || state.days === undefined) {
    return `${state.mode || 'unknown mode'}/no default retention`;
  }
  return `${state.mode || 'unknown mode'}/${state.days}d`;
}

function retentionDays(state) {
  if (!state || !state.enabled) return 0;
  if (state.years !== null && state.years !== undefined) return Number(state.years) * 365;
  if (state.days === null || state.days === undefined) return 0;
  return Number(state.days);
}

function weakensLock(state, want) {
  if (!state || !state.enabled) return false;
  if (state.mode === 'COMPLIANCE' && want.mode !== 'COMPLIANCE') return true;
  return retentionDays(state) > Number(want.days);
}

function lockMatches(state, want) {
  return !!state && state.enabled === true
    && state.mode === want.mode
    && (state.years === null || state.years === undefined)
    && Number(state.days) === Number(want.days);
}

function readIdentityScopes() {
  let text;
  try {
    text = fs.readFileSync(IDENTITIES_FILE, 'utf8');
  } catch (err) {
    return { checked: false, path: IDENTITIES_FILE, reason: `could not be read (${err.code})`, scopes: null };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { checked: false, path: IDENTITIES_FILE, reason: `is not valid JSON (${err.message})`, scopes: null };
  }

  if (!doc || !Array.isArray(doc.identities)) {
    return { checked: false, path: IDENTITIES_FILE, reason: 'has no identities array', scopes: null };
  }

  const scopes = new Map();
  for (const identity of doc.identities) {
    const who = (identity && identity.name) || '(unnamed identity)';
    const actions = identity && Array.isArray(identity.actions) ? identity.actions : [];
    for (const action of actions) {
      const grant = String(action);
      const colon = grant.indexOf(':');
      if (colon < 0) continue;
      const bucket = grant.slice(colon + 1).split('/')[0].trim();
      if (!bucket) continue;
      if (!scopes.has(bucket)) scopes.set(bucket, new Set());
      scopes.get(bucket).add(who);
    }
  }
  return { checked: true, path: IDENTITIES_FILE, reason: null, scopes };
}

async function waitForS3() {
  const deadline = Math.min(Date.now() + READY_TIMEOUT_MS, runDeadlineAt());
  let attempt = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const out = await s3.send(new ListBucketsCommand({}));
      log(`gateway ready after ${attempt} attempt(s); ${(out.Buckets || []).length} bucket(s) present`);
      return out.Buckets || [];
    } catch (err) {
      last = err;
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (status === 403 || /SignatureDoesNotMatch|InvalidAccessKeyId/i.test(errName(err))) {
        throw new Error(
          `The S3 gateway rejected our credential (${errName(err)}). The access key id comes from ` +
          `AWS_ACCESS_KEY_ID and its secret from ARGUS_S3_ADMIN_SECRET; neither value is logged. ` +
          `Check that seaweed-config wrote s3.json with that identity and that ARGUS_S3_ADMIN_SECRET ` +
          `in .env matches the secret it wrote.`);
      }
      if (attempt === 1 || attempt % 5 === 0) {
        log(`waiting for ${ENDPOINT} (${errName(err)})`);
      }
      await sleep(2000);
    }
  }
  throw new Error(
    `The S3 gateway at ${ENDPOINT} did not accept a signed request within ` +
    `${Math.min(READY_TIMEOUT_MS, RUN_DEADLINE_MS)} ms. Last error: ${errName(last)} ${last && last.message}`);
}

function readBucketSet() {
  let text;
  try {
    text = fs.readFileSync(BUCKETS_FILE, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read ${BUCKETS_FILE} (${err.code}). This file is the single source for bucket ` +
      `configuration and is mounted read-only from platform/gitops/storage/buckets.yaml.`);
  }

  const doc = YAML.parse(text);
  if (!doc || doc.kind !== 'BucketSet' || !Array.isArray(doc.buckets)) {
    throw new Error(`${BUCKETS_FILE} is not a BucketSet document (kind was ${doc && doc.kind}).`);
  }

  return doc.buckets.map((b) => {
    if (!b || typeof b.name !== 'string' || !b.name) {
      throw new Error(`A bucket entry in ${BUCKETS_FILE} has no name: ${JSON.stringify(b)}`);
    }
    const declaredLock = b.objectLock
      ? { mode: String(b.objectLock.mode || 'COMPLIANCE').toUpperCase(), days: Number(b.objectLock.days) }
      : null;
    if (declaredLock && !isRetentionDays(declaredLock.days)) {
      throw new Error(
        `${b.name}: objectLock in ${BUCKETS_FILE} needs days to be a whole number greater than zero, got ` +
        `${JSON.stringify(b.objectLock.days)}. Retention that cannot be compared cannot be verified.`);
    }
    if (declaredLock && !LOCK_MODES.has(declaredLock.mode)) {
      throw new Error(
        `${b.name}: objectLock mode in ${BUCKETS_FILE} must be one of ${[...LOCK_MODES].join(' or ')}, got ` +
        `${JSON.stringify(b.objectLock.mode)}.`);
    }

    let lock = declaredLock;
    if (declaredLock && PROFILE === 'dev') {
      if (!isRetentionDays(DEV_LOCK_DAYS)) {
        throw new Error(
          `ARGUS_OBJECT_LOCK_DAYS must be a whole number of days greater than zero, got ` +
          `${JSON.stringify(process.env.ARGUS_OBJECT_LOCK_DAYS)}.`);
      }
      if (!LOCK_MODES.has(DEV_LOCK_MODE)) {
        throw new Error(
          `ARGUS_DEV_LOCK_MODE must be one of ${[...LOCK_MODES].join(' or ')}, got ` +
          `${JSON.stringify(process.env.ARGUS_DEV_LOCK_MODE)}.`);
      }
      lock = { mode: DEV_LOCK_MODE, days: DEV_LOCK_DAYS };
    } else if (declaredLock && (DEV_LOCK_DAYS !== declaredLock.days || DEV_LOCK_MODE !== declaredLock.mode)) {
      warn(`ARGUS_PROFILE=${PROFILE}: ignoring ARGUS_OBJECT_LOCK_* overrides for ${b.name}; ` +
           `applying the declared ${declaredLock.mode}/${declaredLock.days}d.`);
    }

    return {
      name: b.name,
      versioning: !!b.versioning || !!declaredLock,
      declaredLock,
      lock,
      lifecycleDays: b.lifecycle && Number(b.lifecycle.expireDays) ? Number(b.lifecycle.expireDays) : null,
      owner: b.owner || null
    };
  });
}

async function bucketExists(name) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function getLockConfig(name) {
  try {
    const out = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: name }));
    const rule = out.ObjectLockConfiguration && out.ObjectLockConfiguration.Rule;
    const d = rule && rule.DefaultRetention;
    if (!d) {
      return {
        enabled: !!(out.ObjectLockConfiguration && out.ObjectLockConfiguration.ObjectLockEnabled),
        mode: null, days: null, years: null
      };
    }
    return {
      enabled: true,
      mode: d.Mode || null,
      days: d.Days === undefined || d.Days === null ? null : Number(d.Days),
      years: d.Years === undefined || d.Years === null ? null : Number(d.Years)
    };
  } catch (err) {
    if (isNotFound(err)) return { enabled: false, mode: null, days: null, years: null };
    throw err;
  }
}

async function getVersioning(name) {
  try {
    const out = await s3.send(new GetBucketVersioningCommand({ Bucket: name }));
    return out.Status === 'Enabled';
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function putLock(name, lock) {
  await s3.send(new PutObjectLockConfigurationCommand({
    Bucket: name,
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: lock.mode, Days: lock.days } }
    }
  }));
}

async function applyBucket(spec, problems) {
  const problemsBefore = problems.length;
  const existed = await bucketExists(spec.name);

  if (!existed) {
    await s3.send(new CreateBucketCommand({
      Bucket: spec.name,
      ObjectLockEnabledForBucket: !!spec.lock
    }));
    log(`created ${spec.name}${spec.lock ? ' (object lock enabled at creation)' : ''}`);
  }

  if (spec.versioning) {
    await s3.send(new PutBucketVersioningCommand({
      Bucket: spec.name,
      VersioningConfiguration: { Status: 'Enabled' }
    }));
  }

  let lockState = { enabled: false, mode: null, days: null, years: null };
  let lockRepaired = false;
  if (spec.lock) {
    const want = `${spec.lock.mode}/${spec.lock.days}d`;
    if (!existed) {
      await putLock(spec.name, spec.lock);
    }
    lockState = await getLockConfig(spec.name);

    if (!lockState.enabled) {
      problems.push(
        `${spec.name}: buckets.yaml declares Object Lock ${spec.declaredLock.mode}/${spec.declaredLock.days}d, ` +
        `but the bucket exists WITHOUT it. Object Lock cannot be enabled after creation. ` +
        `The bucket must be recreated (destroying its contents) or the declaration removed.`);
    } else if (!lockMatches(lockState, spec.lock) && weakensLock(lockState, spec.lock)) {
      const before = describeLock(lockState);
      problems.push(
        `${spec.name}: the bucket enforces ${before} and ${want} is required, which is WEAKER. ` +
        `${PROFILE === 'dev' && spec.declaredLock && spec.lock !== spec.declaredLock
            ? `${want} comes from the dev overrides collapsing the declared ` +
              `${spec.declaredLock.mode}/${spec.declaredLock.days}d, not from ${BUCKETS_FILE}. `
            : `${BUCKETS_FILE} declares less retention than the bucket already enforces. `}` +
        `Retention that already exists is never reduced here, so the bucket was left at ${before}. ` +
        `Recreate the bucket, or raise the declaration to match what it enforces.`);
    } else if (!lockMatches(lockState, spec.lock)) {
      const before = describeLock(lockState);
      log(`${spec.name}: default retention is ${before}, ${want} is required; re-applying it`);
      let reapplyError = null;
      try {
        await putLock(spec.name, spec.lock);
        lockState = await getLockConfig(spec.name);
      } catch (err) {
        reapplyError = err;
      }
      if (reapplyError) {
        problems.push(
          `${spec.name}: default retention is ${before} but ${want} is required` +
          `${spec.declaredLock ? ` (buckets.yaml declares ${spec.declaredLock.mode}/${spec.declaredLock.days}d)` : ''}, ` +
          `and re-applying it was refused (${errName(reapplyError)}: ${reapplyError && reapplyError.message}). ` +
          `Objects written to this bucket are retained for the wrong period.`);
      } else if (!lockMatches(lockState, spec.lock)) {
        problems.push(
          `${spec.name}: default retention is ${describeLock(lockState)} after re-applying ${want}. ` +
          `The gateway accepted the configuration and did not store it, so the retention this bucket ` +
          `actually enforces is not the declared one.`);
      } else {
        lockRepaired = existed;
        log(`${spec.name}: default retention repaired from ${before} to ${describeLock(lockState)}`);
      }
    }
  } else {
    lockState = await getLockConfig(spec.name);
    if (lockState.enabled) {
      warn(`${spec.name}: Object Lock is enabled but buckets.yaml does not declare it.`);
    }
  }

  if (spec.lifecycleDays) {
    try {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: spec.name,
        LifecycleConfiguration: {
          Rules: [{
            ID: 'argus-expire',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            Expiration: { Days: spec.lifecycleDays }
          }]
        }
      }));
    } catch (err) {
      problems.push(`${spec.name}: lifecycle expiry of ${spec.lifecycleDays} days was refused (${errName(err)}). ` +
                    `Objects will accumulate until something else deletes them.`);
    }
  }

  const versioning = await getVersioning(spec.name);
  if (spec.versioning && !versioning) {
    problems.push(`${spec.name}: versioning was requested but the bucket reports it disabled.`);
  }

  const failed = problems.length > problemsBefore;
  const status = failed ? 'failed'
    : !existed ? 'created'
    : lockRepaired ? 'repaired'
    : 'verified';

  return {
    name: spec.name,
    status,
    created: !existed,
    repaired: lockRepaired,
    versioning,
    lock: lockState.enabled
      ? { mode: lockState.mode, days: lockState.days, years: lockState.years,
          declared: spec.declaredLock ? `${spec.declaredLock.mode}/${spec.declaredLock.days}d` : null,
          required: spec.lock ? `${spec.lock.mode}/${spec.lock.days}d` : null }
      : null,
    lifecycleDays: spec.lifecycleDays
  };
}

async function probeWorm() {
  const at = new Date().toISOString();
  const key = `probe-${Date.now()}`;
  const base = { bucket: PROBE_BUCKET, key, at, scope: 'single-node docker compose on WSL2' };

  try {
    if (!(await bucketExists(PROBE_BUCKET))) {
      await s3.send(new CreateBucketCommand({ Bucket: PROBE_BUCKET, ObjectLockEnabledForBucket: true }));
      await s3.send(new PutBucketVersioningCommand({
        Bucket: PROBE_BUCKET, VersioningConfiguration: { Status: 'Enabled' }
      }));
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: PROBE_BUCKET,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 1 } }
        }
      }));
      log(`created ${PROBE_BUCKET} (COMPLIANCE/1d, dedicated to this probe)`);
    }

    const put = await s3.send(new PutObjectCommand({
      Bucket: PROBE_BUCKET,
      Key: key,
      Body: 'argus-worm-probe',
      ContentType: 'text/plain'
    }));

    const versionId = put.VersionId;
    if (!versionId) {
      return { ...base, verdict: 'unknown',
        detail: 'The gateway returned no VersionId, so there is no specific version to attempt to delete. ' +
                'Versioning may not be in effect on this bucket.' };
    }

    try {
      await s3.send(new DeleteObjectCommand({ Bucket: PROBE_BUCKET, Key: key, VersionId: versionId }));
      return { ...base, versionId, verdict: 'not-enforced',
        detail: 'A locked object version was deleted successfully. Object Lock is configured but NOT enforced ' +
                'by this server. Anything that depends on immutability -- ADR-0020 backups above all -- is ' +
                'unprotected.' };
    } catch (err) {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (status === 403 || /AccessDenied/i.test(errName(err))) {
        return { ...base, versionId, verdict: 'enforced',
          detail: `The versioned delete was refused with ${errName(err)}. Retention is enforced.` };
      }
      return { ...base, versionId, verdict: 'unknown',
        detail: `The versioned delete failed with ${errName(err)} (${err && err.message}). That is not a refusal ` +
                'and is not evidence of enforcement.' };
    }
  } catch (err) {
    return { ...base, verdict: 'unknown',
      detail: `The probe could not run: ${errName(err)} (${err && err.message}).` };
  }
}

function writeState(name, value) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(value, null, 2) + '\n');
    return true;
  } catch (err) {
    warn(`could not write ${path.join(STATE_DIR, name)}: ${err.message}`);
    return false;
  }
}

async function run() {
  log(`endpoint ${ENDPOINT}, region ${REGION}, profile ${PROFILE}`);

  const problems = [];
  let runFailures = 0;

  const specs = readBucketSet();
  log(`${specs.length} bucket(s) declared in ${BUCKETS_FILE}`);
  if (PROFILE === 'dev') {
    const locked = specs.filter((s) => s.declaredLock);
    if (locked.length) {
      log(`dev profile: collapsing Object Lock on ${locked.length} bucket(s) to ${DEV_LOCK_MODE}/${DEV_LOCK_DAYS}d ` +
          `(declared: ${locked.map((s) => `${s.name}=${s.declaredLock.mode}/${s.declaredLock.days}d`).join(', ')})`);
    }
  }

  const declaredNames = new Set(specs.map((s) => s.name));
  const identityScopes = readIdentityScopes();
  const undeclaredScopes = [];
  if (identityScopes.checked) {
    for (const [bucket, identities] of identityScopes.scopes) {
      if (declaredNames.has(bucket) || bucket === PROBE_BUCKET) continue;
      undeclaredScopes.push({ bucket, identities: [...identities].sort() });
    }
    for (const scope of undeclaredScopes) {
      runFailures += 1;
      problems.push(
        `${scope.bucket}: ${scope.identities.join(', ')} in ${identityScopes.path} ` +
        `${scope.identities.length === 1 ? 'is' : 'are'} scoped to this bucket, but ${BUCKETS_FILE} does not ` +
        `declare it, so nothing creates it. Every call those identities make against it fails at runtime. ` +
        `Declare the bucket in buckets.yaml or drop the grant.`);
    }
    log(`${identityScopes.scopes.size} bucket(s) referenced by identities in ${identityScopes.path}`);
  } else if (IDENTITIES_FILE_PINNED) {
    runFailures += 1;
    problems.push(
      `ARGUS_S3_IDENTITIES_FILE points at ${identityScopes.path}, which ${identityScopes.reason}. ` +
      `Without it a bucket an identity is scoped to but buckets.yaml does not declare cannot be reported.`);
  } else {
    warn(`${identityScopes.path} ${identityScopes.reason}, so buckets that identities are scoped to but ` +
         `${BUCKETS_FILE} does not declare CANNOT be detected on this run. Mount the gateway's s3.json ` +
         `read-only at ${identityScopes.path}, or point ARGUS_S3_IDENTITIES_FILE at it.`);
  }

  await waitForS3();

  const rows = [];
  for (const spec of specs) {
    rows.push(await applyBucket(spec, problems));
  }

  const worm = await probeWorm();
  log(`WORM enforcement: ${worm.verdict.toUpperCase()} -- ${worm.detail}`);

  let actual = null;
  let actualError = null;
  try {
    const out = await s3.send(new ListBucketsCommand({}));
    actual = (out.Buckets || []).map((b) => ({
      name: b.Name,
      createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null
    })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    actualError = `${errName(err)}: ${err && err.message}`;
    warn(`could not enumerate buckets for the drift record: ${actualError}`);
  }

  if (actual) {
    const undeclared = actual.map((b) => b.name)
      .filter((n) => !declaredNames.has(n) && n !== PROBE_BUCKET);
    if (undeclared.length) {
      warn(`${undeclared.length} bucket(s) exist but are not declared in ${BUCKETS_FILE}: ${undeclared.join(', ')}`);
    }
  }

  const report = {
    at: new Date().toISOString(),
    endpoint: ENDPOINT,
    profile: PROFILE,
    source: BUCKETS_FILE,
    devOverrides: PROFILE === 'dev' ? { mode: DEV_LOCK_MODE, days: DEV_LOCK_DAYS } : null,
    buckets: rows,
    actual,
    actualError,
    probeBucket: PROBE_BUCKET,
    identityScopes: {
      path: identityScopes.path,
      checked: identityScopes.checked,
      reason: identityScopes.reason,
      undeclared: undeclaredScopes
    },
    problems,
    worm
  };
  writeState('storage-init.json', report);
  writeState('worm-verdict.json', worm);

  const counts = { created: 0, verified: 0, repaired: 0, failed: 0 };
  for (const r of rows) counts[r.status] += 1;

  console.log('');
  const pad = rows.length ? Math.max(...rows.map((r) => r.name.length)) : 0;
  const statusPad = rows.length ? Math.max(...rows.map((r) => r.status.length)) : 0;
  for (const r of rows) {
    const bits = [];
    if (r.versioning) bits.push('versioned');
    if (r.lock) bits.push(`lock ${describeLock({ enabled: true, mode: r.lock.mode, days: r.lock.days, years: r.lock.years })}${r.lock.declared && r.lock.declared !== `${r.lock.mode}/${r.lock.days}d` ? ` (declared ${r.lock.declared})` : ''}`);
    if (r.lifecycleDays) bits.push(`expire ${r.lifecycleDays}d`);
    console.log(`  ${r.status.padEnd(statusPad)}  ${r.name.padEnd(pad)}  ${bits.join(', ') || '-'}`);
  }
  console.log('');
  console.log(`  ${counts.created} created, ${counts.verified} verified, ${counts.repaired} repaired, ` +
              `${counts.failed} failed`);
  console.log('');

  let failureCount = counts.failed + runFailures;
  if (problems.length && failureCount === 0) failureCount = problems.length;

  if (problems.length) {
    console.error(`  ${problems.length} problem(s) this script could not resolve:\n`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error('');
    return failureCount;
  }

  log('object storage ready');
  return 0;
}

async function main() {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `The run did not finish within ARGUS_S3_RUN_DEADLINE_MS (${RUN_DEADLINE_MS} ms). Something after the ` +
      `readiness check stopped answering; the console is gated on this container, so it exits rather than ` +
      `waiting for ever.`)), RUN_DEADLINE_MS);
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

main()
  .then((failures) => {
    try { s3.destroy(); } catch (err) { void err; }
    process.exitCode = Math.min(failures, 125);
  })
  .catch((err) => {
    console.error('');
    console.error('[storage-init] FAILED:', err && err.message ? err.message : err);
    console.error('');
    try { s3.destroy(); } catch (e) { void e; }
    process.exit(1);
  });
