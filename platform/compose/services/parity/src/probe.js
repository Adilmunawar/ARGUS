'use strict';

const { request } = require('./presign');

function root(endpoint) {
  return endpoint.replace(/\/+$/, '');
}

async function endpointReachable(endpoint, timeoutMs) {
  try {
    const response = await request(`${root(endpoint)}/`, { timeoutMs });
    return { reachable: true, status: response.status };
  } catch (err) {
    return { reachable: false, reason: err.message };
  }
}

async function localstackIdentity(endpoint, timeoutMs) {
  try {
    const response = await request(`${root(endpoint)}/_localstack/health`, { timeoutMs });
    if (response.status !== 200) return { version: null, edition: null };
    const parsed = JSON.parse(response.body);
    return { version: parsed.version || null, edition: parsed.edition || null };
  } catch (err) {
    return { version: null, edition: null };
  }
}

async function seaweedVersion(endpoint, timeoutMs) {
  try {
    const response = await request(`${root(endpoint)}/status`, { timeoutMs });
    if (response.status !== 200) return null;
    const parsed = JSON.parse(response.body);
    return parsed.Version || parsed.version || null;
  } catch (err) {
    return null;
  }
}

module.exports = { endpointReachable, localstackIdentity, seaweedVersion };
