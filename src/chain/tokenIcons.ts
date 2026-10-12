// 代币图标 —— 参考 TP 显示真实 logo 而不是字母头像的做法。
//
// 没有走"运行时打 CoinGecko 拉图标"这条路:一是 prices.ts 里已经踩过坑,
// CoinGecko 在国内网络下经常整个不通,图标这种纯展示的东西不该也跟着一起
// 依赖一个不稳定的外部请求;二是我们真正需要图标的就是 COINGECKO_IDS
// (prices.ts)里那几个有官方定价的核心代币,数量很少,没必要为此引入图片
// 缓存/磁盘存储这一整套机制——直接把图片下载下来,跟着安装包一起分发,
// 离线也能显示,也没有加载闪烁。
//
// 覆盖不到的代币(生态里其他几百个小代币)照样退回 TokenBadge 原来的
// 字母头像,不强求全部有图。
//
// key 格式和 prices.ts 的 key() 保持一致:`${contract}:${symbol.toUpperCase()}`,
// 图标来源于 CoinGecko(2026-08 抓取,https://api.coingecko.com/api/v3/coins/markets)。
export const TOKEN_ICONS: Record<string, any> = {
  'eosio.token:EOS': require('../../assets/tokens/eos.png'),
  'core.vaulta:A': require('../../assets/tokens/vaulta.png'),
  'tethertether:USDT': require('../../assets/tokens/usdt.png'),
  'usdcusdcusdc:USDC': require('../../assets/tokens/usdc.png'),
};

export function tokenIconOf(contract: string | undefined, symbol: string): any | null {
  if (!contract) return null;
  return TOKEN_ICONS[`${contract}:${(symbol ?? '').toUpperCase()}`] ?? null;
}
