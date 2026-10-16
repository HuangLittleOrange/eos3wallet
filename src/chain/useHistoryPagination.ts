import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChainAction, ChainClient } from './client';
import { historyKey, readHistoryPage } from './historyCache';
const PAGE_SIZE = 30;
type State = { key: string; extra: ChainAction[]; skip: number; loading: boolean; hasMore: boolean };

/** The two history screens share page reads, with guards against late responses after a head/account change. */
export function useHistoryPagination(client: ChainClient, account: string, head: ChainAction[], waiting: boolean) {
  const headVersion = useMemo(() => JSON.stringify(head.map(row => [row.id, row.seq])), [head]);
  const key = JSON.stringify([historyKey(client, account), headVersion]);
  const [state, setState] = useState<State | null>(null);
  const current = useRef(key); current.current = key;
  const mounted = useRef(true), pending = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const page = state?.key === key ? state : null;
  const extra = page?.extra ?? EMPTY;
  const hasMore = page?.hasMore ?? head.length >= PAGE_SIZE;
  const loadingMore = page?.loading ?? false;
  const all = useMemo(() => [...head, ...extra], [head, extra]);
  const loadMore = async () => {
    if (!account || waiting || !hasMore || loadingMore || pending.current === key || !client.historyNode) return;
    const skip = page?.skip ?? head.length;
    pending.current = key;
    setState({ key, extra, skip, loading: true, hasMore });
    try {
      const next = await readHistoryPage(client, account, { skip, limit: PAGE_SIZE, headVersion });
      if (!mounted.current || current.current !== key) return;
      const seen = new Set(all.map(row => `${row.id}:${row.seq}`));
      const added = next.actions.filter(row => { const id = `${row.id}:${row.seq}`;
        if (seen.has(id)) return false; seen.add(id); return true; });
      setState({ key, extra: [...extra, ...added], skip: skip + next.actions.length, loading: false, hasMore: next.hasMore });
    } catch { // Keep the visible rows and allow the next scroll to retry.
      if (mounted.current && current.current === key) setState({ key, extra, skip, loading: false, hasMore });
    } finally { if (pending.current === key) pending.current = null; }
  };
  return { all, loadingMore, loadMore };
}
const EMPTY: ChainAction[] = [];
