'use strict';

const { purgePrefix } = require('../teardown');

function normalise(tagSet) {
  return (tagSet || []).map((tag) => `${tag.Key}=${tag.Value}`).sort();
}

module.exports = {
  id: 'tagging',
  title: 'Object and bucket tagging',
  matrixRows: [8],
  async run(ctx) {
    const {
      PutObjectCommand, PutObjectTaggingCommand, GetObjectTaggingCommand, DeleteObjectTaggingCommand,
      PutBucketTaggingCommand, GetBucketTaggingCommand, DeleteBucketTaggingCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const key = ctx.key('tagged');

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));
    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeleteBucketTaggingCommand({ Bucket: bucket })).catch(() => null),
    ));

    await ctx.compare('object-tagging-roundtrip', async (s3) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'argus-parity' }));
      await s3.send(new PutObjectTaggingCommand({
        Bucket: bucket, Key: key,
        Tagging: { TagSet: [{ Key: 'owner', Value: 'argus' }, { Key: 'leg', Value: 'tagging' }] },
      }));
      const read = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      return { tags: normalise(read.TagSet) };
    }, { expected: { outcome: 'ok', detail: { tags: ['leg=tagging', 'owner=argus'] } } });

    await ctx.compare('object-tagging-delete', async (s3) => {
      await s3.send(new DeleteObjectTaggingCommand({ Bucket: bucket, Key: key }));
      const read = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      return { tags: normalise(read.TagSet) };
    }, { expected: { outcome: 'ok', detail: { tags: [] } } });

    await ctx.compare('object-tagging-on-put', async (s3) => {
      const tagged = ctx.key('tagged-on-put');
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: tagged, Body: 'argus-parity', Tagging: 'phase=write&owner=argus',
      }));
      const read = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: tagged }));
      return { tags: normalise(read.TagSet) };
    }, { expected: { outcome: 'ok', detail: { tags: ['owner=argus', 'phase=write'] } } });

    await ctx.compare('bucket-tagging-roundtrip', async (s3) => {
      await s3.send(new PutBucketTaggingCommand({
        Bucket: bucket, Tagging: { TagSet: [{ Key: 'purpose', Value: 'parity' }] },
      }));
      const read = await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      return { tags: normalise(read.TagSet) };
    }, { expected: { outcome: 'ok', detail: { tags: ['purpose=parity'] } } });

    await ctx.compare('bucket-tagging-delete', async (s3) => {
      await s3.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
      await s3.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      return {};
    }, { expected: { outcome: 'NoSuchTagSet' } });
  },
};
