import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { CHAINS, type ChainConfig, type CustomChainId } from './config';
import { fetchPublicJSON } from '../net/publicApi';
import type { TranslationKey } from '../i18n';

export const CUSTOM_NETWORKS_KEY = 'eos3.customNetworks.v1';
const MAX_NETWORKS = 50;
export type CustomNetworkInput = {
  name: string; rpcUrl: string; backupRpcUrl: string; chainIdHash: string;
  symbol: string; precision: number; systemToken: string; resourceContract: string;
  testnet: boolean; historyUrl: string; explorerUrl: string;
};
type Snapshot = { networks: readonly ChainConfig[]; ready: boolean; readError: boolean };
let snapshot: Snapshot = { networks: [], ready: false, readError: false };
let hydration: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export const customNetworksSnapshot = () => snapshot;
export const subscribeCustomNetworks = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
function publish(next: Snapshot) { snapshot = next; listeners.forEach(listener => listener()); }
export class NetworkValidationError extends Error {
  constructor(readonly key: TranslationKey) { super(key); }
}
function invalid(key: TranslationKey): never { throw new NetworkValidationError(key); }
export function normalizeNetworkUrl(value: string): string {
  const text = value.trim();
  let url: URL;
  try { url = new URL(text); } catch { return invalid('network.invalidUrl'); }
  if (text.length > 2048 || url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || /[\\\p{Cc}\s]/u.test(text)) invalid('network.invalidUrl');
  return url.toString().replace(/\/+$/, '');
}
export function validateCustomNetwork(input: CustomNetworkInput): ChainConfig {
  const name = input.name.trim();
  const hash = input.chainIdHash.trim().toLowerCase();
  const symbol = input.symbol.trim();
  const systemToken = input.systemToken.trim();
  const resourceContract = input.resourceContract.trim();
  if (!name || [...name].length > 40 || /\p{Cc}/u.test(name)) invalid('network.invalidName');
  if (!/^[a-f0-9]{64}$/.test(hash) || /^0+$/.test(hash)) invalid('network.invalidChainId');
  if (!/^[A-Z]{1,7}$/.test(symbol) || !Number.isInteger(input.precision) || input.precision < 0 || input.precision > 18)
    invalid('network.invalidCurrency');
  if (![systemToken, resourceContract].every(value => /^[a-z1-5.]{1,12}$/.test(value) && /[a-z1-5]/.test(value) && !value.endsWith('.')))
    invalid('network.invalidContract');
  if (typeof input.testnet !== 'boolean') invalid('network.invalidData');
  const rpcUrl = normalizeNetworkUrl(input.rpcUrl);
  // Keep the same two-host corroboration used for imports and signing on built-in networks.
  const backupRpcUrl = input.backupRpcUrl.trim() ? normalizeNetworkUrl(input.backupRpcUrl) : '';
  if (backupRpcUrl && new URL(rpcUrl).hostname === new URL(backupRpcUrl).hostname) invalid('network.distinctRpc');
  const historyUrl = input.historyUrl.trim() ? normalizeNetworkUrl(input.historyUrl) : '';
  const explorerUrl = input.explorerUrl.trim() ? normalizeNetworkUrl(input.explorerUrl) : undefined;
  const id: CustomChainId = `custom:${hash}`;
  return { id, name, chainIdHash: hash, symbol, precision: input.precision, systemToken, resourceContract,
    testnet: input.testnet, custom: true, explorerUrl,
    nodes: [{ id: `${id}:rpc`, name, url: rpcUrl }, ...(backupRpcUrl ? [{ id: `${id}:backup`, name: `${name} 2`, url: backupRpcUrl }] : [])],
    historyNodes: historyUrl ? [{ id: `${id}:history`, name: 'Hyperion', url: historyUrl }] : [] };
}
function parseSaved(value: unknown): ChainConfig[] {
  const doc = value as { version?: unknown; networks?: unknown } | null;
  if (doc?.version !== 1 || !Array.isArray(doc.networks) || doc.networks.length > MAX_NETWORKS) invalid('network.invalidData');
  const hashes = new Set([CHAINS.vaulta.chainIdHash, CHAINS.jungle4.chainIdHash]);
  return doc.networks.map((entry: CustomNetworkInput) => {
    const config = validateCustomNetwork(entry);
    if (hashes.has(config.chainIdHash)) invalid('network.duplicate');
    hashes.add(config.chainIdHash);
    return config;
  });
}
function register(networks: readonly ChainConfig[]) {
  for (const network of networks) CHAINS[network.id] = network;
}
export function loadCustomNetworks(): Promise<void> {
  if (!hydration) hydration = (async () => {
    try {
      const raw = await AsyncStorage.getItem(CUSTOM_NETWORKS_KEY);
      if (raw && raw.length > 256 * 1024) invalid('network.invalidData');
      const networks = raw ? parseSaved(JSON.parse(raw)) : [];
      register(networks);
      publish({ networks, ready: true, readError: false });
    } catch { publish({ ...snapshot, ready: true, readError: true }); }
  })();
  return hydration;
}
export function retryCustomNetworks() {
  if (snapshot.readError) { hydration = null; publish({ ...snapshot, ready: false, readError: false }); }
  return loadCustomNetworks();
}
export function useCustomNetworks() {
  const value = useSyncExternalStore(subscribeCustomNetworks, customNetworksSnapshot, customNetworksSnapshot);
  useEffect(() => { void loadCustomNetworks(); }, []);
  return value;
}
function savedInput(network: ChainConfig): CustomNetworkInput {
  return { name: network.name, chainIdHash: network.chainIdHash, symbol: network.symbol, precision: network.precision,
    systemToken: network.systemToken, resourceContract: network.resourceContract, testnet: network.testnet,
    rpcUrl: network.nodes[0].url, backupRpcUrl: network.nodes[1]?.url ?? '',
    historyUrl: network.historyNodes[0]?.url ?? '', explorerUrl: network.explorerUrl ?? '' };
}
export function addCustomNetwork(input: CustomNetworkInput): Promise<ChainConfig> {
  // Capture form values before awaiting anything; serialized writes cannot lose another addition.
  const config = validateCustomNetwork(input);
  const operation = writes.catch(() => {}).then(async () => {
    await loadCustomNetworks();
    if (snapshot.readError) invalid('network.settingsError');
    if (Object.values(CHAINS).some(network => network.chainIdHash === config.chainIdHash)) invalid('network.duplicate');
    if (snapshot.networks.length >= MAX_NETWORKS) invalid('network.limit');
    await Promise.all(config.nodes.map(async node => {
      let info: unknown;
      try { info = await fetchPublicJSON(node.url + '/v1/chain/get_info', { timeoutMs: 8000, maxLength: 64 * 1024, label: 'RPC' }); }
      catch { return invalid('network.rpcUnavailable'); }
      const value = info as { chain_id?: unknown; head_block_num?: unknown } | null;
      if (typeof value?.chain_id !== 'string' || value.chain_id.toLowerCase() !== config.chainIdHash)
        invalid('network.chainMismatch');
      if (!Number.isSafeInteger(value.head_block_num) || Number(value.head_block_num) <= 0) invalid('network.rpcUnavailable');
    }));
    const networks = [...snapshot.networks, config];
    await AsyncStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify({ version: 1, networks: networks.map(savedInput) }));
    register([config]);
    publish({ networks, ready: true, readError: false });
    return config;
  });
  writes = operation.catch(() => {});
  return operation;
}
