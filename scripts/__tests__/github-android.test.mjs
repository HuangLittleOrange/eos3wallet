import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { context, checksums, verifyChecksums, sameRun, unsignedFiles, signedFiles } = require('../github-android.cjs');
const workflow = require('yaml').parse(fs.readFileSync(new URL('../../.github/workflows/android-build.yml', import.meta.url), 'utf8'));
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/wallet', GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com',
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const pythonAvailable = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

test('provenance context refuses PRs, other branches, missing commit and malformed repository', () => {
  const info = context(env);
  assert.equal(info.commit, env.GITHUB_SHA);
  assert.match(info.runUrl, /\/actions\/runs\/123\/attempts\/1$/);
  for (const override of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/dev' },
    { GITHUB_SHA: undefined }, { GITHUB_REPOSITORY: 'example/wallet\nother' }, { GITHUB_ACTIONS: 'false' }]) {
    assert.throws(() => context({ ...env, ...override }), /must use a main commit/);
  }
  assert.throws(() => sameRun({ ...info, runAttempt: '2' }, info), /different/);
});

test('artifact verification refuses replacement APKs, unlisted files in checksum manifest and symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-checksum-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'unsigned.apk'), 'original');
    checksums(dir, ['unsigned.apk']);
    verifyChecksums(dir, ['unsigned.apk']);
    fs.writeFileSync(path.join(dir, 'unsigned.apk'), 'replaced');
    assert.throws(() => verifyChecksums(dir, ['unsigned.apk']), /mismatch/);
    checksums(dir, ['unsigned.apk']);
    fs.appendFileSync(path.join(dir, 'SHA256SUMS'), '0'.repeat(64) + '  ../../private-file\n');
    assert.throws(() => verifyChecksums(dir, ['unsigned.apk']), /mismatch/);
    fs.renameSync(path.join(dir, 'unsigned.apk'), path.join(dir, 'original'));
    fs.symlinkSync(path.join(dir, 'original'), path.join(dir, 'unsigned.apk'));
    assert.throws(() => checksums(dir, ['unsigned.apk']), /regular/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workflow keeps main-only triggers and grants attestation authority only to a clean job', () => {
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
  assert.equal(workflow.jobs.build.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with.ref, '${{ github.sha }}');
        assert.equal(step.with['persist-credentials'], false);
      }
    }
    if (!['attest', 'release'].includes(name)) assert.equal(job.permissions, undefined);
  }
  assert.deepEqual(workflow.jobs.attest.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.ok(!workflow.jobs.attest.steps.some((step) => step.uses?.startsWith('actions/checkout@')));
  assert.ok(!workflow.jobs.attest.steps.some((step) => /node |npm |scripts\//.test(step.run ?? '')));
  assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs.release.needs, ['build', 'test-sign', 'attest']);
  assert.equal(workflow.jobs.release.if, "github.ref == 'refs/heads/main'");
  assert.ok(!workflow.jobs.release.steps.some((step) => step.uses?.startsWith('actions/checkout@')));
  assert.ok(!workflow.jobs.release.steps.some((step) => /node |npm |scripts\//.test(step.run ?? '')));
  const sparse = workflow.jobs['test-sign'].steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['sparse-checkout'];
  assert.doesNotMatch(sparse, /\/src\/|package[.]json|node_modules|gradle/);
});

function inlinePython(step) {
  const script = step.run.split("python3 - <<'PY'\n")[1]?.split('\nPY')[0];
  assert.ok(script, 'inline verification script exists');
  return script;
}

function evidenceFixture(directory) {
  const unsigned = path.join(directory, 'evidence/unsigned'), signed = path.join(directory, 'evidence/signed');
  fs.mkdirSync(unsigned, { recursive: true }); fs.mkdirSync(signed, { recursive: true });
  for (const name of unsignedFiles) fs.writeFileSync(path.join(unsigned, name), 'public fixture');
  for (const name of signedFiles) fs.writeFileSync(path.join(signed, name), 'public fixture');
  checksums(unsigned, unsignedFiles); checksums(signed, signedFiles);
  const hashOf = (target, name) => fs.readFileSync(path.join(target, 'SHA256SUMS'), 'utf8').split('\n').find((line) => line.endsWith(`  ${name}`)).slice(0, 64);
  const unsignedHash = hashOf(unsigned, unsignedFiles[0]), signedHash = hashOf(signed, signedFiles[0]);
  const info = context(env), certificate = 'b'.repeat(64);
  const legal = path.join(directory, 'evidence/legal');
  const licenseNames = ['docs/dependency-security.md', 'third-party/fixture-license.txt'];
  const files = {};
  for (const name of licenseNames) {
    const target = path.join(legal, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'public license fixture'); files[name] = sha256(fs.readFileSync(target));
  }
  const manifest = JSON.stringify({ files }); fs.writeFileSync(path.join(unsigned, 'source-manifest.json'), manifest);
  fs.writeFileSync(path.join(unsigned, 'build-info.json'), JSON.stringify({ ...info, productionSigning: false, sha256: unsignedHash, sourceManifestSha256: sha256(manifest) }));
  fs.writeFileSync(path.join(signed, 'sign-info.json'), JSON.stringify({ ...info, productionSigning: false, sha256: signedHash, unsignedSha256: unsignedHash, certificateSha256: certificate }));
  fs.writeFileSync(path.join(signed, 'wallet-review-test-signed.apk.json'), JSON.stringify({ unsignedSha256: unsignedHash, signedSha256: signedHash, certificateSha256: certificate, signatureVerified: true, alignment16KbVerified: true }));
  checksums(unsigned, unsignedFiles); checksums(signed, signedFiles);
  return { unsigned, signed, legal };
}

test('actual OIDC job verification rejects substituted APKs even with updated checksum files and rejects another run', { skip: pythonAvailable ? false : 'Python 3 is needed to exercise Ubuntu workflow steps' }, () => {
  const script = inlinePython(workflow.jobs.attest.steps.find((step) => step.name?.startsWith('Verify artifacts')));
  for (const variant of ['valid', 'replacement', 'other-run', 'signature-missing', 'license-replaced']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-evidence-test-'));
    try {
      const { unsigned, signed, legal } = evidenceFixture(directory);
      if (variant === 'license-replaced') fs.writeFileSync(path.join(legal, 'third-party/fixture-license.txt'), 'replaced');
      if (variant === 'replacement') fs.writeFileSync(path.join(signed, signedFiles[0]), 'replacement APK');
      if (variant === 'other-run') {
        const file = path.join(unsigned, 'build-info.json');
        const metadata = JSON.parse(fs.readFileSync(file)); metadata.runId = '999'; fs.writeFileSync(file, JSON.stringify(metadata));
      }
      if (variant === 'signature-missing') {
        const file = path.join(signed, 'wallet-review-test-signed.apk.json');
        const proof = JSON.parse(fs.readFileSync(file)); proof.signatureVerified = false; fs.writeFileSync(file, JSON.stringify(proof));
      }
      checksums(unsigned, unsignedFiles); checksums(signed, signedFiles);
      const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env, RUNNER_TEMP: directory } });
      if (variant === 'valid') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readdirSync(path.join(directory, 'public-apk')).length, unsignedFiles.length + signedFiles.length + 2);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /mismatch|missing|differs/);
        assert.equal(fs.readdirSync(path.join(directory, 'public-apk')).length, 0);
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test('publication hashes the downloaded bundle and all outputs and binds CLI instructions to the commit', { skip: pythonAvailable ? false : 'Python 3 is needed to exercise Ubuntu workflow steps' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-summary-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'public-apk'));
    fs.writeFileSync(path.join(directory, 'public-apk', signedFiles[0]), 'signed fixture');
    fs.mkdirSync(path.join(directory, 'public-apk/third-party'));
    fs.writeFileSync(path.join(directory, 'public-apk/third-party/fixture-license.txt'), 'license');
    const bundle = path.join(directory, 'bundle.jsonl'); fs.writeFileSync(bundle, '{"fixture":true}\n');
    const summary = path.join(directory, 'summary.md');
    const script = inlinePython(workflow.jobs.attest.steps.find((step) => step.name?.startsWith('Publish SHA256')));
    const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env, RUNNER_TEMP: directory, ATTESTATION_BUNDLE: bundle, GITHUB_STEP_SUMMARY: summary } });
    assert.equal(result.status, 0, result.stderr);
    verifyChecksums(path.join(directory, 'public-apk'), ['provenance.jsonl', 'third-party/fixture-license.txt', signedFiles[0]]);
    assert.match(fs.readFileSync(summary, 'utf8'), new RegExp(`--source-digest ${env.GITHUB_SHA}`));
    assert.match(fs.readFileSync(summary, 'utf8'), /--signer-workflow example\/wallet\//);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('release preparation refuses foreign builds, unsigned evidence, replaced APKs and unsafe inventories', { skip: !pythonAvailable }, () => {
  const prepare = inlinePython(workflow.jobs.release.steps.find((step) => step.name?.startsWith('Verify release inventory')));
  const assemble = inlinePython(workflow.jobs.attest.steps.find((step) => step.name?.startsWith('Verify artifacts')));
  const manifest = inlinePython(workflow.jobs.attest.steps.find((step) => step.name?.startsWith('Publish SHA256')));
  for (const variant of ['valid', 'replacement', 'other-run', 'signature-missing', 'symlink', 'traversal', 'extra-file', 'other-branch']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-release-test-'));
    try {
      evidenceFixture(dir);
      const summary = path.join(dir, 'summary.md'), bundle = path.join(dir, 'bundle.jsonl');
      fs.writeFileSync(bundle, '{"fixture":true}\n');
      const childEnv = { PATH: process.env.PATH, ...env, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, ATTESTATION_BUNDLE: bundle };
      for (const script of [assemble, manifest]) {
        const result = spawnSync('python3', ['-c', script], { env: childEnv, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      const input = path.join(dir, 'release-input');
      fs.renameSync(path.join(dir, 'public-apk'), input);
      if (variant === 'replacement') fs.writeFileSync(path.join(input, signedFiles[0]), 'replaced APK');
      if (variant === 'other-run') {
        const file = path.join(input, 'build-info.json');
        const info = JSON.parse(fs.readFileSync(file)); info.runId = '456'; fs.writeFileSync(file, JSON.stringify(info));
      }
      if (variant === 'signature-missing') {
        const file = path.join(input, 'wallet-review-test-signed.apk.json');
        const proof = JSON.parse(fs.readFileSync(file)); proof.signatureVerified = false; fs.writeFileSync(file, JSON.stringify(proof));
      }
      if (variant === 'symlink') {
        fs.writeFileSync(path.join(dir, 'external'), 'external data');
        fs.symlinkSync(path.join(dir, 'external'), path.join(input, 'linked-secret'));
      }
      if (['other-run', 'signature-missing', 'symlink'].includes(variant)) {
        const names = fs.readFileSync(path.join(input, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split('  ')[1]);
        if (variant === 'symlink') names.push('linked-secret');
        fs.writeFileSync(path.join(input, 'SHA256SUMS'), names.map((name) => `${sha256(fs.readFileSync(path.join(input, name)))}  ${name}\n`).join(''));
      }
      if (variant === 'traversal') {
        fs.writeFileSync(path.join(dir, 'external'), 'external data');
        fs.appendFileSync(path.join(input, 'SHA256SUMS'), `${sha256('external data')}  ../external\n`);
      }
      if (variant === 'extra-file') fs.writeFileSync(path.join(input, 'unexpected.apk'), 'extra APK');
      if (variant === 'other-branch') childEnv.GITHUB_REF = 'refs/heads/dev';
      const result = spawnSync('python3', ['-c', prepare], { env: childEnv, encoding: 'utf8' });
      if (variant === 'valid') {
        assert.equal(result.status, 0, result.stderr);
        const plan = JSON.parse(fs.readFileSync(path.join(dir, 'release-output/plan.json')));
        assert.equal(plan.commit, env.GITHUB_SHA);
        assert.equal(plan.tag, `android-test-${env.GITHUB_SHA}-123-1`);
        assert.ok(plan.assets.some((asset) => asset.name === 'provenance.jsonl'));
        for (const asset of plan.assets) assert.equal(sha256(fs.readFileSync(asset.path)), asset.sha256);
        const notes = fs.readFileSync(plan.notes, 'utf8');
        assert.match(notes, /预发布测试版/);
        assert.ok(notes.includes(`--source-digest ${env.GITHUB_SHA}`));
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /mismatch|Unsafe|regular|Invalid|forbidden/);
        assert.ok(!fs.existsSync(path.join(dir, 'release-output/plan.json')));
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
