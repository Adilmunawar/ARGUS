'use strict';

const fs = require('node:fs');

const authConfig = require('./config');
const hash = require('./hash');

const SUBJECT_MAX = 128;

let loaded = null;

function normaliseRoles(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .map((r) => r.trim())
    .slice(0, 32);
}

function accept(raw, problems, index) {
  if (!raw || typeof raw !== 'object') {
    problems.push(`operator ${index} is not an object.`);
    return null;
  }
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (!subject || subject.length > SUBJECT_MAX) {
    problems.push(`operator ${index} has no usable "subject".`);
    return null;
  }
  if (raw.disabled === true) return null;
  if (!hash.parse(raw.password)) {
    problems.push(`operator ${JSON.stringify(subject)} has no readable scrypt password record.`);
    return null;
  }
  return {
    subject,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : subject,
    roles: normaliseRoles(raw.roles),
    password: raw.password,
    credentials: Array.isArray(raw.credentials) ? raw.credentials : []
  };
}

function read() {
  if (authConfig.mode !== 'session') {
    return { ok: true, required: false, records: new Map(), problems: [], file: authConfig.operatorsFile };
  }

  const file = authConfig.operatorsFile;
  const problems = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(`${file} could not be read: ${err && err.code ? err.code : err && err.message}.`);
    return { ok: false, required: true, records: new Map(), problems, file };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    problems.push(`${file} is not valid JSON.`);
    return { ok: false, required: true, records: new Map(), problems, file };
  }

  const list = parsed && Array.isArray(parsed.operators) ? parsed.operators : null;
  if (!list) {
    problems.push(`${file} has no "operators" array.`);
    return { ok: false, required: true, records: new Map(), problems, file };
  }

  const records = new Map();
  list.forEach((raw, index) => {
    const record = accept(raw, problems, index);
    if (record) records.set(record.subject, record);
  });

  return { ok: records.size > 0, required: true, records, problems, file };
}

function load() {
  if (!loaded) loaded = read();
  return loaded;
}

function find(subject) {
  return load().records.get(subject) || null;
}

function count() {
  return load().records.size;
}

function reset() {
  loaded = null;
}

module.exports = { load, find, count, reset };
