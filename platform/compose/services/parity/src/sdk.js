'use strict';

const path = require('node:path');

const VENDORED = path.resolve(__dirname, '../../../../console/server/node_modules');

function tryRequire(id) {
  try {
    return { module: require(id), from: id };
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function resolveS3() {
  const direct = tryRequire('@aws-sdk/client-s3');
  if (direct) return { available: true, s3: direct.module, source: 'NODE_PATH' };
  const vendored = tryRequire(path.join(VENDORED, '@aws-sdk/client-s3'));
  if (vendored) return { available: true, s3: vendored.module, source: VENDORED };
  return {
    available: false,
    s3: null,
    source: null,
    reason: `@aws-sdk/client-s3 not resolvable via NODE_PATH or ${VENDORED}`,
  };
}

module.exports = { resolveS3, VENDORED };
