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
function sha256CertificateFixture() { return createHash('sha256').update('public certificate fixture').digest('hex'); }
const env = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/wallet', GITHUB_RUN_ID: '123',
  RELEASE_CERTIFICATE_SHA256: sha256CertificateFixture(),
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
      if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+(?:\/(?:restore|save))?@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with.ref, '${{ github.sha }}');
        assert.equal(step.with['persist-credentials'], false);
      }
    }
    if (!['attest', 'release', 'reserve-release-tag'].includes(name)) assert.equal(job.permissions, undefined);
  }
  assert.deepEqual(workflow.jobs.attest.permissions, { contents: 'read', 'id-token': 'write', attestations: 'write' });
  assert.ok(!workflow.jobs.attest.steps.some((step) => step.uses?.startsWith('actions/checkout@')));
  assert.ok(!workflow.jobs.attest.steps.some((step) => /node |npm |scripts\//.test(step.run ?? '')));
  assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs['reserve-release-tag'].permissions, { contents: 'write' });
  assert.equal(workflow.jobs.build.needs, 'reserve-release-tag');
  assert.equal(workflow.jobs['reserve-release-tag'].if, "github.ref == 'refs/heads/main'");
  assert.ok(!workflow.jobs['reserve-release-tag'].steps.some((step) => step.uses?.includes('checkout') || /node |npm |scripts\//.test(step.run ?? '')));
  assert.deepEqual(workflow.jobs.release.needs, ['build', 'release-sign', 'attest']);
  assert.equal(workflow.jobs.release.if, "github.ref == 'refs/heads/main'");
  assert.ok(!workflow.jobs.release.steps.some((step) => step.uses?.startsWith('actions/checkout@')));
  assert.ok(!workflow.jobs.release.steps.some((step) => /node |npm |scripts\//.test(step.run ?? '')));
  const sparse = workflow.jobs['release-sign'].steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['sparse-checkout'];
  assert.doesNotMatch(sparse, /\/src\/|package[.]json|node_modules|gradle/);
  assert.equal(workflow.jobs['release-sign'].environment, 'android-production-signing');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      const secretVariables = Object.entries(step.env ?? {}).filter(([, value]) => /secrets\./.test(String(value)));
      if (secretVariables.length) {
        assert.equal(name, 'release-sign');
        assert.match(step.run, /^node scripts\/github-android\.cjs sign /);
        assert.equal(secretVariables.length, 2);
      }
    }
  }
  assert.match(workflow.env.RELEASE_CERTIFICATE_SHA256, /^[a-f0-9]{64}$/);
});

test('public download cache is exact-key, build-only and excludes executable build outputs and secrets', () => {
  const steps = workflow.jobs.build.steps;
  const restore = steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
  const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
  const paths = ['.codex/native-build-cache/gradle-9.3.1-bin.zip', '.codex/native-build-cache/modules-2', '.codex/native-build-cache/npm-cache/_cacache'];
  assert.deepEqual(restore.with.path.trim().split('\n'), paths);
  assert.deepEqual(save.with.path.trim().split('\n'), paths);
  assert.equal(restore.with['restore-keys'], undefined);
  assert.match(restore.with.key, /hashFiles\(.*package-lock[.]json.*native-build-policy[.]json.*dependency-policy[.]json/);
  const discard = steps.find((step) => step.name === 'Discard a non-exact cache match');
  assert.equal(discard.if, "steps.public-cache.outputs.cache-hit != 'true'");
  assert.equal(discard.run, 'rm -rf .codex/native-build-cache');
  assert.ok(steps.indexOf(discard) > steps.indexOf(restore));
  assert.ok(steps.indexOf(save) > steps.findIndex((step) => step.run?.includes('--prepare-cache')));
  assert.ok(steps.indexOf(save) < steps.findIndex((step) => step.id === 'native'));
  assert.equal(save.if, "steps.public-cache.outputs.cache-hit != 'true'");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'build') assert.ok(!job.steps.some((step) => step.uses?.startsWith('actions/cache/')));
  }
});

function inlinePython(step) {
  const script = step.run.split("python3 - <<'PY'\n")[1]?.split('\nPY')[0];
  assert.ok(script, 'inline verification script exists');
  return script;
}

test('actual tag preflight reserves only the current public main source and fails before compilation on denied permissions or moved source', { skip: !pythonAvailable }, () => {
  const script = inlinePython(workflow.jobs['reserve-release-tag'].steps[0]);
  for (const variant of ['create', 'existing', 'advanced', 'denied', 'wrong-tag', 'private']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tag-preflight-test-'));
    try {
      const stateFile = path.join(dir, 'state.json');
      fs.writeFileSync(stateFile, JSON.stringify({ variant, calls: [], exists: ['existing', 'wrong-tag'].includes(variant) }));
      const mock = `#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ['FAKE_GH_STATE']); s = json.loads(p.read_text()); args = sys.argv[1:]; s['calls'].append(args); p.write_text(json.dumps(s))
sha = os.environ['GITHUB_SHA']; endpoint = args[-1]
if '--method' in args:
    assert args[args.index('--method')+1] == 'POST'
    assert f'sha={sha}' in args
    assert f'ref=refs/tags/android-prerelease-{sha}-123-1' in args
    if s['variant'] == 'denied':
        print('Resource not accessible by integration (HTTP 403)',file=sys.stderr); sys.exit(1)
    s['exists'] = True; p.write_text(json.dumps(s)); print('{}')
elif endpoint.endswith('/git/ref/heads/main'):
    print(json.dumps({'object':{'type':'commit','sha':'b'*40 if s['variant']=='advanced' else sha}}))
elif '/git/ref/tags/' in endpoint:
    if not s['exists']:
        print('Not Found (HTTP 404)',file=sys.stderr); sys.exit(1)
    print(json.dumps({'object':{'type':'commit','sha':'b'*40 if s['variant']=='wrong-tag' else sha}}))
else:
    sys.exit('Unexpected API request')
`;
      fs.writeFileSync(path.join(dir, 'gh'), mock, { mode: 0o700 });
      const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { PATH: dir + path.delimiter + process.env.PATH, ...env, REPOSITORY_PRIVATE: variant === 'private' ? 'true' : 'false', FAKE_GH_STATE: stateFile } });
      const state = JSON.parse(fs.readFileSync(stateFile));
      if (['create', 'existing'].includes(variant)) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /no APK or release has been published/);
      } else assert.notEqual(result.status, 0);
      assert.equal(state.calls.filter((args) => args.includes('POST')).length, ['create', 'denied'].includes(variant) ? 1 : 0);
      assert.ok(state.calls.every((args) => args[0] === 'api' && args.some((arg) => arg.includes('/git/'))));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

function evidenceFixture(directory) {
  const unsigned = path.join(directory, 'evidence/unsigned'), signed = path.join(directory, 'evidence/signed');
  fs.mkdirSync(unsigned, { recursive: true }); fs.mkdirSync(signed, { recursive: true });
  for (const name of unsignedFiles) fs.writeFileSync(path.join(unsigned, name), 'public fixture');
  for (const name of signedFiles) fs.writeFileSync(path.join(signed, name), 'public fixture');
  checksums(unsigned, unsignedFiles); checksums(signed, signedFiles);
  const hashOf = (target, name) => fs.readFileSync(path.join(target, 'SHA256SUMS'), 'utf8').split('\n').find((line) => line.endsWith(`  ${name}`)).slice(0, 64);
  const unsignedHash = hashOf(unsigned, unsignedFiles[0]), signedHash = hashOf(signed, signedFiles[0]);
  const info = context(env), certificate = env.RELEASE_CERTIFICATE_SHA256;
  const policy = JSON.stringify({ certificateSha256: certificate });
  fs.writeFileSync(path.join(signed, 'android-signing-policy.json'), policy);
  fs.writeFileSync(path.join(signed, 'android-release-certificate.der'), 'public certificate fixture');
  const legal = path.join(directory, 'evidence/legal');
  const licenseNames = ['docs/dependency-security.md', 'third-party/fixture-license.txt'];
  const files = {};
  for (const name of licenseNames) {
    const target = path.join(legal, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'public license fixture'); files[name] = sha256(fs.readFileSync(target));
  }
  files['android-signing-policy.json'] = sha256(policy);
  files['docs/android-release-certificate.der'] = certificate;
  const manifest = JSON.stringify({ files }); fs.writeFileSync(path.join(unsigned, 'source-manifest.json'), manifest);
  fs.writeFileSync(path.join(unsigned, 'build-info.json'), JSON.stringify({ ...info, productionSigning: false, sha256: unsignedHash, sourceManifestSha256: sha256(manifest) }));
  fs.writeFileSync(path.join(signed, 'sign-info.json'), JSON.stringify({ ...info, productionSigning: true, signingPolicySha256: sha256(policy), sha256: signedHash, unsignedSha256: unsignedHash, certificateSha256: certificate }));
  fs.writeFileSync(path.join(signed, 'wallet-release.apk.json'), JSON.stringify({ productionSigning: true, signingPolicySha256: sha256(policy), unsignedSha256: unsignedHash, signedSha256: signedHash, certificateSha256: certificate, signatureVerified: true, alignment16KbVerified: true }));
  checksums(unsigned, unsignedFiles); checksums(signed, signedFiles);
  return { unsigned, signed, legal };
}

test('actual OIDC job verification rejects substituted APKs even with updated checksum files and rejects another run', { skip: pythonAvailable ? false : 'Python 3 is needed to exercise Ubuntu workflow steps' }, () => {
  const script = inlinePython(workflow.jobs.attest.steps.find((step) => step.name?.startsWith('Verify artifacts')));
  for (const variant of ['valid', 'replacement', 'other-run', 'signature-missing', 'license-replaced', 'wrong-certificate', 'test-signature']) {
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
        const file = path.join(signed, 'wallet-release.apk.json');
        const proof = JSON.parse(fs.readFileSync(file)); proof.signatureVerified = false; fs.writeFileSync(file, JSON.stringify(proof));
      }
      if (variant === 'wrong-certificate') {
        const f = path.join(signed, 'sign-info.json'), p = path.join(signed, 'wallet-release.apk.json');
        for (const file of [f,p]) { const info = JSON.parse(fs.readFileSync(file)); info.certificateSha256 = '0'.repeat(64); fs.writeFileSync(file,JSON.stringify(info)); }
      }
      if (variant === 'test-signature') { const f = path.join(signed, 'sign-info.json'); const info = JSON.parse(fs.readFileSync(f)); info.productionSigning = false; fs.writeFileSync(f,JSON.stringify(info)); }
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
        const file = path.join(input, 'wallet-release.apk.json');
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
        assert.equal(plan.tag, `android-prerelease-${env.GITHUB_SHA}-123-1`);
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

test('release publication resumes drafts by ID and refuses wrong tags or remote asset digests', { skip: !pythonAvailable }, () => {
  const script = inlinePython(workflow.jobs.release.steps.find((step) => step.name?.startsWith('Upload verified assets')));
  for (const variant of ['draft', 'published', 'wrong-tag', 'bad-digest']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-release-api-test-'));
    try {
      const output = path.join(dir, 'release-output'); fs.mkdirSync(output);
      const file = path.join(dir, 'fixture.apk'); fs.writeFileSync(file, 'verified fixture APK');
      const asset = { path: file, name: 'fixture.apk', sha256: sha256(fs.readFileSync(file)) };
      const plan = { repository: env.GITHUB_REPOSITORY, tag: 'android-prerelease-fixture', commit: env.GITHUB_SHA, assets: [asset] };
      fs.writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan));
      const release = { id: 1, tag_name: plan.tag, target_commitish: plan.commit, draft: variant !== 'published', prerelease: true, html_url: 'https://example.test/release', assets: variant === 'published' ? [{ name: asset.name, digest: 'sha256:' + asset.sha256 }] : [] };
      const stateFile = path.join(dir, 'state.json');
      fs.writeFileSync(stateFile, JSON.stringify({ release, variant, calls: [], commit: plan.commit }));
      const mock = `#!/usr/bin/env python3
import json, os, pathlib, sys, hashlib
state_file = pathlib.Path(os.environ['FAKE_GH_STATE'])
state = json.loads(state_file.read_text()); args = sys.argv[1:]
state['calls'].append(args); release = state['release']; response = None
if args[0] == 'api':
    endpoint = args[-1]
    if '/git/ref/tags/' in endpoint:
        response = {'object': {'type':'commit','sha':'b'*40 if state['variant']=='wrong-tag' else state['commit']}}
    elif '/releases/tags/' in endpoint:
        raise SystemExit('Drafts cannot be retrieved by tag')
    elif '/releases?per_page=' in endpoint:
        response = [[release]]
    elif endpoint.endswith('/releases/1'):
        response = release
    else:
        raise SystemExit('Unexpected API request')
elif args[:2] == ['release','upload']:
    files = [pathlib.Path(item) for item in args if pathlib.Path(item).is_file()]
    release['assets'] = [{'name':item.name, 'digest':'sha256:'+('0'*64 if state['variant']=='bad-digest' else hashlib.sha256(item.read_bytes()).hexdigest())} for item in files]
elif args[:2] == ['release','edit']:
    assert '--draft=false' in args and '--prerelease' in args and '--latest=false' in args
    release['draft'] = False
else:
    raise SystemExit('Unexpected CLI request')
state_file.write_text(json.dumps(state))
if response is not None: print(json.dumps(response))
`;
      const executable = path.join(dir, 'gh'); fs.writeFileSync(executable, mock, { mode: 0o755 });
      const result = spawnSync('python3', ['-c', script], { env: { PATH: dir + path.delimiter + process.env.PATH, RUNNER_TEMP: dir, FAKE_GH_STATE: stateFile, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') }, encoding: 'utf8' });
      const state = JSON.parse(fs.readFileSync(stateFile));
      if (['draft', 'published'].includes(variant)) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(state.release.draft, false);
        assert.equal(state.release.prerelease, true);
        assert.ok(fs.existsSync(path.join(output, 'published.json')));
        if (variant === 'published') assert.ok(!state.calls.some((args) => args[0] === 'release'));
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(state.release.draft, true);
        assert.ok(!state.calls.some((args) => args[1] === 'edit'));
        if (variant === 'wrong-tag') assert.ok(!state.calls.some((args) => args[1] === 'upload'));
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
