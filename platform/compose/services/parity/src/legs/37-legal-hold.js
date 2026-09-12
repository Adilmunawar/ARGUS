'use strict';

const { purgePrefix } = require('../teardown');

module.exports = {
  id: 'legal-hold',
  title: 'Object legal hold',
  matrixRows: [6],
  async run(ctx) {
    const {
      PutObjectCommand, PutObjectLegalHoldCommand, GetObjectLegalHoldCommand,
      DeleteObjectCommand, HeadObjectCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.worm;

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.compare('put-and-get-legal-hold', async (s3) => {
      const key = ctx.key('hold-roundtrip');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'argus-parity' }));
      const put = await s3.send(new PutObjectLegalHoldCommand({
        Bucket: bucket, Key: key, LegalHold: { Status: 'ON' },
      }));
      const read = await s3.send(new GetObjectLegalHoldCommand({ Bucket: bucket, Key: key }));
      return {
        putStatus: put.$metadata.httpStatusCode,
        status: (read.LegalHold || {}).Status || null,
      };
    }, { expected: { outcome: 'ok', detail: { putStatus: 200, status: 'ON' } } });

    await ctx.compare('delete-under-legal-hold', async (s3) => {
      const key = ctx.key('hold-roundtrip');
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: head.VersionId }));
      return {};
    }, { expected: { outcome: 'AccessDenied', status: 403 } });

    await ctx.compare('delete-after-legal-hold-released', async (s3) => {
      const key = ctx.key('hold-roundtrip');
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      await s3.send(new PutObjectLegalHoldCommand({
        Bucket: bucket, Key: key, VersionId: head.VersionId, LegalHold: { Status: 'OFF' },
      }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: head.VersionId }));
      return {};
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('legal-hold-status-is-case-sensitive', async (s3) => {
      const key = ctx.key('hold-casing');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'argus-parity' }));
      await s3.send(new PutObjectLegalHoldCommand({
        Bucket: bucket, Key: key, LegalHold: { Status: 'on' },
      }));
      return {};
    }, { expected: { outcome: 'MalformedXML' } });

    await ctx.compare('get-legal-hold-when-never-set', async (s3) => {
      const key = ctx.key('hold-absent');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'argus-parity' }));
      const read = await s3.send(new GetObjectLegalHoldCommand({ Bucket: bucket, Key: key }));
      return { status: (read.LegalHold || {}).Status || null };
    });
  },
};
