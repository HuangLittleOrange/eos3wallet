// 合约付费创建账户 —— 未完成订单的本地持久化(参考 TP「未完成的 EOS 订单,是否
// 前往激活」那一套:中途退出创建流程后再进来,能看到上次没走完的订单,选择继续
// 还是删掉重来)。
//
// 这里只存公开信息(账户名、公钥、往哪个合约转多少、memo 长什么样),不含任何
// 密钥材料 —— 这把新密钥的私钥在生成的那一刻就单独存进了 SecureStore 的临时槽位
// (见 vault.ts 的 savePendingKey,以及那里对"为什么这一段不套密码加密"的说明)。
// 每条链最多保留一条订单。临时密钥按公钥分别存储，不同链的订单互不覆盖。
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChainId } from './config';

const KEY_PREFIX = 'aurora.signup.pending.';

export type PendingSignupOrder = {
  id: string;
  chainId: ChainId;
  accountName: string;
  /** 新账户的公钥(PUB_K1_...) */
  publicKey: string;
  /** memo 里实际用的旧版 EOS... 格式公钥 */
  legacyPublicKey: string;
  /** 仅用于展示("随机生成"),不是真的派生路径 */
  path?: string;
  contract: string;
  memo: string;
  amount: number;
  symbol: string;
  precision: number;
  /** draft:账户名/密钥已生成、memo 已定,但还没转账;submitted:转账已发出(或用户已确认已从别处转账),在等链上出现这个账户 */
  status: 'draft' | 'submitted';
  txid?: string;
  explorerUrl?: string;
  createdAt: number;
  updatedAt: number;
};

const keyOf = (chainId: ChainId) => `${KEY_PREFIX}${chainId}`;

export async function loadPendingSignup(chainId: ChainId): Promise<PendingSignupOrder | null> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(chainId));
    if (!raw) return null;
    return JSON.parse(raw) as PendingSignupOrder;
  } catch {
    return null;
  }
}

export async function savePendingSignup(order: PendingSignupOrder): Promise<void> {
  await AsyncStorage.setItem(keyOf(order.chainId), JSON.stringify(order));
}

export async function clearPendingSignup(chainId: ChainId): Promise<void> {
  await AsyncStorage.removeItem(keyOf(chainId)).catch(() => {});
}
