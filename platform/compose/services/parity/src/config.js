'use strict';

const path = require('node:path');

const DEFAULT_RESULTS_DIR = '/var/lib/argus/parity';
const REPORT_FILENAME = 'latest.json';

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function flag(name) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function credentials(accessName, secretName) {
  const accessKeyId = str(accessName, '');
  const secretAccessKey = str(secretName, '');
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
}

function bucketNonce() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

function nonce() {
  const now = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${now}-${rand}`;
}

function parseArgs(argv) {
  const args = { only: null, list: false, report: null, serve: null, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--serve') args.serve = true;
    else if (arg === '--once') args.serve = false;
    else if (arg === '--only') args.only = argv[++i] || '';
    else if (arg.startsWith('--only=')) args.only = arg.slice(7);
    else if (arg === '--report') args.report = argv[++i] || '';
    else if (arg.startsWith('--report=')) args.report = arg.slice(9);
    else args.unknown.push(arg);
  }
  return args;
}

function selection(args) {
  const raw = args.only !== null ? args.only : str('ARGUS_PARITY_ONLY', '');
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function load(argv) {
  const args = parseArgs(argv || []);
  const region = str('ARGUS_S3_REGION', 'us-east-1');
  const resultsDir = str('ARGUS_PARITY_RESULTS_DIR', DEFAULT_RESULTS_DIR);
  const reportPath = args.report
    || str('ARGUS_PARITY_REPORT', path.join(resultsDir, REPORT_FILENAME));
  const referenceEndpoint = str('ARGUS_PARITY_REFERENCE_ENDPOINT', '');
  const referenceCredentials =
    credentials('ARGUS_PARITY_REFERENCE_ACCESS_KEY', 'ARGUS_PARITY_REFERENCE_SECRET_KEY') ||
    (referenceEndpoint ? { accessKeyId: 'test', secretAccessKey: 'test' } : null);

  return {
    args,
    list: args.list,
    serve: args.serve === null ? flag('ARGUS_PARITY_SERVE') : args.serve,
    bind: str('ARGUS_PARITY_BIND', '127.0.0.1'),
    port: positiveInt('ARGUS_PARITY_PORT', 9781),
    intervalMs: positiveInt('ARGUS_PARITY_INTERVAL_MS', 900000),
    selection: selection(args),
    region,
    timeoutMs: positiveInt('ARGUS_PARITY_TIMEOUT_MS', 15000),
    reportPath,
    reportDir: path.dirname(reportPath),
    sdkRequired: flag('ARGUS_PARITY_SDK_REQUIRED'),
    runId: nonce(),
    bucketNonce: bucketNonce(),
    subject: {
      name: 'subject',
      kind: str('ARGUS_PARITY_SUBJECT_KIND', 'seaweedfs'),
      endpoint: str('ARGUS_S3_ENDPOINT', 'http://seaweed-s3:8333'),
      region,
      declaredVersion: str('ARGUS_PARITY_SUBJECT_VERSION', '') || null,
      identities: {
        standard: credentials('ARGUS_PARITY_ACCESS_KEY', 'ARGUS_PARITY_SECRET_KEY'),
        deny: credentials('ARGUS_PARITY_DENY_ACCESS_KEY', 'ARGUS_PARITY_DENY_SECRET_KEY'),
        admin: credentials('ARGUS_PARITY_ADMIN_ACCESS_KEY', 'ARGUS_PARITY_ADMIN_SECRET_KEY'),
      },
    },
    reference: !referenceEndpoint ? null : {
      name: 'reference',
      kind: str('ARGUS_PARITY_REFERENCE_KIND', 'localstack'),
      endpoint: referenceEndpoint,
      region,
      identities: {
        standard: referenceCredentials,
        deny: referenceCredentials,
        admin: referenceCredentials,
      },
    },
    buckets: {
      main: str('ARGUS_S3_BUCKET', 'argus-parity'),
      worm: str('ARGUS_S3_WORM_BUCKET', 'argus-parity-worm'),
      forbidden: str('ARGUS_S3_FORBIDDEN_BUCKET', 'argus-parity-forbidden'),
      crudPrefix: str('ARGUS_PARITY_CRUD_BUCKET_PREFIX', 'argus-parity-crud'),
    },
    wormRetainSeconds: positiveInt('ARGUS_S3_WORM_RETAIN_SECONDS', 120),
    complianceCanary: flag('ARGUS_PARITY_COMPLIANCE_CANARY'),
  };
}

module.exports = { load, flag, positiveInt, str, DEFAULT_RESULTS_DIR, REPORT_FILENAME };
