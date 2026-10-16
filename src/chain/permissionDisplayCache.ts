import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AccountResources, ChainClient } from './client';
import { invalidateLiveAccountRequest, requestLiveAccount } from './liveAccountRequest';
import type { ChainId } from './config';

export const PERMISSION_DISPLAY_TTL = 60 * 60 * 1000;
type Permissions = Pick<AccountResources, 'account' | 'permissions'>;
type Snapshot = Permissions & { updatedAt: number };
type Entry = {
  snapshot: Snapshot | null;
  loaded: boolean;
  loading?: Promise<void>;
  refreshing?: Promise<void>;
  attemptedAt?: number;
  listeners: Set<() => void>;
  client: ChainClient;
  account: string;
  generation: number;
};
const entries = new Map<string, Entry>();
const keyFor = (client: ChainClient, account: string) =>
  'aurora.permissionDisplay.v1.' + JSON.stringify([client.chainId, client.node.url, account]);
const entryFor = (client: ChainClient, account: string): Entry => {
  const key = keyFor(client, account);
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: null, loaded: false, listeners: new Set(), client, account, generation: 0 };
    entries.set(key, entry);
  } else entry.client = client;
  return entry;
};
const notify = (entry: Entry) => entry.listeners.forEach(listener => listener());

function valid(data: unknown, account: string): data is Snapshot {
  const value = data as Snapshot | null;
  return !!value && typeof value.account === 'string' && value.account.length > 0 && value.account === account
    && Number.isFinite(value.updatedAt) && value.updatedAt >= 0
    && value.updatedAt <= Date.now() + 60000 && Array.isArray(value.permissions)
    && value.permissions.every(permission => !!permission && typeof permission.name === 'string' && Array.isArray(permission.keys)
      && permission.keys.every(key => typeof key === 'string'));
}

/** Public display data only. Never used to choose a signer or authorize a transaction. */
export const peekPermissionDisplay = (client: ChainClient, account: string) => entryFor(client, account).snapshot;
export function subscribePermissionDisplay(client: ChainClient, account: string, listener: () => void): () => void {
  const entry = entryFor(client, account);
  entry.listeners.add(listener);
  return () => { entry.listeners.delete(listener); };
}

export function rememberPermissionDisplay(client: ChainClient, resources: Permissions): void {
  const snapshot = { account: resources.account, permissions: resources.permissions, updatedAt: Date.now() };
  if (!valid(snapshot, resources.account)) return;
  const entry = entryFor(client, resources.account);
  entry.snapshot = snapshot;
  entry.loaded = true;
  notify(entry);
  void AsyncStorage.setItem(keyFor(client, resources.account), JSON.stringify(snapshot)).catch(() => {});
}

export function hydratePermissionDisplay(client: ChainClient, account: string): Promise<void> {
  const entry = entryFor(client, account);
  if (entry.loaded) return Promise.resolve();
  if (entry.loading) return entry.loading;
  const generation = entry.generation;
  entry.loading = AsyncStorage.getItem(keyFor(client, account)).then(raw => {
    if (raw && !entry.snapshot && generation === entry.generation) {
      const snapshot: unknown = JSON.parse(raw);
      if (valid(snapshot, account)) { entry.snapshot = snapshot; notify(entry); }
    }
  }).catch(() => {}).finally(() => { entry.loaded = true; entry.loading = undefined; });
  return entry.loading;
}

export async function refreshPermissionDisplay(client: ChainClient, account: string): Promise<void> {
  const entry = entryFor(client, account);
  await hydratePermissionDisplay(client, account);
  if (entry.snapshot && Date.now() - entry.snapshot.updatedAt < PERMISSION_DISPLAY_TTL) return;
  if (entry.refreshing) return entry.refreshing;
  if (entry.attemptedAt !== undefined && Date.now() - entry.attemptedAt < 30000) return;
  entry.attemptedAt = Date.now();
  const generation = entry.generation;
  const request = requestLiveAccount(client, account).then(resources => {
    if (generation !== entry.generation) return;
    if (resources.account !== account) throw new Error('Account response mismatch');
    rememberPermissionDisplay(client, resources);
  }).finally(() => { if (entry.refreshing === request) entry.refreshing = undefined; });
  entry.refreshing = request;
  return entry.refreshing;
}

export function invalidatePermissionDisplay(chainId: ChainId, account: string): void {
  for (const [key, entry] of entries) {
    if (entry.client.chainId !== chainId || entry.account !== account) continue;
    entry.generation++; entry.loaded = true; entry.refreshing = undefined; entry.attemptedAt = undefined;
    invalidateLiveAccountRequest(entry.client, account);
    if (entry.snapshot) entry.snapshot = { ...entry.snapshot, updatedAt: 0 };
    void AsyncStorage.removeItem(key).catch(() => {});
    notify(entry);
  }
}
