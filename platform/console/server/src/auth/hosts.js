'use strict';

const authConfig = require('./config');
const base = require('../config');

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parseHost(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text || text.length > 255) return null;
  let name;
  let rest;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return null;
    name = text.slice(0, close + 1);
    rest = text.slice(close + 1);
  } else {
    const colon = text.indexOf(':');
    name = colon < 0 ? text : text.slice(0, colon);
    rest = colon < 0 ? '' : text.slice(colon);
  }
  if (!name || /[\s/\\@?#]/.test(name)) return null;
  if (rest === '') return { name, port: null };
  if (!/^:\d{1,5}$/.test(rest)) return null;
  const port = Number(rest.slice(1));
  if (port < 1 || port > 65535) return null;
  return { name, port };
}

function readAllowed(raw) {
  const out = [];
  const rejected = [];
  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parsed = parseHost(trimmed);
    if (parsed) out.push(parsed);
    else rejected.push(trimmed);
  }
  return { entries: out, rejected };
}

function publicOriginHost() {
  if (!authConfig.publicOrigin) return null;
  try {
    const url = new URL(authConfig.publicOrigin);
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    return { name: url.hostname.toLowerCase(), port };
  } catch (err) {
    return null;
  }
}

const configured = readAllowed(process.env.ARGUS_ALLOWED_HOSTS);
const fromOrigin = publicOriginHost();

const notes = [];
for (const entry of configured.rejected) {
  notes.push(`ARGUS_ALLOWED_HOSTS entry ${JSON.stringify(entry)} is not a host name with an optional port, so it is ignored.`);
}

function allowList() {
  const list = configured.entries.slice();
  if (fromOrigin) list.push(fromOrigin);
  return list;
}

function defaultPort(req) {
  return req.socket && req.socket.encrypted ? 443 : 80;
}

function check(req) {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || raw.length === 0) return { allowed: false, reason: 'no-host' };
  const parsed = parseHost(raw);
  if (!parsed) return { allowed: false, reason: 'malformed-host' };
  const port = parsed.port === null ? defaultPort(req) : parsed.port;
  const bound = req.socket ? req.socket.localPort : null;

  if (LOOPBACK_NAMES.has(parsed.name) && (port === bound || port === base.port)) {
    return { allowed: true, signal: 'loopback' };
  }

  for (const entry of allowList()) {
    if (entry.name !== parsed.name) continue;
    if (entry.port !== null && parsed.port !== null && entry.port !== parsed.port) continue;
    if (authConfig.mode === 'off' && !LOOPBACK_NAMES.has(entry.name)) continue;
    return { allowed: true, signal: 'allow-list' };
  }

  return { allowed: false, reason: authConfig.mode === 'off' ? 'host-not-loopback' : 'host-not-allowed' };
}

module.exports = { check, parseHost, readAllowed, allowList, notes, LOOPBACK_NAMES };
