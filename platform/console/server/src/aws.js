/*
 * The AWS side of the estate.
 *
 * Three rules shape this file.
 *
 * 1. There are no credentials here and no parameter to pass them in. The SDK's
 *    own provider chain resolves them -- environment, shared config, SSO, or an
 *    instance role -- so this process can run on a short-lived role credential
 *    whose text it never sees, and nothing secret can be committed by accident.
 *
 * 2. Not being configured is a normal state, not an error. A laptop with no
 *    credentials, an expired SSO session and a denied IAM policy must each
 *    produce a panel that says what is wrong and what to do, never a stack
 *    trace and never a blank screen pretending the estate is empty. Every
 *    reader returns {ok, ...} rather than throwing.
 *
 * 3. Every call is bounded. An AWS API that hangs must not hang the dashboard,
 *    so each request carries an AbortSignal on a timer.
 *
 * The clients are required lazily so the server still starts, and still serves
 * host telemetry, when the SDK is not installed at all.
 */
'use strict';

const config = require('./config');
const cache = require('./cache');

let sdk = null;
let sdkError = null;

function load() {
  if (sdk || sdkError) return sdk;
  try {
    sdk = {
      STS: require('@aws-sdk/client-sts'),
      EC2: require('@aws-sdk/client-ec2'),
      S3: require('@aws-sdk/client-s3'),
      RDS: require('@aws-sdk/client-rds'),
      CW: require('@aws-sdk/client-cloudwatch'),
      CE: require('@aws-sdk/client-cost-explorer')
    };
  } catch (err) {
    sdkError = 'The AWS SDK is not installed. Run `npm install` in platform/console/server.';
  }
  return sdk;
}

const clients = new Map();
function client(kind, Ctor) {
  if (!clients.has(kind)) clients.set(kind, new Ctor({ region: config.region }));
  return clients.get(kind);
}

/** Every AWS call goes through here, so every AWS call is bounded and mapped. */
async function call(fn) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.awsTimeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn an SDK error into something an operator can act on.
 *
 * The distinction that matters is "you are not connected" versus "you are
 * connected and not allowed" versus "AWS is having a bad day" -- three
 * different next actions, and the raw error message conflates them.
 */
function classify(err) {
  const name = (err && (err.name || err.Code)) || 'Error';
  const msg = (err && err.message) || String(err);

  if (/AbortError|TimeoutError/i.test(name)) {
    return { reason: 'timeout', message: `AWS did not answer within ${config.awsTimeoutMs} ms.` };
  }
  if (/CredentialsProviderError|Could not load credentials/i.test(name + msg)) {
    return {
      reason: 'not-configured',
      message: 'No AWS credentials were found. Configure a profile, an SSO session, or an instance role.'
    };
  }
  if (/ExpiredToken|InvalidClientTokenId|TokenRefreshRequired/i.test(name)) {
    return { reason: 'expired', message: 'The AWS credentials have expired. Sign in again.' };
  }
  if (/AccessDenied|UnauthorizedOperation|AuthFailure|Forbidden/i.test(name)) {
    return { reason: 'denied', message: 'The credentials are valid but not permitted this call. ' + msg };
  }
  if (/Throttling|RequestLimitExceeded|TooManyRequests/i.test(name)) {
    return { reason: 'throttled', message: 'AWS is rate-limiting this account. The dashboard will back off.' };
  }
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|NetworkingError/i.test(name + msg)) {
    return { reason: 'unreachable', message: 'AWS is unreachable from this host.' };
  }
  return { reason: 'error', message: msg };
}

/** A reader that never throws: it reports why it could not answer. */
function guarded(key, ttlMs, producer) {
  return async function () {
    if (!load()) return { ok: false, reason: 'no-sdk', message: sdkError };
    try {
      const r = await cache.through(key, ttlMs, producer);
      return {
        ok: true, ...r.value,
        cachedAt: r.cachedAt,
        stale: !!r.stale,
        ...(r.stale ? { staleBecause: classify(r.error || {}) } : {})
      };
    } catch (err) {
      return { ok: false, ...classify(err) };
    }
  };
}

/* --------------------------------------------------------------- identity --- */

/** Who are we, and are we connected at all? Everything else depends on this. */
const identity = guarded('sts:identity', config.cacheTtlMs, async () => {
  const { STSClient, GetCallerIdentityCommand } = load().STS;
  const out = await call((signal) =>
    client('sts', STSClient).send(new GetCallerIdentityCommand({}), { abortSignal: signal }));
  return { account: out.Account, arn: out.Arn, userId: out.UserId, region: config.region };
});

/* --------------------------------------------------------------------- ec2 --- */

const instances = guarded('ec2:instances', config.cacheTtlMs, async () => {
  const { EC2Client, DescribeInstancesCommand } = load().EC2;
  const c = client('ec2', EC2Client);
  const rows = [];
  let token;
  // Paginated deliberately: an account with 400 instances returns them in
  // pages, and a dashboard that reads only the first page is worse than one
  // that reads none, because it looks complete.
  do {
    const out = await call((signal) =>
      c.send(new DescribeInstancesCommand({ MaxResults: 200, NextToken: token }), { abortSignal: signal }));
    for (const r of out.Reservations || []) {
      for (const i of r.Instances || []) {
        rows.push({
          id: i.InstanceId,
          name: tag(i.Tags, 'Name') || i.InstanceId,
          type: i.InstanceType,
          state: i.State && i.State.Name,
          az: i.Placement && i.Placement.AvailabilityZone,
          privateIp: i.PrivateIpAddress || null,
          publicIp: i.PublicIpAddress || null,
          launchedAt: i.LaunchTime ? new Date(i.LaunchTime).toISOString() : null,
          platform: i.PlatformDetails || null,
          tags: (i.Tags || []).reduce((a, t) => (a[t.Key] = t.Value, a), {})
        });
      }
    }
    token = out.NextToken;
  } while (token);
  return { instances: rows, count: rows.length };
});

function tag(tags, key) {
  const t = (tags || []).find((x) => x.Key === key);
  return t ? t.Value : null;
}

/* ---------------------------------------------------------------------- s3 --- */

const buckets = guarded('s3:buckets', config.cacheTtlMs, async () => {
  const { S3Client, ListBucketsCommand } = load().S3;
  const out = await call((signal) =>
    client('s3', S3Client).send(new ListBucketsCommand({}), { abortSignal: signal }));
  /* Size and object count are deliberately absent. There is no cheap API for
     them -- ListObjectsV2 over a large bucket is thousands of requests -- and a
     dashboard that quietly walks a bucket on page load is how a storage bill
     doubles. They belong on a CloudWatch daily metric, wired separately. */
  return {
    buckets: (out.Buckets || []).map((b) => ({
      name: b.Name,
      createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : null
    })),
    count: (out.Buckets || []).length
  };
});

/* --------------------------------------------------------------------- rds --- */

const databases = guarded('rds:instances', config.cacheTtlMs, async () => {
  const { RDSClient, DescribeDBInstancesCommand } = load().RDS;
  const c = client('rds', RDSClient);
  const rows = [];
  let marker;
  do {
    const out = await call((signal) =>
      c.send(new DescribeDBInstancesCommand({ Marker: marker }), { abortSignal: signal }));
    for (const d of out.DBInstances || []) {
      rows.push({
        id: d.DBInstanceIdentifier,
        engine: d.Engine,
        engineVersion: d.EngineVersion,
        class: d.DBInstanceClass,
        status: d.DBInstanceStatus,
        multiAz: !!d.MultiAZ,
        storageGb: d.AllocatedStorage,
        endpoint: d.Endpoint ? d.Endpoint.Address : null,
        backupRetentionDays: d.BackupRetentionPeriod,
        publiclyAccessible: !!d.PubliclyAccessible
      });
    }
    marker = out.Marker;
  } while (marker);
  return { databases: rows, count: rows.length };
});

/* -------------------------------------------------------------- cloudwatch --- */

const alarms = guarded('cw:alarms', config.cacheTtlMs, async () => {
  const { CloudWatchClient, DescribeAlarmsCommand } = load().CW;
  const out = await call((signal) =>
    client('cw', CloudWatchClient).send(
      new DescribeAlarmsCommand({ MaxRecords: 100, StateValue: undefined }), { abortSignal: signal }));
  const rows = (out.MetricAlarms || []).map((a) => ({
    name: a.AlarmName,
    state: a.StateValue,
    reason: a.StateReason,
    metric: a.MetricName,
    namespace: a.Namespace,
    updatedAt: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : null
  }));
  return {
    alarms: rows,
    count: rows.length,
    inAlarm: rows.filter((r) => r.state === 'ALARM').length
  };
});

/* -------------------------------------------------------------------- cost --- */

/* Cost Explorer charges per request, so it is off unless asked for and cached
   for hours rather than seconds. A dashboard that refreshes cost every thirty
   seconds bills you for the privilege of watching your bill. */
const cost = guarded('ce:month', config.costCacheTtlMs, async () => {
  if (!config.costEnabled) {
    return { enabled: false, note: 'Cost Explorer is off. Set ARGUS_COST_ENABLED=1 to enable it; each call is billed.' };
  }
  const { CostExplorerClient, GetCostAndUsageCommand } = load().CE;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const out = await call((signal) =>
    // Cost Explorer is only available in us-east-1, whatever the estate region.
    new (load().CE.CostExplorerClient)({ region: 'us-east-1' }).send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: start, End: end },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
      }), { abortSignal: signal }));
  const groups = ((out.ResultsByTime || [])[0] || {}).Groups || [];
  const services = groups.map((g) => ({
    service: g.Keys[0],
    amount: Number(g.Metrics.UnblendedCost.Amount),
    unit: g.Metrics.UnblendedCost.Unit
  })).sort((a, b) => b.amount - a.amount);
  return {
    enabled: true,
    period: { start, end },
    total: services.reduce((a, s) => a + s.amount, 0),
    currency: services.length ? services[0].unit : 'USD',
    services
  };
});

module.exports = { identity, instances, buckets, databases, alarms, cost, classify };
