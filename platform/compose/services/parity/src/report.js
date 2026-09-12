'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const VERDICTS = ['conform', 'diverge', 'absent', 'untestable', 'error'];

function emptySummary() {
  const summary = {};
  for (const verdict of VERDICTS) summary[verdict] = 0;
  return summary;
}

function summarise(groups) {
  const summary = emptySummary();
  for (const group of groups) {
    for (const record of group.cases) {
      if (summary[record.verdict] === undefined) summary[record.verdict] = 0;
      summary[record.verdict] += 1;
    }
  }
  return summary;
}

function divergences(groups) {
  const found = [];
  for (const group of groups) {
    for (const record of group.cases) {
      if (record.verdict === 'diverge') found.push({ group: group.id, case: record.id, differences: record.differences });
    }
  }
  return found;
}

function build({ config, started, finished, sides, sdk, groups, bootstrap }) {
  const reference = sides.find((side) => side.name === 'reference');
  const subject = sides.find((side) => side.name === 'subject');
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: config.runId,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    sdk: {
      available: Boolean(sdk.available),
      source: sdk.source || null,
      reason: sdk.reason || null,
    },
    subject: subject
      ? {
        kind: subject.kind,
        endpoint: subject.endpoint,
        region: subject.region,
        reachable: bootstrap.subjectReachable,
        unreachableReason: bootstrap.subjectUnreachableReason || null,
        version: bootstrap.subjectVersion,
      }
      : {
        kind: config.subject.kind,
        endpoint: config.subject.endpoint,
        region: config.subject.region,
        reachable: false,
        unreachableReason: 'no S3 client available, the endpoint was never probed',
        version: config.subject.declaredVersion,
      },
    reference: reference
      ? {
        kind: reference.kind,
        endpoint: reference.endpoint,
        region: reference.region,
        reachable: bootstrap.referenceReachable,
        unreachableReason: bootstrap.referenceUnreachableReason || null,
        version: bootstrap.referenceVersion,
        edition: bootstrap.referenceEdition,
      }
      : { kind: null, endpoint: null, status: 'absent' },
    residue: bootstrap.residue || {},
    identities: {
      standard: Boolean(config.subject.identities.standard),
      deny: Boolean(config.subject.identities.deny),
      admin: Boolean(config.subject.identities.admin),
    },
    summary: summarise(groups),
    divergences: divergences(groups),
    groups,
  };
}

function write(reportPath, report) {
  const directory = path.dirname(reportPath);
  const temporary = `${reportPath}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, reportPath);
    return { written: true, path: reportPath };
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { void cleanupError; }
    return { written: false, path: reportPath, reason: err.message };
  }
}

const GLYPH = {
  conform: 'conform  ',
  diverge: 'DIVERGE  ',
  absent: 'absent   ',
  untestable: 'untested ',
  error: 'ERROR    ',
};

function render(report) {
  const lines = [];
  lines.push(`argus parity ${report.runId}`);
  lines.push(`  subject    ${report.subject.kind} ${report.subject.endpoint} ${report.subject.reachable ? 'reachable' : `UNREACHABLE: ${report.subject.unreachableReason}`}`);
  lines.push(`  reference  ${report.reference.endpoint ? `${report.reference.kind} ${report.reference.endpoint} ${report.reference.reachable ? `reachable ${report.reference.version || ''}` : `UNREACHABLE: ${report.reference.unreachableReason}`}` : 'absent'}`);
  lines.push(`  sdk        ${report.sdk.available ? `@aws-sdk/client-s3 via ${report.sdk.source}` : `unavailable: ${report.sdk.reason}`}`);
  lines.push('');
  for (const group of report.groups) {
    lines.push(`${group.id}  ${group.title}`);
    for (const record of group.cases) {
      const suffix = record.verdict === 'diverge'
        ? `  ${record.differences.map((d) => `${d.field}: subject=${JSON.stringify(d.subject)} reference=${JSON.stringify(d.reference)}`).join('; ')}`
        : record.reason ? `  (${record.reason})` : '';
      lines.push(`  ${GLYPH[record.verdict] || record.verdict} ${record.id}${suffix}`);
    }
    for (const note of group.notes) lines.push(`  note      ${note}`);
    for (const failure of group.cleanup) lines.push(`  residue   ${failure.outcome}: ${failure.message}`);
    lines.push('');
  }
  const summary = report.summary;
  lines.push(`conform ${summary.conform}  diverge ${summary.diverge}  absent ${summary.absent}  untestable ${summary.untestable}  error ${summary.error}`);
  return lines.join('\n');
}

module.exports = { build, write, render, summarise, divergences, SCHEMA_VERSION, VERDICTS };
