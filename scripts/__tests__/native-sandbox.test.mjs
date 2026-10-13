import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { removeAndroidSigning } = require('../android-unsigned.cjs');
const { sandboxProfile, cleanEnvironment, prepareStage, runSandbox, runSandboxStreaming, nodeRuntimeRoot } = require('../native-sandbox.cjs');
const { cloneCache } = require('../build-android-isolated.cjs');

test('public cache retains AndroidX credentials dependencies while rejecting credential files and links', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cache-test-'));
  try {
    const source = path.join(parent, 'cache'), destination = path.join(parent, 'copy');
    const dependency = 'files-2.1/androidx.credentials/credentials/1.3.0/hash/credentials-1.3.0.aar';
    fs.mkdirSync(path.dirname(path.join(source, dependency)), { recursive: true });
    fs.writeFileSync(path.join(source, dependency), 'public dependency');
    for (const name of ['credentials.json', '.env.production', '.npmrc', 'signing.p12', 'cache.lock']) fs.writeFileSync(path.join(source, name), 'fake credential');
    fs.symlinkSync(path.join(source, 'credentials.json'), path.join(source, 'linked-secret'));
    cloneCache(source, destination);
    assert.equal(fs.readFileSync(path.join(destination, dependency), 'utf8'), 'public dependency');
    assert.deepEqual(fs.readdirSync(destination), ['files-2.1']);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('unsigned preparation removes every generated signing reference and rejects changed templates', () => {
  const template = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    debug { signingConfig signingConfigs.debug }
    release { signingConfig signingConfigs.debug }
`;
  const result = removeAndroidSigning(template);
  assert.equal((result.match(/signingConfig null/g) ?? []).length, 2);
  assert.doesNotMatch(result, /storeFile|storePassword|keyAlias|keyPassword|signingConfigs/);
  assert.throws(() => removeAndroidSigning(template.replace('androiddebugkey', 'unexpected')), /template changed/);
  assert.throws(() => removeAndroidSigning(template + 'storeFile other'), /material remains/);
});

test('native child environment has no inherited signing tokens or host configuration', () => {
  const env = cleanEnvironment('/private/tmp/public-build', '/opt/node/bin', '/opt/jdk', '/approved/sdk');
  assert.equal(env.HOME, '/private/tmp/public-build/home');
  assert.equal(env.EXPO_NO_DOTENV, '1');
  assert.equal(env.NPM_CONFIG_IGNORE_SCRIPTS, 'true');
  assert.equal(env.GRADLE_USER_HOME, '/private/tmp/public-build/gradle-home');
  assert.match(env.JAVA_TOOL_OPTIONS, /-Djava[.]net[.]preferIPv4Stack=true/);
  assert.match(env.JAVA_TOOL_OPTIONS, /-Duser[.]home=\/private\/tmp\/public-build\/home/);
  for (const name of ['EXPO_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'APPLE_ID_PASSWORD', 'ORG_GRADLE_PROJECT_STORE_PASSWORD', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
});

test('hosted Node runtime permits sibling npm files without opening the hosted cache or home', { skip: process.platform !== 'darwin' || process.env.EOSTP_NATIVE_SANDBOX === '1' }, () => {
  const parent = fs.mkdtempSync('/private/tmp/hosted-node-test-');
  try {
    const distribution = path.join(parent, 'node/22.23.2/x64');
    const executable = path.join(distribution, 'bin/node');
    const npmFile = path.join(distribution, 'lib/node_modules/npm/package.json');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(path.dirname(npmFile), { recursive: true });
    fs.writeFileSync(executable, 'fake executable'); fs.writeFileSync(npmFile, 'public npm code');
    fs.writeFileSync(path.join(parent, 'host-token'), 'fake token');
    assert.equal(nodeRuntimeRoot(executable), distribution);
    const stage = path.join(parent, 'stage'); fs.mkdirSync(stage); prepareStage(stage);
    const script = `const fs=require('fs');if(fs.readFileSync(${JSON.stringify(npmFile)},'utf8')!=='public npm code')process.exit(1);try{fs.readFileSync(${JSON.stringify(path.join(parent, 'host-token'))});process.exit(1)}catch(e){if(!['EPERM','EACCES'].includes(e.code))process.exit(1)}`;
    runSandbox(stage, [path.dirname(process.execPath), nodeRuntimeRoot(executable)], false, process.execPath, ['-e', script], cleanEnvironment(stage, path.dirname(process.execPath), '/unused', '/unused'), path.join(stage, 'node-probe.txt'));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('native policy blocks keychain IPC, outside process inspection, writes and external network', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'native-profile-test-'));
  try {
    const profile = sandboxProfile(stage, [], false, [os.tmpdir()]);
    assert.ok(profile.includes(`(literal ${JSON.stringify(fs.realpathSync(os.tmpdir()))})`));
    assert.ok(!profile.includes(`(subpath ${JSON.stringify(fs.realpathSync(os.tmpdir()))})`));
    assert.match(profile, /com\.apple\.securityd\.xpc/);
    assert.match(profile, /deny process-info/);
    assert.match(profile, /deny appleevent-send/);
    assert.match(profile, /deny file-write/);
    assert.match(profile, /deny network-outbound/);
    assert.match(profile, /localhost/);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
});

// macOS refuses nested sandbox initialization. The outer build controller runs
// the same actual boundary probe before starting an already sandboxed worker.
test('macOS sandbox actually refuses credential reads/writes and non-loopback network', { skip: process.platform !== 'darwin' || process.env.EOSTP_NATIVE_SANDBOX === '1' }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'native-boundary-test-'));
  try {
    const stage = path.join(parent, 'builder'); fs.mkdirSync(stage); prepareStage(stage);
    const canary = path.join(parent, 'credential-canary'); fs.writeFileSync(canary, 'public fake credential');
    const env = cleanEnvironment(stage, path.dirname(process.execPath), '/opt/unused-jdk', '/unused-sdk');
    const script = `const fs=require('fs'),net=require('net');if(!fs.readdirSync(${JSON.stringify(parent)}).includes('credential-canary'))process.exit(1);let denied=0;for(const f of [()=>fs.readFileSync(${JSON.stringify(canary)}),()=>fs.writeFileSync(${JSON.stringify(canary)},'changed')]){try{f()}catch(e){if(['EPERM','EACCES'].includes(e.code))denied++}}if(denied!==2)process.exit(1);const s=net.connect(443,'1.1.1.1');s.on('connect',()=>process.exit(1));s.on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?0:1));setTimeout(()=>process.exit(1),2000);`;
    runSandbox(stage, [path.dirname(process.execPath)], false, process.execPath, ['-e', script], env, path.join(stage, 'probe.txt'), [parent]);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'public fake credential');
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('networked preparation refuses host Unix sockets such as a Docker or SSH agent socket', { skip: process.platform !== 'darwin' || process.env.EOSTP_NATIVE_SANDBOX === '1' }, async () => {
  const parent = fs.mkdtempSync('/private/tmp/native-socket-test-');
  const socket = path.join(parent, 'fake-host-agent.sock');
  const server = net.createServer((connection) => connection.end());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    const stage = path.join(parent, 'builder'); fs.mkdirSync(stage); prepareStage(stage);
    const script = `const s=require('net').connect(${JSON.stringify(socket)});s.on('connect',()=>process.exit(1));s.on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?0:1));setTimeout(()=>process.exit(1),2000);`;
    runSandbox(stage, [path.dirname(process.execPath)], true, process.execPath, ['-e', script], cleanEnvironment(stage, path.dirname(process.execPath), '/unused', '/unused'), path.join(stage, 'probe.txt'));
  } finally { server.close(); fs.rmSync(parent, { recursive: true, force: true }); }
});

test('live sandbox output arrives before exit, preserves raw logs and cannot inject Actions commands', { skip: process.platform !== 'darwin' || process.env.EOSTP_NATIVE_SANDBOX === '1' }, async () => {
  const stage = fs.mkdtempSync('/private/tmp/native-stream-test-');
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    prepareStage(stage);
    const log = path.join(stage, 'build.txt'), ack = path.join(stage, 'ack'), done = path.join(stage, 'done');
    const output = [];
    const env = cleanEnvironment(stage, path.dirname(process.execPath), '/unused', '/unused');
    // Child waits for parent acknowledgment: buffered-until-exit logging cannot
    // pass. Fake workflow commands and split UTF-8 bytes exercise both streams.
    const script = `const fs=require('fs');console.log('ready ::set-output name=unsafe::yes');console.error('::error::fake');const b=Buffer.from('中文');process.stdout.write(b.subarray(0,2));process.stdout.write(b.subarray(2));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ack)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(done)},'done')}},20);setTimeout(()=>process.exit(2),3000).unref();`;
    await runSandboxStreaming(stage, [path.dirname(process.execPath)], false, process.execPath, ['-e', script], env, log, [], {
      label: 'build', output: (text) => {
        output.push(text);
        if (text.includes('ready')) {
          assert.equal(fs.existsSync(done), false);
          assert.match(fs.readFileSync(log, 'utf8'), /ready/);
          fs.writeFileSync(ack, 'ok');
        }
      },
    });
    const token = output[0].match(/^::stop-commands::([a-f0-9-]+)\n$/)?.[1];
    assert.ok(token);
    assert.equal(output.at(-1), `\n::${token}::\n`);
    assert.equal(fs.existsSync(done), true);
    assert.match(output.join(''), /中文/);
    const raw = fs.readFileSync(log, 'utf8');
    assert.match(raw, /::set-output name=unsafe::yes/);
    assert.match(raw, /::error::fake/);
    assert.ok(!raw.includes(token));
    assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous;
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test('live sandbox failures retain diagnostics, and release signing refuses live logging', { skip: process.platform !== 'darwin' || process.env.EOSTP_NATIVE_SANDBOX === '1' }, async () => {
  const stage = fs.mkdtempSync('/private/tmp/native-stream-failure-');
  try {
    prepareStage(stage);
    const env = cleanEnvironment(stage, path.dirname(process.execPath), '/unused', '/unused');
    const log = path.join(stage, 'failure.txt');
    await assert.rejects(runSandboxStreaming(stage, [path.dirname(process.execPath)], false, process.execPath, ['-e', "console.error('compiler failure');process.exit(7)"], env, log, [], { output: () => {} }), /failed \(7\)/);
    assert.match(fs.readFileSync(log, 'utf8'), /compiler failure/);
    await assert.rejects(runSandboxStreaming(stage, [], false, process.execPath, [], { ...env, EOS3_RELEASE_SIGNER: '1' }, path.join(stage, 'sign.txt')), /Signing diagnostics cannot be streamed/);
    assert.equal(fs.existsSync(path.join(stage, 'sign.txt')), false);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
});
