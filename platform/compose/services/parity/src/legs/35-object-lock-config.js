'use strict';

const { destroyBucket } = require('../teardown');

module.exports = {
  id: 'object-lock-configuration',
  title: 'Object lock configuration',
  matrixRows: [4],
  async run(ctx) {
    const {
      GetObjectLockConfigurationCommand, PutObjectLockConfigurationCommand,
      CreateBucketCommand, PutBucketVersioningCommand,
    } = ctx.sdk;
    const worm = ctx.buckets.worm;

    await ctx.compare('get-object-lock-configuration', async (s3) => {
      const response = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: worm }));
      const configuration = response.ObjectLockConfiguration || {};
      const defaultRetention = (configuration.Rule || {}).DefaultRetention || {};
      return {
        enabled: configuration.ObjectLockEnabled || null,
        defaultRetention: defaultRetention.Mode || null,
      };
    }, { expected: { outcome: 'ok', detail: { enabled: 'Enabled' } } });

    const unversioned = `${ctx.buckets.crudPrefix}-nolock-${ctx.config.bucketNonce}`;
    const versioned = `${ctx.buckets.crudPrefix}-lock-${ctx.config.bucketNonce}`;
    const admin = { identity: 'admin' };

    if (!ctx.subject.has('admin')) {
      ctx.note('the negative configuration cases need a bucket the harness owns, which requires the admin identity');
    }

    ctx.cleanup(() => ctx.forEachSide(async (s3) => {
      await destroyBucket(s3, ctx.sdk, unversioned).catch(() => null);
      await destroyBucket(s3, ctx.sdk, versioned).catch(() => null);
    }, { identity: 'admin' }));

    await ctx.compare('lock-configuration-on-unversioned-bucket', async (s3) => {
      await s3.send(new CreateBucketCommand({ Bucket: unversioned })).catch(() => null);
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: unversioned,
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
      }));
      return {};
    }, { ...admin, expected: { outcome: 'InvalidBucketState' } });

    await ctx.compare('lock-configuration-without-rule', async (s3) => {
      await s3.send(new CreateBucketCommand({ Bucket: versioned })).catch(() => null);
      await s3.send(new PutBucketVersioningCommand({
        Bucket: versioned, VersioningConfiguration: { Status: 'Enabled' },
      }));
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
      }));
      const response = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: versioned }));
      return {
        enabled: (response.ObjectLockConfiguration || {}).ObjectLockEnabled || null,
        rulePresent: Boolean((response.ObjectLockConfiguration || {}).Rule),
      };
    }, { ...admin, expected: { outcome: 'ok', detail: { enabled: 'Enabled', rulePresent: false } } });

    await ctx.compare('lock-configuration-days-and-years', async (s3) => {
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1, Years: 1 } },
        },
      }));
      return {};
    }, { ...admin, expected: { outcome: 'MalformedXML' } });

    await ctx.compare('lock-configuration-neither-days-nor-years', async (s3) => {
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE' } },
        },
      }));
      return {};
    }, { ...admin, expected: { outcome: 'MalformedXML' } });

    await ctx.compare('lock-configuration-unknown-mode', async (s3) => {
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'STRICT', Days: 1 } },
        },
      }));
      return {};
    }, { ...admin, expected: { outcome: 'MalformedXML' } });

    await ctx.compare('default-retention-inherited-by-put-object', async (s3) => {
      const { PutObjectCommand, GetObjectRetentionCommand } = ctx.sdk;
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
        },
      }));
      const key = 'inherited-put-object';
      await s3.send(new PutObjectCommand({ Bucket: versioned, Key: key, Body: 'argus-parity' }));
      const retention = await s3.send(new GetObjectRetentionCommand({ Bucket: versioned, Key: key }));
      return { mode: (retention.Retention || {}).Mode || null };
    }, { ...admin, expected: { outcome: 'ok', detail: { mode: 'GOVERNANCE' } } });

    await ctx.compare('default-retention-inherited-by-copy-object', async (s3) => {
      const { PutObjectCommand, CopyObjectCommand, GetObjectRetentionCommand } = ctx.sdk;
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
        },
      }));
      const source = 'inherited-copy-source';
      const target = 'inherited-copy-target';
      await s3.send(new PutObjectCommand({ Bucket: versioned, Key: source, Body: 'argus-parity' }));
      await s3.send(new CopyObjectCommand({
        Bucket: versioned, Key: target, CopySource: `${versioned}/${source}`,
      }));
      const retention = await s3.send(new GetObjectRetentionCommand({ Bucket: versioned, Key: target }));
      return { mode: (retention.Retention || {}).Mode || null };
    }, { ...admin, expected: { outcome: 'ok', detail: { mode: 'GOVERNANCE' } } });

    await ctx.compare('default-retention-inherited-by-multipart', async (s3) => {
      const {
        CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
        GetObjectRetentionCommand,
      } = ctx.sdk;
      await s3.send(new PutObjectLockConfigurationCommand({
        Bucket: versioned,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
        },
      }));
      const key = 'inherited-multipart';
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: versioned, Key: key }));
      const part = await s3.send(new UploadPartCommand({
        Bucket: versioned, Key: key, UploadId: created.UploadId, PartNumber: 1,
        Body: Buffer.alloc(5 * 1024 * 1024, 'a'),
      }));
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: versioned, Key: key, UploadId: created.UploadId,
        MultipartUpload: { Parts: [{ ETag: part.ETag, PartNumber: 1 }] },
      }));
      const retention = await s3.send(new GetObjectRetentionCommand({ Bucket: versioned, Key: key }));
      return { mode: (retention.Retention || {}).Mode || null };
    }, { ...admin, expected: { outcome: 'ok', detail: { mode: 'GOVERNANCE' } } });
  },
};
