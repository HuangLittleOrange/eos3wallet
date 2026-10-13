'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const quote = (value) => JSON.stringify(value);

function nodeRuntimeRoot(executable = process.execPath) {
  const binary = fs.realpathSync(executable);
  const bin = path.dirname(binary);
  // setup-node keeps npm in ../lib/node_modules/npm. Permit only this exact
  // Node distribution, never the runner home or the whole hosted tool cache.
  return path.basename(bin) === 'bin' ? path.dirname(bin) : bin;
}

function sandboxProfile(directory, readTools = [], online = false, listDirectories = []) {
  const stage = fs.realpathSync(directory);
  const readable = [stage, ...readTools.map((item) => fs.realpathSync(item))];
  // SDK discovery lists component parents. Literal directory access does not
  // grant data access to their children or other installed SDK components.
  const exceptions = [...readable.map((item) => `(subpath ${quote(item)})`),
    ...listDirectories.map((item) => `(literal ${quote(fs.realpathSync(item))})`)].join(' ');
  return `(version 1)
(allow default)
(deny file-read-data (require-all
  (require-any (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))
  (require-not (require-any ${exceptions}))))
(deny file-read-data (require-all
  (regex #"(^|/)([.]env[^/]*|[.]npmrc|credentials[.]json)$|[.](jks|keystore|p8|p12|pfx|mobileprovision|keychain|keychain-db|key)$")
  (require-not (subpath ${quote(stage)}))))
(deny file-write* (require-not (require-any (subpath ${quote(stage)}) (literal "/dev/null"))))
(deny process-info* (require-not (target same-sandbox)))
(deny signal (require-not (target same-sandbox)))
(deny appleevent-send)
(deny network-outbound (require-all
  (require-not (remote ip "*:*"))
  (require-not (require-any (subpath ${quote(stage)}) ${online ? '(literal "/private/var/run/mDNSResponder")' : ''}))))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd") (global-name "com.apple.securityd.ckks"))
${online ? '' : '(deny network-outbound (require-not (remote ip "localhost:*")))\n(deny network-inbound (require-not (local ip "localhost:*")))'}
`;
}

function cleanEnvironment(directory, nodeDirectory, javaHome, sdk) {
  return {
    PATH: [nodeDirectory, path.join(javaHome, 'bin'), '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: path.join(directory, 'home'), TMPDIR: path.join(directory, 'tmp'),
    JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
    GRADLE_USER_HOME: path.join(directory, 'gradle-home'),
    NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_USERCONFIG: path.join(directory, 'empty-npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'empty-global-npmrc'), NPM_CONFIG_CACHE: path.join(directory, 'npm-cache'),
    CI: '1', EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', EOSTP_NATIVE_SANDBOX: '1',
    // macOS evaluates Java's dual-stack bind differently from IPv4 loopback.
    // Keep the loopback-only policy and use IPv4 for local Gradle IPC.
    LANG: 'en_US.UTF-8', JAVA_TOOL_OPTIONS: `-XX:-UsePerfData -Djava.net.preferIPv4Stack=true -Duser.home=${path.join(directory, 'home')} -Djava.io.tmpdir=${path.join(directory, 'tmp')}`,
  };
}

function prepareStage(directory) {
  for (const name of ['home', 'tmp']) fs.mkdirSync(path.join(directory, name), { recursive: true });
  for (const name of ['empty-npmrc', 'empty-global-npmrc']) fs.writeFileSync(path.join(directory, name), '');
}

function runSandbox(directory, tools, online, command, args, env, log, listDirectories = []) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('This native entry point requires macOS sandbox-exec; no unsandboxed fallback is allowed.');
  const profile = path.join(directory, online ? 'networked.sb' : 'offline.sb');
  const extra = env.EOS3_RELEASE_SIGNER === '1' ? '\n(deny network*)\n' : '';
  fs.writeFileSync(profile, sandboxProfile(directory, tools, online, listDirectories) + extra);
  const descriptor = fs.openSync(log, 'w', 0o600);
  try {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, command, ...args], { cwd: directory, env, stdio: ['ignore', descriptor, descriptor] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Sandboxed native step failed (${result.status ?? result.signal}); inspect ${path.basename(log)}. No unsandboxed fallback was used.`);
  } finally { fs.closeSync(descriptor); }
}

// Only credential-free compilation may stream output. The release signer keeps
// using runSandbox, whose private diagnostics never reach the Actions console.
async function runSandboxStreaming(directory, tools, online, command, args, env, log, listDirectories = [], { label = 'native', output = (text) => process.stdout.write(text) } = {}) {
  if (env.EOS3_RELEASE_SIGNER === '1') throw new Error('Signing diagnostics cannot be streamed.');
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('This native entry point requires macOS sandbox-exec; no unsandboxed fallback is allowed.');
  const profile = path.join(directory, online ? 'networked.sb' : 'offline.sb');
  fs.writeFileSync(profile, sandboxProfile(directory, tools, online, listDirectories));
  const descriptor = fs.openSync(log, 'w', 0o600);
  // Dependencies can print arbitrary workflow commands. Suspend interpretation
  // with a fresh token kept only in the parent, never in the child or log file.
  const token = process.env.GITHUB_ACTIONS === 'true' ? randomUUID() : null;
  let child;
  const interrupt = () => child?.kill('SIGTERM');
  const started = Date.now();
  const display = (text) => {
    const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (clean) output(`[${label}] ${clean.replace(/\r\n?|\n/g, `\n[${label}] `)}\n`);
  };
  let heartbeat;
  try {
    if (token) output(`::stop-commands::${token}\n`);
    child = spawn('/usr/bin/sandbox-exec', ['-f', profile, command, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
    process.once('SIGTERM', interrupt);
    process.once('SIGINT', interrupt);
    heartbeat = setInterval(() => output(`[${label}] running; elapsed ${Math.floor((Date.now() - started) / 1000)}s\n`), 60000);
    async function drain(stream) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      try {
        for await (const chunk of stream) {
          fs.writeSync(descriptor, chunk);
          pending += decoder.write(chunk);
          const lastLine = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
          if (lastLine >= 0) {
            display(pending.slice(0, lastLine).replace(/\r$/, ''));
            pending = pending.slice(lastLine + 1);
          }
          // Keep a dependency printing one enormous line from growing memory.
          if (pending.length > 65536) { display(pending); pending = ''; }
        }
        display(pending + decoder.end());
      } catch (error) {
        child.kill('SIGKILL');
        throw error;
      }
    }
    const results = await Promise.allSettled([completed, drain(child.stdout), drain(child.stderr)]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    const result = results[0].value;
    if (result.status !== 0) throw new Error(`Sandboxed native step failed (${result.status ?? result.signal}); inspect ${path.basename(log)}. No unsandboxed fallback was used.`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
    }
    clearInterval(heartbeat);
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    fs.closeSync(descriptor);
    if (token) output(`\n::${token}::\n`);
  }
}

module.exports = { sandboxProfile, cleanEnvironment, prepareStage, runSandbox, runSandboxStreaming, nodeRuntimeRoot };
