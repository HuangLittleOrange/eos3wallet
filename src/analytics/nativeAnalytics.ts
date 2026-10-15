import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { createUsageAnalytics, type AnalyticsSdk } from './usageAnalytics';

export async function loadNativeAnalyticsSdk(): Promise<AnalyticsSdk> {
  // Lazy native imports keep unconfigured builds, Expo Go and web usable without Firebase.
  const { getApps } = require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
  if (!getApps().some(app => app.name === '[DEFAULT]')) throw new Error('Firebase is not configured');
  const { getAnalytics, setAnalyticsCollectionEnabled, setConsent, resetAnalyticsData } = require('@react-native-firebase/analytics') as typeof import('@react-native-firebase/analytics');
  const instance = getAnalytics();
  return {
    collection: enabled => setAnalyticsCollectionEnabled(instance, enabled),
    consent: value => setConsent(instance, value),
    reset: () => resetAnalyticsData(instance),
  };
}
const platform = Platform?.OS;
const configured = Constants.expoConfig?.extra?.firebaseAnalytics;
export const usageAnalytics = createUsageAnalytics({
  available: !__DEV__ && (platform === 'android' || platform === 'ios') && configured?.[platform] === true,
  storage: AsyncStorage,
  loadSdk: loadNativeAnalyticsSdk,
});
