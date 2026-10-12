// 记一份"哪些 dApp 通过身份请求拿到过本机的接收频道信息"的清单——纯展示层
// 数据,不含任何密钥材料,AsyncStorage 即可(跟 chain/session.ts 记住上次
// 会话是同一个道理)。
//
// 撤销的语义:本机的接收密钥只有一把,所有 dApp 共用同一条频道——不像
// 「每个 dApp 一把独立密钥」那样,撤销可以直接吊销某一把。真正的撤销靠
// LinkSessionProvider 收到频道推送时,拿发送方公钥(sealed.from)比对这份
// 清单——不在清单里的直接丢弃,不弹确认签名弹窗。所以"删掉一条记录"就
// 等于撤销了那个 dApp 继续推送的资格,不需要真的去吊销/轮换密钥本身。
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChainId } from '../chain/config';

const KEY = 'aurora.link.sessions.v1';

export type LinkSession = {
  /** dApp 建立会话时用的请求公钥——频道推送靠这个字段认领是谁发的 */
  requestKey: string;
  /** dApp 自报的名字/scope,展示用,不保证准确(对方自己填的) */
  name: string;
  /** 当时是用哪个账户完成的身份验证 */
  account: string;
  /** 当时在哪条链上——账户名是链内资源,同名账户在别的链上可能是完全不同的人,
   *  详情页得把这个标出来,不能只显示账户名 */
  chainId: ChainId;
  createdAt: number;
};

export async function listLinkSessions(): Promise<LinkSession[]> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as LinkSession[];
  } catch {
    return [];
  }
}

// 首页那颗"有会话连接"的入口气泡(参考 TP)得随时反映最新数量——但它可能
// 在 WalletScreen 一直停留、没有重新聚焦的这段时间里被推送悄悄建立起来
// (LinkSessionProvider 收到扫码/推送就直接建会话,不经过任何导航跳转),
// 光靠 useFocusEffect 重新拉一遍是接不住的。加这一层最简单的订阅——写操作
// 之后广播一声,谁在监听谁自己去重新拉列表,不在这里传递具体数据。
type Listener = () => void;
const listeners = new Set<Listener>();

/** 返回取消订阅函数;每次清单发生变化(新增/撤销)都会调用一次 */
export function subscribeLinkSessions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyLinkSessionsChanged(): void {
  listeners.forEach((l) => l());
}

/** 同一个 requestKey 再次建立会话(比如重新扫了次码)——覆盖旧记录,不叠加 */
export async function recordLinkSession(session: LinkSession): Promise<void> {
  const all = await listLinkSessions();
  const next = [...all.filter((s) => s.requestKey !== session.requestKey), session];
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
  notifyLinkSessionsChanged();
}

export async function revokeLinkSession(requestKey: string): Promise<void> {
  const all = await listLinkSessions();
  await AsyncStorage.setItem(KEY, JSON.stringify(all.filter((s) => s.requestKey !== requestKey)));
  notifyLinkSessionsChanged();
}

export async function isKnownLinkSession(requestKey: string): Promise<boolean> {
  const all = await listLinkSessions();
  return all.some((s) => s.requestKey === requestKey);
}
