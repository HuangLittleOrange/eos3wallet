import { useCallback, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ReadCache, type ReadSnapshot } from './readCache';

const EMPTY: ReadSnapshot<never> = { data: undefined, updatedAt: 0, refreshing: false, error: null };

/** Only visible pages poll; navigating back reuses data and refreshes it if stale. */
export function useReadCache<T>(cache: ReadCache<T>, key: string | null, loader: () => Promise<T>) {
  const latestLoader = useRef({ key, loader }); latestLoader.current = { key, loader };
  const subscribe = useCallback((listener: () => void) => key ? cache.subscribe(key, listener) : () => {}, [cache, key]);
  const snapshot = useCallback(() => key ? cache.get(key) : EMPTY, [cache, key]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useFocusEffect(useCallback(() => {
    if (!key) return;
    let alive = true;
    const read = latestLoader.current.loader;
    const refresh = () => {
      if (alive && (AppState.currentState === 'active' || AppState.currentState == null))
        void cache.fetch(key, read).catch(() => {});
    };
    void cache.hydrate(key).then(refresh);
    const timer = setInterval(refresh, Math.max(1000, Math.min(cache.ttl, 60000)));
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { alive = false; clearInterval(timer); subscription.remove(); };
  }, [cache, key]));
  const refresh = useCallback(() => {
    const current = latestLoader.current;
    if (current.key !== key) return Promise.reject(new Error('Read context changed'));
    return key ? cache.fetch(key, current.loader, true) : Promise.resolve(undefined);
  }, [cache, key]);
  return { ...state, refresh };
}
