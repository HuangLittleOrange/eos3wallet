// DApp 搜索历史 + "打开外部链接前提示" 的确认状态
//
// 对齐主流钱包(如 TokenPocket)打开网站的步骤:搜索页留历史 → 输入网址给出
// 「打开网站」建议 → 首次跳转前弹一次风险提示,勾选「不再提示」后才不再弹。
// 都不含密钥材料,用 AsyncStorage 即可,不占用 SecureStore 的加密槽位。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_CHAIN, type ChainId } from '../chain/config';

const HISTORY_KEY = 'aurora.dapp.history.v1';
const FAVORITES_KEY = 'aurora.dapp.favorites.v1';
const ACK_KEY = 'aurora.dapp.riskAck.v1';
const MAX_HISTORY = 10;

export type DappHistoryItem = { url: string; visitedAt: number; title?: string; thumbnail?: string; networkId?: ChainId };
export type DappFavorite = { url: string; name: string; addedAt: number; networkId?: ChainId };
export type DappRecordScope = ChainId | 'unassigned';
const listeners = new Set<() => void>();
const queues = new Map<string, Promise<unknown>>();
export function subscribeDappRecords(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const matches = (item: { networkId?: ChainId }, scope: DappRecordScope) =>
  scope === 'unassigned' ? item.networkId === undefined : item.networkId === scope;
async function readList<T>(key: string): Promise<T[]> {
  try { const value = JSON.parse(await AsyncStorage.getItem(key) ?? '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function mutate<T, R>(key: string, update: (list: T[]) => { list: T[]; result: R }): Promise<R> {
  const operation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const next = update(await readList<T>(key));
    await AsyncStorage.setItem(key, JSON.stringify(next.list));
    for (const listener of listeners) listener();
    return next.result;
  });
  queues.set(key, operation.catch(() => {}));
  return operation;
}

export async function listDappHistory(scope?: DappRecordScope): Promise<DappHistoryItem[]> {
  await queues.get(HISTORY_KEY);
  const list = await readList<DappHistoryItem>(HISTORY_KEY);
  return scope === undefined ? list : list.filter(item => matches(item, scope));
}

/** title 是页面的 <title>,拿得到就存,给标签卡片当更友好的名字用;拿不到就只留网址 */
export async function addDappHistory(url: string, title?: string, networkId: ChainId = DEFAULT_CHAIN): Promise<void> {
  await mutate<DappHistoryItem, void>(HISTORY_KEY, list => {
    const group = list.filter(item => matches(item, networkId));
    const prev = group.find(item => item.url === url);
    const next = [{ url, networkId, visitedAt: Date.now(), title: title || prev?.title, thumbnail: prev?.thumbnail },
      ...group.filter(item => item.url !== url)].slice(0, MAX_HISTORY);
    return { list: [...next, ...list.filter(item => !matches(item, networkId))], result: undefined };
  }).catch(() => {});
}

/**
 * 最小化/关闭前截一张页面快照存成缩略图 —— 找不到对应记录(比如还没来得及
 * 写历史)就忽略,不单独补一条,标签卡片只认已经在历史里的条目。
 */
export async function setDappThumbnail(url: string, thumbnail: string, networkId: ChainId = DEFAULT_CHAIN): Promise<void> {
  await mutate<DappHistoryItem, void>(HISTORY_KEY, list => ({
    list: list.map(item => item.url === url && matches(item, networkId) ? { ...item, thumbnail } : item), result: undefined,
  })).catch(() => {});
}

export async function clearDappHistory(scope: DappRecordScope = DEFAULT_CHAIN): Promise<void> {
  await mutate<DappHistoryItem, void>(HISTORY_KEY, list => ({ list: list.filter(item => !matches(item, scope)), result: undefined })).catch(() => {});
}

/** 关掉单个「标签」—— 轻量版标签管理器复用的就是这份历史记录 */
export async function removeDappHistoryItem(url: string, scope: DappRecordScope = DEFAULT_CHAIN): Promise<void> {
  await mutate<DappHistoryItem, void>(HISTORY_KEY, list => ({
    list: list.filter(item => item.url !== url || !matches(item, scope)), result: undefined,
  })).catch(() => {});
}

// ---------- 收藏 ----------

export async function listDappFavorites(scope?: DappRecordScope): Promise<DappFavorite[]> {
  await queues.get(FAVORITES_KEY);
  const list = await readList<DappFavorite>(FAVORITES_KEY);
  return (scope === undefined ? list : list.filter(item => matches(item, scope))).sort((a, b) => b.addedAt - a.addedAt);
}

export async function isDappFavorite(url: string, networkId: ChainId = DEFAULT_CHAIN): Promise<boolean> {
  return (await listDappFavorites(networkId)).some((f) => f.url === url);
}

/** 收藏 / 取消收藏 —— 返回切换后的状态 */
export async function toggleDappFavorite(url: string, name: string, networkId: ChainId = DEFAULT_CHAIN): Promise<boolean> {
  return mutate<DappFavorite, boolean>(FAVORITES_KEY, list => {
    const exists = list.some(item => item.url === url && matches(item, networkId));
    return { list: exists ? list.filter(item => item.url !== url || !matches(item, networkId))
      : [{ url, name, networkId, addedAt: Date.now() }, ...list], result: !exists };
  });
}

export async function removeDappFavorite(url: string, scope: DappRecordScope = DEFAULT_CHAIN): Promise<void> {
  await mutate<DappFavorite, void>(FAVORITES_KEY, list => ({
    list: list.filter(item => item.url !== url || !matches(item, scope)), result: undefined,
  })).catch(() => {});
}

/** Claim legacy data explicitly; never guess a network or discard its original details. */
export async function assignDappRecord(kind: 'history' | 'favorite', url: string, networkId: ChainId): Promise<void> {
  const key = kind === 'history' ? HISTORY_KEY : FAVORITES_KEY;
  await mutate<DappHistoryItem | DappFavorite, void>(key, list => {
    const legacy = list.find(item => item.url === url && item.networkId === undefined);
    if (!legacy) return { list, result: undefined };
    const exists = list.some(item => item.url === url && item.networkId === networkId);
    // Keep the unassigned copy if a destination entry already exists, so neither loses metadata.
    return { list: exists ? list : list.map(item => item === legacy ? { ...item, networkId } : item), result: undefined };
  });
}

/** 是否已勾选过「不再提示」 */
export async function getRiskAck(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ACK_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function setRiskAck(): Promise<void> {
  await AsyncStorage.setItem(ACK_KEY, '1').catch(() => {});
}

/** 粗略判断输入是否像一个网址/域名,而不是代币名或 DApp 名称关键词 */
export function isUrlLike(input: string): boolean {
  const s = input.trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s);
}

export function normalizeDappUrl(input: string): string {
  const s = input.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}
