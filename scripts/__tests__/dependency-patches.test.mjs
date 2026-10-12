import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256, p521 } from '@noble/curves/nist.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const { ec: EC } = require('elliptic');
const forge = require('node-forge');
const specs = ['elliptic-6.6.1.json', 'node-forge-1.4.0.json'].map((name) =>
  JSON.parse(fs.readFileSync(path.join(root, 'patches', name), 'utf8'))
);
const pristineText = (spec) => {
  const file = spec.files[0];
  let text = fs.readFileSync(path.join(root, 'node_modules', spec.package, file.path), 'utf8');
  for (const change of [...file.changes].reverse()) text = text.replace(change.after, change.before);
  assert.equal(createHash('sha256').update(text).digest('hex'), file.before_sha256);
  return text;
};
const filename = require.resolve('elliptic/lib/elliptic/ec/index.js');
const originalModule = new Module(filename);
originalModule.filename = filename;
originalModule.paths = Module._nodeModulePaths(path.dirname(filename));
originalModule._compile(pristineText(specs[0]), filename);
const OriginalEC = originalModule.exports;

test('installed dependency patches pass exact source checks', () => {
  require('../dependency-patches.cjs').verifyDependencyPatches();
});

test('P521 leading-zero nonce matches an independent RFC 6979 implementation', () => {
  // Public, unusable-for-funds reproduction vector from elliptic PR #322.
  // https://github.com/indutny/elliptic/pull/322#issuecomment-2463004218
  const secret = Buffer.from('01535d22d63de9195efd4c41358ddc89c68b6cc202b558fbf48a09e95dddf953afc1b4cfed6df0f3330f986735085e367fd07030c3ab49dcd3461197b00f09a064fb', 'hex');
  const digest = createHash('sha512').update(Buffer.from('12f830e9591916ec', 'hex')).digest();
  const before = new OriginalEC('p521').sign(digest, secret);
  const after = new EC('p521').sign(digest, secret);
  const reference = p521.sign(digest, secret, { prehash: false, lowS: false, format: 'der' });
  assert.notEqual(before.toDER('hex'), Buffer.from(reference).toString('hex'));
  assert.equal(after.toDER('hex'), Buffer.from(reference).toString('hex'));

  // Both signatures can verify. The danger is their related nonces, not a
  // verification failure: recover the PUBLIC TEST key from the signature pair.
  const n = BigInt(`0x${new EC('p521').n.toString(16)}`);
  const mod = (x) => ((x % n) + n) % n;
  function inverse(x) {
    let a = mod(x), b = n, u = 1n, v = 0n;
    while (b) { const q = a / b; [a, b] = [b, a - q * b]; [u, v] = [v, u - q * v]; }
    assert.equal(a, 1n);
    return mod(u);
  }
  const [rb, sb, rg, sg] = [before.r, before.s, after.r, after.s].map((x) => BigInt(`0x${x.toString(16)}`));
  const z = BigInt(`0x${digest.toString('hex')}`);
  const denominator = inverse(128n * sb * rg - sg * rb);
  const expectedPublic = Buffer.from(p521.getPublicKey(secret)).toString('hex');
  let recovered = false;
  for (let remainder = 0n; remainder < 128n; remainder++) {
    const candidate = mod(((sg - 128n * sb) * z - sb * sg * remainder) * denominator);
    if (!candidate) continue;
    const bytes = Buffer.from(candidate.toString(16).padStart(132, '0'), 'hex');
    if (Buffer.from(p521.getPublicKey(bytes)).toString('hex') === expectedPublic) { recovered = true; break; }
  }
  assert.equal(recovered, true);
});

test('K1/R1 SHA-256 signatures stay byte-for-byte compatible, including leading zeros', async () => {
  const { Bytes, Checksum256, KeyType, PrivateKey } = await import('@wharfkit/antelope');
  const secret = new Uint8Array(32); secret[31] = 1; // Public test scalar only.
  for (const [name, type, reference] of [['secp256k1', KeyType.K1, secp256k1], ['p256', KeyType.R1, p256]]) {
    const original = new OriginalEC(name), patched = new EC(name);
    const key = new PrivateKey(type, Bytes.from(secret));
    for (let i = 0; i < 64; i++) {
      const digest = createHash('sha256').update(`public compatibility vector ${i}`).digest();
      if (i < 32) digest.fill(0, 0, i);
      if (i === 32) digest.fill(255);
      const options = { canonical: true, pers: [i + 1] };
      const before = original.sign(digest, secret, options), after = patched.sign(digest, secret, options);
      assert.equal(after.toDER('hex'), before.toDER('hex'));
      assert.equal(after.recoveryParam, before.recoveryParam);
      assert.equal(reference.verify(Buffer.from(after.toDER()), digest, reference.getPublicKey(secret), { prehash: false, format: 'der' }), true);
      const signature = key.signDigest(Checksum256.from(digest));
      assert.equal(signature.recoverDigest(Checksum256.from(digest)).equals(key.toPublic()), true);
    }
  }
});

test('node-forge rejects extra nested DigestAlgorithm elements accepted before the patch', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-forge-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'node_modules/node-forge/lib'), path.join(temporary, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'lib/rsa.js'), pristineText(specs[1]));
  const original = require(path.join(temporary, 'lib/index.js'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const publicKey = forge.pki.publicKeyFromPem(publicPem);
  const digest = createHash('sha256').update('public parser regression vector').digest().toString('binary');
  const a = forge.asn1;
  const make = (type, value, constructed = false) => a.create(a.Class.UNIVERSAL, type, constructed, value);
  for (const hasNull of [true, false]) {
    const algorithm = [make(a.Type.OID, a.oidToDer(forge.oids.sha256).getBytes())];
    if (hasNull) algorithm.push(make(a.Type.NULL, ''));
    const validInfo = make(a.Type.SEQUENCE, [make(a.Type.SEQUENCE, [...algorithm], true), make(a.Type.OCTETSTRING, digest)], true);
    const validSignature = privateKey.sign(a.toDer(validInfo).getBytes(), 'NONE');
    assert.equal(publicKey.verify(digest, validSignature), true); // NULL remains optional for SHA-256.
    algorithm.push(make(a.Type.OCTETSTRING, 'unconsumed test data'));
    const info = make(a.Type.SEQUENCE, [make(a.Type.SEQUENCE, algorithm, true), make(a.Type.OCTETSTRING, digest)], true);
    const signature = privateKey.sign(a.toDer(info).getBytes(), 'NONE');
    assert.equal(original.pki.publicKeyFromPem(publicPem).verify(digest, signature), true);
    assert.throws(() => publicKey.verify(digest, signature), /DigestInfo/);
  }
});

test('ordinary RSA certificates and Expo code-signing output remain compatible', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const keyPair = {
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey.export({ type: 'spki', format: 'pem' })),
    privateKey: forge.pki.privateKeyFromPem(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
  const signing = require('@expo/code-signing-certificates');
  const certificate = signing.generateSelfSignedCodeSigningCertificate({ keyPair, commonName: 'Public regression test', validityNotBefore: new Date(Date.now() - 60000), validityNotAfter: new Date(Date.now() + 3600000) });
  signing.validateSelfSignedCertificate(certificate, keyPair);
  const message = Buffer.from('public code-signing regression vector');
  const signature = Buffer.from(signing.signBufferRSASHA256AndVerify(keyPair.privateKey, certificate, message), 'base64');
  assert.equal(verify('sha256', message, pair.publicKey, signature), true);
});

test('patch application is reproducible and refuses missing, changed or unknown-version sources', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-patch-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const folder of ['scripts', 'patches']) fs.mkdirSync(path.join(temporary, folder));
  fs.copyFileSync(path.join(root, 'scripts/dependency-patches.cjs'), path.join(temporary, 'scripts/dependency-patches.cjs'));
  const lock = { packages: {} };
  for (const spec of specs) {
    const directory = path.join(temporary, 'node_modules', spec.package);
    fs.mkdirSync(path.dirname(path.join(directory, spec.files[0].path)), { recursive: true });
    fs.copyFileSync(path.join(root, 'node_modules', spec.package, 'package.json'), path.join(directory, 'package.json'));
    fs.writeFileSync(path.join(directory, spec.files[0].path), pristineText(spec));
    fs.writeFileSync(path.join(temporary, 'patches', `${spec.package}-${spec.version}.json`), JSON.stringify(spec));
    lock.packages[`node_modules/${spec.package}`] = { version: spec.version };
  }
  fs.writeFileSync(path.join(temporary, 'package-lock.json'), JSON.stringify(lock));
  const run = (mode) => spawnSync(process.execPath, ['scripts/dependency-patches.cjs', mode], { cwd: temporary, encoding: 'utf8' });
  assert.notEqual(run('--check').status, 0);
  assert.equal(run('--apply').status, 0);
  assert.equal(run('--apply').status, 0);
  assert.equal(run('--check').status, 0);
  const first = path.join(temporary, 'node_modules/elliptic', specs[0].files[0].path);
  const second = path.join(temporary, 'node_modules/node-forge', specs[1].files[0].path);
  fs.writeFileSync(first, pristineText(specs[0]));
  fs.appendFileSync(second, '\n// unexpected source change\n');
  assert.notEqual(run('--apply').status, 0);
  assert.equal(fs.readFileSync(first, 'utf8'), pristineText(specs[0])); // No partial writes.
  fs.writeFileSync(path.join(temporary, 'node_modules/elliptic/package.json'), JSON.stringify({ name: 'elliptic', version: '0.0.0' }));
  assert.notEqual(run('--apply').status, 0);
  fs.rmSync(path.join(temporary, 'patches/elliptic-6.6.1.json'));
  assert.notEqual(run('--check').status, 0);
});
