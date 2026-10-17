'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { verifyDependencyPolicy } = require('./dependency-policy.cjs');
const root = path.resolve(__dirname, '..');

function sourcePaths() {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
}

function copyPublicSource(destination, paths = sourcePaths()) {
  const manifest = {};
  for (const name of paths) {
    // Never follow links or copy local tools, credentials, environment or native output.
    if (name.split('/').some((part) => part === '..') || path.isAbsolute(name)) throw new Error('Unexpected source path.');
    if (/(^|\/)(?:\.git|\.claude|\.codex|node_modules|backups|exports|credentials)(?:\/|$)|(^|\/)\.env|(^|\/)credentials\.json$|\.(?:pem|key|p8|p12|pfx|jks|keystore|mobileprovision|apk|aab|ipa|log)$/i.test(name)) continue;
    // Local Expo modules contain reviewed native source. Generated platform
    // projects and module build output still never enter the public snapshot.
    if (/(^|\/)(?:android|ios)(?:\/|$)/i.test(name) &&
      !/^modules\/[^/]+\/android\/(?:build\.gradle|src\/main\/(?:AndroidManifest\.xml|java\/.+\.kt))$/.test(name)) continue;
    const source = path.join(root, name);
    if (!fs.existsSync(source)) continue;
    if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) throw new Error('Symlinks and non-file source entries are not allowed.');
    const data = fs.readFileSync(source);
    manifest[name] = crypto.createHash('sha256').update(data).digest('hex');
    fs.mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
    fs.writeFileSync(path.join(destination, name), data);
  }
  return manifest;
}

function containerArgs(image, input, output, volume, network, phase) {
  return ['run', '--rm', '--read-only', '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--network', network, '--pids-limit', '256', '--memory', '4g', '--cpus', '4',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,src=${input},dst=/source,readonly`,
    '--mount', `type=bind,src=${output},dst=/output`,
    '--mount', `type=volume,src=${volume},dst=/workspace`,
    '--env', 'HOME=/tmp/home', '--env', 'CI=1',
    '--env', 'EXPO_NO_DOTENV=1', '--env', 'EXPO_NO_TELEMETRY=1',
    '--env', 'NPM_CONFIG_IGNORE_SCRIPTS=true', '--env', 'NPM_CONFIG_USERCONFIG=/tmp/home/.npmrc',
    '--env', 'NPM_CONFIG_CACHE=/workspace/.npm-cache',
    image, 'node', '/source/scripts/isolated-worker.cjs', phase];
}

module.exports = { copyPublicSource, containerArgs };

if (require.main === module) {
  const id = crypto.randomUUID();
  const volume = `eostp-review-${id}`;
  let temporary;
  function docker(args) {
    const result = spawnSync('docker', args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Isolated Docker step failed (${result.status ?? 'signal'}); no host-build fallback was used.`);
  }
  try {
    const testsOnly = process.argv.length === 3 && process.argv[2] === '--tests-only';
    if (process.argv.length > 2 && !testsOnly) throw new Error('Only --tests-only is supported; local environment files are never loaded.');
    verifyDependencyPolicy();
    const scan = spawnSync(process.execPath, ['scripts/check-source.mjs'], { cwd: root, stdio: 'inherit' });
    if (scan.status !== 0) throw new Error('Public source scan failed.');
    const image = JSON.parse(fs.readFileSync(path.join(root, 'dependency-policy.json'), 'utf8')).buildImage;
    if (!/^node@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Build image must be approved by immutable digest.');
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'eostp-review-'));
    const input = path.join(temporary, 'source');
    fs.mkdirSync(input);
    const output = path.join(root, 'exports', 'isolated-review', id);
    fs.mkdirSync(output, { recursive: true });
    // This newly created directory contains only public review outputs.
    fs.chmodSync(output, 0o777);
    const manifest = copyPublicSource(input);
    fs.writeFileSync(path.join(input, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest));
    // Docker's unprivileged user must be able to read this public-only snapshot.
    for (const name of ['', ...fs.readdirSync(input, { recursive: true })]) {
      const target = path.join(input, name);
      fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o755 : 0o644);
    }
    fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify({ image, files: manifest }, null, 2) + '\n');
    const cached = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
    const digests = cached.status === 0 ? JSON.parse(cached.stdout)[0].RepoDigests ?? [] : [];
    if (!digests.includes(image)) docker(['pull', image]);
    docker(['volume', 'create', volume]);
    // Only an empty Docker volume is writable during this root-owned setup step.
    docker(['run', '--rm', '--network=none', '--read-only', '--mount', `type=volume,src=${volume},dst=/workspace`, image, 'chown', '1000:1000', '/workspace']);
    docker(containerArgs(image, input, output, volume, 'bridge', 'install'));
    // Dependencies execute only after network access has been removed.
    docker(containerArgs(image, input, output, volume, 'none', testsOnly ? 'verify-tests' : 'verify'));
    console.log(`Isolated ${testsOnly ? 'tests and typecheck' : 'checks and Android/iOS JavaScript bundles'} passed. Reports: ${path.relative(root, output)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
