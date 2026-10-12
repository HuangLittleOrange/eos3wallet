import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'EOS³ Wallet',
  slug: config.slug ?? 'eostp',
  ...(process.env.EAS_OWNER ? { owner: process.env.EAS_OWNER } : {}),
  ...(process.env.EAS_PROJECT_ID ? {
    extra: { ...config.extra, eas: { ...config.extra?.eas, projectId: process.env.EAS_PROJECT_ID } },
  } : {}),
});
