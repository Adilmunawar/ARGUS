'use strict';

const fs = require('node:fs');
const { timingSafeEqual, createHash } = require('node:crypto');

const authConfig = require('./config');

function readToken(env) {
  const direct = String(env.ARGUS_METRICS_TOKEN || '').trim();
  if (direct) return { token: direct, source: 'ARGUS_METRICS_TOKEN', problem: null };
  const file = String(env.ARGUS_METRICS_TOKEN_FILE || '').trim();
  if (!file) return { token: '', source: null, problem: null };
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return { token: '', source: file, problem: `${file} is empty` };
    return { token: text, source: file, problem: null };
  } catch (err) {
    return { token: '', source: file, problem: `${file} could not be read (${err && err.code ? err.code : 'unknown'})` };
  }
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function bearerOf(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

function createGate(settings) {
  const token = settings.token || '';
  const problem = settings.problem || null;
  const loopback = !!settings.bindIsLoopback;
  const expected = token ? digest(token) : null;

  function decide(authorizationHeader) {
    if (problem) {
      return {
        allowed: false,
        reason: 'unauthenticated',
        message: `The metrics token file is configured but unusable: ${problem}. /metrics stays closed until it is fixed.`
      };
    }
    if (expected) {
      const presented = bearerOf(authorizationHeader);
      if (presented && timingSafeEqual(digest(presented), expected)) return { allowed: true, authenticated: true };
      return {
        allowed: false,
        reason: 'unauthenticated',
        message: 'This scrape endpoint needs Authorization: Bearer <token>, with the token from ARGUS_METRICS_TOKEN or ARGUS_METRICS_TOKEN_FILE.'
      };
    }
    if (loopback) return { allowed: true, authenticated: false };
    return {
      allowed: false,
      reason: 'unauthenticated',
      message: 'This console is bound to a non-loopback address and has no metrics token, so /metrics is closed. ' +
        'Set ARGUS_METRICS_TOKEN or ARGUS_METRICS_TOKEN_FILE and give the scraper the same token.'
    };
  }

  function bootNote() {
    if (problem) return `ARGUS_METRICS_TOKEN_FILE is set but ${problem}, so /metrics refuses every scrape.`;
    if (expected) return null;
    if (loopback) {
      return '/metrics is public because no ARGUS_METRICS_TOKEN or ARGUS_METRICS_TOKEN_FILE is set. ' +
        'That is allowed only while the console is bound to loopback.';
    }
    return '/metrics is closed: the console is bound to a non-loopback address and no ARGUS_METRICS_TOKEN or ' +
      'ARGUS_METRICS_TOKEN_FILE is set.';
  }

  return { decide, bootNote, protectedByToken: !!expected };
}

const loaded = readToken(process.env);
const gate = createGate({ token: loaded.token, problem: loaded.problem, bindIsLoopback: authConfig.bindIsLoopback });

module.exports = { decide: gate.decide, bootNote: gate.bootNote, createGate, readToken, bearerOf };
