'use strict';

const rejected = [];

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  rejected.push(`${name}=${JSON.stringify(raw)} is not a positive integer, so ${fallback} is used instead.`);
  return fallback;
}

function reportRejections(write) {
  const emit = write || ((line) => process.stderr.write(`argus: ${line}\n`));
  while (rejected.length) emit(rejected.shift());
}

module.exports = { positiveInt, reportRejections };
