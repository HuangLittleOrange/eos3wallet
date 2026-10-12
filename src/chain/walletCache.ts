// 「先秀上次的数,后台悄悄刷新」用的余额快照缓存。
//
// 只给 WalletScreen 这种"看一眼"的展示页用,让冷启动/切账户时不至于
// 每次都空转——不是权威数据源。任何要签名/广播的流程(SendScreen、
// ConfirmTxSheet、DApp 交易确认)必须继续读 WalletContext 里 refresh()
// 拿到的实时 tokens/resources,绝不能读这份缓存做资金相关判断,
// 所以这里刻意不导出任何"当前余额"之类会被误用的语义,只做存取。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TokenBalance } from './client';
import { ChainId } from './config';

const PREFIX = 'aurora.balanceSnapshot.v1.';

type Snapshot = { tokens: TokenBalance[]; updatedAt: number };

const keyFor = (chainId: ChainId, account: string) => `${PREFIX}${chainId}.${account}`;

export async function loadTokenSnapshot(chainId: ChainId, account: string): Promise<Snapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(chainId, account));
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

export async function saveTokenSnapshot(chainId: ChainId, account: string, tokens: TokenBalance[]): Promise<void> {
  const snap: Snapshot = { tokens, updatedAt: Date.now() };
  await AsyncStorage.setItem(keyFor(chainId, account), JSON.stringify(snap)).catch(() => {});
}
