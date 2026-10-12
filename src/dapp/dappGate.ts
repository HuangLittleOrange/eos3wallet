// DApp 搜索历史 + "打开外部链接前提示" 的确认状态
//
// 对齐主流钱包(如 TokenPocket)打开网站的步骤:搜索页留历史 → 输入网址给出
// 「打开网站」建议 → 首次跳转前弹一次风险提示,勾选「不再提示」后才不再弹。
// 都不含密钥材料,用 AsyncStorage 即可,不占用 SecureStore 的加密槽位。
import AsyncStorage from '@react-native-async-storage/async-storage';

const HISTORY_KEY = 'aurora.dapp.history.v1';
const FAVORITES_KEY = 'aurora.dapp.favorites.v1';
const ACK_KEY = 'aurora.dapp.riskAck.v1';
const MAX_HISTORY = 10;

export type DappHistoryItem = { url: string; visitedAt: number; title?: string; thumbnail?: string };
export type DappFavorite = { url: string; name: string; addedAt: number };

export async function listDappHistory(): Promise<DappHistoryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** title 是页面的 <title>,拿得到就存,给标签卡片当更友好的名字用;拿不到就只留网址 */
export async function addDappHistory(url: string, title?: string): Promise<void> {
  try {
    const list = await listDappHistory();
    const prev = list.find((x) => x.url === url);
    const next = [
      { url, visitedAt: Date.now(), title: title || prev?.title, thumbnail: prev?.thumbnail },
      ...list.filter((x) => x.url !== url),
    ].slice(0, MAX_HISTORY);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 历史记录丢了不影响主流程,静默忽略
  }
}

/**
 * 最小化/关闭前截一张页面快照存成缩略图 —— 找不到对应记录(比如还没来得及
 * 写历史)就忽略,不单独补一条,标签卡片只认已经在历史里的条目。
 */
export async function setDappThumbnail(url: string, thumbnail: string): Promise<void> {
  try {
    const list = await listDappHistory();
    if (!list.some((x) => x.url === url)) return;
    const next = list.map((x) => (x.url === url ? { ...x, thumbnail } : x));
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 截图存不下去不影响主流程
  }
}

export async function clearDappHistory(): Promise<void> {
  await AsyncStorage.removeItem(HISTORY_KEY).catch(() => {});
}

/** 关掉单个「标签」—— 轻量版标签管理器复用的就是这份历史记录 */
export async function removeDappHistoryItem(url: string): Promise<void> {
  const list = await listDappHistory();
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(list.filter((x) => x.url !== url))).catch(() => {});
}

// ---------- 收藏 ----------

export async function listDappFavorites(): Promise<DappFavorite[]> {
  try {
    const raw = await AsyncStorage.getItem(FAVORITES_KEY);
    const list: DappFavorite[] = raw ? JSON.parse(raw) : [];
    return list.sort((a, b) => b.addedAt - a.addedAt);
  } catch {
    return [];
  }
}

export async function isDappFavorite(url: string): Promise<boolean> {
  return (await listDappFavorites()).some((f) => f.url === url);
}

/** 收藏 / 取消收藏 —— 返回切换后的状态 */
export async function toggleDappFavorite(url: string, name: string): Promise<boolean> {
  const list = await listDappFavorites();
  const exists = list.some((f) => f.url === url);
  const next = exists ? list.filter((f) => f.url !== url) : [{ url, name, addedAt: Date.now() }, ...list];
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(next)).catch(() => {});
  return !exists;
}

export async function removeDappFavorite(url: string): Promise<void> {
  const list = await listDappFavorites();
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(list.filter((f) => f.url !== url))).catch(() => {});
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
