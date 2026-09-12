'use strict';

const { destroyBucket } = require('../teardown');

module.exports = {
  id: 'bucket-crud',
  title: 'Bucket CRUD',
  matrixRows: [1],
  async run(ctx) {
    const { CreateBucketCommand, HeadBucketCommand, DeleteBucketCommand, ListBucketsCommand,
      GetBucketLocationCommand, PutObjectCommand } = ctx.sdk;
    const bucket = `${ctx.buckets.crudPrefix}-${ctx.config.bucketNonce}`;
    const absent = `${bucket}-absent`;
    const options = { identity: 'admin' };

    ctx.note(`per-run bucket ${bucket}; global Admin is required by SeaweedFS PutBucketHandler`);
    ctx.cleanup(() => ctx.forEachSide(
      (s3) => destroyBucket(s3, ctx.sdk, bucket).catch(() => null),
      { identity: 'admin' },
    ));

    await ctx.compare('create-bucket', async (s3) => {
      const response = await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      return { locationPresent: Boolean(response.Location) };
    }, { ...options, expected: { outcome: 'ok' } });

    await ctx.compare('head-bucket-present', async (s3) => {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return {};
    }, { ...options, expected: { outcome: 'ok' } });

    await ctx.compare('head-bucket-absent', async (s3) => {
      await s3.send(new HeadBucketCommand({ Bucket: absent }));
      return {};
    }, { ...options, expected: { status: 404 } });

    await ctx.compare('get-bucket-location', async (s3) => {
      const response = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
      return { constraint: response.LocationConstraint === undefined ? null : response.LocationConstraint };
    }, { ...options, expected: { outcome: 'ok' } });

    await ctx.compare('list-buckets-includes-created', async (s3) => {
      const response = await s3.send(new ListBucketsCommand({}));
      return { present: (response.Buckets || []).some((entry) => entry.Name === bucket) };
    }, { ...options, expected: { outcome: 'ok', detail: { present: true } } });

    await ctx.compare('delete-bucket-not-empty', async (s3) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'occupied', Body: 'occupied' }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      return {};
    }, { ...options, expected: { outcome: 'BucketNotEmpty' } });

    await ctx.compare('delete-bucket-absent', async (s3) => {
      await s3.send(new DeleteBucketCommand({ Bucket: absent }));
      return {};
    }, { ...options, expected: { status: 404 } });
  },
};
