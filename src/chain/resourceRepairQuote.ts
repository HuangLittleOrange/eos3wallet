import type { ChainClient } from './client';
import type { ChainId } from './config';
import { buildPowerupTopUp, POWERUP_TOPUP_DEFAULT } from './resourceRepair';
import { requestSponsoredBuild } from './sponsor';
import type { PowerupMarket } from './powerupPricing';
import { getCachedSponsorFee, isSponsorFeeFresh, rememberSponsorFee, type SponsorFeeSnapshot } from './sponsorFeeCache';
import { t } from '../i18n';

const markets = new WeakMap<ChainClient, { promise: Promise<PowerupMarket>; validUntil: number }>();
const refreshes = new Map<ChainId, Promise<SponsorFeeSnapshot>>();

/** PowerUp 市场会变化,只合并请求并缓存 30 秒,与每日代付费分开。 */
export function getResourceRepairMarket(client: ChainClient): Promise<PowerupMarket> {
  const cached = markets.get(client);
  if (cached && cached.validUntil > Date.now()) return cached.promise;
  const entry = { promise: null as unknown as Promise<PowerupMarket>, validUntil: Infinity };
  entry.promise = client.getPowerupState().then((market) => {
    if (!market) throw new Error(t('resource.powerupMarketUnavailable'));
    entry.validUntil = Date.now() + 30_000;
    return market;
  }).catch((error) => {
    if (markets.get(client) === entry) markets.delete(client);
    throw error;
  });
  markets.set(client, entry);
  return entry.promise;
}

/** 首次进入钱包/缓存过期时后台获取项目费率,24 小时内不再为报价 build。 */
export function refreshResourceRepairFee(client: ChainClient, actor: string, permission: string): Promise<SponsorFeeSnapshot> {
  const chainId = client.chainId;
  const pending = refreshes.get(chainId);
  if (pending) return pending;
  const refreshing = (async () => {
    const cached = await getCachedSponsorFee(chainId);
    if (cached && isSponsorFeeFresh(cached)) return cached;
    const market = await getResourceRepairMarket(client);
    const cfg = client.config;
    const { action } = buildPowerupTopUp({
      market, payment: Number(POWERUP_TOPUP_DEFAULT), actor,
      contract: cfg.resourceContract, symbol: cfg.symbol, precision: cfg.precision,
    });
    const build = await requestSponsoredBuild({ actor, permission, actions: [action] });
    // 只取费用,服务意图/待签字节不缓存。后台请求期间若充值已拿到新价,保留新价。
    const latest = await getCachedSponsorFee(chainId);
    if (latest && latest !== cached) return latest;
    return rememberSponsorFee(chainId, build.sponsorFee ?? '');
  })().finally(() => {
    if (refreshes.get(chainId) === refreshing) refreshes.delete(chainId);
  });
  refreshes.set(chainId, refreshing);
  return refreshing;
}
