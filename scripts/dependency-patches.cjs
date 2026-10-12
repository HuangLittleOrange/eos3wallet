'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function inspectPatches(apply) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const pending = [];
  for (const name of ['elliptic-6.6.1.json', 'node-forge-1.4.0.json']) {
    const patch = JSON.parse(fs.readFileSync(path.join(root, 'patches', name), 'utf8'));
    const locations = Object.keys(lock.packages).filter((location) =>
      location === `node_modules/${patch.package}` || location.endsWith(`/node_modules/${patch.package}`)
    );
    if (!locations.length) throw new Error(`${patch.package}: dependency missing; review its patch before proceeding`);
    for (const location of locations) {
      const directory = path.join(root, location);
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name !== patch.package || pkg.version !== patch.version || lock.packages[location].version !== patch.version) {
        throw new Error(`${patch.package}: version changed; review its patch before proceeding`);
      }
      for (const file of patch.files) {
        const target = path.resolve(directory, file.path);
        const real = fs.realpathSync(target);
        if (!real.startsWith(`${fs.realpathSync(directory)}${path.sep}`)) throw new Error(`${patch.package}: unexpected patch target`);
        const original = fs.readFileSync(target, 'utf8');
        const hash = sha256(original);
        if (hash === file.after_sha256) continue;
        if (!apply) throw new Error(`${patch.package}: security patch missing; run npm run patch:dependencies`);
        if (hash !== file.before_sha256) throw new Error(`${patch.package}: source changed; refusing to apply an unverified patch`);
        let result = original;
        for (const change of file.changes) {
          if (result.split(change.before).length !== 2) throw new Error(`${patch.package}: patch context is not unique`);
          result = result.replace(change.before, change.after);
        }
        if (sha256(result) !== file.after_sha256) throw new Error(`${patch.package}: patched source checksum mismatch`);
        pending.push({ target, result });
      }
    }
  }
  // Validate every target before writing any of them; unknown versions fail closed.
  for (const item of pending) fs.writeFileSync(item.target, item.result);
  return pending.length;
}

function verifyDependencyPatches() { inspectPatches(false); }
module.exports = { verifyDependencyPatches };

if (require.main === module) {
  try {
    const mode = process.argv[2];
    if (mode !== '--apply' && mode !== '--check') throw new Error('Use --apply or --check');
    const count = inspectPatches(mode === '--apply');
    console.log(`Dependency security patches verified${count ? `; applied ${count} file patches` : ''}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
