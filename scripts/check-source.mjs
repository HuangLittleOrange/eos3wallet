import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
// Exact fingerprints of the two public anchor-link test keys, only at their source fixture.
const publicVectors = new Set([
  'd23272d381d1',
  'fbe38325acc1',
]);
const patterns = [
  /PVT_[KR]1_[1-9A-HJ-NP-Za-km-z]{35,}/g,
  /\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /gh[pousr]_[A-Za-z0-9]{25,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /SPONSOR_PROJECT_(?:PASSWORD)/g,
];
const failures = [];
for (const file of files) {
  let stat;
  try { stat = statSync(file); } catch { continue; }
  if (!stat.isFile()) continue;
  if (/(^|\/)(?:\.claude|\.codex|backups|exports|credentials)(?:\/|$)|(?:\.p12|\.p8|\.pfx|\.jks|\.keystore|\.mobileprovision|\.ipa|\.apk|\.aab|\.log)$|(^|\/)\.env(?:$|\.(?!.*example$))/i.test(file)) {
    failures.push(`${file}: private/generated file in source inventory`);
    continue;
  }
  const text = readFileSync(file).toString('utf8');
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const hash = createHash('sha256').update(match[0]).digest('hex').slice(0, 12);
      if (file === 'src/dapp/__tests__/linkCrypto.test.ts' && publicVectors.has(hash)) continue;
      failures.push(`${file}: possible secret (content withheld)`);
    }
  }
}
const app = JSON.parse(readFileSync('app.json')).expo;
if (app.owner || app.extra?.eas?.projectId) failures.push('app.json: personal build ownership belongs in local configuration');
if (failures.length) {
  console.error([...new Set(failures)].join('\n'));
  process.exitCode = 1;
} else console.log(`Checked ${files.length} source paths; no matching secret or private file found. This scan is not a security certification.`);
