import { Serializer, Transaction } from '@wharfkit/antelope';
import { CpuNetExhaustedError } from '../chain/sponsor';
import { ASSUMED_TRANSFER_CPU_US } from '../chain/powerupPricing';
import { fetchWithTimeout } from '../net/fetchRetry';
import { t } from '../i18n';

/**
 * 只签名的请求,广播结果在 DApp 手里,钱包收不到资源错误。签名前读取额度,
 * 对明显不足的 CPU/NET 弹修复。CPU 用普通转账的保守估算,NET 用交易字节数;
 * 不模拟执行、不广播、不保证复杂合约够用,也不猜 RAM 会增长多少。
 * 有其他账户授权(例如 DApp 已加资源代付)时跳过,避免要求用户重复买资源。
 */
export async function preflightDappResources(opts: { transaction: Transaction; actor: string; nodeUrl: string }): Promise<void> {
  const actors = new Set(opts.transaction.actions.flatMap((action) => action.authorization.map((auth) => String(auth.actor))));
  if (actors.size !== 1 || !actors.has(opts.actor)) return;
  let account: any;
  try {
    const response = await fetchWithTimeout(`${opts.nodeUrl.replace(/\/$/, '')}/v1/chain/get_account`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_name: opts.actor }),
    }, 4000);
    if (!response.ok) return;
    account = await response.json();
  } catch {
    // 预检查失败不妨碍原本可签的交易,最终由 DApp 的节点判断。
    return;
  }
  const lacks = (limit: any, required: number) => {
    if (!limit || limit.available == null || limit.max == null) return false;
    const max = Number(limit.max);
    const available = Number(limit.available);
    return Number.isFinite(max) && max >= 0 && Number.isFinite(available) && available < required;
  };
  const netBytes = Serializer.encode({ object: opts.transaction }).array.length;
  if (lacks(account.cpu_limit, ASSUMED_TRANSFER_CPU_US) || lacks(account.net_limit, netBytes)) {
    throw new CpuNetExhaustedError(t('sponsorError.cpuNetInsufficient'));
  }
}
