// 切链时该落到哪个账户。单独一个文件而不是塞在 WalletContext 里:这段逻辑是
// 纯函数、要单测,而 WalletContext 一路 import 到 vault 里的原生模块
// (SecureStore / quick-crypto),在 jest 环境里根本加载不起来。
import { ChainId, DEFAULT_CHAIN } from './config';
import type { ChainAccount } from './session';
import type { StoredWallet } from '../crypto/vault';

/**
 * 切到某条链时该落到哪个账户。账户名是链内资源:主网上的账户名在测试网上
 * 多半根本不存在,同名的话更可能是不相干的另一个人,所以切链一律不把当前
 * 账户带过去,只在目标链自己的记录里挑:
 *   1. 这条链上次用的那个账户(memo,含纯观察的账户名)——切过去看一眼再
 *      切回来,两边各自看的账户都原样还在;
 *   2. 没用过,但本机存着这条链的钱包 —— 落到最近添加的那个,比先显示一个
 *      用户根本不认识的兜底账户强;
 *   3. 都没有 —— 返回空账户,显示创建/导入钱包引导。
 */
export function pickChainAccount(
  id: ChainId,
  memo: ChainAccount | undefined,
  wallets: StoredWallet[]
): ChainAccount {
  // 没有 chainId 的是这个字段上线前存的旧数据,按主网处理(那时候还没有多链)
  const onChain = wallets
    .filter((x) => (x.chainId ?? DEFAULT_CHAIN) === id)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (memo?.account) {
    const saved = onChain.find((x) => x.id === memo.walletId && x.account === memo.account)
      ?? onChain.find((x) => x.account === memo.account);
    if (saved) return { account: saved.account, walletId: saved.id };
    // 迁移旧版本的默认账户会话;主动导入的观察账户仍可恢复。
    const legacyDefault = memo.account === (id === 'vaulta' ? 'bitfinexdep1' : 'eosio');
    if (!memo.walletId && memo.hasAccount !== false && (!legacyDefault || memo.hasAccount === true)) {
      return { account: memo.account, walletId: undefined };
    }
  }
  if (onChain.length > 0) return { account: onChain[0].account, walletId: onChain[0].id };
  return { account: '', walletId: undefined };
}
