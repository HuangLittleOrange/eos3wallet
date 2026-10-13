'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

module.exports = { sandboxProfile, cleanEnvironment, prepareStage, runSandbox, nodeRuntimeRoot };
