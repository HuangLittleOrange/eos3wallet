'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [tools, javaHome] = process.argv.slice(2);
const stage = process.cwd();

function run(command, args, expectedFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (expectedFailure ? result.status === 0 : result.status !== 0) throw new Error(`APK ${path.basename(command)} ${args[0]} failed: ${result.stderr ?? ''}`);
  return (result.stdout ?? '') + (result.stderr ?? '');
}

try {
  const signer = path.join(tools, 'apksigner');
  const align = path.join(tools, 'zipalign');
  const failure = run(signer, ['verify', 'input.apk'], true);
  if (!failure.includes('DOES NOT VERIFY')) throw new Error('Input is not a verifiable unsigned APK.');
  run(align, ['-P', '16', '-f', '4', 'input.apk', 'aligned.apk']);
  run(path.join(javaHome, 'bin/keytool'), ['-genkeypair', '-keystore', 'test.p12', '-storetype', 'PKCS12',
    '-storepass:file', 'password', '-keypass:file', 'password', '-alias', 'wallet-review-test',
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '365', '-dname', 'CN=Wallet Review Test', '-noprompt']);
  // PKCS12 uses the same store/key password. apksigner consumes password-file
  // lines, so supplying this file twice would request a missing second line.
  run(signer, ['sign', '--ks', 'test.p12', '--ks-pass', 'file:password', '--out', 'signed.apk', 'aligned.apk']);
  const verification = run(signer, ['verify', '--verbose', '--print-certs', 'signed.apk']);
  run(align, ['-c', '-P', '16', '4', 'signed.apk']);
  const certificate = /certificate SHA-256 digest: ([a-f0-9]+)/i.exec(verification)?.[1];
  if (!certificate) throw new Error('Signing certificate fingerprint missing.');
  fs.writeFileSync(path.join(stage, 'signing.json'), JSON.stringify({ purpose: 'test only', certificateSha256: certificate, signatureVerified: true, alignment16KbVerified: true, releaseApproved: false }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
