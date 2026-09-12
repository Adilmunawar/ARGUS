'use strict';

const { purgePrefix } = require('../teardown');

const KEYS = ['a.txt', 'b.txt', 'c.txt', 'nested/one.txt', 'nested/two.txt', 'nested/deep/three.txt'];
const AWKWARD = 'awkward key +%/ü.txt';

module.exports = {
  id: 'listing',
  title: 'List pagination, delimiters and encoding',
  matrixRows: [11, 12],
  async run(ctx) {
    const { PutObjectCommand, ListObjectsV2Command, ListObjectsCommand } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const root = `${ctx.key('tree')}/`;

    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.fixture('listing-tree', async (s3) => {
      for (const name of [...KEYS, AWKWARD]) {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${root}${name}`, Body: name }));
      }
      return {};
    });

    await ctx.compare('list-v2-full-prefix', async (s3) => {
      const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: root }));
      return {
        keys: (response.Contents || []).length,
        truncated: Boolean(response.IsTruncated),
        keyCount: response.KeyCount === undefined ? null : response.KeyCount,
      };
    }, { expected: { outcome: 'ok', detail: { keys: KEYS.length + 1, truncated: false } } });

    await ctx.compare('list-v2-delimiter-common-prefixes', async (s3) => {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: root, Delimiter: '/',
      }));
      return {
        keys: (response.Contents || []).map((entry) => entry.Key.slice(root.length)).sort(),
        commonPrefixes: (response.CommonPrefixes || []).map((entry) => entry.Prefix.slice(root.length)).sort(),
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { keys: [AWKWARD, 'a.txt', 'b.txt', 'c.txt'].sort(), commonPrefixes: ['nested/'] },
      },
    });

    await ctx.compare('list-v2-max-keys-and-continuation', async (s3) => {
      const first = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: root, MaxKeys: 2 }));
      const second = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: root, MaxKeys: 2, ContinuationToken: first.NextContinuationToken,
      }));
      return {
        firstPage: (first.Contents || []).length,
        firstTruncated: Boolean(first.IsTruncated),
        tokenIssued: Boolean(first.NextContinuationToken),
        secondPage: (second.Contents || []).length,
        pagesDisjoint: !(second.Contents || []).some((entry) =>
          (first.Contents || []).some((other) => other.Key === entry.Key)),
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { firstPage: 2, firstTruncated: true, tokenIssued: true, secondPage: 2, pagesDisjoint: true },
      },
    });

    await ctx.compare('list-v2-start-after', async (s3) => {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: root, StartAfter: `${root}b.txt`,
      }));
      return { keys: (response.Contents || []).map((entry) => entry.Key.slice(root.length)).sort() };
    }, {
      expected: {
        outcome: 'ok',
        detail: { keys: ['c.txt', 'nested/deep/three.txt', 'nested/one.txt', 'nested/two.txt'] },
      },
    });

    await ctx.compare('list-v1-marker', async (s3) => {
      const first = await s3.send(new ListObjectsCommand({ Bucket: bucket, Prefix: root, MaxKeys: 2 }));
      const second = await s3.send(new ListObjectsCommand({
        Bucket: bucket, Prefix: root, MaxKeys: 2,
        Marker: first.NextMarker || (first.Contents || []).slice(-1).map((entry) => entry.Key)[0],
      }));
      return {
        firstPage: (first.Contents || []).length,
        firstTruncated: Boolean(first.IsTruncated),
        nextMarkerIssued: Boolean(first.NextMarker),
        secondPage: (second.Contents || []).length,
      };
    }, { expected: { outcome: 'ok', detail: { firstPage: 2, firstTruncated: true, secondPage: 2 } } });

    await ctx.compare('list-v2-url-encoding', async (s3) => {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: root, Delimiter: '/', EncodingType: 'url',
      }));
      const awkward = (response.Contents || []).map((entry) => entry.Key).find((key) => key.includes('awkward'));
      return {
        encodingTypeEchoed: response.EncodingType || null,
        delimiterEncoded: response.Delimiter || null,
        awkwardKeyEncoded: awkward ? awkward.includes('%20') || awkward.includes('+') : null,
      };
    }, { expected: { outcome: 'ok', detail: { encodingTypeEchoed: 'url' } } });

    await ctx.compare('list-v2-empty-prefix', async (s3) => {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: `${root}no-such-prefix/`,
      }));
      return { keys: (response.Contents || []).length, truncated: Boolean(response.IsTruncated) };
    }, { expected: { outcome: 'ok', detail: { keys: 0, truncated: false } } });
  },
};
