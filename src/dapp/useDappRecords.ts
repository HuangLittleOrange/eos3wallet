import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { ChainId } from '../chain/config';
import { listDappHistory, listDappFavorites, subscribeDappRecords, type DappHistoryItem, type DappFavorite } from './dappGate';

const empty = { history: [] as DappHistoryItem[], favorites: [] as DappFavorite[],
  unassignedHistory: [] as DappHistoryItem[], unassignedFavorites: [] as DappFavorite[] };
export function useDappRecords(networkId: ChainId) {
  const [state, setState] = useState({ networkId, ...empty });
  const scope = useRef(networkId), generation = useRef(0);
  scope.current = networkId;
  const reload = useCallback(async () => {
    const version = ++generation.current;
    const [history, favorites] = await Promise.all([listDappHistory(), listDappFavorites()]);
    if (version === generation.current && scope.current === networkId) {
      setState({ networkId,
        history: history.filter(item => item.networkId === networkId),
        favorites: favorites.filter(item => item.networkId === networkId),
        unassignedHistory: history.filter(item => item.networkId === undefined),
        unassignedFavorites: favorites.filter(item => item.networkId === undefined),
      });
    }
  }, [networkId]);
  useFocusEffect(useCallback(() => {
    const unsubscribe = subscribeDappRecords(() => { void reload(); });
    void reload();
    return () => { unsubscribe(); generation.current++; };
  }, [reload]));
  return { ...(state.networkId === networkId ? state : empty), reload };
}
