// 「先秀上次的数,后台悄悄刷新」用的余额快照缓存。
//
// 用于资产展示和转账代币选择,让冷启动/切账户时不至于
// 每次都空转——不是权威数据源。任何要签名/广播的流程(SendScreen、
// ConfirmTxSheet、DApp 交易确认)必须继续读 WalletContext 里 refresh()
// 拿到的实时 tokens/resources,绝不能读这份缓存做资金相关判断,
// 所以这里刻意不导出任何"当前余额"之类会被误用的语义,只做存取。
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TokenBalance } from './client';
import type { ChainId } from './config';

const PREFIX = 'aurora.balanceSnapshot.v1.';

export type TokenSnapshot = { tokens: TokenBalance[]; updatedAt: number };
const memory = new Map<string, TokenSnapshot>();
const pending = new Map<string, Promise<TokenSnapshot | null>>();

const keyFor = (chainId: ChainId, account: string) => `${PREFIX}${chainId}.${account}`;

function valid(value: unknown): value is TokenSnapshot {
  const snapshot = value as TokenSnapshot | null;
  return !!snapshot && Number.isFinite(snapshot.updatedAt) && snapshot.updatedAt >= 0
    && snapshot.updatedAt <= Date.now() + 60000 && Array.isArray(snapshot.tokens)
    && snapshot.tokens.every(token => !!token && typeof token.contract === 'string'
      && /^[a-z1-5.]{1,13}$/.test(token.contract) && typeof token.symbol === 'string'
      && /^[A-Z]{1,7}$/.test(token.symbol) && Number.isFinite(token.amount) && token.amount >= 0
      && Number.isInteger(token.precision) && token.precision >= 0 && token.precision <= 18
      && typeof token.raw === 'string');
}

export function peekTokenSnapshot(chainId: ChainId, account: string): TokenSnapshot | null {
  return memory.get(keyFor(chainId, account)) ?? null;
}

export function loadTokenSnapshot(chainId: ChainId, account: string): Promise<TokenSnapshot | null> {
  const key = keyFor(chainId, account);
  if (memory.has(key)) return Promise.resolve(memory.get(key)!);
  const loading = pending.get(key);
  if (loading) return loading;
  const request = AsyncStorage.getItem(key).then(raw => {
    // A fresh RPC result may have been saved while the disk read was pending.
    if (memory.has(key)) return memory.get(key)!;
    const snapshot: unknown = raw ? JSON.parse(raw) : null;
    if (!valid(snapshot)) return null;
    memory.set(key, snapshot);
    return snapshot;
  }).catch(() => null).finally(() => { pending.delete(key); });
  pending.set(key, request);
  return request;
}

export async function saveTokenSnapshot(chainId: ChainId, account: string, tokens: TokenBalance[]): Promise<void> {
  const snapshot: TokenSnapshot = { tokens, updatedAt: Date.now() };
  if (!valid(snapshot)) return;
  memory.set(keyFor(chainId, account), snapshot);
  await AsyncStorage.setItem(keyFor(chainId, account), JSON.stringify(snapshot)).catch(() => {});
}
