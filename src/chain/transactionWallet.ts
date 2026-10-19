import type { StoredWallet } from '../crypto/vault';
import type { ChainId } from './config';

/** A selected observation account remains keyless and is never written to the vault. */
export function transactionWallet(w: {
  currentWallet?: StoredWallet; account: string; chainId: ChainId; hasAccount?: boolean;
}): StoredWallet | undefined {
  return w.currentWallet ?? (w.hasAccount && w.account ? {
    id: `watch:${w.chainId}:${w.account}`, account: w.account, chainId: w.chainId,
    publicKey: '', source: 'watch', createdAt: 0,
  } : undefined);
}
