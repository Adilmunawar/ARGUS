'use strict';

const { purgePrefix } = require('../teardown');
const { text } = require('../body');

module.exports = {
  id: 'versioning',
  title: 'Bucket versioning, object versions and delete markers',
  matrixRows: [7],
  async run(ctx) {
    const {
      GetBucketVersioningCommand, PutObjectCommand, GetObjectCommand,
      DeleteObjectCommand, ListObjectVersionsCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.worm;

    ctx.note(`versions are exercised on ${bucket}, which is versioned because object lock requires it`);
    ctx.cleanup(() => ctx.forEachSide((s3) => purgePrefix(s3, ctx.sdk, bucket, ctx.prefix).catch(() => null)));

    await ctx.compare('get-bucket-versioning', async (s3) => {
      const response = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      return { status: response.Status || null };
    }, { expected: { outcome: 'ok', detail: { status: 'Enabled' } } });

    await ctx.compare('two-versions-of-one-key', async (s3) => {
      const key = ctx.key('versioned');
      const first = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'first' }));
      const second = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'second' }));
      const current = await text(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
      const older = first.VersionId
        ? await text(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: first.VersionId })))
        : null;
      return {
        versionIdsIssued: Boolean(first.VersionId && second.VersionId),
        versionIdsDiffer: first.VersionId !== second.VersionId,
        current,
        older,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { versionIdsIssued: true, versionIdsDiffer: true, current: 'second', older: 'first' },
      },
    });

    await ctx.compare('list-object-versions', async (s3) => {
      const response = await s3.send(new ListObjectVersionsCommand({
        Bucket: bucket, Prefix: ctx.key('versioned'),
      }));
      return {
        versions: (response.Versions || []).length,
        latestFlagged: (response.Versions || []).filter((entry) => entry.IsLatest).length,
      };
    }, { expected: { outcome: 'ok', detail: { versions: 2, latestFlagged: 1 } } });

    await ctx.compare('delete-creates-delete-marker', async (s3) => {
      const key = ctx.key('marker');
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'marked' }));
      const deleted = await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
      let readOutcome = 'ok';
      try {
        await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        readOutcome = err.Code || err.name;
      }
      return {
        deleteMarkerFlag: Boolean(deleted.DeleteMarker),
        deleteMarkers: (listed.DeleteMarkers || []).length,
        readAfterDelete: readOutcome,
      };
    }, {
      expected: {
        outcome: 'ok',
        detail: { deleteMarkerFlag: true, deleteMarkers: 1, readAfterDelete: 'NoSuchKey' },
      },
    });

    await ctx.compare('deleting-delete-marker-restores-object', async (s3) => {
      const key = ctx.key('marker');
      const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
      const marker = (listed.DeleteMarkers || [])[0];
      if (!marker) return { restored: false, reason: 'no delete marker listed' };
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: marker.VersionId }));
      const restored = await text(await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
      return { restored: restored === 'marked' };
    }, { expected: { outcome: 'ok', detail: { restored: true } } });

    await ctx.compare('delete-specific-version', async (s3) => {
      const key = ctx.key('version-delete');
      const first = await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'one' }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'two' }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: first.VersionId }));
      const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }));
      return {
        versions: (listed.Versions || []).length,
        deleteMarkers: (listed.DeleteMarkers || []).length,
      };
    }, { expected: { outcome: 'ok', detail: { versions: 1, deleteMarkers: 0 } } });
  },
};
