'use strict';

module.exports = {
  id: 'cors',
  title: 'Bucket CORS configuration and preflight',
  matrixRows: [15],
  async run(ctx) {
    const { PutBucketCorsCommand, GetBucketCorsCommand, DeleteBucketCorsCommand } = ctx.sdk;
    const { request } = ctx.presign;
    const bucket = ctx.buckets.main;
    const origin = 'https://argus.invalid';

    ctx.cleanup(() => ctx.forEachSide(
      (s3) => s3.send(new DeleteBucketCorsCommand({ Bucket: bucket })).catch(() => null),
    ));

    await ctx.compare('bucket-cors-roundtrip', async (s3) => {
      await s3.send(new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [{
            AllowedOrigins: [origin],
            AllowedMethods: ['GET', 'PUT'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 300,
          }],
        },
      }));
      const read = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
      const rule = (read.CORSRules || [])[0] || {};
      return {
        rules: (read.CORSRules || []).length,
        origins: rule.AllowedOrigins || null,
        methods: (rule.AllowedMethods || []).slice().sort(),
        maxAge: rule.MaxAgeSeconds === undefined ? null : rule.MaxAgeSeconds,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { rules: 1, origins: [origin], methods: ['GET', 'PUT'], maxAge: 300 },
      },
    });

    await ctx.compare('cors-preflight-allowed-origin', async (s3, side) => {
      const response = await request(`${side.endpoint.replace(/\/$/, '')}/${bucket}/${ctx.key('cors-probe')}`, {
        method: 'OPTIONS',
        timeoutMs: ctx.config.timeoutMs,
        headers: { origin, 'access-control-request-method': 'GET' },
      });
      return {
        status: response.status,
        allowOrigin: response.headers['access-control-allow-origin'] || null,
        allowMethods: response.headers['access-control-allow-methods'] || null,
      };
    }, { expected: { outcome: 'ok', detail: { status: 200, allowOrigin: origin } } });

    await ctx.compare('cors-preflight-disallowed-origin', async (s3, side) => {
      const response = await request(`${side.endpoint.replace(/\/$/, '')}/${bucket}/${ctx.key('cors-probe')}`, {
        method: 'OPTIONS',
        timeoutMs: ctx.config.timeoutMs,
        headers: { origin: 'https://not-allowed.invalid', 'access-control-request-method': 'GET' },
      });
      return {
        status: response.status,
        allowOrigin: response.headers['access-control-allow-origin'] || null,
      };
    });

    await ctx.compare('bucket-cors-delete', async (s3) => {
      await s3.send(new DeleteBucketCorsCommand({ Bucket: bucket }));
      await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
      return {};
    }, { expected: { outcome: 'NoSuchCORSConfiguration' } });
  },
};
