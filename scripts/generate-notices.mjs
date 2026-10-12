import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const upstream = JSON.parse(await readFile(path.join(root, 'third-party/upstream-licenses.json'), 'utf8'));
const sections = [];
const missing = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev) continue;
  const dir = path.join(root, location);
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')); }
  catch { if (!entry.optional) missing.push(`${location}: not installed`); continue; }
  if (pkg.version !== entry.version) { missing.push(`${pkg.name}: installed version differs from lock`); continue; }
  const names = (await readdir(dir)).filter((name) => /^(licen[sc]e|unlicense|copying|notice)([._-]|$)/i.test(name)).sort();
  const texts = [];
  for (const name of names) {
    try { texts.push(`### ${name}\n\n\`\`\`text\n${(await readFile(path.join(dir, name), 'utf8')).trim()}\n\`\`\``); }
    catch { /* A directory is not a license text. */ }
  }
  async function collectVendoredLicenses(directory, relative = '') {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.isSymbolicLink() || ['node_modules', 'build', '.build', '.git'].includes(child.name)) continue;
      const file = path.join(directory, child.name);
      const label = path.join(relative, child.name);
      if (child.isDirectory()) await collectVendoredLicenses(file, label);
      else if (/^(licen[sc]e|unlicense|copying|notice)([._-]|$)/i.test(child.name)) {
        texts.push(`### ${label}\n\n\`\`\`text\n${(await readFile(file, 'utf8')).trim()}\n\`\`\``);
      }
    }
  }
  for (const child of ['deps', 'vendor', 'third-party', 'third_party']) {
    try { await collectVendoredLicenses(path.join(dir, child), child); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!texts.length) {
    for (const file of (await readdir(dir)).filter((name) => /^readme([._-]|$)/i.test(name))) {
      const text = await readFile(path.join(dir, file), 'utf8');
      if (text.includes('Permission is hereby granted') && /copyright/i.test(text)) texts.push(text);
    }
  }
  if (!texts.length && upstream[`${pkg.name}@${pkg.version}`]?.path) {
    const record = upstream[`${pkg.name}@${pkg.version}`];
    texts.push(`Upstream: ${record.source}\n\n${await readFile(path.join(root, record.path), 'utf8')}`);
  }
  if (!texts.length) { missing.push(`${pkg.name}@${pkg.version}: license text missing`); continue; }
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  sections.push(`## ${pkg.name}@${pkg.version}\n\nLicense: ${entry.license ?? pkg.license ?? 'not specified'}\n\nSource: ${pkg.homepage ?? repository ?? entry.resolved ?? 'npm package'}\n\n${texts.join('\n\n')}`);
}
if (missing.length) {
  console.error(missing.join('\n'));
  process.exitCode = 1;
} else {
  await writeFile(path.join(root, 'third-party/npm-notices.txt'),
    'Third-party packages from package-lock.json (production dependency tree).\n' +
    'Includes build tooling shipped with Expo. These licenses are separate from the project MIT license.\n\n' + sections.join('\n\n'));
  console.log(`Preserved license texts for ${sections.length} dependency installations.`);
}
