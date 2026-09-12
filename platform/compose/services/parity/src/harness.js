'use strict';

const { observe } = require('./observe');
const { verdictAgainstReference, verdictAgainstExpectation } = require('./compare');
const { DEFAULT_CHECKSUM_MODE } = require('./side');

const ABSENT_STATUSES = new Set([400, 404, 405, 501]);
const ABSENT_OUTCOMES = new Set([
  'NotImplemented', 'MethodNotAllowed', 'InvalidRequest', 'InvalidArgument',
  'XmlParseError', 'DeserializationError', 'UnknownError',
]);
const REFUSED_STATUS = 403;
const REFUSED_OUTCOMES = new Set(['AccessDenied', 'SignatureDoesNotMatch', 'InvalidAccessKeyId']);

class FixtureError extends Error {
  constructor(name, side, cause) {
    super(`fixture ${name} failed on ${side}: ${cause && cause.message ? cause.message : cause}`);
    this.name = 'FixtureError';
    this.fixture = name;
    this.side = side;
    this.cause = cause;
  }
}

function looksRefused(observation) {
  if (observation.outcome === 'ok') return false;
  return REFUSED_OUTCOMES.has(observation.outcome) || observation.status === REFUSED_STATUS;
}

function looksAbsent(observation) {
  if (observation.outcome === 'ok') return false;
  if (looksRefused(observation)) return false;
  if (ABSENT_OUTCOMES.has(observation.outcome)) return true;
  if (observation.status !== null && ABSENT_STATUSES.has(observation.status)) return true;
  return false;
}

function createRun({ config, sdk, sides, presign }) {
  const state = { unreachable: new Set() };
  const groups = [];

  function sideByName(name) {
    return sides.find((side) => side.name === name) || null;
  }

  function activeSides(referenceApplicable) {
    const chosen = [sideByName('subject')];
    if (referenceApplicable !== false) chosen.push(sideByName('reference'));
    return chosen.filter(Boolean);
  }

  function markUnreachable(side, observation) {
    if (observation.outcome === 'unreachable') state.unreachable.add(side.name);
  }

  function createContext(leg) {
    const group = {
      id: leg.id,
      title: leg.title,
      matrixRows: leg.matrixRows || [],
      cases: [],
      notes: [],
      cleanup: [],
    };
    groups.push(group);
    const cleanups = [];
    const prefix = `run/${config.runId}/${leg.id}`;

    function push(record) {
      group.cases.push(record);
      return record;
    }

    function untestable(caseId, reason, extra) {
      return push({
        id: caseId,
        title: (extra && extra.title) || caseId,
        verdict: 'untestable',
        reason,
        subject: null,
        reference: null,
        differences: [],
      });
    }

    async function runOnSide(side, identity, checksums, fn) {
      if (state.unreachable.has(side.name)) {
        return { skipped: `${side.name} unreachable` };
      }
      const client = side.client(identity, checksums);
      if (!client) {
        return { skipped: `${side.name} has no ${identity} credential` };
      }
      const observation = await observe(() => fn(client, side));
      markUnreachable(side, observation);
      return { observation };
    }

    async function compare(caseId, fn, opts) {
      const options = opts || {};
      const identity = options.identity || 'standard';
      const checksums = options.checksums || DEFAULT_CHECKSUM_MODE;
      const title = options.title || caseId;
      const subject = sideByName('subject');

      if (state.unreachable.has('subject')) {
        return untestable(caseId, 'subject unreachable', { title });
      }
      if (!subject.has(identity)) {
        return untestable(caseId, `insufficient privilege: no ${identity} credential configured`, { title });
      }

      const subjectRun = await runOnSide(subject, identity, checksums, fn);
      if (subjectRun.skipped) return untestable(caseId, subjectRun.skipped, { title });
      const subjectObservation = subjectRun.observation;
      if (subjectObservation.outcome === 'unreachable') {
        return untestable(caseId, `subject unreachable: ${subjectObservation.message}`, { title });
      }

      const record = {
        id: caseId,
        title,
        identity,
        checksums,
        subject: subjectObservation,
        reference: null,
        verdict: 'untestable',
        reason: null,
        differences: [],
      };

      const reference = options.referenceApplicable === false ? null : sideByName('reference');
      if (reference && !state.unreachable.has('reference')) {
        const referenceRun = await runOnSide(reference, identity, checksums, fn);
        if (referenceRun.observation && referenceRun.observation.outcome !== 'unreachable') {
          record.reference = referenceRun.observation;
        }
      }

      if (record.reference) {
        Object.assign(record, verdictAgainstReference(record.subject, record.reference));
      } else if (options.expected) {
        Object.assign(record, verdictAgainstExpectation(record.subject, options.expected));
        record.reason = options.referenceApplicable === false
          ? 'reference not applicable, compared against recorded expectation'
          : 'reference absent, compared against recorded expectation';
      } else {
        record.verdict = 'untestable';
        record.reason = options.referenceApplicable === false
          ? 'reference not applicable and no recorded expectation'
          : 'reference absent and no recorded expectation';
      }
      return push(record);
    }

    async function expectAbsent(caseId, fn, opts) {
      const options = opts || {};
      const title = options.title || caseId;
      const subject = sideByName('subject');
      if (state.unreachable.has('subject')) return untestable(caseId, 'subject unreachable', { title });
      const identity = options.identity || 'standard';
      if (!subject.has(identity)) {
        return untestable(caseId, `insufficient privilege: no ${identity} credential configured`, { title });
      }
      const subjectRun = await runOnSide(subject, identity, options.checksums, fn);
      if (subjectRun.skipped) return untestable(caseId, subjectRun.skipped, { title });
      const observation = subjectRun.observation;
      if (observation.outcome === 'unreachable') {
        return untestable(caseId, `subject unreachable: ${observation.message}`, { title });
      }
      if (looksRefused(observation)) {
        return untestable(
          caseId,
          `subject answered ${observation.outcome} ${observation.status}: the route may be registered and the identity refused, which proves nothing about absence`,
          { title },
        );
      }
      if (looksAbsent(observation)) {
        return push({
          id: caseId,
          title,
          identity,
          subject: observation,
          reference: null,
          verdict: 'absent',
          reason: 'route not registered on the subject; recorded as absent by design',
          differences: [],
        });
      }
      return push({
        id: caseId,
        title,
        identity,
        subject: observation,
        reference: null,
        verdict: 'diverge',
        reason: 'recorded matrix says this route is absent on the subject, but the subject answered',
        differences: [{ field: 'outcome', subject: observation.outcome, reference: 'absent' }],
      });
    }

    async function fixture(name, fn, opts) {
      const options = opts || {};
      const identity = options.identity || 'standard';
      const results = {};
      for (const side of activeSides(options.referenceApplicable)) {
        if (state.unreachable.has(side.name)) { results[side.name] = null; continue; }
        const client = side.client(identity, options.checksums);
        if (!client) { results[side.name] = null; continue; }
        const observation = await observe(() => fn(client, side));
        markUnreachable(side, observation);
        if (observation.outcome === 'unreachable') { results[side.name] = null; continue; }
        if (observation.outcome !== 'ok' && !options.tolerant) {
          throw new FixtureError(name, side.name, new Error(`${observation.outcome}: ${observation.message}`));
        }
        results[side.name] = observation.outcome === 'ok' ? observation.detail : null;
      }
      return results;
    }

    async function forEachSide(fn, opts) {
      const options = opts || {};
      const identity = options.identity || 'standard';
      for (const side of activeSides(options.referenceApplicable)) {
        if (state.unreachable.has(side.name)) continue;
        const client = side.client(identity, options.checksums);
        if (!client) continue;
        const observation = await observe(() => fn(client, side));
        markUnreachable(side, observation);
      }
    }

    return {
      config,
      sdk,
      presign,
      leg,
      group,
      buckets: config.buckets,
      runId: config.runId,
      prefix,
      subject: sideByName('subject'),
      reference: sideByName('reference'),
      key(...parts) { return [prefix, ...parts].join('/'); },
      note(text) { group.notes.push(text); },
      compare,
      expectAbsent,
      untestable,
      fixture,
      forEachSide,
      cleanup(fn) { cleanups.push(fn); },
      async drain() {
        while (cleanups.length) {
          const fn = cleanups.pop();
          const observation = await observe(fn);
          if (observation.outcome !== 'ok') {
            group.cleanup.push({ outcome: observation.outcome, message: observation.message });
          }
        }
      },
    };
  }

  return { state, groups, createContext, sideByName };
}

module.exports = { createRun, FixtureError, looksAbsent, looksRefused };
