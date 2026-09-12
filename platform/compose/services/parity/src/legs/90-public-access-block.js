'use strict';

module.exports = {
  id: 'public-access-block',
  title: 'Public access block',
  matrixRows: [19],
  async run(ctx) {
    const {
      PutPublicAccessBlockCommand, GetPublicAccessBlockCommand, DeletePublicAccessBlockCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const admin = { identity: 'admin' };

    ctx.note('SeaweedFS 3.97 gates Put/Get/DeletePublicAccessBlock on global Admin');
    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket })).catch(() => null),
      { identity: 'admin' },
    ));

    await ctx.compare('public-access-block-roundtrip', async (s3) => {
      await s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }));
      const read = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
      const configuration = read.PublicAccessBlockConfiguration || {};
      return {
        blockPublicAcls: configuration.BlockPublicAcls === undefined ? null : configuration.BlockPublicAcls,
        ignorePublicAcls: configuration.IgnorePublicAcls === undefined ? null : configuration.IgnorePublicAcls,
        blockPublicPolicy: configuration.BlockPublicPolicy === undefined ? null : configuration.BlockPublicPolicy,
        restrictPublicBuckets: configuration.RestrictPublicBuckets === undefined ? null : configuration.RestrictPublicBuckets,
      };
    }, {
      ...admin,
      expected: {
        outcome: 'ok',
        detail: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    await ctx.compare('public-access-block-delete', async (s3) => {
      await s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket }));
      await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
      return {};
    }, { ...admin, expected: { outcome: 'NoSuchPublicAccessBlockConfiguration' } });
  },
};
