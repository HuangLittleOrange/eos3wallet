'use strict';

// Run only inside scripts/isolated-build.cjs's credential-free container.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const phase = process.argv[2];

function run(command, args, report) {
  const result = spawnSync(command, args, { cwd: '/workspace', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (report) fs.writeFileSync(path.join('/output', report), (result.stdout ?? '') + (result.stderr ?? ''));
  else { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status ?? 'signal'}).`);
}

function verifySource() {
  const files = JSON.parse(fs.readFileSync('/source/SOURCE_MANIFEST.json', 'utf8'));
  for (const [name, expected] of Object.entries(files)) {
    const target = path.join('/workspace', name);
    if (!fs.lstatSync(target).isFile() || crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== expected) {
      throw new Error('Source was modified during dependency execution; review output before release.');
    }
  }
}

try {
  if (!['install', 'verify'].includes(phase) || !fs.existsSync('/source/SOURCE_MANIFEST.json')) throw new Error('Use the isolated-build entry point.');
  process.chdir('/workspace');
  fs.mkdirSync('/tmp/home', { recursive: true });
  if (phase === 'install') {
    // Copy children; replacing/chmodding the volume mount point is disallowed.
    for (const name of fs.readdirSync('/source')) {
      fs.cpSync(path.join('/source', name), path.join('/workspace', name), { recursive: true });
    }
    run('node', ['scripts/dependency-policy.cjs']);
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    run('npm', ['audit', 'signatures', '--json'], 'registry-signatures.json');
    console.log('Registry signatures and available provenance verified.');
  } else {
    verifySource();
    run('npm', ['run', 'patch:dependencies']);
    run('npm', ['test', '--', '--runInBand'], 'tests.txt');
    run('npm', ['run', 'typecheck'], 'typecheck.txt');
    run('node', ['node_modules/expo/bin/cli', 'install', '--check'], 'expo-check.txt');
    for (const platform of ['android', 'ios']) {
      run('node', ['node_modules/expo/bin/cli', 'export', '--platform', platform, '--output-dir', `/output/${platform}`, '--source-maps'], `${platform}-bundle.txt`);
    }
    verifySource();
    fs.writeFileSync('/output/verification.json', JSON.stringify({ registrySignatures: 'passed', tests: 'passed', typecheck: 'passed', expoCompatibility: 'passed', bundles: ['android', 'ios'], networkDuringCodeExecution: 'none', nativeBuild: 'not-run', releaseApproved: false }, null, 2) + '\n');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
