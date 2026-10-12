'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function verifyDependencyPolicy(directory = root) {
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toLowerCase() === 'npm_config_ignore_scripts' && value !== 'true') {
      throw new Error('Install scripts were re-enabled through npm configuration; refusing to proceed.');
    }
    if (name.toLowerCase() === 'npm_config_registry' && value !== 'https://registry.npmjs.org/') {
      throw new Error('The npm registry was overridden; refusing to proceed.');
    }
  }
  const policy = JSON.parse(fs.readFileSync(path.join(directory, 'dependency-policy.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(directory, 'package-lock.json'));
  if (hash(raw) !== policy.lockSha256) throw new Error('Lockfile changed; review dependency sources and scripts before approving a new checksum.');
  const lock = JSON.parse(raw);
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Expected npm lockfile version 3.');
  const config = fs.readFileSync(path.join(directory, '.npmrc'), 'utf8').trim();
  if (config !== 'registry=https://registry.npmjs.org/\nignore-scripts=true\nsave-exact=true') {
    throw new Error('Unexpected npm configuration; review registry, credentials and install-script policy.');
  }
  const scripts = [];
  let count = 0;
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (!/^node_modules\//.test(location) || location.split('/').includes('..') || pkg.link) throw new Error('Local or linked dependencies are not approved.');
    const url = new URL(pkg.resolved);
    if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) {
      throw new Error('Dependency resolved outside the approved npm registry.');
    }
    const integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(pkg.integrity ?? '');
    if (!integrity || Buffer.from(integrity[1], 'base64').length !== 64) throw new Error('Dependency is missing SHA-512 integrity.');
    if (pkg.hasInstallScript) scripts.push(`${location}@${pkg.version}`);
    count++;
  }
  if (JSON.stringify(scripts.sort()) !== JSON.stringify([...policy.blockedInstallScripts].sort())) {
    throw new Error('Install-script inventory changed; review it even though scripts remain disabled.');
  }
  return { packages: count, blockedInstallScripts: scripts.length };
}

module.exports = { verifyDependencyPolicy };
if (require.main === module) {
  try { console.log('Dependency source policy verified:', verifyDependencyPolicy()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
