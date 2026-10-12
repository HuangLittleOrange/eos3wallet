// 记住上次使用的链/账户/节点。
//
// 冷启动恢复用户选择的账户和节点,没有账户时保留空状态。
// 纯展示层状态,不含密钥材料,AsyncStorage 即可。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChainId } from './config';

const KEY = 'aurora.session.v1';

/** 某条链上最后一次在用的账户 + 具体那把钥匙 */
export type ChainAccount = {
  account: string;
  walletId?: string;
  /** false 表示旧版本自动保存的占位账户,不是用户选择的账户。 */
  hasAccount?: boolean;
};

export type Session = {
  chainId: ChainId;
  account: string;
  hasAccount?: boolean;
  /**
   * 同一个账户在本机可能存着不止一把钥匙(比如 active 和 owner 分开导入的两把),
   * 这个字段记的是具体选中的是哪一条 StoredWallet 记录——只认账户名不够,
   * 那样重启后没法知道上次到底是拿哪把钥匙签名的,会又落回"随便挑一把"。
   */
  walletId?: string;
  /** 上次选用的 RPC / 历史节点 id——可能是默认节点,也可能是自定义节点,恢复时两边都要找 */
  nodeId?: string;
  historyNodeId?: string;
  /**
   * 每条链各自最后一次在用的账户,切链时按链取回。账户名是链内资源,主网上
   * 的账户在测试网上多半根本不存在,把它带过去只会得到一个查不到的空账户;
   * 反过来,切去测试网看一眼再切回来,主网这边正在看的账户也必须原样还在。
   * 上面的 chainId/account/walletId 记的是"最后停在哪条链的哪个账户",两者
   * 各管一半,冷启动时先按 chainId 落链,再按这张表落账户。
   */
  perChain?: Partial<Record<ChainId, ChainAccount>>;
};

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export async function saveSession(s: Session): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});
}
