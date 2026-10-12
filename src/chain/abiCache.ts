// 链上合约 ABI 的内存缓存,按「节点 URL + 合约」键控。
//
// ESR 解析(esr.ts)、签服务端交易(eos3Sign.ts)、签名前意图核对
// (txIntentCheck.ts 经 sponsor.ts)三条路都要拿 ABI——同一个 dApp 会话里
// 连续签几笔,同一份 eosio.token 的 ABI 要重复拉好几次,每次都是一趟节点
// 往返,直接体现在「点击到确认弹窗」之间的空档上。ABI 变更极少(合约升级
// 才会动),10 分钟的 TTL 足够新鲜;真撞上升级窗口的调用方(意图核对)
// 自己拿 invalidateAbi() 清掉重试,见 sponsor.ts。
//
// 缓存的是 Promise 而不是结果——两笔签名并发要同一份 ABI 时,第二个直接
// 等第一个的请求,不会各拉各的;请求失败则把这条从缓存里删掉,失败不缓存。
//
// 拉取本身走 fetchWithRetry(见 net/fetchRetry.ts)——TLS 握手偶发失败不该让
// 代付签名前的意图核对(见 sponsor.ts)白白失败一次。
import type { ABI } from '@wharfkit/antelope';

import { t } from '../i18n';
import { fetchWithRetry } from '../net/fetchRetry';

const TTL_MS = 10 * 60 * 1000;

type Entry = { at: number; promise: Promise<ABI.Def> };
const cache = new Map<string, Entry>();

function keyOf(nodeUrl: string, contract: string): string {
  return `${nodeUrl} ${contract}`;
}

async function fetchAbiDef(nodeUrl: string, contract: string): Promise<ABI.Def> {
  const res = await fetchWithRetry(`${nodeUrl}/v1/chain/get_abi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_name: contract }),
  });
  if (!res.ok) throw new Error(t('eos3Error.abiFetchFailed', { contract }));
  const j = await res.json();
  if (!j?.abi) throw new Error(t('eos3Error.abiFetchFailed', { contract }));
  return j.abi as ABI.Def;
}

/** 取某个合约的 ABI,10 分钟内命中缓存;拿不到(无 ABI/网络失败)抛错且不缓存失败 */
export function getCachedAbi(nodeUrl: string, contract: string): Promise<ABI.Def> {
  const key = keyOf(nodeUrl, contract);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;

  const promise = fetchAbiDef(nodeUrl, contract);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    // 只删自己那条——失败后另一个调用方可能已经重新发起、覆盖了这个槽位
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

/** 主动作废一条缓存——意图核对疑似撞上链上 ABI 升级时,清掉换新鲜的再核一次 */
export function invalidateAbi(nodeUrl: string, contract: string): void {
  cache.delete(keyOf(nodeUrl, contract));
}
