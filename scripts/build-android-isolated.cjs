'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyPublicSource } = require('./isolated-build.cjs');
const { verifyDependencyPolicy } = require('./dependency-policy.cjs');
const { cleanEnvironment, prepareStage, runSandbox, runSandboxStreaming, nodeRuntimeRoot } = require('./native-sandbox.cjs');
const { signTestApk } = require('./sign-android-test.cjs');
const root = path.resolve(__dirname, '..');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function cloneCache(source, destination) {
  if (!fs.existsSync(source)) throw new Error('The offline Gradle dependency cache is missing; prepare a public-only cache on a disposable builder.');
  fs.cpSync(source, destination, { recursive: true, mode: fs.constants.COPYFILE_FICLONE,
    filter: (file) => {
      const stat = fs.lstatSync(file);
      // AndroidX has legitimate groups/artifacts named "credentials". Match
      // sensitive file names, not dependency directory name substrings.
      return !stat.isSymbolicLink() && !(stat.isFile() && /^(?:credentials(?:[.]json)?|[.]npmrc)$|^[.]env(?:[.]|$)|[.](?:jks|keystore|p8|p12|pfx|key|pem|log|lock)$/i.test(path.basename(file)));
    } });
}

function verifySource(directory, manifest) {
  for (const [file, expected] of Object.entries(manifest)) {
    const target = path.join(directory, file);
    if (!fs.lstatSync(target).isFile() || hash(fs.readFileSync(target)) !== expected) throw new Error('Source changed inside the native sandbox; refusing to promote an APK.');
  }
}

async function main() {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('This entry point requires macOS sandbox-exec; no unsandboxed fallback.');
  const prepareCache = process.argv.length === 3 && process.argv[2] === '--prepare-cache';
  const unsignedOnly = process.argv.length === 3 && process.argv[2] === '--unsigned-only';
  const emulatorOnly = process.argv.length === 3 && process.argv[2] === '--emulator';
  if (process.argv.length > 2 && !prepareCache && !unsignedOnly && !emulatorOnly) throw new Error('Use no arguments, --unsigned-only, --emulator, or --prepare-cache.');
  verifyDependencyPolicy();
  const scan = spawnSync(process.execPath, ['scripts/check-source.mjs'], { cwd: root, stdio: 'inherit' });
  if (scan.status !== 0) throw new Error('Public source scan failed.');
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'native-build-policy.json')));
  const sdk = fs.realpathSync(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk'));
  const java = fs.realpathSync(execFileSync('/usr/bin/which', ['java'], { encoding: 'utf8' }).trim());
  const javaHome = path.dirname(path.dirname(java));
  const readTools = [`platforms/${policy.platform}`, ...[policy.buildTools, ...(policy.additionalBuildTools ?? [])].map((version) => `build-tools/${version}`), `ndk/${policy.ndk}`, `cmake/${policy.cmake}`, 'licenses'].map((name) => path.join(sdk, name));
  for (const tool of readTools) if (!fs.existsSync(tool)) throw new Error('An approved Android SDK component is missing.');
  readTools.push(javaHome, nodeRuntimeRoot());
  const sdkDirectories = [sdk, ...['platforms', 'build-tools', 'ndk', 'cmake'].map((name) => path.join(sdk, name))];
  const id = crypto.randomUUID();
  const output = path.join(root, 'exports/native-review', id);
  fs.mkdirSync(output, { recursive: true });
  const stage = fs.mkdtempSync('/private/tmp/eostp-native-');
  try {
    prepareStage(stage);
    const source = path.join(stage, 'source');
    const manifest = copyPublicSource(source);
    fs.writeFileSync(path.join(source, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify({ files: manifest }, null, 2) + '\n');
    const zip = path.join(root, '.codex/native-build-cache', `gradle-${policy.gradle.version}-bin.zip`);
    fs.mkdirSync(path.dirname(zip), { recursive: true });
    if (!fs.existsSync(zip) || hash(fs.readFileSync(zip)) !== policy.gradle.sha256) {
      console.log('Downloading the approved Gradle distribution.');
      const response = await fetch(policy.gradle.url);
      if (!response.ok) throw new Error('Gradle download failed.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== policy.gradle.sha256) throw new Error('Gradle distribution checksum mismatch.');
      fs.writeFileSync(zip, bytes);
    }
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, stage]);
    // Never copy ~/.gradle properties, init scripts, daemon logs or signing material.
    const preparedCache = path.join(root, '.codex/native-build-cache/modules-2');
    const initialCache = fs.existsSync(preparedCache) ? preparedCache : path.join(os.homedir(), '.gradle/caches/modules-2');
    if (!fs.existsSync(initialCache) && prepareCache) fs.mkdirSync(path.join(stage, 'gradle-home/caches/modules-2'), { recursive: true });
    else cloneCache(initialCache, path.join(stage, 'gradle-home/caches/modules-2'));
    const env = cleanEnvironment(stage, path.dirname(process.execPath), javaHome, sdk);
    if (emulatorOnly) env.EOS3_ANDROID_ABI = 'arm64-v8a';
    // Reuse only npm's content-addressed public downloads, never installed code,
    // npm configuration, audit logs or native build outputs.
    const npmCache = path.join(root, '.codex/native-build-cache/npm-cache/_cacache');
    if (fs.existsSync(npmCache)) cloneCache(npmCache, path.join(stage, 'npm-cache/_cacache'));
    runSandbox(stage, readTools, false, java, ['-version'], env, path.join(output, 'java-version.txt'));
    if (!/version "17[.]/.test(fs.readFileSync(path.join(output, 'java-version.txt'), 'utf8'))) throw new Error('The reviewed native toolchain requires JDK 17.');
    const canary = path.join(root, '.codex/native-isolation/credential-canary');
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, 'not a real credential', { mode: 0o600 });
    const probe = `const fs=require('fs'),net=require('net');let blocked=0;for(const op of [()=>fs.readFileSync(${JSON.stringify(canary)}),()=>fs.writeFileSync(${JSON.stringify(canary)},'changed')]){try{op()}catch(e){if(['EPERM','EACCES'].includes(e.code))blocked++}}if(blocked!==2)process.exit(1);const s=net.connect(443,'1.1.1.1');s.on('connect',()=>process.exit(1));s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(1);console.log('Credential read/write and external network isolation verified');process.exit(0)});setTimeout(()=>process.exit(1),2000);`;
    runSandbox(stage, readTools, false, process.execPath, ['-e', probe], env, path.join(output, 'sandbox-probe.txt'));
    console.log('Installing dependencies in a sandbox with no host credentials.');
    await runSandboxStreaming(stage, readTools, true, process.execPath, [path.join(source, 'scripts/native-android-worker.cjs'), 'install'], env, path.join(output, 'install.txt'), [], { label: 'install' });
    verifySource(source, manifest);
    fs.rmSync(npmCache, { recursive: true, force: true });
    cloneCache(path.join(stage, 'npm-cache/_cacache'), npmCache);
    if (prepareCache) {
      console.log('Preparing public native dependencies in a credential-free networked sandbox; no APK is promoted.');
      try {
        await runSandboxStreaming(stage, readTools, true, process.execPath, [path.join(source, 'scripts/native-android-worker.cjs'), 'cache'], env, path.join(output, 'cache.txt'), sdkDirectories, { label: 'dependencies' });
      } finally {
        // A partial public cache is reusable, but does not turn a failed
        // preparation into success or permit an online APK build.
        verifySource(source, manifest);
        fs.rmSync(preparedCache, { recursive: true, force: true });
        cloneCache(path.join(stage, 'gradle-home/caches/modules-2'), preparedCache);
      }
      console.log('Public native dependency cache prepared. Run build:android:isolated for an offline APK.');
      return;
    }
    console.log('Building a fresh unsigned Android APK offline; no signing key is present.');
    await runSandboxStreaming(stage, readTools, false, process.execPath, [path.join(source, 'scripts/native-android-worker.cjs'), 'build'], env, path.join(output, 'build.txt'), sdkDirectories, { label: 'build' });
    verifySource(source, manifest);
    const unsigned = path.join(output, 'wallet-review-unsigned.apk');
    fs.copyFileSync(path.join(stage, 'app-release-unsigned.apk'), unsigned);
    const unsignedHash = hash(fs.readFileSync(unsigned));
    // The compiler has finished. The signer gets a copy of the APK and a new key,
    // with no source, node_modules, Gradle cache or production signing credentials.
    const signed = path.join(output, 'wallet-review-test-signed.apk');
    let signing;
    if (!unsignedOnly) {
      console.log('Signing the verified APK in a separate offline sandbox with a temporary test key.');
      signing = signTestApk(unsigned, unsignedHash, signed, sdk, javaHome);
    }
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({
      sourceMatchesSnapshot: true, expo: JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'))).packages['node_modules/expo'].version,
      nativeBuild: 'fresh unsigned release APK', nativeBuildNetwork: 'loopback only for Gradle IPC',
      signing: unsignedOnly ? 'not-run; unsigned APK only' : 'separate offline sandbox; temporary test key', credentialProbe: 'passed',
      unsignedSha256: unsignedHash, ...(signing ? {
        signedSha256: signing.signedSha256, signatureVerified: signing.signatureVerified,
        alignment16KbVerified: signing.alignment16KbVerified,
      } : {}),
      package: JSON.parse(fs.readFileSync(path.join(source, 'app.json'))).expo.android.package,
      versionName: JSON.parse(fs.readFileSync(path.join(source, 'app.json'))).expo.version,
      versionCode: JSON.parse(fs.readFileSync(path.join(source, 'app.json'))).expo.android.versionCode,
      ...(emulatorOnly ? { reviewArchitecture: 'arm64-v8a' } : {}),
      productionSigning: false, iosNativeBuild: 'not-run', releaseApproved: false,
    }, null, 2) + '\n');
    if (unsignedOnly && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `native_output=${output}\n`);
    }
    console.log(`Native ${unsignedOnly ? 'unsigned' : 'test'} APK verified: ${path.relative(root, unsignedOnly ? unsigned : signed)}`);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

module.exports = { verifySource, cloneCache };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
