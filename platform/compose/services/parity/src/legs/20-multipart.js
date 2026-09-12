'use strict';

const { purgePrefix } = require('../teardown');
const { payload, etagShape, text } = require('../body');

const PART_SIZE = 5 * 1024 * 1024;

module.exports = {
  id: 'multipart',
  title: 'Multipart upload',
  matrixRows: [2],
  async run(ctx) {
    const {
      CreateMultipartUploadCommand, UploadPartCommand, UploadPartCopyCommand,
      CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListPartsCommand,
      ListMultipartUploadsCommand, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const first = payload(PART_SIZE, 'argus-parity-part-one-');
    const second = payload(1024, 'argus-parity-part-two-');

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    for (const checksums of ['when_required', 'when_supported']) {
      const key = ctx.key(`multipart-${checksums}`);
      await ctx.compare(`multipart-roundtrip-${checksums}`, async (s3) => {
        const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
        const parts = [];
        for (const [index, part] of [first, second].entries()) {
          const uploaded = await s3.send(new UploadPartCommand({
            Bucket: bucket, Key: key, UploadId: created.UploadId, PartNumber: index + 1, Body: part,
          }));
          parts.push({ ETag: uploaded.ETag, PartNumber: index + 1 });
        }
        const listed = await s3.send(new ListPartsCommand({
          Bucket: bucket, Key: key, UploadId: created.UploadId,
        }));
        const completed = await s3.send(new CompleteMultipartUploadCommand({
          Bucket: bucket, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: parts },
        }));
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          parts: (listed.Parts || []).length,
          etag: etagShape(completed.ETag),
          length: head.ContentLength,
        };
      }, {
        checksums,
        title: `Multipart upload with request checksums ${checksums}`,
        expected: { outcome: 'ok', detail: { parts: 2, etag: 'multipart', length: PART_SIZE + second.length } },
      });
    }

    await ctx.compare('upload-part-copy', async (s3) => {
      const source = ctx.key('copy-source');
      const key = ctx.key('copy-target');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: source, Body: first }));
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      const copied = await s3.send(new UploadPartCopyCommand({
        Bucket: bucket, Key: key, UploadId: created.UploadId, PartNumber: 1,
        CopySource: `/${bucket}/${source}`,
      }));
      const completed = await s3.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: key, UploadId: created.UploadId,
        MultipartUpload: { Parts: [{ ETag: (copied.CopyPartResult || {}).ETag, PartNumber: 1 }] },
      }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { etag: etagShape(completed.ETag), length: head.ContentLength };
    }, { expected: { outcome: 'ok', detail: { length: PART_SIZE } } });

    await ctx.compare('list-and-abort-multipart', async (s3) => {
      const key = ctx.key('aborted');
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      const listed = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }));
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId }));
      const after = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }));
      return {
        visibleBeforeAbort: (listed.Uploads || []).length,
        visibleAfterAbort: (after.Uploads || []).length,
      };
    }, { expected: { outcome: 'ok', detail: { visibleBeforeAbort: 1, visibleAfterAbort: 0 } } });

    await ctx.compare('list-parts-after-abort', async (s3) => {
      const key = ctx.key('parts-after-abort');
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId }));
      await s3.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: created.UploadId }));
      return {};
    }, { expected: { outcome: 'NoSuchUpload', status: 404 } });

    await ctx.compare('complete-multipart-no-parts', async (s3) => {
      const key = ctx.key('complete-empty');
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      try {
        await s3.send(new CompleteMultipartUploadCommand({
          Bucket: bucket, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: [] },
        }));
      } finally {
        await s3.send(new AbortMultipartUploadCommand({
          Bucket: bucket, Key: key, UploadId: created.UploadId,
        })).catch(() => null);
      }
      return {};
    }, { expected: { status: 400 } });

    await ctx.compare('multipart-object-readable', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: ctx.key('multipart-when_required'), Range: 'bytes=0-15',
      }));
      const received = await text(response);
      return { length: received.length, matches: received === first.toString('utf8').slice(0, 16) };
    }, { expected: { outcome: 'ok', detail: { length: 16, matches: true } } });
  },
};
