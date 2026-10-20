jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: jest.fn(), setItem: jest.fn() } }));
let prefs: typeof import('../networkVisibility');
let storage: typeof import('@react-native-async-storage/async-storage').default;
const saved = new Map<string, string>();
function freshModule() {
  jest.resetModules();
  storage = require('@react-native-async-storage/async-storage').default;
  jest.mocked(storage.getItem).mockImplementation(async key => saved.get(key) ?? null);
  jest.mocked(storage.setItem).mockImplementation(async (key, value) => { saved.set(key, value); });
  prefs = require('../networkVisibility');
}
beforeEach(() => { saved.clear(); freshModule(); });

test('fresh installations expose mainnet only, and explicit testnet choices survive reload', async () => {
  await prefs.loadNetworkVisibility();
  expect(prefs.networkVisibilitySnapshot()).toEqual({ enabled: ['vaulta'], ready: true, readError: false });
  expect(storage.setItem).not.toHaveBeenCalled();
  await prefs.setNetworkVisible('jungle4', true);
  freshModule();
  await prefs.loadNetworkVisibility();
  expect(prefs.networkVisibilitySnapshot().enabled).toEqual(['vaulta', 'jungle4']);
});

test('unchecking persists the hidden state while preserving unrelated wallet data', async () => {
  saved.set('wallet-data', 'preserve-this');
  await prefs.setNetworkVisible('jungle4', true);
  await prefs.setNetworkVisible('jungle4', false);
  await prefs.setNetworkVisible('vaulta', false);
  freshModule();
  await prefs.loadNetworkVisibility();
  expect(prefs.networkVisibilitySnapshot().enabled).toEqual(['vaulta']);
  expect(saved.get('wallet-data')).toBe('preserve-this');
});

test('serialized updates keep the final choice, and a write failure does not publish a false success', async () => {
  await Promise.all([prefs.setNetworkVisible('jungle4', true), prefs.setNetworkVisible('jungle4', false)]);
  expect(prefs.networkVisibilitySnapshot().enabled).toEqual(['vaulta']);
  jest.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await expect(prefs.setNetworkVisible('jungle4', true)).rejects.toThrow('disk full');
  expect(prefs.networkVisibilitySnapshot().enabled).toEqual(['vaulta']);
  await prefs.setNetworkVisible('jungle4', true);
  expect(prefs.networkVisibilitySnapshot().enabled).toContain('jungle4');
});

test('failed reads cannot overwrite saved settings; retry recovers them', async () => {
  saved.set(prefs.NETWORK_VISIBILITY_KEY, JSON.stringify({ version: 1, enabled: ['vaulta', 'jungle4'] }));
  jest.mocked(storage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
  await prefs.loadNetworkVisibility();
  expect(prefs.networkVisibilitySnapshot().readError).toBe(true);
  await expect(prefs.setNetworkVisible('jungle4', false)).rejects.toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
  await prefs.retryNetworkVisibility();
  expect(prefs.networkVisibilitySnapshot()).toEqual({ enabled: ['vaulta', 'jungle4'], ready: true, readError: false });
});

test.each(['invalid json', '{"version":2,"enabled":["jungle4"]}', '{"version":1,"enabled":["unknown","vaulta","vaulta"]}'])
  ('unusable preferences retain a valid mainnet default: %s', async raw => {
    saved.set(prefs.NETWORK_VISIBILITY_KEY, raw);
    await prefs.loadNetworkVisibility();
    expect(prefs.networkVisibilitySnapshot().enabled).toEqual(['vaulta']);
  });
