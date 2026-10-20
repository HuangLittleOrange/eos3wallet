import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const workflow = require('yaml').parse(fs.readFileSync(new URL('.github/workflows/ios-build.yml', root), 'utf8'));

test('iOS signing and upload use fresh hosted VMs without dependency execution or shared credentials', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.build.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.sign.needs, 'build');
  assert.equal(workflow.jobs.upload.needs, 'sign');
  assert.equal(workflow.jobs.sign.environment, 'ios-production-signing');
  assert.equal(workflow.jobs.upload.environment, 'ios-testflight');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.on.workflow_dispatch.inputs.distribution.default, 'ad-hoc');
  assert.equal(workflow.on.workflow_dispatch.inputs.upload_to_testflight.default, false);
  assert.equal(workflow.env.IOS_DISTRIBUTION, '${{ inputs.distribution }}');
  assert.equal(workflow.jobs.upload.if, "inputs.distribution == 'app-store-connect' && inputs.upload_to_testflight");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['runs-on'], 'macos-26');
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with.ref, '${{ github.sha }}');
        assert.equal(step.with['persist-credentials'], false);
        if (name !== 'build') assert.equal(step.with['sparse-checkout'], '/scripts/github-ios.py');
      }
      if (name !== 'build') assert.doesNotMatch(step.run ?? '', /npm|pod install|prebuild|eas\b/);
      const secretNames = Object.values(step.env ?? {}).filter(value => /secrets\./.test(value));
      if (secretNames.length) {
        assert.notEqual(name, 'build');
        assert.equal(secretNames.length, name === 'sign' ? 4 : 3);
        assert.equal(step.run, `python3 scripts/github-ios.py ${name}`);
        assert.ok(!JSON.stringify(step.env).includes(name === 'sign' ? 'APP_STORE_CONNECT' : 'IOS_DISTRIBUTION'));
      }
      if (step.uses?.startsWith('actions/download-artifact@')) assert.equal(step.with['digest-mismatch'], 'error');
    }
    if (name !== 'build') assert.ok(job.steps.some(step => step.if === 'always()' && step.run.endsWith(' cleanup')));
  }
  assert.ok(!JSON.stringify(workflow).includes('secrets.GITHUB_TOKEN'));
  assert.doesNotMatch(JSON.stringify(workflow), /eas build|eas submit/);
});

test('iOS controller rejects wrong profiles, tampered archives and mismatched app/build identities', () => {
  const result = spawnSync('python3', ['scripts/__tests__/github_ios_test.py', '-v'], {
    cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('CI build number reaches iOS config and preserves associated domains and Android version', () => {
  const env = { ...process.env, IOS_BUILD_NUMBER: '27', EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1' };
  const result = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'config', '--type', 'public', '--json'], {
    cwd: root, env, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const original = JSON.parse(fs.readFileSync(new URL('app.json', root))).expo;
  assert.equal(config.ios.buildNumber, '27');
  assert.deepEqual(config.ios.associatedDomains, original.ios.associatedDomains);
  assert.equal(config.android.versionCode, original.android.versionCode);
  const invalid = spawnSync(process.execPath, ['node_modules/expo/bin/cli', 'config', '--type', 'public', '--json'], {
    cwd: root, env: { ...env, IOS_BUILD_NUMBER: '27; invalid' }, encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /IOS_BUILD_NUMBER/);
});
