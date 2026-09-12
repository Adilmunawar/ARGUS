'use strict';

const { purgePrefix } = require('../teardown');
const { payload } = require('../body');

module.exports = {
  id: 'presigned-urls',
  title: 'Presigned URL SigV4 query authentication',
  matrixRows: [3],
  async run(ctx) {
    const { PutObjectCommand, HeadObjectCommand } = ctx.sdk;
    const { presign, tamper, request, errorCodeFromBody } = ctx.presign;
    const bucket = ctx.buckets.main;
    const body = payload(512, 'argus-parity-presigned-');
    const timeoutMs = ctx.config.timeoutMs;

    ctx.note('SigV4 query presigning is computed in-harness with node:crypto because @aws-sdk/s3-request-presigner is not present in platform/console/server/node_modules');
    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    function signer(side, options) {
      return presign({
        endpoint: side.endpoint,
        region: side.region,
        credentials: side.credentials('standard'),
        bucket,
        ...options,
      });
    }

    await ctx.compare('presigned-get-valid', async (s3, side) => {
      const key = ctx.key('presigned-get');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      const signed = signer(side, { method: 'GET', key, expiresIn: 900 });
      const response = await request(signed.url, { timeoutMs });
      return { status: response.status, matches: response.body === body.toString('utf8') };
    }, { expected: { outcome: 'ok', detail: { status: 200, matches: true } } });

    await ctx.compare('presigned-get-tampered-signature', async (s3, side) => {
      const key = ctx.key('presigned-get');
      const signed = signer(side, { method: 'GET', key, expiresIn: 900 });
      const response = await request(tamper(signed.url), { timeoutMs });
      return { status: response.status, code: errorCodeFromBody(response.body) };
    }, { expected: { outcome: 'ok', detail: { status: 403 } } });

    await ctx.compare('presigned-get-expired', async (s3, side) => {
      const key = ctx.key('presigned-get');
      const signed = signer(side, {
        method: 'GET', key, expiresIn: 60, now: new Date(Date.now() - 3600000),
      });
      const response = await request(signed.url, { timeoutMs });
      return { status: response.status, code: errorCodeFromBody(response.body) };
    }, { expected: { outcome: 'ok', detail: { status: 403 } } });

    await ctx.compare('presigned-put-valid', async (s3, side) => {
      const key = ctx.key('presigned-put');
      const signed = signer(side, { method: 'PUT', key, expiresIn: 900 });
      const upload = await request(signed.url, { method: 'PUT', body, timeoutMs });
      let length = null;
      if (upload.status < 300) {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        length = head.ContentLength;
      }
      return { status: upload.status, length };
    }, { expected: { outcome: 'ok', detail: { status: 200, length: body.length } } });

    await ctx.compare('presigned-put-content-type-mismatch', async (s3, side) => {
      const key = ctx.key('presigned-put-typed');
      const signed = signer(side, {
        method: 'PUT', key, expiresIn: 900, signedHeaders: { 'content-type': 'text/plain' },
      });
      const upload = await request(signed.url, {
        method: 'PUT', body, timeoutMs, headers: { 'content-type': 'application/json' },
      });
      return { status: upload.status, code: errorCodeFromBody(upload.body) };
    }, { expected: { outcome: 'ok', detail: { status: 403 } } });
  },
};
