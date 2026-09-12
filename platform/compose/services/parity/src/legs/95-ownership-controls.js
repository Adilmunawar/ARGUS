'use strict';

module.exports = {
  id: 'ownership-controls',
  title: 'Bucket ownership controls',
  matrixRows: [20],
  async run(ctx) {
    const {
      PutBucketOwnershipControlsCommand,
      GetBucketOwnershipControlsCommand,
      DeleteBucketOwnershipControlsCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const admin = { identity: 'admin' };

    ctx.note('SeaweedFS 3.97 gates the Put and Delete forms on global Admin; the Get form is not gated');
    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeleteBucketOwnershipControlsCommand({ Bucket: bucket })).catch(() => null),
      { identity: 'admin' },
    ));

    await ctx.compare('ownership-controls-put', async (s3) => {
      await s3.send(new PutBucketOwnershipControlsCommand({
        Bucket: bucket,
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      }));
      return {};
    }, { ...admin, expected: { outcome: 'ok' } });

    await ctx.compare('ownership-controls-get', async (s3) => {
      const read = await s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }));
      const rules = (read.OwnershipControls || {}).Rules || [];
      return { rules: rules.length, ownership: rules.length ? rules[0].ObjectOwnership : null };
    }, { expected: { outcome: 'ok', detail: { rules: 1, ownership: 'BucketOwnerEnforced' } } });

    await ctx.compare('ownership-controls-delete', async (s3) => {
      await s3.send(new DeleteBucketOwnershipControlsCommand({ Bucket: bucket }));
      await s3.send(new GetBucketOwnershipControlsCommand({ Bucket: bucket }));
      return {};
    }, { ...admin, expected: { outcome: 'OwnershipControlsNotFoundError' } });
  },
};
