const originalDev = __DEV__;
afterEach(() => { (globalThis as any).__DEV__ = originalDev; jest.resetModules(); });

function adapter(platform: string, configured: boolean, development: boolean) {
  jest.resetModules();
  (globalThis as any).__DEV__ = development;
  const storage = { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) };
  const nativeAppLoaded = jest.fn();
  const nativeAnalyticsLoaded = jest.fn();
  const instance = {};
  const native = {
    getAnalytics: jest.fn(() => instance),
    setAnalyticsCollectionEnabled: jest.fn(async () => {}),
    setConsent: jest.fn(async () => {}),
    resetAnalyticsData: jest.fn(async () => {}),
  };
  jest.doMock('react-native', () => ({ Platform: { OS: platform } }));
  jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { firebaseAnalytics: { android: configured, ios: configured } } } } }));
  jest.doMock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: storage }));
  jest.doMock('@react-native-firebase/app', () => { nativeAppLoaded(); return { getApps: () => [{ name: '[DEFAULT]' }] }; });
  jest.doMock('@react-native-firebase/analytics', () => { nativeAnalyticsLoaded(); return native; });
  const { usageAnalytics, loadNativeAnalyticsSdk } = require('../nativeAnalytics');
  return { controller: usageAnalytics, loadNativeAnalyticsSdk, nativeAppLoaded, nativeAnalyticsLoaded, native, instance, storage };
}

it.each([
  ['android', false, false], ['ios', false, false], ['web', true, false], ['android', true, true],
])('does not import Firebase in an unsupported or unconfigured build (%s, %s, %s)', async (platform, configured, development) => {
  const f = adapter(platform, configured, development);
  await f.controller.start();
  expect(f.nativeAppLoaded).not.toHaveBeenCalled();
  expect(f.nativeAnalyticsLoaded).not.toHaveBeenCalled();
  expect(f.storage.getItem).not.toHaveBeenCalled();
  expect(f.controller.snapshot()).toMatchObject({ ready: true, available: false, enabled: false });
});

it('the native adapter exposes only collection, consent and reset', async () => {
  const f = adapter('android', true, false);
  const sdk = await f.loadNativeAnalyticsSdk();
  expect(f.nativeAppLoaded).toHaveBeenCalledTimes(1);
  expect(f.nativeAnalyticsLoaded).toHaveBeenCalledTimes(1);
  expect(Object.keys(sdk)).toEqual(['collection', 'consent', 'reset']);
  await sdk.collection(false);
  expect(f.native.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith(f.instance, false);
  await sdk.consent({ analytics_storage: true, ad_storage: false, ad_user_data: false, ad_personalization: false });
  expect(f.native.setConsent).toHaveBeenLastCalledWith(f.instance, { analytics_storage: true, ad_storage: false, ad_user_data: false, ad_personalization: false });
  await sdk.reset();
  expect(f.native.resetAnalyticsData).toHaveBeenCalledWith(f.instance);
});
