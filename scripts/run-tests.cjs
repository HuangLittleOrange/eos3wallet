'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { verifyDependencyPolicy } = require('./dependency-policy.cjs');
const { verifyDependencyPatches } = require('./dependency-patches.cjs');
const root = path.resolve(__dirname, '..');

try {
  // npm ignore-scripts also disables pretest/posttest; keep mandatory checks here.
  verifyDependencyPolicy();
  verifyDependencyPatches();
  const jest = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  if (jest.error) throw jest.error;
  if (jest.status !== 0) process.exit(jest.status ?? 1);
  const tooling = spawnSync(process.execPath, ['--test', 'scripts/__tests__/dependency-patches.test.mjs', 'scripts/__tests__/dependency-policy.test.mjs', 'scripts/__tests__/native-sandbox.test.mjs', 'scripts/__tests__/native-install.test.mjs', 'scripts/__tests__/github-android.test.mjs', 'scripts/__tests__/github-ios.test.mjs', 'scripts/__tests__/release-signing.test.mjs', 'scripts/__tests__/firebase-analytics-config.test.mjs'], { cwd: root, stdio: 'inherit' });
  if (tooling.error) throw tooling.error;
  process.exitCode = tooling.status ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
