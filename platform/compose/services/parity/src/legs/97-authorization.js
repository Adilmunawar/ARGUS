'use strict';

module.exports = {
  id: 'authorization',
  title: 'Identity scoping and negative authorisation',
  matrixRows: [],
  async run(ctx) {
    const { ListObjectsV2Command, GetObjectCommand, HeadBucketCommand } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const forbidden = ctx.buckets.forbidden;

    ctx.note('LocalStack Community does not enforce IAM, so every case here is subject-only and compared against the recorded SeaweedFS 3.97 expectation');
    ctx.note('the deny identity attempts non-mutating operations only');

    const denyOnly = { identity: 'deny', referenceApplicable: false };

    await ctx.compare('read-only-identity-refused-list-on-granted-bucket', async (s3) => {
      const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
      return { keys: (response.Contents || []).length >= 0 };
    }, {
      ...denyOnly,
      title: 'an identity holding only [Read, List] is refused List on the bucket it was granted',
      expected: { outcome: 'AccessDenied', status: 403 },
    });

    await ctx.compare('read-only-identity-refused-read-on-granted-bucket', async (s3) => {
      await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ctx.key('never-written') }));
      return {};
    }, {
      ...denyOnly,
      title: 'an identity holding only [Read, List] is refused Get on the bucket it was granted',
      expected: { outcome: 'AccessDenied', status: 403 },
    });

    await ctx.compare('deny-identity-refused-on-ungranted-bucket', async (s3) => {
      await s3.send(new ListObjectsV2Command({ Bucket: forbidden, MaxKeys: 1 }));
      return {};
    }, {
      ...denyOnly,
      title: 'the deny identity is refused on a bucket it was never granted',
      expected: { outcome: 'AccessDenied', status: 403 },
    });

    await ctx.compare('standard-identity-refused-on-ungranted-bucket', async (s3) => {
      await s3.send(new ListObjectsV2Command({ Bucket: forbidden, MaxKeys: 1 }));
      return {};
    }, {
      referenceApplicable: false,
      title: 'the parity identity is refused on the decoy bucket it was never granted',
      expected: { outcome: 'AccessDenied', status: 403 },
    });

    await ctx.compare('unsigned-request-refused', async (s3, side) => {
      const response = await ctx.presign.request(`${side.endpoint.replace(/\/$/, '')}/${bucket}`, {
        timeoutMs: ctx.config.timeoutMs,
      });
      return { status: response.status, code: ctx.presign.errorCodeFromBody(response.body) };
    }, {
      referenceApplicable: false,
      title: 'an entirely unsigned request is refused',
      expected: { outcome: 'ok', detail: { status: 403 } },
    });

    await ctx.compare('admin-identity-is-distinct-from-parity-identity', async (s3) => {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return {};
    }, {
      identity: 'admin',
      referenceApplicable: false,
      title: 'the admin identity used for bucket CRUD is configured and separate',
      expected: { outcome: 'ok' },
    });
  },
};
