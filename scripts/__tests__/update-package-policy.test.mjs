import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativeDir = path.join(root, 'modules/anchor-authorization/android/src/main/java/expo/modules/anchorauthorization');

test('the native APK identity policy rejects a foreign app, wrong signers, version substitution and rollback', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eostp-update-policy-'));
  try {
    fs.copyFileSync(path.join(nativeDir, 'UpdatePackagePolicy.java'), path.join(temp, 'UpdatePackagePolicy.java'));
    fs.writeFileSync(path.join(temp, 'UpdatePolicyTest.java'), `
package expo.modules.anchorauthorization;
import java.util.Set;
public class UpdatePolicyTest {
  public static void main(String[] args) {
    Set<String> trusted = Set.of("release-cert");
    if (!UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "com.eos3.wallet", 11, trusted, 11)) throw new AssertionError("valid update blocked");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "evil.wallet", 11, trusted, 11)) throw new AssertionError("foreign package accepted");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "com.eos3.wallet", 11, Set.of("attacker"), 11)) throw new AssertionError("wrong certificate accepted");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "com.eos3.wallet", 11, Set.of("release-cert", "attacker"), 11)) throw new AssertionError("additional signer accepted");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, Set.of(), "com.eos3.wallet", 11, Set.of(), 11)) throw new AssertionError("missing certificates accepted");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "com.eos3.wallet", 10, trusted, 10)) throw new AssertionError("same version accepted");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "com.eos3.wallet", 9, trusted, 9)) throw new AssertionError("rollback accepted");
    if (UpdatePackagePolicy.accepts("com.eos3.wallet", 10, trusted, "com.eos3.wallet", 11, trusted, 12)) throw new AssertionError("advertised version substitution accepted");
    System.out.println("Native update identity cases passed");
  }
}`);
    execFileSync('javac', ['-d', temp, path.join(temp, 'UpdatePackagePolicy.java'), path.join(temp, 'UpdatePolicyTest.java')]);
    const output = execFileSync('java', ['-cp', temp, 'expo.modules.anchorauthorization.UpdatePolicyTest'], { encoding: 'utf8' });
    assert.match(output, /cases passed/);
    const module = fs.readFileSync(path.join(nativeDir, 'WalletUpdateVerificationModule.kt'), 'utf8');
    assert.match(module, /UpdatePackagePolicy\.accepts/);
    assert.match(module, /GET_SIGNING_CERTIFICATES/);
    assert.match(module, /cacheDir\.canonicalFile/);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'modules/anchor-authorization/expo-module.config.json'), 'utf8'));
    assert.ok(config.android.modules.includes('expo.modules.anchorauthorization.WalletUpdateVerificationModule'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
