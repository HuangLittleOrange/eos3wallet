'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const [tools, javaHome] = process.argv.slice(2);
function run(command, args, expectedFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error || (expectedFailure ? result.status === 0 : result.status !== 0)) throw new Error('Approved release signing tool failed.');
  return (result.stdout ?? '') + (result.stderr ?? '');
}
try {
  const policy = JSON.parse(fs.readFileSync('policy.json'));
  const signer = path.join(tools, 'apksigner'), align = path.join(tools, 'zipalign');
  if (!run(signer, ['verify', 'input.apk'], true).includes('DOES NOT VERIFY')) throw new Error('Expected an unsigned APK.');
  run(path.join(javaHome, 'bin/keytool'), ['-exportcert', '-keystore', 'release.p12', '-storetype', 'PKCS12',
    '-storepass:file', 'password', '-alias', policy.keyAlias, '-file', 'certificate.der']);
  const expected = crypto.createHash('sha256').update(fs.readFileSync('certificate.der')).digest('hex');
  if (expected !== policy.certificateSha256) throw new Error('Private key does not match the pinned public certificate.');
  run(align, ['-P', '16', '-f', '4', 'input.apk', 'aligned.apk']);
  run(signer, ['sign', '--ks', 'release.p12', '--ks-type', 'PKCS12', '--ks-key-alias', policy.keyAlias,
    '--ks-pass', 'file:password', '--out', 'signed.apk', 'aligned.apk']);
  const verification = run(signer, ['verify', '--verbose', '--print-certs', 'signed.apk']);
  run(align, ['-c', '-P', '16', '4', 'signed.apk']);
  const fingerprints = [...verification.matchAll(/certificate SHA-256 digest: ([a-f0-9]+)/ig)].map((match) => match[1].toLowerCase());
  if (fingerprints.length !== 1 || fingerprints[0] !== expected) throw new Error('Final APK certificate differs from the release identity.');
  fs.writeFileSync('signing.json', JSON.stringify({ purpose: 'fixed release signing', productionSigning: true,
    certificateSha256: expected, signatureVerified: true, alignment16KbVerified: true, releaseApproved: false }, null, 2));
} catch { console.error('Release signer verification failed; private diagnostics withheld.'); process.exitCode = 1; }
