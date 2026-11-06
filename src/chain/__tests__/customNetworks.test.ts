jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../net/publicApi', () => ({ fetchPublicJSON: jest.fn() }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: jest.fn(), setItem: jest.fn() } }));
import type { CustomNetworkInput } from '../customNetworks';
let registry: typeof import('../customNetworks');
let config: typeof import('../config');
let storage: typeof import('@react-native-async-storage/async-storage').default;
let fetchJSON: jest.Mock;
const saved = new Map<string, string>();
const hash = 'ab'.repeat(32);
const input = (overrides: Partial<CustomNetworkInput> = {}): CustomNetworkInput => ({ name: 'Example', rpcUrl: 'https://rpc.example.com/',
  backupRpcUrl: 'https://backup.example.org', chainIdHash: hash, symbol: 'EOS', precision: 4,
  systemToken: 'eosio.token', resourceContract: 'eosio', testnet: false, historyUrl: '', explorerUrl: '', ...overrides });
function fresh() {
  jest.resetModules();
  storage = require('@react-native-async-storage/async-storage').default;
  jest.mocked(storage.getItem).mockImplementation(async key => saved.get(key) ?? null);
  jest.mocked(storage.setItem).mockImplementation(async (key, value) => { saved.set(key, value); });
  fetchJSON = require('../../net/publicApi').fetchPublicJSON;
  fetchJSON.mockResolvedValue({ chain_id: hash, head_block_num: 100 });
  registry = require('../customNetworks'); config = require('../config');
}
beforeEach(() => { saved.clear(); fresh(); });

test('validates endpoints, registers only after verified durable storage, and restores before visibility', async () => {
  const network = await registry.addCustomNetwork(input({ chainIdHash: hash.toUpperCase() }));
  expect(network.id).toBe(`custom:${hash}`);
  expect(network.nodes[0].url).toBe('https://rpc.example.com');
  expect(network.historyNodes).toEqual([]);
  expect(fetchJSON).toHaveBeenCalledTimes(2);
  expect(config.CHAINS[network.id]).toEqual(network);
  const visibility = require('../networkVisibility');
  await visibility.setNetworkVisible(network.id, true);
  fresh();
  await registry.loadCustomNetworks();
  await require('../networkVisibility').loadNetworkVisibility();
  expect(config.isChainId(network.id)).toBe(true);
  expect(require('../networkVisibility').networkVisibilitySnapshot().enabled).toContain(network.id);
  expect(fetchJSON).not.toHaveBeenCalled(); // Restoring saved identities works offline.
});

test.each(['http://rpc.example.com', 'https://user:secret@rpc.example.com', 'https://rpc.example.com?token=x',
  'https://rpc.example.com#fragment', 'https://rpc.example.com\\evil', 'javascript:alert(1)'])('rejects unsafe RPC %s', rpcUrl => {
  expect(() => registry.validateCustomNetwork(input({ rpcUrl }))).toThrow('network.invalidUrl');
});
test.each([{ chainIdHash: '123' }, { chainIdHash: '0'.repeat(64) }, { symbol: 'FAKEEOSX' }, { precision: 19 },
  { precision: 1.5 }, { systemToken: 'eosio.6' }, { resourceContract: '...' }, { name: ' ' }])('rejects invalid network identity/currency %j', value => {
  expect(() => registry.validateCustomNetwork(input(value))).toThrow();
});
test('requires a distinct backup host and leaves a single-node network usable for observation', () => {
  expect(() => registry.validateCustomNetwork(input({ backupRpcUrl: 'https://rpc.example.com/other' }))).toThrow('network.distinctRpc');
  expect(registry.validateCustomNetwork(input({ backupRpcUrl: '' })).nodes).toHaveLength(1);
});
test('rejects a wrong chain from either RPC and never stores or registers it', async () => {
  fetchJSON.mockResolvedValueOnce({ chain_id: hash, head_block_num: 100 })
    .mockResolvedValueOnce({ chain_id: 'cd'.repeat(32), head_block_num: 100 });
  await expect(registry.addCustomNetwork(input())).rejects.toThrow('network.chainMismatch');
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(config.isChainId(`custom:${hash}`)).toBe(false);
});
test('duplicate chain hashes cannot alias built-in networks or existing wallets', async () => {
  await expect(registry.addCustomNetwork(input({ chainIdHash: config.CHAINS.vaulta.chainIdHash }))).rejects.toThrow('network.duplicate');
  expect(fetchJSON).not.toHaveBeenCalled();
  await registry.addCustomNetwork(input());
  await expect(registry.addCustomNetwork(input({ name: 'Another name' }))).rejects.toThrow('network.duplicate');
  expect(registry.customNetworksSnapshot().networks).toHaveLength(1);
});
test('RPC failures and storage failures leave the registry unchanged', async () => {
  fetchJSON.mockRejectedValueOnce(new Error('offline'));
  await expect(registry.addCustomNetwork(input())).rejects.toThrow('network.rpcUnavailable');
  jest.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await expect(registry.addCustomNetwork(input())).rejects.toThrow('disk full');
  expect(config.isChainId(`custom:${hash}`)).toBe(false);
  await registry.addCustomNetwork(input());
  expect(registry.customNetworksSnapshot().networks).toHaveLength(1);
});
test('corrupt or unreadable storage cannot be overwritten; retry restores saved networks', async () => {
  saved.set(registry.CUSTOM_NETWORKS_KEY, JSON.stringify({ version: 1, networks: [input()] }));
  jest.mocked(storage.getItem).mockRejectedValueOnce(new Error('unavailable'));
  await registry.loadCustomNetworks();
  await expect(registry.addCustomNetwork(input())).rejects.toThrow('network.settingsError');
  expect(storage.setItem).not.toHaveBeenCalled();
  await registry.retryCustomNetworks();
  expect(registry.customNetworksSnapshot()).toMatchObject({ ready: true, readError: false });
  fresh(); saved.set(registry.CUSTOM_NETWORKS_KEY, '{broken');
  await registry.loadCustomNetworks();
  expect(registry.customNetworksSnapshot().readError).toBe(true);
  expect(config.isChainId(`custom:${hash}`)).toBe(false);
});
test('remote node catalogs cannot remove custom identities or change their endpoints', async () => {
  const network = await registry.addCustomNetwork(input());
  const { BUILTIN_NODE_CATALOG, withCustomNetworkNodes } = require('../nodeCatalog');
  const merged = withCustomNetworkNodes({ ...BUILTIN_NODE_CATALOG, [network.id]: { rpc: [], history: [] } });
  expect(merged[network.id]).toEqual({ rpc: network.nodes, history: [] });
  expect(BUILTIN_NODE_CATALOG[network.id]).toBeUndefined();
});
