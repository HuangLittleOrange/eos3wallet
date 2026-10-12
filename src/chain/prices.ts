// 代币行情
//
// ⚠️ 价格是**链下数据**,链上查不到法币价格。不同行情源对同一代币
// 给出的价格可能相差很大,因此界面必须标明数据来源,不能把某个数字
// 当作权威——这也是为什么行情源和 RPC/历史节点一样,做成用户可以在
// 节点页手动切换的独立选项,而不是写死一个"唯一正确"的源。
//
// 源踩过的坑,写在这儿免得以后又踩一遍(2026-08 实测):
// - Binance 的 EOSUSDT 交易对已经停牌(exchangeInfo 里 status: BREAK),
//   拿到的是停牌前的陈旧价格(实测 $0.78,跟其他源的 $0.06~0.07 差一个
//   数量级)——EOS 改名 Vaulta 之后,币安实际在交易的是 AUSDT 这个新对,
//   所以 Binance 源里 EOS 不报价,只用 AUSDT 给「A」定价,好过给一个
//   误导性的数字。
// - 国内网络到 CoinGecko 经常连不上(prices.ts 原有的超时兜底就是为这个
//   加的),Binance 作为切换选项也是给这种情况一条退路。
// - Coinbase 曾经也接过,后来去掉了——它没有「A」(core.vaulta)的交易对,
//   覆盖率还不如 Binance,用户明确要求去掉后就没再收录。

import { t } from '../i18n';
import { fetchWithTimeout as fetchWithTimeoutRaw } from '../net/fetchRetry';

export type PriceSourceId = 'coingecko' | 'binance';

export const PRICE_SOURCES: { id: PriceSourceId; name: string }[] = [
  { id: 'coingecko', name: 'CoinGecko' },
  { id: 'binance', name: 'Binance' },
];

export const DEFAULT_PRICE_SOURCE: PriceSourceId = 'coingecko';

/** 合约:符号 → CoinGecko 币种 id。只有正规发行方才会被定价 */
const COINGECKO_IDS: Record<string, string> = {
  'eosio.token:EOS': 'eos',
  'core.vaulta:A': 'vaulta',
  'tethertether:USDT': 'tether',
  'usdcusdcusdc:USDC': 'usd-coin',
};

/** 主源不可用时的兜底价 —— 会过时,仅用于避免界面全是「—」 */
const FALLBACK: Record<string, number> = {
  'eosio.token:EOS': 0.06,
  'core.vaulta:A': 0.06,
  'tethertether:USDT': 1.0,
  'usdcusdcusdc:USDC': 1.0,
};

export type Quote = { usd: number; change24h: number };
export type PriceMap = Record<string, Quote>;

export type PriceSnapshot = {
  prices: PriceMap;
  source: string;
  updatedAt: number;
  /** 选中的源失败、当前用的是兜底价 */
  stale: boolean;
};

const key = (contract: string, symbol: string) => `${contract}:${(symbol ?? '').toUpperCase()}`;

/**
 * 行情源在部分网络环境下不是快速失败,而是请求发出去后石沉大海——不加超时
 * 首页会一直转圈转到底层网络栈自己放弃为止。见 net/fetchRetry.ts,这里只是
 * 把默认超时收紧到 6s(行情不是关键路径,失败了有 FALLBACK 兜底,不值得像
 * 链上查询那样等 8s)。不重试:单个源超时/连不上就直接换兜底价,比多等几秒
 * 重试更符合"行情本来就该快"的预期。
 */
function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response> {
  return fetchWithTimeoutRaw(url, undefined, timeoutMs);
}

const fallbackSnapshot = (): PriceSnapshot => ({
  prices: Object.fromEntries(Object.entries(FALLBACK).map(([k, v]) => [k, { usd: v, change24h: 0 }])),
  source: t('priceError.localFallback'),
  updatedAt: Date.now(),
  stale: true,
});

async function fetchFromCoinGecko(): Promise<PriceMap> {
  const ids = Array.from(new Set(Object.values(COINGECKO_IDS))).join(',');
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
    `&vs_currencies=usd&include_24hr_change=true`;
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();

  const prices: PriceMap = {};
  for (const [k, id] of Object.entries(COINGECKO_IDS)) {
    const row = j[id];
    if (row && typeof row.usd === 'number') {
      prices[k] = { usd: row.usd, change24h: Number(row.usd_24h_change ?? 0) };
    }
  }
  if (Object.keys(prices).length === 0) throw new Error(t('priceError.empty'));
  return prices;
}

async function fetchFromBinance(): Promise<PriceMap> {
  // .vision 是币安专门给行情类只读请求用的公开域名,不受主站的地域限制。
  // 币安符号 → 我们的 合约:符号:AUSDT 是「A」(Vaulta)现在实际在交易的对,
  // USDT 作为计价货币本身恒为 1,不用查;EOSUSDT 已停牌,见文件头注释,不报价。
  const symbols = ['AUSDT', 'USDCUSDT'];
  const url = `https://data-api.binance.vision/api/v3/ticker/price?symbols=${encodeURIComponent(
    JSON.stringify(symbols)
  )}`;
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(t('priceError.badFormat'));

  const symbolToKey: Record<string, string> = {
    AUSDT: 'core.vaulta:A',
    USDCUSDT: 'usdcusdcusdc:USDC',
  };
  const prices: PriceMap = {};
  for (const row of j) {
    const k = symbolToKey[row.symbol];
    const usd = Number(row.price);
    if (k && Number.isFinite(usd)) prices[k] = { usd, change24h: 0 };
  }
  if (Object.keys(prices).length === 0) throw new Error(t('priceError.empty'));
  prices['tethertether:USDT'] = { usd: 1, change24h: 0 };
  return prices;
}

const FETCHERS: Record<PriceSourceId, () => Promise<PriceMap>> = {
  coingecko: fetchFromCoinGecko,
  binance: fetchFromBinance,
};

// 每个源各自 60 秒缓存,互不影响——切源不会读到另一个源的缓存,
// 也不会因为切了源就把还没过期的老源缓存白白扔掉。
const cache: Partial<Record<PriceSourceId, PriceSnapshot>> = {};
const TTL_MS = 60_000;

/** 拉取行情。60 秒内复用缓存,避免频繁请求被限流 */
export async function fetchPrices(
  source: PriceSourceId = DEFAULT_PRICE_SOURCE,
  force = false
): Promise<PriceSnapshot> {
  const cached = cache[source];
  if (!force && cached && Date.now() - cached.updatedAt < TTL_MS) return cached;

  try {
    const prices = await FETCHERS[source]();
    const snap: PriceSnapshot = {
      prices,
      source: PRICE_SOURCES.find((s) => s.id === source)?.name ?? source,
      updatedAt: Date.now(),
      stale: false,
    };
    cache[source] = snap;
    return snap;
  } catch {
    // 失败不抛错 —— 钱包应当继续可用,只是价格标为兜底
    const snap = cached && !cached.stale ? { ...cached, stale: true } : fallbackSnapshot();
    cache[source] = snap;
    return snap;
  }
}

/** 查某个代币的价格。未收录的代币返回 0,UI 会显示合约名代替 */
export function quoteOf(snap: PriceSnapshot | null, contract: string, symbol: string): Quote | null {
  if (!snap) return null;
  return snap.prices[key(contract, symbol)] ?? null;
}

export function priceIn(snap: PriceSnapshot | null, contract: string, symbol: string): number {
  return quoteOf(snap, contract, symbol)?.usd ?? 0;
}

/** 测一个行情源当前能不能用、多快、覆盖了我们关心的几种代币——节点页用 */
export async function probePriceSource(
  source: PriceSourceId
): Promise<{ ms: number; covered: number } | null> {
  try {
    const t0 = Date.now();
    const prices = await FETCHERS[source]();
    return { ms: Date.now() - t0, covered: Object.keys(prices).length };
  } catch {
    return null;
  }
}
