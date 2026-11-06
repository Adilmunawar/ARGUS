'use strict';

const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');

const authConfig = require('./config');

const IDENTITY_MAX = 128;

const allowList = (() => {
  const list = new net.BlockList();
  for (const cidr of authConfig.trustedProxyCidrs) {
    list.addSubnet(cidr.address, cidr.bits, cidr.family);
  }
  return list;
})();

function peerTrusted(remoteAddress) {
  if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) return false;
  if (authConfig.trustedProxyCidrs.length === 0) return false;
  try {
    return allowList.check(remoteAddress, remoteAddress.includes(':') ? 'ipv6' : 'ipv4');
  } catch (err) {
    return false;
  }
}

function normaliseHop(raw) {
  let text = String(raw || '').trim();
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    text = close > 0 ? text.slice(1, close) : '';
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(':'));
  }
  return net.isIP(text) ? text : null;
}

function sourceAddress(req) {
  const peer = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  if (!authConfig.trustForwardedFor || !peerTrusted(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : String(header || ''))
    .split(',').map((hop) => hop.trim()).filter(Boolean);
  let nearest = peer;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const hop = normaliseHop(chain[i]);
    if (!hop) return nearest;
    if (!peerTrusted(hop)) return hop;
    nearest = hop;
  }
  return nearest;
}

function secretMatches(presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(authConfig.proxySharedSecret);
  if (a.length !== b.length || b.length === 0) return false;
  return timingSafeEqual(a, b);
}

function parseGroups(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((g) => g.trim()).filter(Boolean).slice(0, 32);
}

function identify(req) {
  const peer = req.socket && req.socket.remoteAddress;
  if (!peerTrusted(peer)) return { ok: false, reason: 'untrusted-peer' };

  if (!secretMatches(req.headers[authConfig.proxySecretHeader])) {
    return { ok: false, reason: 'bad-proxy-secret' };
  }

  const subject = req.headers[authConfig.proxyIdentityHeader];
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > IDENTITY_MAX) {
    return { ok: false, reason: 'bad-identity-header' };
  }
  if (subject.includes(',')) return { ok: false, reason: 'duplicate-identity-header' };

  const name = req.headers[authConfig.proxyNameHeader];
  return {
    ok: true,
    subject: subject.trim(),
    displayName: typeof name === 'string' && name.trim() && !name.includes(',') ? name.trim() : subject.trim(),
    roles: parseGroups(req.headers[authConfig.proxyGroupsHeader])
  };
}

module.exports = { identify, peerTrusted, sourceAddress };
