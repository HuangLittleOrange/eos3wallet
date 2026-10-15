'use strict';
// Use the official app plugin only on platforms with a validated service file.
// The SDK app plugin otherwise requires both files and would break unconfigured platforms.
module.exports = function withOptionalFirebaseApp(config, enabled) {
  if (!enabled.android && !enabled.ios) return config;
  const before = config.mods || {};
  const next = require('@react-native-firebase/app/app.plugin.js')({ ...config, mods: { ...before } });
  if (!enabled.android) next.mods.android = before.android;
  if (!enabled.ios) next.mods.ios = before.ios;
  return next;
};
