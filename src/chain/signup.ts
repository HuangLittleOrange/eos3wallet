// "合约付费创建账户"用到的链上只读查询 —— 目标合约是 signupwallet
// (参考 https://eoseyes.com/signup 的公开说明,链上 get_abi/get_table_rows 验证过,
// 不是照抄 TP 截图里那个没有文档的第三方合约)。
//
// 只在 Vaulta 主网确认过这个合约存在,调用方需要自己先判断 chainId === 'vaulta'。

import { t } from '../i18n';
import { fetchWithRetry } from '../net/fetchRetry';

export const SIGNUP_CONTRACT = 'signupwallet';

async function getTableRows<T = any>(
  chainUrl: string,
  params: { code: string; scope: string; table: string; limit?: number }
): Promise<T[]> {
  const r = await fetchWithRetry(`${chainUrl}/v1/chain/get_table_rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: true, limit: 10, ...params }),
  });
  if (!r.ok) throw new Error(t('signupError.queryFailed', { status: r.status }));
  const j = await r.json();
  return (j.rows ?? []) as T[];
}

/**
 * 开户要转的金额,固定 2 —— eoseyes.com/signup 给出的就是"建议 ≥ 2 A",合约拿到
 * 这笔钱后自动质押 CPU/NET、留少量启动余额、剩下的买 RAM。
 *
 * 之前这里是"实时 RAM 价格 × 1.5 与 2 取大值"的动态估算,现在按需求改回固定值:
 * 金额浮动会让"该转多少"这件事变得不确定 —— 用户从交易所提币时得照着一个会变的
 * 数字填,填少了合约不建号且退不回来。固定 2 更好交代,也和外部工具的说法一致。
 */
export const SIGNUP_AMOUNT = 2;

/** signupwallet 的 token 表:接受哪些合约的转账触发建号 */
export async function isSignupTokenSupported(chainUrl: string, tokenContract: string): Promise<boolean> {
  const rows = await getTableRows<{ contract: string }>(chainUrl, {
    code: SIGNUP_CONTRACT,
    scope: SIGNUP_CONTRACT,
    table: 'token',
    limit: 20,
  });
  return rows.some((r) => r.contract === tokenContract);
}

