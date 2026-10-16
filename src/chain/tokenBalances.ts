import type { ChainClient, TokenBalance } from './client';
const pending = new WeakMap<ChainClient, Map<string, Promise<TokenBalance[]>>>();

/** Only concurrent live reads are shared. A post-mutation request bypasses older reads. */
export function readTokenBalances(client: ChainClient, account: string, force = false, changedContracts: string[] = []): Promise<TokenBalance[]> {
  let accounts = pending.get(client);
  if (!accounts) { accounts = new Map(); pending.set(client, accounts); }
  const existing = accounts.get(account);
  if (!force && existing) return existing;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Balance request timed out')), 15000); });
  const read = async () => {
    // Bypass an indexer's lag after a transfer, querying only affected contracts plus the native token.
    const direct = new Map<string, TokenBalance[] | null>();
    const contracts = force ? [...new Set([client.config.systemToken, ...changedContracts])] : [];
    let next = 0;
    const worker = async () => {
      while (next < contracts.length) {
        const contract = contracts[next++];
        try { direct.set(contract, await client.getBalance(contract, account)); }
        catch { direct.set(contract, null); }
      }
    };
    const directReads = Promise.all(Array.from({ length: Math.min(3, contracts.length) }, worker));
    const nativeFallback = async () => {
      if (force) {
        await directReads;
        const native = direct.get(client.config.systemToken);
        if (native !== null && native !== undefined) return native;
      }
      return client.getBalance(client.config.systemToken, account);
    };
    let list: TokenBalance[];
    try {
      list = await client.getTokens(account);
      if (!list.length) list = await nativeFallback();
    } catch { list = await nativeFallback(); }
    await directReads;
    for (const [contract, balances] of direct) {
      if (balances !== null) list = [...list.filter(token => token.contract !== contract), ...balances];
    }
    const system = list.find(token => token.contract === client.config.systemToken && token.symbol === client.config.symbol);
    return [system ?? { contract: client.config.systemToken, symbol: client.config.symbol, precision: client.config.precision,
      amount: 0, raw: `${(0).toFixed(client.config.precision)} ${client.config.symbol}` }, ...list.filter(token => token !== system)];
  };
  const request = Promise.race([Promise.resolve().then(read), timeout]).finally(() => {
    clearTimeout(timer); if (accounts!.get(account) === request) accounts!.delete(account);
  });
  accounts.set(account, request); return request;
}
