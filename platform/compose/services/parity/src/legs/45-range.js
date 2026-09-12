'use strict';

const crypto = require('node:crypto');
const { purgePrefix } = require('../teardown');
const { text, payload, md5Base64 } = require('../body');

const SIZE = 1024;

module.exports = {
  id: 'range-get',
  title: 'Range GET on plain and encrypted objects',
  matrixRows: [9],
  async run(ctx) {
    const { PutObjectCommand, GetObjectCommand } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const body = payload(SIZE, 'abcdefghij');
    const plain = ctx.key('range-plain');
    const encrypted = ctx.key('range-sse-c');
    const customerKey = crypto.createHash('sha256').update('argus-parity-sse-c').digest();
    const sseC = {
      SSECustomerAlgorithm: 'AES256',
      SSECustomerKey: customerKey.toString('base64'),
      SSECustomerKeyMD5: md5Base64(customerKey),
    };

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.fixture('range-object', (s3) => s3.send(new PutObjectCommand({
      Bucket: bucket, Key: plain, Body: body,
    })));

    await ctx.compare('range-leading-bytes', async (s3) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: plain, Range: 'bytes=0-9' }));
      const received = await text(response);
      return {
        status: response.$metadata.httpStatusCode,
        length: received.length,
        contentRange: response.ContentRange || null,
        matches: received === body.toString('utf8').slice(0, 10),
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { status: 206, length: 10, contentRange: `bytes 0-9/${SIZE}`, matches: true },
      },
    });

    await ctx.compare('range-open-ended', async (s3) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: plain, Range: 'bytes=1000-' }));
      const received = await text(response);
      return { status: response.$metadata.httpStatusCode, length: received.length };
    }, { expected: { outcome: 'ok', detail: { status: 206, length: 24 } } });

    await ctx.compare('range-suffix', async (s3) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: plain, Range: 'bytes=-16' }));
      const received = await text(response);
      return {
        status: response.$metadata.httpStatusCode,
        length: received.length,
        matches: received === body.toString('utf8').slice(-16),
      };
    }, { expected: { outcome: 'ok', detail: { status: 206, length: 16, matches: true } } });

    await ctx.compare('range-unsatisfiable', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: plain, Range: `bytes=${SIZE * 10}-${SIZE * 11}`,
      }));
      return { status: response.$metadata.httpStatusCode, length: (await text(response)).length };
    }, { expected: { outcome: 'InvalidRange', status: 416 } });

    await ctx.compare('range-multiple-specs', async (s3) => {
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: plain, Range: 'bytes=0-9,20-29',
      }));
      const received = await text(response);
      return {
        status: response.$metadata.httpStatusCode,
        multipart: (response.ContentType || '').startsWith('multipart/byteranges'),
        length: received.length,
      };
    });

    await ctx.compare('range-on-sse-c-object', async (s3) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: encrypted, Body: body, ...sseC }));
      const response = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: encrypted, Range: 'bytes=0-9', ...sseC,
      }));
      const received = await text(response);
      return {
        status: response.$metadata.httpStatusCode,
        length: received.length,
        contentRange: response.ContentRange || null,
        matches: received === body.toString('utf8').slice(0, 10),
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { status: 206, length: 10, contentRange: `bytes 0-9/${SIZE}`, matches: true },
      },
    });
  },
};
