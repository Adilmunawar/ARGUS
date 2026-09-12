'use strict';

const authConfig = require('./auth/config');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  'sandbox allow-scripts allow-same-origin'
].join('; ');

const PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=()', 'camera=()', 'cross-origin-isolated=()', 'display-capture=()',
  'encrypted-media=()', 'fullscreen=()', 'geolocation=()', 'gyroscope=()', 'keyboard-map=()',
  'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'picture-in-picture=()',
  'publickey-credentials-get=()', 'screen-wake-lock=()', 'sync-xhr=(self)', 'usb=()', 'web-share=()',
  'xr-spatial-tracking=()', 'clipboard-read=()', 'clipboard-write=()', 'gamepad=()', 'hid=()',
  'idle-detection=()', 'interest-cohort=()', 'serial=()', 'unload=()'
].join(', ');

const BASELINE = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'x-frame-options': 'deny',
  'x-permitted-cross-domain-policies': 'none',
  'x-dns-prefetch-control': 'off',
  'permissions-policy': PERMISSIONS_POLICY,
  vary: 'Sec-Fetch-Site, Origin, Cookie'
};

const HSTS = `max-age=${authConfig.hstsMaxAge}; includeSubDomains`;

function apply(res) {
  for (const name of Object.keys(BASELINE)) res.setHeader(name, BASELINE[name]);
  if (authConfig.hstsApplies) res.setHeader('strict-transport-security', HSTS);
  if (authConfig.mode === 'off') res.setHeader('x-argus-auth', 'disabled');
  res.removeHeader('server');
  res.removeHeader('x-powered-by');
}

module.exports = { apply, BASELINE, CSP, PERMISSIONS_POLICY };
