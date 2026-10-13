'use strict';

// No npm packages, application code, network or inherited host credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanEnvironment, prepareStage, runSandbox } = require('./native-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function signingMaterial(env, policy) {
  const encoded = env.ANDROID_RELEASE_KEYSTORE_BASE64 ?? '';
  const password = env.ANDROID_RELEASE_STORE_PASSWORD ?? '';
  if (!encoded || encoded.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
      !password || /[\r\n\0]/.test(password)) throw new Error('Release signing secrets are missing or invalid.');
  const keystore = Buffer.from(encoded, 'base64');
  if (!keystore.length || keystore.toString('base64') !== encoded) throw new Error('Invalid release keystore encoding.');
  if (policy.schemaVersion !== 1 || policy.certificateFile !== 'docs/android-release-certificate.der' ||
      !/^[a-f0-9]{64}$/.test(policy.certificateSha256 ?? '') ||
      env.RELEASE_CERTIFICATE_SHA256 !== policy.certificateSha256 ||
      !/^[a-zA-Z0-9_-]+$/.test(policy.keyAlias ?? '')) throw new Error('Release certificate policy or workflow pin mismatch.');
  return { keystore, password };
}

function signReleaseApk(input, expectedHash, output, sdk, javaHome, env = process.env) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(fs.readFileSync(input)) !== expectedHash) {
    throw new Error('Reviewed unsigned APK checksum mismatch; refusing to sign.');
  }
  const policyBytes = fs.readFileSync(path.join(root, 'android-signing-policy.json'));
  const policy = JSON.parse(policyBytes);
  const material = signingMaterial(env, policy);
  const certificate = fs.readFileSync(path.join(root, policy.certificateFile));
  if (hash(certificate) !== policy.certificateSha256) throw new Error('Public release certificate differs from the policy.');
  const native = JSON.parse(fs.readFileSync(path.join(root, 'native-build-policy.json')));
  const tools = path.join(sdk, 'build-tools', native.buildTools);
  for (const [file, expected] of Object.entries(native.signingTools)) {
    if (hash(fs.readFileSync(path.join(tools, file))) !== expected) throw new Error('Signing tool changed; review before signing.');
  }
  const stage = fs.mkdtempSync('/private/tmp/eos3-release-sign-');
  fs.chmodSync(stage, 0o700);
  try {
    prepareStage(stage);
    for (const [name, data] of Object.entries({ 'input.apk': fs.readFileSync(input), 'release.p12': material.keystore,
      'password': material.password, 'policy.json': policyBytes })) fs.writeFileSync(path.join(stage, name), data, { mode: 0o600 });
    fs.copyFileSync(path.join(__dirname, 'release-signing-worker.cjs'), path.join(stage, 'worker.cjs'));
    const child = cleanEnvironment(stage, path.dirname(process.execPath), javaHome, sdk);
    // Stronger than the builder sandbox: the signer needs no network, including loopback.
    child.EOS3_RELEASE_SIGNER = '1';
    runSandbox(stage, [tools, javaHome, path.dirname(process.execPath)], false, process.execPath,
      [path.join(stage, 'worker.cjs'), tools, javaHome], child, path.join(stage, 'signing.txt'));
    const report = JSON.parse(fs.readFileSync(path.join(stage, 'signing.json')));
    if (report.certificateSha256 !== policy.certificateSha256 || !report.signatureVerified || !report.alignment16KbVerified) {
      throw new Error('Release signature verification failed.');
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(stage, 'signed.apk'), output);
    Object.assign(report, { unsignedSha256: expectedHash, signedSha256: hash(fs.readFileSync(output)),
      signingPolicySha256: hash(policyBytes), signingMaterial: 'fixed encrypted release key; temporary signing copy deleted' });
    fs.writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch {
    // Never publish signer diagnostics: tool output could contain signing material.
    throw new Error('Independent release signing failed. No private signing diagnostics were exported.');
  } finally {
    material.keystore.fill(0);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { signingMaterial, signReleaseApk };
