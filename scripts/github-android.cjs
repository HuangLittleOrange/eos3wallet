'use strict';

// The CI controller uses Node built-ins only; it never installs npm packages.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const unsignedName = 'wallet-review-unsigned.apk';
const signedName = 'wallet-review-test-signed.apk';

function context(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
      env.GITHUB_SERVER_URL !== 'https://github.com') throw new Error('Public Android builds must use a main commit in GitHub Actions.');
  return {
    repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF, commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/tree/${env.GITHUB_SHA}`,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
  };
}

function checkedFile(directory, name) {
  const target = path.join(directory, name);
  if (!fs.lstatSync(target).isFile()) throw new Error(`Expected a regular artifact file: ${name}`);
  return fs.readFileSync(target);
}

function checksums(directory, names) {
  const text = names.map((name) => `${sha256(checkedFile(directory, name))}  ${name}\n`).join('');
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), text);
}

function verifyChecksums(directory, names) {
  const expected = checkedFile(directory, 'SHA256SUMS').toString('utf8');
  const actual = names.map((name) => `${sha256(checkedFile(directory, name))}  ${name}\n`).join('');
  if (expected !== actual) throw new Error('Artifact inventory or SHA256 mismatch.');
}

function sameRun(metadata, expected) {
  for (const key of ['repository', 'ref', 'commit', 'runId', 'runAttempt']) {
    if (metadata[key] !== expected[key]) throw new Error('Artifact belongs to a different source commit or workflow run.');
  }
}

function checkoutContext() {
  const info = context();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (commit !== info.commit) throw new Error('Checkout does not match the workflow commit.');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim()) {
    throw new Error('Checkout has local changes; refusing to claim it was built from the recorded commit.');
  }
  return info;
}

const unsignedFiles = [unsignedName, 'build-info.json', 'source-manifest.json', 'verification.json',
  'java-version.txt', 'sandbox-probe.txt', 'install.txt', 'build.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
const signedFiles = [signedName, `${signedName}.json`, 'sign-info.json'];

function packageBuild(input, destination) {
  const info = checkoutContext();
  const manifestBytes = checkedFile(input, 'source-manifest.json');
  const manifest = JSON.parse(manifestBytes).files;
  const { copyPublicSource } = require('./isolated-build.cjs');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'github-source-check-'));
  try {
    const current = copyPublicSource(temporary);
    if (JSON.stringify(current) !== JSON.stringify(manifest)) throw new Error('Built source inventory differs from the checkout.');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const verification = JSON.parse(checkedFile(input, 'verification.json'));
  const apk = checkedFile(input, unsignedName);
  if (!verification.sourceMatchesSnapshot || verification.productionSigning !== false ||
      verification.signing !== 'not-run; unsigned APK only' || verification.unsignedSha256 !== sha256(apk)) {
    throw new Error('Unsigned build verification failed.');
  }
  // Start with an empty destination and copy only explicitly public outputs.
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error('Artifact destination must be empty.');
  for (const name of unsignedFiles.filter((name) => !['build-info.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(name))) {
    fs.writeFileSync(path.join(destination, name), checkedFile(input, name));
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.writeFileSync(path.join(destination, name), checkedFile(root, name));
  const policy = JSON.parse(checkedFile(root, 'native-build-policy.json'));
  fs.writeFileSync(path.join(destination, 'build-info.json'), JSON.stringify({
    ...info, artifact: unsignedName, sha256: sha256(apk), node: process.version,
    expo: verification.expo, platform: `${process.platform}-${process.arch}`,
    android: { sdk: policy.platform, buildTools: policy.buildTools, ndk: policy.ndk, cmake: policy.cmake, gradle: policy.gradle.version },
    lockfileSha256: sha256(checkedFile(root, 'package-lock.json')),
    nativePolicySha256: sha256(checkedFile(root, 'native-build-policy.json')),
    sourceManifestSha256: sha256(manifestBytes), productionSigning: false, reproducibilityVerified: false,
  }, null, 2) + '\n');
  checksums(destination, unsignedFiles);
}

function packageSignature(input, destination) {
  const info = checkoutContext();
  verifyChecksums(input, unsignedFiles);
  const metadata = JSON.parse(checkedFile(input, 'build-info.json'));
  sameRun(metadata, info);
  if (metadata.sha256 !== sha256(checkedFile(input, unsignedName))) throw new Error('Unsigned APK metadata mismatch.');
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error('Artifact destination must be empty.');
  const sdk = fs.realpathSync(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
  const java = fs.realpathSync(execFileSync('/usr/bin/which', ['java'], { encoding: 'utf8' }).trim());
  const { signTestApk } = require('./sign-android-test.cjs');
  const signed = signTestApk(path.join(input, unsignedName), metadata.sha256, path.join(destination, signedName), sdk, path.dirname(path.dirname(java)));
  fs.writeFileSync(path.join(destination, 'sign-info.json'), JSON.stringify({
    ...info, artifact: signedName, sha256: signed.signedSha256,
    unsignedSha256: metadata.sha256, certificateSha256: signed.certificateSha256,
    productionSigning: false, purpose: 'test only; a fresh temporary key is deleted after each run',
  }, null, 2) + '\n');
  checksums(destination, signedFiles);
}

function installSdk(signOnly = false) {
  const policy = JSON.parse(checkedFile(root, 'native-build-policy.json'));
  const sdk = fs.realpathSync(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
  const components = signOnly ? [`build-tools/${policy.buildTools}`] :
    [`platforms/${policy.platform}`, ...[policy.buildTools, ...(policy.additionalBuildTools ?? [])].map((value) => `build-tools/${value}`), `ndk/${policy.ndk}`, `cmake/${policy.cmake}`];
  const packages = components.map((component) => component.replace('/', ';'));
  execFileSync(path.join(sdk, 'cmdline-tools/latest/bin/sdkmanager'), [`--sdk_root=${sdk}`, ...packages], { stdio: 'inherit' });
  for (const component of components) if (!fs.existsSync(path.join(sdk, component))) throw new Error('Required SDK component was not installed.');
}

module.exports = { context, checkedFile, checksums, verifyChecksums, sameRun, unsignedFiles, signedFiles };
if (require.main === module) {
  try {
    const [command, input, destination, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Unexpected CI arguments.');
    if (command === 'sdk' && !input && !destination) installSdk();
    else if (command === 'sign-sdk' && !input && !destination) installSdk(true);
    else if (command === 'package-build' && input && destination) packageBuild(path.resolve(input), path.resolve(destination));
    else if (command === 'sign' && input && destination) packageSignature(path.resolve(input), path.resolve(destination));
    else throw new Error('Usage: github-android.cjs sdk | sign-sdk | package-build INPUT OUTPUT | sign INPUT OUTPUT');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
