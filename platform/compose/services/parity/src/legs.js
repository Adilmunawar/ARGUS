'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY = path.join(__dirname, 'legs');

function load() {
  return fs.readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => {
      const leg = require(path.join(DIRECTORY, name));
      if (!leg || typeof leg.run !== 'function' || !leg.id) {
        throw new Error(`${name} does not export { id, title, run }`);
      }
      return { ...leg, file: name };
    });
}

function select(legs, selection) {
  if (!selection) return legs;
  return legs.filter((leg) => selection.has(leg.id) || selection.has(leg.file));
}

function unmatched(legs, selection) {
  if (!selection) return [];
  return [...selection].filter((name) => !legs.some((leg) => leg.id === name || leg.file === name));
}

module.exports = { load, select, unmatched, DIRECTORY };
