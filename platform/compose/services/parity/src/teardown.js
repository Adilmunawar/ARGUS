'use strict';

async function abortUploads(client, sdk, bucket, prefix) {
  const { ListMultipartUploadsCommand, AbortMultipartUploadCommand } = sdk;
  let keyMarker;
  let uploadIdMarker;
  do {
    const page = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker,
    }));
    for (const upload of page.Uploads || []) {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId,
      })).catch(() => null);
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker || uploadIdMarker);
}

async function releaseAndDelete(client, sdk, bucket, entry) {
  const { PutObjectLegalHoldCommand, DeleteObjectCommand } = sdk;
  await client.send(new PutObjectLegalHoldCommand({
    Bucket: bucket, Key: entry.Key, VersionId: entry.VersionId, LegalHold: { Status: 'OFF' },
  })).catch(() => null);
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: bucket, Key: entry.Key, VersionId: entry.VersionId, BypassGovernanceRetention: true,
    }));
    return null;
  } catch (err) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.Key, VersionId: entry.VersionId }));
      return null;
    } catch (retryError) {
      return { key: entry.Key, versionId: entry.VersionId, reason: retryError.message };
    }
  }
}

async function purgePrefix(client, sdk, bucket, prefix) {
  const { ListObjectVersionsCommand, ListObjectsV2Command, DeleteObjectCommand } = sdk;
  const retained = [];
  await abortUploads(client, sdk, bucket, prefix).catch(() => null);

  let versioned = true;
  let keyMarker;
  let versionIdMarker;
  do {
    let page;
    try {
      page = await client.send(new ListObjectVersionsCommand({
        Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
      }));
    } catch (err) {
      versioned = false;
      break;
    }
    for (const entry of [...(page.Versions || []), ...(page.DeleteMarkers || [])]) {
      const failure = await releaseAndDelete(client, sdk, bucket, entry);
      if (failure) retained.push(failure);
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);

  if (!versioned) {
    let token;
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token,
      }));
      for (const entry of page.Contents || []) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.Key })).catch((err) => {
          retained.push({ key: entry.Key, versionId: null, reason: err.message });
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  return retained;
}

async function sweepExpiredResidue(client, sdk, bucket, rootPrefix) {
  const retained = await purgePrefix(client, sdk, bucket, rootPrefix);
  return retained;
}

async function destroyBucket(client, sdk, bucket) {
  const { DeleteBucketCommand } = sdk;
  await purgePrefix(client, sdk, bucket, '').catch(() => null);
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

module.exports = { purgePrefix, abortUploads, destroyBucket, sweepExpiredResidue };
