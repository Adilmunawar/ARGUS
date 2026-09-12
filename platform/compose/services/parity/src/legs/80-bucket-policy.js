'use strict';

module.exports = {
  id: 'bucket-policy',
  title: 'Bucket policy',
  matrixRows: [17],
  async run(ctx) {
    const { PutBucketPolicyCommand, GetBucketPolicyCommand, DeleteBucketPolicyCommand } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'ArgusParityDenyDeleteBucket',
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:DeleteBucket'],
        Resource: [`arn:aws:s3:::${bucket}`],
      }],
    };

    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket })).catch(() => null),
    ));

    await ctx.compare('bucket-policy-roundtrip', async (s3) => {
      await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
      const read = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      const parsed = JSON.parse(read.Policy);
      const statement = (parsed.Statement || [])[0] || {};
      return {
        statements: (parsed.Statement || []).length,
        sid: statement.Sid || null,
        effect: statement.Effect || null,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { statements: 1, sid: 'ArgusParityDenyDeleteBucket', effect: 'Deny' },
      },
    });

    await ctx.compare('bucket-policy-malformed-json', async (s3) => {
      await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: '{not json' }));
      return {};
    }, { expected: { status: 400 } });

    await ctx.compare('bucket-policy-delete', async (s3) => {
      await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
      await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      return {};
    }, { expected: { outcome: 'NoSuchBucketPolicy' } });
  },
};
