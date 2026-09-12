'use strict';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
    return true;
  }
  return false;
}

function matchesSubset(actual, expected) {
  if (!isPlainObject(expected)) return deepEqual(actual, expected);
  if (!isPlainObject(actual)) return false;
  for (const key of Object.keys(expected)) {
    if (!matchesSubset(actual[key], expected[key])) return false;
  }
  return true;
}

function comparable(observation) {
  if (!observation) return null;
  return {
    outcome: observation.outcome,
    status: observation.status === undefined ? null : observation.status,
    detail: observation.detail === undefined ? {} : observation.detail,
  };
}

function differences(subject, reference) {
  const a = comparable(subject);
  const b = comparable(reference);
  const found = [];
  if (a.outcome !== b.outcome) {
    found.push({ field: 'outcome', subject: a.outcome, reference: b.outcome });
  }
  if (a.status !== b.status) {
    found.push({ field: 'status', subject: a.status, reference: b.status });
  }
  const keys = new Set([...Object.keys(a.detail || {}), ...Object.keys(b.detail || {})]);
  for (const key of keys) {
    if (!deepEqual(a.detail[key], b.detail[key])) {
      found.push({ field: `detail.${key}`, subject: a.detail[key], reference: b.detail[key] });
    }
  }
  return found;
}

function verdictAgainstReference(subject, reference) {
  const found = differences(subject, reference);
  if (!found.length) return { verdict: 'conform', differences: [] };
  return { verdict: 'diverge', differences: found };
}

function verdictAgainstExpectation(subject, expected) {
  if (matchesSubset(comparable(subject), expected)) {
    return { verdict: 'conform', differences: [] };
  }
  return {
    verdict: 'diverge',
    differences: [{ field: 'expectation', subject: comparable(subject), reference: expected }],
  };
}

module.exports = {
  deepEqual,
  matchesSubset,
  comparable,
  differences,
  verdictAgainstReference,
  verdictAgainstExpectation,
};
