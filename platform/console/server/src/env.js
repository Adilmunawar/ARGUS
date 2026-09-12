'use strict';

const rejected = [];

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  const line = `${name}=${JSON.stringify(raw)} is not a positive integer, so ${fallback} is used instead.`;
  if (!rejected.includes(line)) rejected.push(line);
  return fallback;
}

function reportRejections(write) {
  const emit = write || ((line) => process.stderr.write(`argus: ${line}\n`));
  while (rejected.length) emit(rejected.shift());
}

module.exports = { positiveInt, reportRejections };
