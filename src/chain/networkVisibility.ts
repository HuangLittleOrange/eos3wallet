import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_CHAIN, isChainId, type ChainId } from './config';

export const NETWORK_VISIBILITY_KEY = 'eos3.networkVisibility.v1';
type Snapshot = { enabled: readonly ChainId[]; ready: boolean; readError: boolean };
let snapshot: Snapshot = { enabled: [DEFAULT_CHAIN], ready: false, readError: false };
let hydration: Promise<void> | null = null;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export const networkVisibilitySnapshot = () => snapshot;
export function subscribeNetworkVisibility(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: Snapshot) { snapshot = next; for (const listener of listeners) listener(); }

/** No saved preference means mainnet only; existing test wallets never opt themselves in. */
export function loadNetworkVisibility(): Promise<void> {
  if (!hydration) hydration = (async () => {
    try {
      const raw = await AsyncStorage.getItem(NETWORK_VISIBILITY_KEY);
      let enabled: ChainId[] = [DEFAULT_CHAIN];
      if (raw) {
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = null; }
        const saved = value as { version?: unknown; enabled?: unknown } | null;
        if (saved?.version === 1 && Array.isArray(saved.enabled)) {
          enabled = [...new Set([DEFAULT_CHAIN, ...saved.enabled.filter(isChainId)])];
        }
      }
      publish({ enabled, ready: true, readError: false });
    } catch { publish({ ...snapshot, ready: true, readError: true }); }
  })();
  return hydration;
}

export function retryNetworkVisibility() {
  if (snapshot.readError) { hydration = null; publish({ ...snapshot, ready: false, readError: false }); }
  return loadNetworkVisibility();
}

export function setNetworkVisible(network: ChainId, visible: boolean): Promise<void> {
  const operation = writes.catch(() => {}).then(async () => {
    await loadNetworkVisibility();
    // A failed read must not overwrite preferences that could not be recovered.
    if (snapshot.readError) throw new Error('Unable to read network preferences');
    const enabled = visible ? [...new Set([...snapshot.enabled, network])]
      : snapshot.enabled.filter(id => id === DEFAULT_CHAIN || id !== network);
    await AsyncStorage.setItem(NETWORK_VISIBILITY_KEY, JSON.stringify({ version: 1, enabled }));
    publish({ enabled, ready: true, readError: false });
  });
  writes = operation.catch(() => {});
  return operation;
}

export function useNetworkVisibility() {
  const value = useSyncExternalStore(subscribeNetworkVisibility, networkVisibilitySnapshot, networkVisibilitySnapshot);
  useEffect(() => { void loadNetworkVisibility(); }, []);
  return value;
}
