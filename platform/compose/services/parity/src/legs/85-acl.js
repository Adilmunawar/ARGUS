'use strict';

const { purgePrefix } = require('../teardown');

module.exports = {
  id: 'acl',
  title: 'Bucket and object ACLs',
  matrixRows: [18],
  async run(ctx) {
    const {
      PutObjectCommand, GetBucketAclCommand, PutBucketAclCommand,
      GetObjectAclCommand, PutObjectAclCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const key = ctx.key('acl-object');

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.compare('get-bucket-acl', async (s3) => {
      const read = await s3.send(new GetBucketAclCommand({ Bucket: bucket }));
      return {
        ownerPresent: Boolean(read.Owner && read.Owner.ID),
        grants: (read.Grants || []).length,
        permissions: (read.Grants || []).map((grant) => grant.Permission).sort(),
      };
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('put-bucket-acl-private', async (s3) => {
      await s3.send(new PutBucketAclCommand({ Bucket: bucket, ACL: 'private' }));
      const read = await s3.send(new GetBucketAclCommand({ Bucket: bucket }));
      return { grants: (read.Grants || []).length };
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('object-acl-roundtrip', async (s3) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'argus-parity' }));
      await s3.send(new PutObjectAclCommand({ Bucket: bucket, Key: key, ACL: 'private' }));
      const read = await s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: key }));
      return {
        ownerPresent: Boolean(read.Owner && read.Owner.ID),
        permissions: (read.Grants || []).map((grant) => grant.Permission).sort(),
      };
    }, { expected: { outcome: 'ok' } });

    await ctx.compare('object-acl-public-read', async (s3) => {
      await s3.send(new PutObjectAclCommand({ Bucket: bucket, Key: key, ACL: 'public-read' }));
      const read = await s3.send(new GetObjectAclCommand({ Bucket: bucket, Key: key }));
      const publicGrant = (read.Grants || []).some((grant) =>
        grant.Grantee && grant.Grantee.URI && grant.Grantee.URI.includes('AllUsers'));
      return { publicGrant };
    });

    await ctx.compare('object-acl-unknown-canned-value', async (s3) => {
      await s3.send(new PutObjectAclCommand({ Bucket: bucket, Key: key, ACL: 'not-a-canned-acl' }));
      return {};
    }, { expected: { status: 400 } });
  },
};
