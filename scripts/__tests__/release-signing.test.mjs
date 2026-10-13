import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { signingMaterial } = require('../sign-android-release.cjs');
const policy = { schemaVersion: 1, certificateFile: 'docs/android-release-certificate.der', keyAlias: 'release', certificateSha256: 'a'.repeat(64) };
const env = { ANDROID_RELEASE_KEYSTORE_BASE64: Buffer.from('disposable fixture').toString('base64'),
  ANDROID_RELEASE_STORE_PASSWORD: 'fixture-password', RELEASE_CERTIFICATE_SHA256: policy.certificateSha256 };

test('published certificate, policy, workflow pin and Android domain association share the release identity', () => {
  const realPolicy = JSON.parse(fs.readFileSync(new URL('../../android-signing-policy.json', import.meta.url)));
  const certificate = fs.readFileSync(new URL('../../docs/android-release-certificate.der', import.meta.url));
  assert.equal(createHash('sha256').update(certificate).digest('hex'), realPolicy.certificateSha256);
  const workflow = fs.readFileSync(new URL('../../.github/workflows/android-build.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('RELEASE_CERTIFICATE_SHA256: ' + realPolicy.certificateSha256));
  const links = JSON.parse(fs.readFileSync(new URL('../../well-known/assetlinks.json', import.meta.url)));
  assert.ok(links.some(item => item.target.package_name === 'com.eos3.wallet' && item.target.sha256_cert_fingerprints.some(value => value.replaceAll(':', '').toLowerCase() === realPolicy.certificateSha256)));
});

test('release signing rejects absent secrets, malformed encoding, multiline passwords and unpinned identity', () => {
  assert.equal(signingMaterial(env, policy).keystore.toString(), 'disposable fixture');
  for (const change of [{ ANDROID_RELEASE_KEYSTORE_BASE64: '' }, { ANDROID_RELEASE_KEYSTORE_BASE64: 'YWJj!' },
    { ANDROID_RELEASE_STORE_PASSWORD: '' }, { ANDROID_RELEASE_STORE_PASSWORD: 'secret\nsecond-line' },
    { RELEASE_CERTIFICATE_SHA256: 'b'.repeat(64) }]) assert.throws(() => signingMaterial({ ...env, ...change }, policy));
  assert.throws(() => signingMaterial(env, { ...policy, certificateFile: '../credentials.json' }));
});

test('actual release worker refuses the wrong key, multiple signers and already signed inputs without disclosing passwords', () => {
  const worker = fs.readFileSync(new URL('../release-signing-worker.cjs', import.meta.url));
  for (const variant of ['valid', 'wrong-key', 'multiple-signers', 'already-signed', 'tool-error']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-worker-test-'));
    try {
      const certificate = Buffer.from('disposable public certificate');
      const fingerprint = createHash('sha256').update(certificate).digest('hex');
      fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ keyAlias: 'release', certificateSha256: fingerprint }));
      fs.writeFileSync(path.join(dir, 'input.apk'), 'fixture'); fs.writeFileSync(path.join(dir, 'password'), 'secret-value-never-export');
      fs.writeFileSync(path.join(dir, 'worker.cjs'), worker);
      const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
      const mock = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'); const name=path.basename(process.argv[1]),args=process.argv.slice(2);
if(name==='keytool') { fs.writeFileSync('certificate.der', ${JSON.stringify(variant === 'wrong-key' ? 'different certificate' : certificate.toString())}); }
if(name==='apksigner') {
  if(args.includes('input.apk')) { if(${JSON.stringify(variant)}==='already-signed')process.exit(0);console.log('DOES NOT VERIFY');process.exit(1); }
  if(args[0]==='sign')fs.writeFileSync('signed.apk','signed fixture');
  if(args.includes('--print-certs'))console.log('Signer #1 certificate SHA-256 digest: ${fingerprint}'+(${JSON.stringify(variant)}==='multiple-signers'?'\\nSigner #2 certificate SHA-256 digest: ${fingerprint}':''));
}
if(${JSON.stringify(variant)}==='tool-error'){console.error('secret-value-never-export');process.exit(1);}
`;
      for (const name of ['keytool', 'apksigner', 'zipalign']) fs.writeFileSync(path.join(bin, name), mock, { mode: 0o755 });
      const result = spawnSync(process.execPath, ['worker.cjs', bin, dir], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.doesNotMatch(result.stdout + result.stderr, /secret-value-never-export/);
      if (variant === 'valid') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'signing.json'))).productionSigning, true);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(path.join(dir, 'signing.json')), false);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
