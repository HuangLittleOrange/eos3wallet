import type { ChainId } from './config';
export type WalletDataChange = { chainId: ChainId; accounts: string[]; permissions?: boolean; balanceContracts?: string[] };
const listeners = new Set<(change: WalletDataChange) => void>();
export function subscribeWalletDataChanges(listener: (change: WalletDataChange) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Refresh work must never turn a successful broadcast/storage write into a reported failure. */
export function notifyWalletDataChanged(change: WalletDataChange): void {
  for (const listener of listeners) { try { listener(change); } catch { /* A consumer can retry independently. */ } }
}
export function notifyTransactionApplied(chainId: ChainId, actor: string,
  actions: readonly { account: unknown; name: unknown; data?: unknown }[]): void {
  const accounts = new Set([actor]);
  const contracts = new Set<string>();
  let permissions = false;
  for (const action of actions) {
    if (String(action.name) === 'transfer') contracts.add(String(action.account));
    permissions ||= String(action.account) === 'paylimit1111'
      || ['updateauth', 'deleteauth', 'linkauth', 'unlinkauth'].includes(String(action.name));
    const data = action.data as Record<string, unknown> | null;
    for (const key of ['from', 'to', 'owner', 'receiver', 'account']) {
      if (data && typeof data[key] === 'string' && /^[a-z1-5.]{1,12}$/.test(data[key] as string)) accounts.add(data[key] as string);
    }
  }
  notifyWalletDataChanged({ chainId, accounts: [...accounts], permissions, balanceContracts: [...contracts] });
}
