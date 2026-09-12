'use strict';

const crypto = require('node:crypto');
const { purgePrefix } = require('../teardown');
const { text, md5Base64 } = require('../body');

module.exports = {
  id: 'encryption',
  title: 'Server-side encryption and bucket encryption configuration',
  matrixRows: [14],
  async run(ctx) {
    const {
      PutObjectCommand, GetObjectCommand, HeadObjectCommand,
      PutBucketEncryptionCommand, GetBucketEncryptionCommand, DeleteBucketEncryptionCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const customerKey = crypto.createHash('sha256').update('argus-parity-sse-c').digest();
    const wrongKey = crypto.createHash('sha256').update('argus-parity-sse-c-wrong').digest();
    const sseC = (key) => ({
      SSECustomerAlgorithm: 'AES256',
      SSECustomerKey: key.toString('base64'),
      SSECustomerKeyMD5: md5Base64(key),
    });

    ctx.note('Put/Get/DeleteBucketEncryption are gated on global Admin by SeaweedFS 3.97, so those cases use the admin identity');
    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.compare('sse-s3-roundtrip', async (s3) => {
      const key = ctx.key('sse-s3');
      const put = await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: 'argus-parity-sse-s3', ServerSideEncryption: 'AES256',
      }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const body = await text(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
      return {
        putEncryption: put.ServerSideEncryption || null,
        headEncryption: head.ServerSideEncryption || null,
        body,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { putEncryption: 'AES256', headEncryption: 'AES256', body: 'argus-parity-sse-s3' },
      },
    });

    await ctx.compare('sse-c-roundtrip', async (s3) => {
      const key = ctx.key('sse-c');
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: 'argus-parity-sse-c', ...sseC(customerKey),
      }));
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: key, ...sseC(customerKey),
      }));
      return { algorithm: response.SSECustomerAlgorithm || null, body: await text(response) };
    }, { expected: { outcome: 'ok', detail: { algorithm: 'AES256', body: 'argus-parity-sse-c' } } });

    await ctx.compare('sse-c-read-with-wrong-key', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: ctx.key('sse-c'), ...sseC(wrongKey),
      }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { status: 403 } });

    await ctx.compare('sse-c-read-without-key', async (s3) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ctx.key('sse-c') }));
      response.Body.destroy();
      return { status: response.$metadata.httpStatusCode };
    }, { expected: { status: 400 } });

    await ctx.compare('sse-kms-requested', async (s3) => {
      const key = ctx.key('sse-kms');
      const put = await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: 'argus-parity-sse-kms', ServerSideEncryption: 'aws:kms',
      }));
      return { encryption: put.ServerSideEncryption || null, keyIdPresent: Boolean(put.SSEKMSKeyId) };
    });

    const admin = { identity: 'admin' };
    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeleteBucketEncryptionCommand({ Bucket: bucket })).catch(() => null),
      { identity: 'admin' },
    ));

    await ctx.compare('bucket-encryption-roundtrip', async (s3) => {
      await s3.send(new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
      }));
      const read = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
      const rules = (read.ServerSideEncryptionConfiguration || {}).Rules || [];
      const applied = (rules[0] || {}).ApplyServerSideEncryptionByDefault || {};
      return { rules: rules.length, algorithm: applied.SSEAlgorithm || null };
    }, { ...admin, expected: { outcome: 'ok', detail: { rules: 1, algorithm: 'AES256' } } });

    await ctx.compare('bucket-encryption-delete', async (s3) => {
      await s3.send(new DeleteBucketEncryptionCommand({ Bucket: bucket }));
      await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
      return {};
    }, { ...admin, expected: { outcome: 'ServerSideEncryptionConfigurationNotFoundError' } });
  },
};
