'use strict';

const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');

const authConfig = require('./config');

const KEY_BYTES = 32;
const SALT_BYTES = 16;

function scryptOptionsWithExplicitMaxmem(params) {
  return {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelism,
    maxmem: params.maxmem
  };
}

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, scryptOptionsWithExplicitMaxmem(params), (err, tag) => {
      if (err) return reject(err);
      resolve(tag);
    });
  });
}

async function hash(password, params) {
  const p = params || authConfig.scrypt;
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, p);
  return `scrypt$N=${p.cost},r=${p.blockSize},p=${p.parallelism}$` +
    `${salt.toString('base64url')}$${tag.toString('base64url')}`;
}

function parse(record) {
  if (typeof record !== 'string') return null;
  const parts = record.split('$');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'scrypt') return null;

  const params = { cost: 0, blockSize: 0, parallelism: 0, maxmem: authConfig.scrypt.maxmem };
  for (const pair of parts[1].split(',')) {
    const [name, raw] = pair.split('=');
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return null;
    if (name === 'N') params.cost = value;
    else if (name === 'r') params.blockSize = value;
    else if (name === 'p') params.parallelism = value;
    else return null;
  }
  if (!params.cost || !params.blockSize || !params.parallelism) return null;

  const salt = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (salt.length === 0 || tag.length === 0) return null;

  const maxmemNeededByThisRecord = 128 * params.cost * params.blockSize;
  if (maxmemNeededByThisRecord > params.maxmem) params.maxmem = maxmemNeededByThisRecord + 1024 * 1024;

  return { params, salt, tag };
}

function equalTagsWithoutThrowingOnLength(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

let chain = Promise.resolve();
let queued = 0;

function busy() {
  return Object.assign(new Error('Too many sign-in attempts are in flight. Try again in a moment.'),
    { name: 'Busy' });
}

function serialize(work) {
  if (queued >= authConfig.verifyQueueMax) return Promise.reject(busy());
  queued += 1;
  const run = chain.then(work, work);
  chain = run.then(() => { queued -= 1; }, () => { queued -= 1; });
  return run;
}

async function verify(password, record) {
  const parsed = parse(record);
  if (!parsed) return false;
  const tag = await derive(password, parsed.salt, parsed.params);
  return equalTagsWithoutThrowingOnLength(tag, parsed.tag);
}

let decoy = null;

function decoyRecord() {
  if (!decoy) decoy = hash(randomBytes(24).toString('base64url'));
  return decoy;
}

async function verifyOrSpendTheSameTimeOnADecoy(password, record) {
  if (typeof record === 'string' && record.length > 0) return verify(password, record);
  await verify(randomBytes(24).toString('base64url'), await decoyRecord());
  return false;
}

module.exports = {
  hash,
  parse,
  verify,
  verifyOrSpendTheSameTimeOnADecoy,
  serialize,
  equalTagsWithoutThrowingOnLength,
  KEY_BYTES,
  SALT_BYTES
};
