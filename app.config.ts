import type { ConfigContext, ExpoConfig } from 'expo/config';
const { configureFirebase } = require('./plugins/firebase-analytics-config.cjs');
const iosBuildNumber = process.env.IOS_BUILD_NUMBER;
if (iosBuildNumber !== undefined && !/^[1-9][0-9]{0,8}$/.test(iosBuildNumber)) {
  throw new Error('IOS_BUILD_NUMBER must be a positive integer of at most 9 digits.');
}

export default ({ config }: ConfigContext): ExpoConfig => configureFirebase({
  ...config,
  name: config.name ?? 'EOS³ Wallet',
  slug: config.slug ?? 'eostp',
  ...(iosBuildNumber ? { ios: { ...config.ios, buildNumber: iosBuildNumber } } : {}),
  ...(process.env.EAS_OWNER ? { owner: process.env.EAS_OWNER } : {}),
  ...(process.env.EAS_PROJECT_ID ? {
    extra: { ...config.extra, eas: { ...config.extra?.eas, projectId: process.env.EAS_PROJECT_ID } },
  } : {}),
}, __dirname);
