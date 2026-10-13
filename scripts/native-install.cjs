'use strict';

const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { StringDecoder } = require('node:string_decoder');

const installArguments = Object.freeze(['ci', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--maxsockets=8', '--fetch-retries=2', '--fetch-timeout=300000']);

function transientDownloadError(text) {
  const codes = [...text.matchAll(/^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$/gm)].map((match) => match[1]);
  const allowed = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'E500', 'E502', 'E503', 'E504']);
  // Integrity, registry authentication, TLS, policy and unknown failures stop.
  return codes.length > 0 && codes.every((code) => allowed.has(code));
}

async function installPublicDependencies(cwd, { command = 'npm', attempts = 3, retryDelayMs = 5000, output = (text) => process.stdout.write(text) } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('At most three npm installation attempts are allowed.');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    output(`Starting npm ci download attempt ${attempt}/${attempts}\n`);
    const child = spawn(command, installArguments, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
    async function stream(pipe) {
      const decoder = new StringDecoder('utf8');
      try {
        for await (const chunk of pipe) {
          const text = decoder.write(chunk);
          tail = (tail + text).slice(-65536);
          output(text);
        }
        const text = decoder.end(); tail = (tail + text).slice(-65536); output(text);
      } catch (error) {
        child.kill('SIGKILL');
        throw error;
      }
    }
    const results = await Promise.allSettled([completed, stream(child.stdout), stream(child.stderr)]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    const { status, signal } = results[0].value;
    if (status === 0) { output(`npm ci succeeded on attempt ${attempt}\n`); return; }
    if (signal || attempt === attempts || !transientDownloadError(tail)) throw new Error(`npm ci failed (${status ?? signal}); installation stopped without bypassing validation.`);
    output(`Transient npm download failure; retrying with the same lockfile and download cache in ${retryDelayMs / 1000}s\n`);
    await delay(retryDelayMs);
  }
}

module.exports = { installArguments, transientDownloadError, installPublicDependencies };
