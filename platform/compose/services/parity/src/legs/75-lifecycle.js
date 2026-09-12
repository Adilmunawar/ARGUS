'use strict';

module.exports = {
  id: 'lifecycle',
  title: 'Bucket lifecycle configuration',
  matrixRows: [16],
  async run(ctx) {
    const {
      PutBucketLifecycleConfigurationCommand,
      GetBucketLifecycleConfigurationCommand,
      DeleteBucketLifecycleCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;

    ctx.note('SeaweedFS 3.97 implements expiration rules only; transition rules are the recorded gap');
    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket })).catch(() => null),
    ));

    await ctx.compare('lifecycle-expiration-rule', async (s3) => {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [{
            ID: 'argus-parity-expire',
            Status: 'Enabled',
            Filter: { Prefix: `${ctx.prefix}/` },
            Expiration: { Days: 30 },
          }],
        },
      }));
      const read = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      const rule = (read.Rules || [])[0] || {};
      return {
        rules: (read.Rules || []).length,
        id: rule.ID || null,
        status: rule.Status || null,
        expirationDays: rule.Expiration ? rule.Expiration.Days : null,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { rules: 1, id: 'argus-parity-expire', status: 'Enabled', expirationDays: 30 },
      },
    });

    await ctx.compare('lifecycle-transition-rule', async (s3) => {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [{
            ID: 'argus-parity-transition',
            Status: 'Enabled',
            Filter: { Prefix: `${ctx.prefix}/` },
            Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
          }],
        },
      }));
      const read = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      const rule = (read.Rules || [])[0] || {};
      return { transitions: (rule.Transitions || []).length };
    });

    await ctx.compare('lifecycle-delete', async (s3) => {
      await s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
      await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
      return {};
    }, { expected: { outcome: 'NoSuchLifecycleConfiguration' } });
  },
};
