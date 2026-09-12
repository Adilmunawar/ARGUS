'use strict';

const { purgePrefix } = require('../teardown');
const { text, payload, etagShape } = require('../body');

const CHECKSUM_MODES = ['when_required', 'when_supported'];

module.exports = {
  id: 'object-basics',
  title: 'Object put, get, head, delete',
  matrixRows: [1],
  async run(ctx) {
    const { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const body = payload(2048, 'argus-parity-object-');

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    for (const checksums of CHECKSUM_MODES) {
      const key = ctx.key(`basic-${checksums}`);
      await ctx.compare(`put-object-${checksums}`, async (s3) => {
        const response = await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentType: 'application/octet-stream',
        }));
        return {
          etag: etagShape(response.ETag),
          checksumCrc32Present: Boolean(response.ChecksumCRC32),
        };
      }, {
        checksums,
        title: `PutObject with request checksums ${checksums}`,
        expected: { outcome: 'ok' },
      });

      await ctx.compare(`get-object-${checksums}`, async (s3) => {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const received = await text(response);
        return {
          length: received.length,
          matches: received === body.toString('utf8'),
          contentType: response.ContentType || null,
          etag: etagShape(response.ETag),
        };
      }, {
        checksums,
        title: `GetObject with response checksums ${checksums}`,
        expected: { outcome: 'ok', detail: { length: body.length, matches: true } },
      });
    }

    await ctx.compare('head-object-present', async (s3) => {
      const response = await s3.send(new HeadObjectCommand({
        Bucket: bucket, Key: ctx.key('basic-when_required'),
      }));
      return { length: response.ContentLength, etag: etagShape(response.ETag) };
    }, { expected: { outcome: 'ok', detail: { length: body.length } } });

    await ctx.compare('head-object-absent', async (s3) => {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: ctx.key('never-written') }));
      return {};
    }, { expected: { status: 404 } });

    await ctx.compare('get-object-absent', async (s3) => {
      await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ctx.key('never-written') }));
      return {};
    }, { expected: { outcome: 'NoSuchKey', status: 404 } });

    await ctx.compare('delete-object-absent-is-idempotent', async (s3) => {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: ctx.key('never-written') }));
      return {};
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('put-object-empty-body', async (s3) => {
      const key = ctx.key('empty');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.alloc(0) }));
      const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { length: response.ContentLength };
    }, { expected: { outcome: 'ok', detail: { length: 0 } } });
  },
};
