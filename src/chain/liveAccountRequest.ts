import type { AccountResources, ChainClient } from './client';

// Shares only concurrent RPC reads, never cached authorization/transaction state.
const pending = new WeakMap<ChainClient, Map<string, Promise<AccountResources>>>();
export function invalidateLiveAccountRequest(client: ChainClient, account: string) { pending.get(client)?.delete(account); }

export function requestLiveAccount(client: ChainClient, account: string): Promise<AccountResources> {
  let accounts = pending.get(client);
  if (!accounts) { accounts = new Map(); pending.set(client, accounts); }
  const existing = accounts.get(account);
  if (existing) return existing;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Account request timed out')), 15000);
  });
  const request = Promise.race([Promise.resolve().then(() => client.getAccount(account)), timeout])
    .finally(() => { clearTimeout(timer); if (accounts!.get(account) === request) accounts!.delete(account); });
  accounts.set(account, request);
  return request;
}
