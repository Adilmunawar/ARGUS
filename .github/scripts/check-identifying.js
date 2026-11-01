'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const SALT = 'argus-identity-guard-v1';

const BLOCKED = new Set([
  '0d02c0187c46b0b5640bd0fc49cb561020fe59e67fad75820deb4f87001d3a6b',
  '0dc3ce002886892cf4f26d901b445a662be49c8b54d791fc53860ca45af84dda',
  '1dde9d6a3510c8a3a3e98e58f5a2ac5a375e20162eaef8d2129676df610fef7f',
  '20c9d928450a469c872bbd16b5b63e63142de65e1565ef4a7ff5ab5c1fa5a4ac',
  '24d4301c77dfb497ce49c66c541ab8323908edaeb112f07dcca55fbcb399ef11',
  '2e6b737cf2f7d62255c1fed3adb1626f4ee3fbb0aecfa5833dacbe6248579d2f',
  '3072e2677b6c61522ce62c0eacdd4a4b2f59e90daf563b8e7e60f9e743825d81',
  '54702c06651e5128baf8f74dd4afdef860b4832d562ca35105b5cdce957ac330',
  '5729b6107cc728ff1d9ef1950aed4efb68e563af0d94506144646fc8748eb001',
  '5b69e4fc0cae9b34571b5bb5e538785e94312b19397b792e599e13c3201c0550',
  '5e42c4ebee0af0945884399cd3b6ed1a2a7032fb4ebe63bef6681334c5c872c5',
  '665d18a3df16cca33de2bdb20ee7b9766529fcbca8054cf1088d94504591d086',
  '75e1ceae7736d3493b0af6f93e4992ae79fd784d6b7dba071a6243a06af026de',
  '8d22f151ee8c0f871dd047158d8beab9559dd93c47adbd3010b364ded36139b6',
  '9226531864eea362508296a8cb4b01402705a4cd1a0e13c48923dd147ae7f772',
  '93b85970d9059b3f60ddb7587da1caea5f018a735ce4f72236fdc8149d54a00c',
  '9b7aa36786f738d8fbfcdbfb2f4949dc4de1f46078e12f604e5b145af6060e33',
  'ae4ea079735abbe280f3297cdb8d10cfe56129086c3c20fb38876e425b647316',
  'bf18983160473d6e5558b6e46991f7dfa5b44125ef32251eaf90f1bdfc07761b',
  'c1123c268e6db9b5a3095aa4f60264f3e24c37fada52d60777ccf339204fca2f',
  'e799cabb76b388038dd66783c663e4bf5e23a1ad01d62cd5396aa639ef5647e4'
]);

const SKIP = /(^|\/)package-lock\.json$/;

function digest(token) {
  return crypto.createHash('sha256').update(SALT + token).digest('hex');
}

function tokens(line) {
  return line.toLowerCase().match(/[a-z0-9]+(?:_[a-z0-9]+)*/g) || [];
}

function scan(text) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const token of tokens(line)) {
      if (BLOCKED.has(digest(token))) hits.push(index + 1);
    }
  });
  return hits;
}

function selfTest() {
  const sample = 'guardselfcheck';
  BLOCKED.add(digest(sample));
  const planted = 'host = "x.' + sample + '.example"';
  const clean = 'an ordinary line about orders and billing at example.com';
  const caught = scan(planted).length > 0;
  const quiet = scan(clean).length === 0;
  BLOCKED.delete(digest(sample));
  if (!caught) throw new Error('self-test: a planted term was not caught');
  if (!quiet) throw new Error('self-test: a clean line was flagged');
  console.log('self-test: planted term caught, clean line passed');
}

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return 0; }
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  let found = 0;
  for (const file of files) {
    if (SKIP.test(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    for (const line of scan(buffer.toString('utf8'))) {
      console.log('::error file=' + file + ',line=' + line + '::this line names a private organisation, person, host or database');
      found += 1;
    }
  }
  if (found) {
    console.log(found + ' line(s) carry a private name. Use the neutral sample names instead.');
    return 1;
  }
  console.log('clean: ' + files.length + ' tracked files carry no private name');
  return 0;
}

process.exit(main());
