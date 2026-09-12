'use strict';

const CHECKSUM_MODES = {
  when_supported: {
    requestChecksumCalculation: 'when_supported',
    responseChecksumValidation: 'when_supported',
  },
  when_required: {
    requestChecksumCalculation: 'when_required',
    responseChecksumValidation: 'when_required',
  },
};

const DEFAULT_CHECKSUM_MODE = 'when_required';

function create(spec, { s3, timeoutMs }) {
  const { S3Client } = s3;
  const cache = new Map();

  function client(identity, checksumMode) {
    const mode = checksumMode || DEFAULT_CHECKSUM_MODE;
    const key = `${identity}:${mode}`;
    if (cache.has(key)) return cache.get(key);
    const credentials = spec.identities[identity];
    if (!credentials) return null;
    const instance = new S3Client({
      endpoint: spec.endpoint,
      region: spec.region,
      forcePathStyle: true,
      credentials,
      maxAttempts: 1,
      requestHandler: { requestTimeout: timeoutMs, connectionTimeout: timeoutMs },
      ...CHECKSUM_MODES[mode],
    });
    cache.set(key, instance);
    return instance;
  }

  return {
    name: spec.name,
    kind: spec.kind,
    endpoint: spec.endpoint,
    region: spec.region,
    identities: spec.identities,
    has(identity) {
      return Boolean(spec.identities[identity]);
    },
    credentials(identity) {
      return spec.identities[identity] || null;
    },
    client,
    destroy() {
      for (const instance of cache.values()) {
        try { instance.destroy(); } catch (err) { void err; }
      }
      cache.clear();
    },
  };
}

module.exports = { create, CHECKSUM_MODES, DEFAULT_CHECKSUM_MODE };
