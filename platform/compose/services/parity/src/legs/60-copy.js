'use strict';

const { purgePrefix } = require('../teardown');
const { text } = require('../body');

module.exports = {
  id: 'copy-object',
  title: 'CopyObject and its directives',
  matrixRows: [13],
  async run(ctx) {
    const {
      PutObjectCommand, CopyObjectCommand, HeadObjectCommand,
      GetObjectCommand, GetObjectTaggingCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const source = ctx.key('copy-source');

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.fixture('copy-source', (s3) => s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: source,
      Body: 'argus-parity-copy',
      ContentType: 'text/plain',
      Metadata: { origin: 'parity' },
      Tagging: 'phase=source',
    })));

    await ctx.compare('copy-object-same-bucket', async (s3) => {
      const target = ctx.key('copy-plain');
      const copied = await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: target, CopySource: `/${bucket}/${source}`,
      }));
      const body = await text(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: target })));
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: target }));
      return {
        resultEtagPresent: Boolean(copied.CopyObjectResult && copied.CopyObjectResult.ETag),
        body,
        contentType: head.ContentType || null,
        metadata: head.Metadata ? head.Metadata.origin || null : null,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { resultEtagPresent: true, body: 'argus-parity-copy', contentType: 'text/plain', metadata: 'parity' },
      },
    });

    await ctx.compare('copy-object-metadata-replace', async (s3) => {
      const target = ctx.key('copy-replaced');
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: target,
        CopySource: `/${bucket}/${source}`,
        MetadataDirective: 'REPLACE',
        ContentType: 'application/json',
        Metadata: { origin: 'replaced' },
      }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: target }));
      return {
        contentType: head.ContentType || null,
        metadata: head.Metadata ? head.Metadata.origin || null : null,
      };
    }, { expected: { outcome: 'ok', detail: { contentType: 'application/json', metadata: 'replaced' } } });

    await ctx.compare('copy-object-tagging-directive', async (s3) => {
      const copied = ctx.key('copy-tags-copied');
      const replaced = ctx.key('copy-tags-replaced');
      await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: copied, CopySource: `/${bucket}/${source}`, TaggingDirective: 'COPY',
      }));
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: replaced,
        CopySource: `/${bucket}/${source}`,
        TaggingDirective: 'REPLACE',
        Tagging: 'phase=target',
      }));
      const inherited = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: copied }));
      const overwritten = await s3.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: replaced }));
      return {
        inherited: (inherited.TagSet || []).map((tag) => `${tag.Key}=${tag.Value}`).sort(),
        overwritten: (overwritten.TagSet || []).map((tag) => `${tag.Key}=${tag.Value}`).sort(),
      };
    }, { expected: { outcome: 'ok', detail: { inherited: ['phase=source'], overwritten: ['phase=target'] } } });

    await ctx.compare('copy-object-onto-itself-without-replace', async (s3) => {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: source, CopySource: `/${bucket}/${source}`,
      }));
      return {};
    }, { expected: { outcome: 'InvalidRequest' } });

    await ctx.compare('copy-object-missing-source', async (s3) => {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: ctx.key('copy-missing'), CopySource: `/${bucket}/${ctx.key('never-written')}`,
      }));
      return {};
    }, { expected: { outcome: 'NoSuchKey', status: 404 } });
  },
};
