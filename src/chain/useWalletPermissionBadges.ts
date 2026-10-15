import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { AccountResources, ChainClient } from './client';
import { resolveAuthPermissions } from './account';

type BadgeWallet = { id: string; account: string; publicKey?: string; authPermissions?: string[] };
type Snapshot = { client: ChainClient; accounts: string; values: Record<string, AccountResources> };

/** Read-only, account-deduplicated badge refresh. Never mutates wallet/signing metadata. */
export function useWalletPermissionBadges(wallets: BadgeWallet[], client: ChainClient, enabled = true, refreshKey?: unknown): Record<string, string[]> {
  const accounts = JSON.stringify([...new Set(wallets.filter(wallet => wallet.publicKey).map(wallet => wallet.account))].sort());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      const names: string[] = JSON.parse(accounts);
      const values: Record<string, AccountResources> = {};
      // Loading/failed reads must not display previously imported permissions.
      setSnapshot({ client, accounts, values: {} });
      let next = 0;
      const worker = async () => {
        while (alive && generation === current && next < names.length) {
          const account = names[next++];
          try {
            const resources = await client.getAccount(account);
            if (!alive || generation !== current) return;
            if (resources.account !== account) continue;
            values[account] = resources;
            setSnapshot({ client, accounts, values: { ...values } });
          } catch { /* An unavailable account has no verified permission badges. */ }
        }
      };
      for (let i = 0; i < Math.min(3, names.length); i++) void worker();
    };
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') refresh();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
      else { ++generation; setSnapshot(null); }
    });
    return () => { alive = false; ++generation; subscription.remove(); };
  }, [accounts, client, enabled, refreshKey]);
  const values = enabled && snapshot?.client === client && snapshot.accounts === accounts ? snapshot.values : {};
  return Object.fromEntries(wallets.map(wallet => [wallet.id, resolveAuthPermissions(wallet, wallet.account, values[wallet.account])]));
}
