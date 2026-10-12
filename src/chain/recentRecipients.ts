// 「选择钱包」里的「最近」:只收用户自己在转账页亲手转过的收款方。
//
// 以前是从链上交易记录里去重取对手账户,结果 DApp 里换币打给的合约
// (swap.defi、router.1dex……)、买资源打给的系统合约、别人转进来的账户全混在
// 一起——链上看这些都是普通 transfer,分不出哪笔是用户自己在转账页发的。
// 只有转账页自己知道,所以在那里转账成功时记一笔,这里按链分开存。
//
// 只存账户名,不存 Memo:给交易所充值的 Memo 每次可能不同,自动带出上一次的
// Memo 反而可能充错。
// 不含任何密钥材料,放 AsyncStorage 即可。
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'aurora.recentRecipients.v1';
const MAX_PER_CHAIN = 10;

type Store = Record<string, { account: string; at: number }[]>;

async function readAll(): Promise<Store> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 按最近一次转账时间倒序,同一个账户只出现一次 */
export async function listRecentRecipients(chainId: string): Promise<string[]> {
  const all = await readAll();
  return (all[chainId] ?? []).map((r) => r.account);
}

/** 转账页转账成功后调用 —— 把这个收款方挪到最前面 */
export async function recordRecentRecipient(chainId: string, account: string): Promise<void> {
  const all = await readAll();
  const list = (all[chainId] ?? []).filter((r) => r.account !== account);
  list.unshift({ account, at: Date.now() });
  all[chainId] = list.slice(0, MAX_PER_CHAIN);
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}
