'use strict';

const { purgePrefix } = require('../teardown');

module.exports = {
  id: 'post-object',
  title: 'Browser POST upload with a signed policy',
  matrixRows: [21],
  async run(ctx) {
    const { HeadObjectCommand } = ctx.sdk;
    const { postPolicy, multipartForm, request, errorCodeFromBody } = ctx.presign;
    const bucket = ctx.buckets.main;
    const timeoutMs = ctx.config.timeoutMs;

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    async function post(side, key, options) {
      const settings = options || {};
      const signed = postPolicy({
        region: side.region,
        credentials: side.credentials('standard'),
        bucket,
        key,
        expiresInSeconds: settings.expiresInSeconds || 900,
        now: settings.now,
      });
      const fields = { ...signed.fields, ...(settings.override || {}) };
      const form = multipartForm(fields, {
        filename: 'argus-parity.txt',
        contentType: 'text/plain',
        body: settings.body || 'argus-parity-post-object',
      });
      return request(`${side.endpoint.replace(/\/$/, '')}/${bucket}`, {
        method: 'POST',
        timeoutMs,
        headers: {
          'content-type': `multipart/form-data; boundary=${form.boundary}`,
          'content-length': String(form.body.length),
        },
        body: form.body,
      });
    }

    await ctx.compare('post-object-valid-policy', async (s3, side) => {
      const key = ctx.key('post-valid');
      const response = await post(side, key);
      let length = null;
      if (response.status < 300) {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).catch(() => null);
        length = head ? head.ContentLength : null;
      }
      return { status: response.status, code: errorCodeFromBody(response.body), length };
    });

    await ctx.compare('post-object-expired-policy', async (s3, side) => {
      const response = await post(side, ctx.key('post-expired'), {
        expiresInSeconds: 60, now: new Date(Date.now() - 3600000),
      });
      return { status: response.status, code: errorCodeFromBody(response.body) };
    }, { expected: { outcome: 'ok', detail: { status: 403 } } });

    await ctx.compare('post-object-tampered-signature', async (s3, side) => {
      const response = await post(side, ctx.key('post-tampered'), {
        override: { 'x-amz-signature': '0'.repeat(64) },
      });
      return { status: response.status, code: errorCodeFromBody(response.body) };
    }, { expected: { outcome: 'ok', detail: { status: 403 } } });
  },
};
