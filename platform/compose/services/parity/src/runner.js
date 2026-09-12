'use strict';

const config = require('./config');
const legsModule = require('./legs');
const { resolveS3 } = require('./sdk');
const { create: createSide } = require('./side');
const { createRun } = require('./harness');
const { endpointReachable, localstackIdentity, seaweedVersion } = require('./probe');
const { purgePrefix } = require('./teardown');
const presign = require('./presign');
const report = require('./report');

const EXIT_BOOTSTRAP_FAILURE = 70;
const MAX_EXIT_CODE = 125;
const RESIDUE_ROOT = 'run/';

async function sweepResidue(side, sdk, settings) {
  const client = side.client('standard');
  if (!client) return null;
  const retained = await purgePrefix(client, sdk, settings.buckets.worm, RESIDUE_ROOT).catch(() => null);
  return retained;
}

async function execute(settings) {
  const started = new Date();
  const sdkResolution = resolveS3();
  const discovered = legsModule.load();
  const legs = legsModule.select(discovered, settings.selection);
  for (const missing of legsModule.unmatched(discovered, settings.selection)) {
    process.stderr.write(`argus-parity: --only names no such leg: ${missing}\n`);
  }

  const bootstrap = {
    subjectReachable: false,
    subjectVersion: null,
    referenceReachable: false,
    referenceVersion: null,
    referenceEdition: null,
    residue: {},
  };

  if (!sdkResolution.available) {
    const groups = legs.map((leg) => ({
      id: leg.id,
      title: leg.title,
      matrixRows: leg.matrixRows || [],
      notes: [],
      cleanup: [],
      cases: [{
        id: `${leg.id}:bootstrap`,
        title: leg.title,
        verdict: 'untestable',
        reason: sdkResolution.reason,
        subject: null,
        reference: null,
        differences: [],
      }],
    }));
    return {
      report: report.build({
        config: settings,
        started,
        finished: new Date(),
        sides: [],
        sdk: sdkResolution,
        groups,
        bootstrap,
      }),
      exitCode: settings.sdkRequired ? EXIT_BOOTSTRAP_FAILURE : 0,
    };
  }

  const sdk = sdkResolution.s3;
  const sides = [createSide(settings.subject, { s3: sdk, timeoutMs: settings.timeoutMs })];
  if (settings.reference) {
    sides.push(createSide(settings.reference, { s3: sdk, timeoutMs: settings.timeoutMs }));
  }

  const run = createRun({ config: settings, sdk, sides, presign });

  for (const side of sides) {
    const probe = await endpointReachable(side.endpoint, settings.timeoutMs);
    if (!probe.reachable) {
      run.state.unreachable.add(side.name);
      if (side.name === 'subject') bootstrap.subjectUnreachableReason = probe.reason;
      else bootstrap.referenceUnreachableReason = probe.reason;
      continue;
    }
    if (side.name === 'subject') {
      bootstrap.subjectReachable = true;
      bootstrap.subjectVersion = await seaweedVersion(side.endpoint, settings.timeoutMs)
        || settings.subject.declaredVersion;
    } else {
      bootstrap.referenceReachable = true;
      const identity = await localstackIdentity(side.endpoint, settings.timeoutMs);
      bootstrap.referenceVersion = identity.version;
      bootstrap.referenceEdition = identity.edition;
    }
  }

  for (const side of sides) {
    if (run.state.unreachable.has(side.name)) continue;
    const retained = await sweepResidue(side, sdk, settings);
    if (retained && retained.length) bootstrap.residue[side.name] = retained;
  }

  for (const leg of legs) {
    const ctx = run.createContext(leg);
    try {
      await leg.run(ctx);
    } catch (err) {
      ctx.group.cases.push({
        id: `${leg.id}:run`,
        title: leg.title,
        verdict: err && err.name === 'FixtureError' ? 'untestable' : 'error',
        reason: (err && err.message) || String(err),
        subject: null,
        reference: null,
        differences: [],
      });
    }
    await ctx.drain();
  }

  for (const side of sides) side.destroy();

  const built = report.build({
    config: settings,
    started,
    finished: new Date(),
    sides,
    sdk: sdkResolution,
    groups: run.groups,
    bootstrap,
  });

  return { report: built, exitCode: Math.min(built.summary.diverge, MAX_EXIT_CODE) };
}

async function once(settings) {
  const outcome = await execute(settings);
  const written = report.write(settings.reportPath, outcome.report);
  process.stdout.write(`${report.render(outcome.report)}\n`);
  if (written.written) {
    process.stdout.write(`report ${written.path}\n`);
  } else {
    process.stderr.write(`argus-parity: report not written to ${written.path}: ${written.reason}\n`);
  }
  return outcome;
}

async function serve(settings) {
  const http = require('node:http');
  const state = { runs: 0, lastFinishedAt: null, lastError: null, report: null };

  async function cycle() {
    try {
      const outcome = await once(settings);
      state.runs += 1;
      state.lastFinishedAt = new Date().toISOString();
      state.lastError = null;
      state.report = outcome.report;
    } catch (err) {
      state.lastError = (err && err.message) || String(err);
      process.stderr.write(`argus-parity: run failed: ${state.lastError}\n`);
    }
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(state.lastError === null ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        runs: state.runs,
        lastFinishedAt: state.lastFinishedAt,
        lastError: state.lastError,
      }));
      return;
    }
    if (request.url === '/latest.json') {
      response.writeHead(state.report ? 200 : 503, { 'content-type': 'application/json' });
      response.end(state.report ? JSON.stringify(state.report) : '{}');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
  });

  server.listen(settings.port, settings.bind);
  await cycle();
  const timer = setInterval(cycle, settings.intervalMs);
  timer.unref();
  return new Promise(() => {});
}

async function main() {
  const settings = config.load(process.argv.slice(2));

  for (const unknown of settings.args.unknown) {
    process.stderr.write(`argus-parity: unrecognised argument ${unknown}\n`);
  }

  if (settings.list) {
    for (const leg of legsModule.load()) {
      process.stdout.write(`${leg.id}\t${leg.file}\t${leg.title}\n`);
    }
    return 0;
  }

  if (settings.serve) {
    await serve(settings);
    return 0;
  }

  const outcome = await once(settings);
  return outcome.exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(`argus-parity: ${(err && err.stack) || err}\n`);
    process.exitCode = EXIT_BOOTSTRAP_FAILURE;
  });
