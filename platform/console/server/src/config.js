/*
 * Configuration, entirely from the environment.
 *
 * There are no credentials in this file and there is no place to put them.
 * The AWS SDK resolves them through its own provider chain -- environment,
 * shared config file, SSO, or an instance role -- which means the process can
 * hold a short-lived role credential it never sees the text of, and nothing
 * secret can end up in this repository by accident.
 *
 * Every value has a default that is safe to run with, so `npm start` works on a
 * laptop with nothing configured and tells you honestly what is unavailable
 * rather than refusing to boot.
 */
'use strict';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const config = {
  port: int('ARGUS_PORT', 8787),
  host: process.env.ARGUS_HOST || '127.0.0.1',

  /* The console is an administrative surface. It binds to loopback by default
     so that starting it does not silently expose an estate inventory to the
     network; putting it on an interface is a deliberate act. */
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1',

  /* AWS calls cost money and are rate-limited. Every read is cached for this
     long. */
  cacheTtlMs: int('ARGUS_CACHE_TTL_MS', 30000),

  /* A hung AWS call must not become a hung dashboard. */
  awsTimeoutMs: int('ARGUS_AWS_TIMEOUT_MS', 8000),

  /* Cost Explorer is billed per request, so it is opt-in and cached hard. */
  costEnabled: bool('ARGUS_COST_ENABLED', false),
  costCacheTtlMs: int('ARGUS_COST_CACHE_TTL_MS', 6 * 60 * 60 * 1000),

  /* Read-only by default. Any mutating route refuses unless this is on, so the
     dashboard cannot terminate an instance because somebody mis-clicked while
     evaluating it. */
  allowWrites: bool('ARGUS_ALLOW_WRITES', false),

  /* Where the static console is served from, relative to this file. */
  webRoot: process.env.ARGUS_WEB_ROOT || '../../prototype',

  logLevel: process.env.ARGUS_LOG_LEVEL || 'info'
};

module.exports = config;
