'use strict';

const { purgePrefix } = require('../teardown');

module.exports = {
  id: 'conditional-requests',
  title: 'Conditional reads and conditional writes',
  matrixRows: [10],
  async run(ctx) {
    const { PutObjectCommand, GetObjectCommand, HeadObjectCommand } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const key = ctx.key('conditional');

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.fixture('conditional-object', (s3) => s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: 'argus-parity-conditional',
    })));

    async function currentEtag(s3) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return head.ETag;
    }

    await ctx.compare('if-match-current-etag', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, IfMatch: await currentEtag(s3),
      }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { outcome: 'ok', detail: { status: 200 } } });

    await ctx.compare('if-match-stale-etag', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, IfMatch: '"00000000000000000000000000000000"',
      }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { outcome: 'PreconditionFailed', status: 412 } });

    await ctx.compare('if-none-match-current-etag', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, IfNoneMatch: await currentEtag(s3),
      }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { status: 304 } });

    await ctx.compare('if-modified-since-future', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, IfModifiedSince: new Date(Date.now() + 86400000),
      }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { status: 304 } });

    await ctx.compare('if-unmodified-since-past', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, IfUnmodifiedSince: new Date(Date.now() - 86400000),
      }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { outcome: 'PreconditionFailed', status: 412 } });

    await ctx.compare('conditional-write-if-none-match-star-on-new-key', async (s3) => {
      const fresh = ctx.key(`conditional-write-${Date.now()}`);
      const response = await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: fresh, Body: 'argus-parity', IfNoneMatch: '*',
      }));
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { outcome: 'ok', detail: { status: 200 } } });

    await ctx.compare('conditional-write-if-none-match-star-on-existing-key', async (s3) => {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: 'argus-parity-overwrite', IfNoneMatch: '*',
      }));
      return {};
    }, { expected: { outcome: 'PreconditionFailed', status: 412 } });
  },
};
