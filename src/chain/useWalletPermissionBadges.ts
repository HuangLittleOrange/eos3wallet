import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { ChainClient } from './client';
import { resolveAuthPermissions } from './account';
import { hydratePermissionDisplay, peekPermissionDisplay, refreshPermissionDisplay,
  subscribePermissionDisplay } from './permissionDisplayCache';

type BadgeWallet = { id: string; account: string; publicKey?: string; authPermissions?: string[] };

/** Publish a complete display snapshot, never a succession of per-row RPC results. */
export function useWalletPermissionBadges(wallets: BadgeWallet[], client: ChainClient, enabled = true): Record<string, string[]> {
  const walletKey = JSON.stringify(wallets.map(({ id, account, publicKey }) => ({ id, account, publicKey })));
  const scope = JSON.stringify([client.chainId, client.node.url, walletKey]);
  const read = () => Object.fromEntries(wallets.map(wallet => [wallet.id,
    resolveAuthPermissions(wallet, wallet.account, peekPermissionDisplay(client, wallet.account))]));
  const [published, setPublished] = useState(() => ({ scope, badges: read() }));

  useEffect(() => {
    const list: BadgeWallet[] = JSON.parse(walletKey);
    const names = [...new Set(list.filter(wallet => wallet.publicKey).map(wallet => wallet.account))];
    let alive = true;
    let hydrating = true;
    let running = false;
    const publish = () => {
      if (alive) setPublished({ scope, badges: Object.fromEntries(list.map(wallet => [wallet.id,
        resolveAuthPermissions(wallet, wallet.account, peekPermissionDisplay(client, wallet.account))])) });
    };
    const refresh = async () => {
      if (!enabled || hydrating || running || !alive
        || (AppState.currentState !== 'active' && AppState.currentState != null)) return;
      running = true;
      let next = 0;
      const worker = async () => {
        while (alive && next < names.length) {
          try { await refreshPermissionDisplay(client, names[next++]); }
          catch { /* Keep the last verified display while offline. */ }
        }
      };
      try { await Promise.all(Array.from({ length: Math.min(3, names.length) }, worker)); }
      finally { running = false; publish(); }
    };
    const unsubscribe = names.map(account => subscribePermissionDisplay(client, account, () => {
      if (hydrating) return;
      if (!running) publish();
      // Permission invalidation must not wait for an older, now-discarded read to finish.
      if (enabled && (!peekPermissionDisplay(client, account) || peekPermissionDisplay(client, account)?.updatedAt === 0))
        void refreshPermissionDisplay(client, account).catch(() => {}).finally(() => { if (!running) publish(); });
    }));
    // Warm all persisted badges while hidden; opening reuses the whole verified snapshot.
    void Promise.all(names.map(account => hydratePermissionDisplay(client, account))).then(() => {
      hydrating = false;
      publish();
      void refresh();
    });
    const timer = setInterval(() => { void refresh(); }, 60000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { alive = false; clearInterval(timer); subscription.remove(); unsubscribe.forEach(remove => remove()); };
  }, [walletKey, scope, client, enabled]);
  return published.scope === scope ? published.badges : read();
}
