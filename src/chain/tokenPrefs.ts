// 用户对"首页资产列表要显示哪些代币"的个性化偏好 —— 参考 TP「添加代币」页
// 「首页代币 / 我的代币」的思路:持有的代币默认都上首页,可以手动从首页隐藏
// (不是真的动了持仓,只是首页不展示);没持有的生态代币也能从「热门代币」
// 手动加一个 0 余额占位到首页(比如提前关注一个还没到账的空投)。
// 按链 + 账户分开存(代币持仓是账户维度的),不含密钥材料,AsyncStorage 即可。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChainId } from './config';
import { notifyWalletDataChanged } from './walletDataEvents';

const KEY = 'aurora.chain.tokenPrefs.v1';

export type TokenPrefs = {
  /** 手动从首页隐藏的持仓代币,id 格式 `${contract}:${symbol}` */
  hidden: string[];
  /** 手动从「热门代币」加到首页的未持有代币(0 余额占位),id 格式同上 */
  added: string[];
};

type Store = Record<string, TokenPrefs>; // key = `${chainId}:${account}`

const EMPTY: TokenPrefs = { hidden: [], added: [] };
const keyOf = (chainId: ChainId, account: string) => `${chainId}:${account}`;

async function readStore(): Promise<Store> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(store)).catch(() => {});
}

export async function loadTokenPrefs(chainId: ChainId, account: string): Promise<TokenPrefs> {
  const store = await readStore();
  return store[keyOf(chainId, account)] ?? EMPTY;
}

/** id 格式 `${contract}:${symbol}`。hide=true 从首页隐藏,false 取消隐藏。 */
export async function setTokenHidden(
  chainId: ChainId,
  account: string,
  id: string,
  hide: boolean
): Promise<TokenPrefs> {
  const store = await readStore();
  const k = keyOf(chainId, account);
  const cur = store[k] ?? { hidden: [], added: [] };
  const hidden = hide ? Array.from(new Set([...cur.hidden, id])) : cur.hidden.filter((x) => x !== id);
  const next = { ...cur, hidden };
  store[k] = next;
  await writeStore(store);
  return next;
}

/** id 格式 `${contract}:${symbol}`。add=true 加到首页(0 余额占位),false 移除。 */
export async function setTokenAdded(
  chainId: ChainId,
  account: string,
  id: string,
  add: boolean
): Promise<TokenPrefs> {
  const store = await readStore();
  const k = keyOf(chainId, account);
  const cur = store[k] ?? { hidden: [], added: [] };
  const added = add ? Array.from(new Set([...cur.added, id])) : cur.added.filter((x) => x !== id);
  const next = { ...cur, added };
  store[k] = next;
  await writeStore(store);
  notifyWalletDataChanged({ chainId, accounts: [account] });
  return next;
}
