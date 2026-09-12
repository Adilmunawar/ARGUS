'use strict';

const { purgePrefix } = require('../teardown');

function future(seconds) {
  return new Date(Date.now() + seconds * 1000);
}

module.exports = {
  id: 'object-retention',
  title: 'Object retention, GOVERNANCE bypass and COMPLIANCE immutability',
  matrixRows: [5],
  async run(ctx) {
    const {
      PutObjectCommand, PutObjectRetentionCommand, GetObjectRetentionCommand,
      DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.worm;
    const retainSeconds = ctx.config.wormRetainSeconds;

    ctx.note('GOVERNANCE fixtures are removed with x-amz-bypass-governance-retention; the single COMPLIANCE canary is undeletable until its retain-until passes and is swept by the next run');
    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    async function governanceObject(s3, key) {
      const response = await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: 'argus-parity-governance',
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: future(retainSeconds),
      }));
      return response.VersionId || null;
    }

    await ctx.compare('put-object-with-governance-retention', async (s3) => {
      const key = ctx.key('governance-write');
      await governanceObject(s3, key);
      const retention = await s3.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key }));
      return { mode: (retention.Retention || {}).Mode || null };
    }, { expected: { outcome: 'ok', detail: { mode: 'GOVERNANCE' } } });

    await ctx.compare('delete-under-governance-without-bypass', async (s3) => {
      const key = ctx.key('governance-delete');
      const versionId = await governanceObject(s3, key);
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
      return {};
    }, { expected: { outcome: 'AccessDenied', status: 403 } });

    await ctx.compare('delete-under-governance-with-bypass', async (s3) => {
      const key = ctx.key('governance-bypass');
      const versionId = await governanceObject(s3, key);
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket, Key: key, VersionId: versionId, BypassGovernanceRetention: true,
      }));
      return {};
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('delete-objects-plural-honours-lock', async (s3) => {
      const key = ctx.key('governance-plural');
      const versionId = await governanceObject(s3, key);
      const response = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: [{ Key: key, VersionId: versionId }], Quiet: false },
      }));
      return {
        deleted: (response.Deleted || []).length,
        errors: (response.Errors || []).map((entry) => entry.Code).sort(),
      };
    }, { expected: { outcome: 'ok', detail: { deleted: 0, errors: ['AccessDenied'] } } });

    await ctx.compare('extend-retention-allowed', async (s3) => {
      const key = ctx.key('governance-extend');
      await governanceObject(s3, key);
      await s3.send(new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: future(retainSeconds * 2) },
      }));
      return {};
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('shorten-governance-without-bypass', async (s3) => {
      const key = ctx.key('governance-shorten');
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: 'argus-parity-governance',
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: future(retainSeconds * 4),
      }));
      await s3.send(new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: future(retainSeconds) },
      }));
      return {};
    }, { expected: { outcome: 'AccessDenied', status: 403 } });

    await ctx.compare('shorten-governance-with-bypass', async (s3) => {
      const key = ctx.key('governance-shorten-bypass');
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: 'argus-parity-governance',
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: future(retainSeconds * 4),
      }));
      await s3.send(new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: key,
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: future(retainSeconds) },
        BypassGovernanceRetention: true,
      }));
      return {};
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('retain-until-date-in-the-past', async (s3) => {
      const key = ctx.key('past-retention');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'argus-parity' }));
      try {
        await s3.send(new PutObjectRetentionCommand({
          Bucket: bucket,
          Key: key,
          Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() - 86400000) },
        }));
      } catch (err) {
        err.parityDetail = { pacificTimeQuirk: /\bPST\b|\bPDT\b/.test(err.message || '') };
        throw err;
      }
      return {};
    }, { expected: { outcome: 'InvalidArgument' } });

    await ctx.compare('lock-mode-without-retain-until', async (s3) => {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: ctx.key('mode-only'), Body: 'argus-parity', ObjectLockMode: 'GOVERNANCE',
      }));
      return {};
    }, { expected: { outcome: 'InvalidArgument' } });

    await ctx.compare('unknown-lock-mode-on-write', async (s3) => {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: ctx.key('unknown-mode'),
        Body: 'argus-parity',
        ObjectLockMode: 'STRICT',
        ObjectLockRetainUntilDate: future(retainSeconds),
      }));
      return {};
    }, { expected: { outcome: 'InvalidArgument' } });

    const complianceKey = ctx.key('compliance-canary');
    await ctx.compare('compliance-write', async (s3) => {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: complianceKey,
        Body: 'argus-parity-compliance',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: future(retainSeconds),
      }));
      const retention = await s3.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: complianceKey }));
      return { mode: (retention.Retention || {}).Mode || null };
    }, { expected: { outcome: 'ok', detail: { mode: 'COMPLIANCE' } } });

    await ctx.compare('compliance-shorten-denied-even-with-bypass', async (s3) => {
      await s3.send(new PutObjectRetentionCommand({
        Bucket: bucket,
        Key: complianceKey,
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: future(1) },
        BypassGovernanceRetention: true,
      }));
      return {};
    }, { expected: { outcome: 'AccessDenied', status: 403 } });

    await ctx.compare('compliance-version-delete-denied-even-with-bypass', async (s3) => {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: complianceKey }));
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket, Key: complianceKey, VersionId: head.VersionId, BypassGovernanceRetention: true,
      }));
      return {};
    }, { expected: { outcome: 'AccessDenied', status: 403 } });

    ctx.note(`compliance canary ${complianceKey} in ${bucket} is undeletable for ${retainSeconds}s by design`);
  },
};
