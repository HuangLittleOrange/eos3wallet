'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { cleanEnvironment, prepareStage, runSandbox } = require('./native-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function signTestApk(input, expectedHash, output, sdk, javaHome) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('An explicit reviewed unsigned APK checksum is required.');
  const data = fs.readFileSync(input);
  if (hash(data) !== expectedHash) throw new Error('Unsigned APK checksum changed; refusing to sign.');
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'native-build-policy.json')));
  const tools = path.join(sdk, 'build-tools', policy.buildTools);
  for (const [file, expected] of Object.entries(policy.signingTools)) {
    if (hash(fs.readFileSync(path.join(tools, file))) !== expected) throw new Error('Signing tool changed; review before signing.');
  }
  const stage = fs.mkdtempSync('/private/tmp/eostp-sign-');
  try {
    prepareStage(stage);
    fs.writeFileSync(path.join(stage, 'input.apk'), data, { mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'password'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    fs.copyFileSync(path.join(__dirname, 'test-signing-worker.cjs'), path.join(stage, 'worker.cjs'));
    const env = cleanEnvironment(stage, path.dirname(process.execPath), javaHome, sdk);
    // This sandbox can read its own APK/key and SDK tools, but no app source or builder stage.
    runSandbox(stage, [tools, javaHome, path.dirname(process.execPath)], false, process.execPath,
      [path.join(stage, 'worker.cjs'), tools, javaHome], env, path.join(stage, 'signing.txt'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(stage, 'signed.apk'), output);
    const report = JSON.parse(fs.readFileSync(path.join(stage, 'signing.json')));
    report.unsignedSha256 = expectedHash;
    report.signedSha256 = hash(fs.readFileSync(output));
    report.signingMaterial = 'new temporary test key, deleted after signing';
    fs.writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + '\n');
    return report;
  } catch (error) {
    const log = path.join(stage, 'signing.txt');
    if (fs.existsSync(log)) {
      const password = fs.readFileSync(path.join(stage, 'password'), 'utf8');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(`${output}.failure.txt`, fs.readFileSync(log, 'utf8').replaceAll(password, '[redacted]'));
    }
    throw error;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

module.exports = { signTestApk };
if (require.main === module) {
  try {
    const [input, expected, output, ...extra] = process.argv.slice(2);
    if (!input || !expected || !output || extra.length) throw new Error('Usage: npm run sign:android:test -- UNSIGNED_APK SHA256 OUTPUT_APK');
    const sdk = fs.realpathSync(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk'));
    const java = fs.realpathSync(execFileSync('/usr/bin/which', ['java'], { encoding: 'utf8' }).trim());
    signTestApk(path.resolve(input), expected, path.resolve(output), sdk, path.dirname(path.dirname(java)));
    console.log('APK signed with a temporary test key; signature and alignment verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
