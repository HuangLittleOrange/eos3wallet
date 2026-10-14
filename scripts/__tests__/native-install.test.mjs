import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { installPublicDependencies, transientDownloadError, installArguments } = createRequire(import.meta.url)('../native-install.cjs');

test('only explicit transient npm download failures can be retried', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'E503']) assert.equal(transientDownloadError(`npm error code ${code}\n`), true);
  for (const code of ['EINTEGRITY', 'E401', 'E403', 'EINVALIDSIGNATURE', 'CERT_HAS_EXPIRED', 'EUSAGE']) assert.equal(transientDownloadError(`npm error code ETIMEDOUT\nnpm error code ${code}\n`), false);
  assert.equal(transientDownloadError('npm warn package says ETIMEDOUT'), false);
  assert.equal(transientDownloadError('unknown error'), false);
});

test('actual child retries a network timeout with unchanged safe arguments, streams output and stops at the limit', async () => {
  for (const variant of ['recover', 'exhausted', 'integrity']) {
    // The isolated container's /tmp is deliberately noexec. Keep the tiny
    // executable fixture in its writable workspace instead of weakening /tmp.
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.npm-retry-test-'));
    try {
      const executable = path.join(dir, 'fake-npm');
      fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('fs');const n=fs.existsSync('count')?+fs.readFileSync('count'):0;fs.writeFileSync('count',String(n+1));fs.appendFileSync('arguments.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');console.log('live download progress');if(${JSON.stringify(variant)}==='recover'&&n===1)process.exit(0);console.error('npm error code '+(${JSON.stringify(variant)}==='integrity'?'EINTEGRITY':'ETIMEDOUT'));process.exit(1);\n`, { mode: 0o700 });
      const output = [];
      const promise = installPublicDependencies(dir, { command: executable, retryDelayMs: 0, output: (text) => output.push(text) });
      if (variant === 'recover') await promise; else await assert.rejects(promise, /installation stopped without bypassing validation/);
      assert.equal(+fs.readFileSync(path.join(dir, 'count')), variant === 'recover' ? 2 : variant === 'exhausted' ? 3 : 1);
      for (const args of fs.readFileSync(path.join(dir, 'arguments.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)) {
        assert.deepEqual(args, installArguments);
        assert.ok(args.includes('--ignore-scripts'));
        assert.ok(!args.some((arg) => /--force|--registry=|--ignore-scripts=false/.test(arg)));
      }
      assert.match(output.join(''), /live download progress/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
