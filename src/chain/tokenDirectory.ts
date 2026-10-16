import { ReadCache } from '../net/readCache';
import type { ChainId } from './config';
import type { TokenBalance } from './client';

export type TokenMetadata = Pick<TokenBalance, 'contract' | 'symbol' | 'precision'>;
export const TOKEN_DIRECTORY_TTL = 24 * 60 * 60 * 1000;
function valid(value: unknown): value is TokenMetadata[] {
  return Array.isArray(value) && value.every(token => token && /^[a-z1-5.]{1,13}$/.test(token.contract)
    && /^[A-Z]{1,7}$/.test(token.symbol) && Number.isInteger(token.precision) && token.precision >= 0 && token.precision <= 18
    && Object.keys(token).every(key => ['contract', 'symbol', 'precision'].includes(key)));
}
export const tokenDirectoryCache = new ReadCache<TokenMetadata[]>(TOKEN_DIRECTORY_TTL,
  { storagePrefix: 'eos3.tokenDirectory.v1.', validate: valid });
export const tokenDirectoryKey = (chainId: ChainId, account: string) => JSON.stringify([chainId, account]);
const id = (token: TokenMetadata) => `${token.contract}:${token.symbol}`;

/** Reuse the bulk balance response. No extra discovery request, and no amounts in the directory. */
export async function rememberTokenDirectory(chainId: ChainId, account: string, tokens: TokenMetadata[], force = false, observedAt = Date.now()) {
  const key = tokenDirectoryKey(chainId, account);
  await tokenDirectoryCache.hydrate(key);
  const saved = tokenDirectoryCache.get(key);
  if (observedAt < saved.updatedAt) return;
  const expired = force || !saved.data || observedAt - saved.updatedAt >= TOKEN_DIRECTORY_TTL;
  const entries = new Map((saved.data ?? []).map(token => [id(token), token]));
  let added = false;
  for (const { contract, symbol, precision } of tokens) {
    const metadata = { contract, symbol, precision };
    if (!valid([metadata])) continue;
    if (expired || !entries.has(id(metadata))) { added ||= !entries.has(id(metadata)); entries.set(id(metadata), metadata); }
  }
  // A minute-by-minute balance update must not extend the 24-hour metadata lifetime.
  if (expired || added) tokenDirectoryCache.remember(key, [...entries.values()], expired ? observedAt : saved.updatedAt);
}

/** Selection rows join stable metadata to balances; metadata alone always has zero spendable units. */
export function tokensForSelection(directory: TokenMetadata[], balances: TokenBalance[]): TokenBalance[] {
  const present = new Set(balances.map(id));
  return [...balances, ...directory.filter(token => !present.has(id(token))).map(token => ({
    ...token, amount: 0, raw: `${(0).toFixed(token.precision)} ${token.symbol}`,
  }))];
}
