'use strict';

module.exports = {
  id: 'absent-by-design',
  title: 'Routes recorded as absent on SeaweedFS 3.97',
  matrixRows: [22, 23, 24, 25, 26, 27, 28, 29, 31, 32],
  async run(ctx) {
    const {
      GetObjectAttributesCommand, PutObjectCommand,
      GetBucketNotificationConfigurationCommand, PutBucketNotificationConfigurationCommand,
      GetBucketReplicationCommand, GetBucketWebsiteCommand, GetBucketLoggingCommand,
      RestoreObjectCommand, GetBucketAccelerateConfigurationCommand,
      ListBucketInventoryConfigurationsCommand, ListBucketAnalyticsConfigurationsCommand,
      ListBucketMetricsConfigurationsCommand, ListBucketIntelligentTieringConfigurationsCommand,
      GetBucketRequestPaymentCommand, PutBucketRequestPaymentCommand,
      GetBucketPolicyStatusCommand,
    } = ctx.sdk;
    const bucket = ctx.buckets.main;
    const key = ctx.key('absent-probe');

    ctx.note('SelectObjectContent is excluded: LocalStack 4.14 implements it but returns InternalError on nested JSON, so it cannot serve as a reference');
    ctx.note('an absent route fails loudly at the call site, which is the safe failure; a route that answers wrongly is the dangerous one');

    await ctx.fixture('absent-probe-object', (s3) => s3.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: 'argus-parity',
    })), { referenceApplicable: false, tolerant: true });

    await ctx.expectAbsent('get-object-attributes', (s3) => s3.send(new GetObjectAttributesCommand({
      Bucket: bucket, Key: key, ObjectAttributes: ['ETag', 'ObjectSize'],
    })), { title: 'GetObjectAttributes (matrix row 22)' });

    await ctx.expectAbsent('get-bucket-notification-configuration', (s3) =>
      s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket })),
    { title: 'GetBucketNotificationConfiguration (matrix row 23)' });

    await ctx.expectAbsent('put-bucket-notification-configuration', (s3) =>
      s3.send(new PutBucketNotificationConfigurationCommand({
        Bucket: bucket, NotificationConfiguration: {},
      })),
    { title: 'PutBucketNotificationConfiguration (matrix row 23)' });

    await ctx.expectAbsent('get-bucket-replication', (s3) =>
      s3.send(new GetBucketReplicationCommand({ Bucket: bucket })),
    { title: 'GetBucketReplication (matrix row 24)' });

    await ctx.expectAbsent('get-bucket-website', (s3) =>
      s3.send(new GetBucketWebsiteCommand({ Bucket: bucket })),
    { title: 'GetBucketWebsite (matrix row 25)' });

    await ctx.expectAbsent('get-bucket-logging', (s3) =>
      s3.send(new GetBucketLoggingCommand({ Bucket: bucket })),
    { title: 'GetBucketLogging (matrix row 26)' });

    await ctx.expectAbsent('restore-object', (s3) =>
      s3.send(new RestoreObjectCommand({
        Bucket: bucket, Key: key, RestoreRequest: { Days: 1 },
      })),
    { title: 'RestoreObject (matrix row 27)' });

    await ctx.expectAbsent('get-bucket-accelerate-configuration', (s3) =>
      s3.send(new GetBucketAccelerateConfigurationCommand({ Bucket: bucket })),
    { title: 'GetBucketAccelerateConfiguration (matrix row 28)' });

    await ctx.expectAbsent('list-bucket-inventory-configurations', (s3) =>
      s3.send(new ListBucketInventoryConfigurationsCommand({ Bucket: bucket })),
    { title: 'ListBucketInventoryConfigurations (matrix row 29)' });

    await ctx.expectAbsent('list-bucket-analytics-configurations', (s3) =>
      s3.send(new ListBucketAnalyticsConfigurationsCommand({ Bucket: bucket })),
    { title: 'ListBucketAnalyticsConfigurations (matrix row 29)' });

    await ctx.expectAbsent('list-bucket-metrics-configurations', (s3) =>
      s3.send(new ListBucketMetricsConfigurationsCommand({ Bucket: bucket })),
    { title: 'ListBucketMetricsConfigurations (matrix row 29)' });

    await ctx.expectAbsent('list-bucket-intelligent-tiering-configurations', (s3) =>
      s3.send(new ListBucketIntelligentTieringConfigurationsCommand({ Bucket: bucket })),
    { title: 'ListBucketIntelligentTieringConfigurations (matrix row 29)' });

    await ctx.expectAbsent('put-bucket-request-payment', (s3) =>
      s3.send(new PutBucketRequestPaymentCommand({
        Bucket: bucket, RequestPaymentConfiguration: { Payer: 'BucketOwner' },
      })),
    { title: 'PutBucketRequestPayment (matrix row 31, GET is registered but PUT is not)' });

    await ctx.expectAbsent('get-bucket-policy-status', (s3) =>
      s3.send(new GetBucketPolicyStatusCommand({ Bucket: bucket })),
    { title: 'GetBucketPolicyStatus (matrix row 32)' });

    await ctx.compare('get-bucket-request-payment', async (s3) => {
      const read = await s3.send(new GetBucketRequestPaymentCommand({ Bucket: bucket }));
      return { payer: read.Payer || null };
    }, {
      title: 'GetBucketRequestPayment (matrix row 31, registered on both sides)',
      expected: { outcome: 'ok' },
    });
  },
};
