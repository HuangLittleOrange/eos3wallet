import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { verifyDependencyPolicy } = require('../dependency-policy.cjs');
const { copyPublicSource, containerArgs } = require('../isolated-build.cjs');
const root = path.resolve(import.meta.dirname, '../..');

function fixture(edit = () => {}, approve = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-policy-test-'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'dependency-policy.json')));
  edit(lock, policy);
  const raw = JSON.stringify(lock, null, 2) + '\n';
  if (approve) policy.lockSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  fs.writeFileSync(path.join(directory, 'package-lock.json'), raw);
  fs.writeFileSync(path.join(directory, 'dependency-policy.json'), JSON.stringify(policy));
  fs.copyFileSync(path.join(root, '.npmrc'), path.join(directory, '.npmrc'));
  return directory;
}

test('approved registry inventory and locked installation policy pass', () => {
  assert.deepEqual(verifyDependencyPolicy(root), { packages: 929, blockedInstallScripts: 1 });
});

test('unreviewed lock changes fail even with a valid npm lockfile', () => {
  const directory = fixture((lock) => { lock.packages['node_modules/elliptic'].version = '99.0.0'; }, false);
  try { assert.throws(() => verifyDependencyPolicy(directory), /Lockfile changed/); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('registry, integrity, links and newly introduced scripts are rejected independently of checksum approval', () => {
  for (const edit of [
    (lock) => { lock.packages['node_modules/elliptic'].resolved = 'https://example.invalid/package.tgz'; },
    (lock) => { delete lock.packages['node_modules/elliptic'].integrity; },
    (lock) => { lock.packages['node_modules/elliptic'].link = true; },
    (lock) => { lock.packages['node_modules/elliptic'].hasInstallScript = true; },
    (lock) => { lock.packages['node_modules/elliptic'].resolved = 'https://user:secret@registry.npmjs.org/package.tgz'; },
  ]) {
    const directory = fixture(edit);
    try { assert.throws(() => verifyDependencyPolicy(directory)); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test('npm configuration cannot silently re-enable scripts or add credentials', () => {
  const directory = fixture();
  try {
    fs.appendFileSync(path.join(directory, '.npmrc'), '\nignore-scripts=false\n');
    assert.throws(() => verifyDependencyPolicy(directory), /Unexpected npm configuration/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('environment overrides cannot re-enable install scripts or redirect the registry', () => {
  for (const [name, value] of [['NPM_CONFIG_IGNORE_SCRIPTS', 'false'], ['NPM_CONFIG_REGISTRY', 'https://example.invalid/']]) {
    const previous = process.env[name];
    try {
      process.env[name] = value;
      assert.throws(() => verifyDependencyPolicy(root), /refusing to proceed/);
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  }
});

test('container source snapshot excludes environment, history, credentials and local artifacts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-snapshot-test-'));
  try {
    const inventory = root === '/workspace' ? '/source/SOURCE_MANIFEST.json' : path.join(root, 'SOURCE_MANIFEST.json');
    const paths = fs.existsSync(inventory) ? Object.keys(JSON.parse(fs.readFileSync(inventory))) : undefined;
    const manifest = copyPublicSource(directory, paths);
    assert.ok(manifest['src/crypto/vault.ts']);
    assert.ok(manifest['.npmrc']);
    assert.ok(manifest['dependency-policy.json']);
    for (const name of Object.keys(manifest)) assert.doesNotMatch(name, /(^|\/)(\.env|\.git\/|\.codex\/|\.claude\/|credentials\/|backups\/|exports\/|android\/|ios\/)/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('npm ci skips both root and dependency install hooks with the project configuration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-hook-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'dep'));
    const hook = 'node -e "require(\'fs\').writeFileSync(\'hook-ran\',\'unexpected\')"';
    fs.writeFileSync(path.join(directory, 'dep/package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', scripts: { install: hook, postinstall: hook } }));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'hook-policy-fixture', version: '1.0.0', scripts: { postinstall: hook }, dependencies: { 'fixture-dependency': 'file:dep' } }));
    fs.copyFileSync(path.join(root, '.npmrc'), path.join(directory, '.npmrc'));
    const env = { PATH: process.env.PATH, HOME: directory, NPM_CONFIG_CACHE: path.join(directory, 'cache'), NPM_CONFIG_USERCONFIG: path.join(directory, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: '/dev/null' };
    for (const args of [['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], ['ci', '--no-audit', '--no-fund']]) {
      const result = spawnSync('npm', args, { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(fs.existsSync(path.join(directory, 'hook-ran')), false);
    assert.equal(fs.existsSync(path.join(directory, 'dep/hook-ran')), false);
    assert.equal(fs.existsSync(path.join(directory, 'node_modules/fixture-dependency/hook-ran')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('dependency execution has no network, host home, Docker socket or inherited environment', () => {
  const args = containerArgs('node@sha256:example', '/public/source', '/public/output', 'test-volume', 'none', 'verify');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('type=bind,src=/public/source,dst=/source,readonly'));
  assert.doesNotMatch(args.join(' '), /docker\.sock|--privileged|--env-file|--network=host/);
  for (let i = 0; i < args.length; i++) if (args[i] === '--env') assert.ok(args[i + 1].includes('='));
});
