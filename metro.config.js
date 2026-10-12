const { verifyDependencyPatches } = require('./scripts/dependency-patches.cjs');
const { verifyDependencyPolicy } = require('./scripts/dependency-policy.cjs');
const { getDefaultConfig } = require('expo/metro-config');

verifyDependencyPolicy();
verifyDependencyPatches();
module.exports = getDefaultConfig(__dirname);
