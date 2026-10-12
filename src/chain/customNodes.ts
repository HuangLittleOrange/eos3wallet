// 用户自己添加的自定义节点 —— 参考 TP「添加自定义节点」的交互:按链分开存,
// 只是访问地址的偏好设置,不含密钥材料,AsyncStorage 即可。
//
// RPC 节点(链上查询)和历史节点(Hyperion)是两套独立的服务,存储上也分开,
// 不能因为都是"节点"就混在一个列表里——参考主流钱包的节点设置页,两者是
// 分别维护、分别切换的,详见 config.ts 里 ChainConfig.nodes / historyNodes 的注释。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChainId, NodeInfo } from './config';

export type NodeKind = 'rpc' | 'history';

// v2:从"每条链一个扁平数组"改成"每条链分 rpc / history 两个数组",
// 和 v1 数据结构不兼容,换个 key 而不是原地改格式,避免把旧数据读成错的形状。
const KEY = 'aurora.chain.customNodes.v2';

type ChainEntry = { rpc: NodeInfo[]; history: NodeInfo[] };
type Store = Partial<Record<ChainId, ChainEntry>>;

const emptyEntry = (): ChainEntry => ({ rpc: [], history: [] });

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

export async function listCustomNodes(chainId: ChainId, kind: NodeKind): Promise<NodeInfo[]> {
  const store = await readStore();
  return store[chainId]?.[kind] ?? [];
}

/** 加一个自定义节点,返回这条链、这个类别更新后的完整自定义节点列表 */
export async function addCustomNode(chainId: ChainId, kind: NodeKind, node: NodeInfo): Promise<NodeInfo[]> {
  const store = await readStore();
  const entry = store[chainId] ?? emptyEntry();
  const nextList = [...entry[kind], node];
  store[chainId] = { ...entry, [kind]: nextList };
  await writeStore(store);
  return nextList;
}

export async function removeCustomNode(chainId: ChainId, kind: NodeKind, id: string): Promise<NodeInfo[]> {
  const store = await readStore();
  const entry = store[chainId] ?? emptyEntry();
  const nextList = entry[kind].filter((n) => n.id !== id);
  store[chainId] = { ...entry, [kind]: nextList };
  await writeStore(store);
  return nextList;
}
