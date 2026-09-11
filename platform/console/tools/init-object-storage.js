/*
 * Create and verify the Argus object store, from the committed bucket set.
 *
 *   node /app/tools/init-object-storage.js
 *
 * Runs once per `docker compose up`, before the console starts, and is the only
 * thing in the stack allowed to hold the S3 admin identity.
 *
 * Four rules.
 *
 * 1. platform/gitops/storage/buckets.yaml is the SINGLE SOURCE. Bucket names,
 *    versioning, object lock and lifecycle are read from it, never restated
 *    here. A table in this file would be a second source, and two sources of
 *    truth do not stay equal.
 *
 * 2. "It already exists, so skip it" is a bug, not an optimisation. Object Lock
 *    CANNOT be enabled on a bucket after creation -- S3 and SeaweedFS both
 *    require it at CreateBucket time. So a bucket created once without lock
 *    stays unlocked forever, while every subsequent boot reports success.
 *    On an existing bucket this VERIFIES the declared configuration
 *    and exits non-zero when it does not match.
 *
 * 3. Configured is not enforced. GetObjectLockConfiguration returning 200 only
 *    proves the server stored a setting. ADR-0020's entire backup story rests
 *    on immutability actually holding, so this deletes a real object version
 *    under real retention and records what happened. The verdict is
 *    three-valued -- enforced / not-enforced / unknown -- because treating an
 *    unexpected error as proof of enforcement is the same class of mistake as
 *    trusting the 200.
 *
 * 4. Never write the probe into a bucket that holds anything. A canary per boot
 *    under COMPLIANCE retention is an unbounded pile of undeletable junk, and
 *    argus-backups is the last place to put that. The probe gets its own
 *    bucket with the minimum retention, so the evidence ages out by itself.
 */
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

/* ------------------------------------------------------------------ config --- */

const ENDPOINT    = process.env.ARGUS_S3_ENDPOINT || 'http://seaweed-s3:8333';
const REGION      = process.env.ARGUS_S3_REGION || 'us-east-1';
const BUCKETS_FILE = process.env.ARGUS_BUCKETS_FILE || '/config/buckets.yaml';
const STATE_DIR   = process.env.ARGUS_STATE_DIR || '/state';
const PROFILE     = (process.env.ARGUS_PROFILE || 'dev').toLowerCase();
const PROBE_BUCKET = process.env.ARGUS_WORM_PROBE_BUCKET || 'argus-worm-probe';
const READY_TIMEOUT_MS = Number(process.env.ARGUS_S3_READY_TIMEOUT_MS || 120000);

/* Dev overrides exist so a developer is not locked out of their own test
   uploads for five weeks, with the only escape being to destroy the volume.
   They are refused outside dev: a 1-day GOVERNANCE lock on a real backup bucket
   is indistinguishable from no lock at all to anyone reading a dashboard. */
const DEV_LOCK_DAYS = Number(process.env.ARGUS_OBJECT_LOCK_DAYS || 1);
const DEV_LOCK_MODE = (process.env.ARGUS_DEV_LOCK_MODE || 'GOVERNANCE').toUpperCase();

const log = (...a) => console.log('[storage-init]', ...a);
const warn = (...a) => console.warn('[storage-init] !', ...a);

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  /* SeaweedFS serves path-style only. The SDK defaults to virtual-host style,
     which resolves bucket.seaweed-s3 -- a name no DNS in this network answers,
     failing as ENOTFOUND rather than as anything about S3. */
  forcePathStyle: true,
  maxAttempts: 3
});

/* ------------------------------------------------------------------- utils --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errName(err) {
  return (err && (err.name || err.Code || (err.$metadata && err.$metadata.httpStatusCode))) || 'Error';
}

function isNotFound(err) {
  const s = err && err.$metadata && err.$metadata.httpStatusCode;
  return s === 404 || /NotFound|NoSuchBucket|NoSuchObjectLockConfiguration|NoSuchLifecycleConfiguration/i.test(errName(err));
}

/* --------------------------------------------------------------- readiness --- */

/**
 * Wait until the gateway answers a SIGNED request.
 *
 * The container health check cannot express this: there is no unauthenticated
 * S3 path that means "ready", and once identities are loaded every anonymous
 * probe is a 403 -- which is indistinguishable from a gateway that has not read
 * its config yet. A signed ListBuckets is the only thing that proves the
 * gateway is up, has loaded s3.json, and accepts our credential.
 */
async function waitForS3() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
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
      /* 403 here is not "not ready" -- it is a wrong or unknown access key, and
         no amount of waiting fixes it. Fail immediately with the real reason
         rather than after a two-minute timeout that reads like a slow start. */
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (status === 403 || /SignatureDoesNotMatch|InvalidAccessKeyId/i.test(errName(err))) {
        throw new Error(
          `The S3 gateway rejected our credential (${errName(err)}). AWS_ACCESS_KEY_ID is ` +
          `"${process.env.AWS_ACCESS_KEY_ID}". Check that seaweed-config wrote s3.json with this identity ` +
          `and that ARGUS_S3_ADMIN_SECRET in .env matches it.`);
      }
      if (attempt === 1 || attempt % 5 === 0) {
        log(`waiting for ${ENDPOINT} (${errName(err)})`);
      }
      await sleep(2000);
    }
  }
  throw new Error(
    `The S3 gateway at ${ENDPOINT} did not accept a signed request within ${READY_TIMEOUT_MS} ms. ` +
    `Last error: ${errName(last)} ${last && last.message}`);
}

/* ------------------------------------------------------------- bucket spec --- */

/**
 * Read the declared bucket set and resolve what this profile should apply.
 *
 * Returns the DECLARED values alongside the EFFECTIVE ones, so the log can say
 * "35 days declared, 1 applied (dev)" rather than printing 1 and letting the
 * reader assume that is what production does.
 */
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

    let lock = declaredLock;
    if (declaredLock && PROFILE === 'dev') {
      lock = { mode: DEV_LOCK_MODE, days: DEV_LOCK_DAYS };
    } else if (declaredLock && (DEV_LOCK_DAYS !== declaredLock.days || DEV_LOCK_MODE !== declaredLock.mode)) {
      /* Outside dev the overrides are ignored, loudly. Silently honouring them
         would let a production stack come up with a 1-day GOVERNANCE lock on
         argus-backups because a stale variable was in the environment. */
      warn(`ARGUS_PROFILE=${PROFILE}: ignoring ARGUS_OBJECT_LOCK_* overrides for ${b.name}; ` +
           `applying the declared ${declaredLock.mode}/${declaredLock.days}d.`);
    }

    return {
      name: b.name,
      /* Object Lock REQUIRES versioning, and SeaweedFS -- like S3 -- turns it on
         implicitly with the lock. Making that explicit here means the desired
         state we verify against is the state we asked for. */
      versioning: !!b.versioning || !!declaredLock,
      declaredLock,
      lock,
      lifecycleDays: b.lifecycle && Number(b.lifecycle.expireDays) ? Number(b.lifecycle.expireDays) : null,
      owner: b.owner || null
    };
  });
}

/* --------------------------------------------------------------- apply ------ */

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
    if (!d) return { enabled: !!(out.ObjectLockConfiguration && out.ObjectLockConfiguration.ObjectLockEnabled), mode: null, days: null };
    return { enabled: true, mode: d.Mode || null, days: d.Days === undefined ? null : Number(d.Days) };
  } catch (err) {
    if (isNotFound(err)) return { enabled: false, mode: null, days: null };
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

/**
 * Bring one bucket to its declared state, or report why it cannot be.
 *
 * Returns a row for the summary. Throws only on something that makes the whole
 * run untrustworthy; a per-bucket mismatch is collected so the operator sees
 * every problem at once rather than fixing them one boot at a time.
 */
async function applyBucket(spec, problems) {
  const existed = await bucketExists(spec.name);

  if (!existed) {
    await s3.send(new CreateBucketCommand({
      Bucket: spec.name,
      /* The one setting that can never be added later. */
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

  let lockState = { enabled: false, mode: null, days: null };
  if (spec.lock) {
    if (!existed) {
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: spec.name,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: spec.lock.mode, Days: spec.lock.days } }
        }
      }));
    }
    lockState = await getLockConfig(spec.name);

    /* This is the check that makes rule 2 real. A bucket created before object
       lock was declared -- or created by hand, or by an older revision of this
       file -- cannot be fixed in place, and saying so is the only useful thing
       to do. */
    if (!lockState.enabled) {
      problems.push(
        `${spec.name}: buckets.yaml declares Object Lock ${spec.declaredLock.mode}/${spec.declaredLock.days}d, ` +
        `but the bucket exists WITHOUT it. Object Lock cannot be enabled after creation. ` +
        `The bucket must be recreated (destroying its contents) or the declaration removed.`);
    } else if (spec.lock.mode && lockState.mode && lockState.mode !== spec.lock.mode) {
      problems.push(
        `${spec.name}: default retention mode is ${lockState.mode}, expected ${spec.lock.mode}.`);
    }
  } else {
    lockState = await getLockConfig(spec.name);
    if (lockState.enabled) {
      /* Locked when nothing asked for it. Not fatal -- it is the safe direction
         -- but it will surprise whoever tries to clean the bucket up. */
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
      /* SeaweedFS's lifecycle coverage is the weakest part of its S3 surface.
         A bucket without expiry grows; it does not lose data. Record it and
         keep going rather than failing the boot over a cleanup policy. */
      problems.push(`${spec.name}: lifecycle expiry of ${spec.lifecycleDays} days was refused (${errName(err)}). ` +
                    `Objects will accumulate until something else deletes them.`);
    }
  }

  const versioning = await getVersioning(spec.name);
  if (spec.versioning && !versioning) {
    problems.push(`${spec.name}: versioning was requested but the bucket reports it disabled.`);
  }

  return {
    name: spec.name,
    created: !existed,
    versioning,
    lock: lockState.enabled
      ? { mode: lockState.mode, days: lockState.days,
          declared: spec.declaredLock ? `${spec.declaredLock.mode}/${spec.declaredLock.days}d` : null }
      : null,
    lifecycleDays: spec.lifecycleDays
  };
}

/* ---------------------------------------------------------------- the probe --- */

/**
 * Prove that retention is ENFORCED, not merely configured.
 *
 * Deleting an object in a versioned bucket WITHOUT a version id creates a
 * delete marker and returns 204 whether or not the object is locked -- that is
 * correct S3 behaviour and proves nothing. The only meaningful test deletes the
 * specific VERSION, which retention must refuse.
 *
 * Three outcomes, all of them reported honestly:
 *
 *   enforced      the versioned delete was refused. What ADR-0020 assumes.
 *   not-enforced  it succeeded. The lock is decoration; the console must show
 *                 a grey badge, never a green shield, and this needs an ADR.
 *   unknown       something else happened. Not evidence either way.
 */
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
      /* COMPLIANCE, because that is the mode the backup story depends on, and
         one day, because that is the minimum and the junk has to age out. */
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

/* ----------------------------------------------------------------- report --- */

function writeState(name, value) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(value, null, 2) + '\n');
    return true;
  } catch (err) {
    /* The console reads this to render the storage screen. If it cannot be
       written the screen must say "not determined", which is what a missing
       file already means -- so warn and continue rather than failing the boot
       over a report. */
    warn(`could not write ${path.join(STATE_DIR, name)}: ${err.message}`);
    return false;
  }
}

async function main() {
  log(`endpoint ${ENDPOINT}, region ${REGION}, profile ${PROFILE}`);

  const specs = readBucketSet();
  log(`${specs.length} bucket(s) declared in ${BUCKETS_FILE}`);
  if (PROFILE === 'dev') {
    const locked = specs.filter((s) => s.declaredLock);
    if (locked.length) {
      log(`dev profile: collapsing Object Lock on ${locked.length} bucket(s) to ${DEV_LOCK_MODE}/${DEV_LOCK_DAYS}d ` +
          `(declared: ${locked.map((s) => `${s.name}=${s.declaredLock.mode}/${s.declaredLock.days}d`).join(', ')})`);
    }
  }

  await waitForS3();

  const problems = [];
  const rows = [];
  for (const spec of specs) {
    rows.push(await applyBucket(spec, problems));
  }

  const worm = await probeWorm();
  log(`WORM enforcement: ${worm.verdict.toUpperCase()} -- ${worm.detail}`);

  /* Record what ACTUALLY exists, not just what was declared.
   *
   * This is the only place in the stack that can. ListBuckets on SeaweedFS
   * 3.97 requires a GLOBAL Write action, and giving that to the console would
   * mean write access to every bucket including any added later -- so the
   * console has per-bucket grants and cannot enumerate. This process is the
   * one holding admin, for the few seconds it takes.
   *
   * The difference between this list and buckets.yaml is drift: a bucket
   * somebody made by hand, or one deleted out from under the declaration.
   * Without it the console can only ever show what the file claims, which
   * makes the file unfalsifiable. */
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
    const declaredNames = new Set(specs.map((s) => s.name));
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
    problems,
    worm
  };
  writeState('storage-init.json', report);
  writeState('worm-verdict.json', worm);

  console.log('');
  const pad = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const bits = [];
    if (r.versioning) bits.push('versioned');
    if (r.lock) bits.push(`lock ${r.lock.mode}/${r.lock.days}d${r.lock.declared && r.lock.declared !== `${r.lock.mode}/${r.lock.days}d` ? ` (declared ${r.lock.declared})` : ''}`);
    if (r.lifecycleDays) bits.push(`expire ${r.lifecycleDays}d`);
    console.log(`  ${r.created ? '+' : ' '} ${r.name.padEnd(pad)}  ${bits.join(', ') || '-'}`);
  }
  console.log('');

  if (problems.length) {
    console.error(`  ${problems.length} problem(s) that this script cannot fix:\n`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error('');
    /* Non-zero, so service_completed_successfully holds the console back. A
       dashboard that renders a green shield over an unlocked backup bucket is
       worse than a stack that refuses to start. */
    process.exit(1);
  }

  log('object storage ready');
}

main().catch((err) => {
  console.error('');
  console.error('[storage-init] FAILED:', err && err.message ? err.message : err);
  console.error('');
  process.exit(1);
});
