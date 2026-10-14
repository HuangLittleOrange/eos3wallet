// "签名广播失败 → 一键买资源"的纯逻辑部分:拼修复交易、算费用、比余额。
// 界面在 components/ResourceRepairSheet.tsx,这里不碰 React,好单测。
//
// 两种修复:
//   CPU/NET 不够 → 用户花自己的 A 买一次 PowerUp(payer=receiver=自己)。这笔
//                  交易用户自己发不出去(没 CPU),走 Sponsor 代付,另收一笔代付费,
//                  两者合起来在弹窗上叫"资源费用"。
//   RAM 不够     → 用自己的余额买 1KB(buyrambytes)。这笔先直接广播;也因为
//                  CPU/NET 发不出去的话,弹窗切到上面那条路。
import { Asset } from '@wharfkit/antelope';

import { buildBuyRamBytes, buildPowerUp } from './resourceActions';
import { estimateTransfersForPayment, fracForResourceUnits, perTransferResourceWeights, type PowerupMarket } from './powerupPricing';
import type { ActionSpec } from './transact';
import { t } from '../i18n';

/** 修复弹窗里 PowerUp 金额的默认值(系统代币数量)——用户可以改 */
export const POWERUP_TOPUP_DEFAULT = '0.01';
export const RAM_TOPUP_BYTES = 1024;

/** 把系统代币数量格式化成链上 asset 字符串,如 "0.0100 A" */
export function formatPayment(payment: number, symbol: string, precision: number): string {
  return String(Asset.fromFloat(payment, `${precision},${symbol}`));
}

/**
 * 花 payment 买 PowerUp:CPU/NET 两边按「一笔普通转账大约消耗多少」的比例同时买
 * (和资源页的 PowerUp 表单同一套换算),返回要签的 action 和内部资源组合单位数。
 * transfers 是预算分配单位,不作为实际可转账次数展示。
 */
export function buildPowerupTopUp(opts: {
  market: PowerupMarket;
  payment: number;
  actor: string;
  contract: string;
  symbol: string;
  precision: number;
}): { action: ActionSpec; transfers: number } {
  const weights = perTransferResourceWeights(opts.market);
  if (!weights) throw new Error(t('resource.powerupMarketUnavailable'));
  const transfers = estimateTransfersForPayment(opts.market, opts.payment, opts.precision) ?? 0;
  if (transfers <= 0) throw new Error(t('resource.estimateTooSmall'));
  const action = buildPowerUp({
    contract: opts.contract,
    payer: opts.actor,
    receiver: opts.actor,
    cpuFrac: fracForResourceUnits(transfers * weights.cpuWeight, opts.market.cpu.weight),
    netFrac: fracForResourceUnits(transfers * weights.netWeight, opts.market.net.weight),
    maxPayment: opts.payment,
    symbol: opts.symbol,
    precision: opts.precision,
    days: opts.market.powerupDays,
  });
  return { action, transfers };
}

/** 给自己买 1KB RAM */
export function buildRamTopUp(opts: { actor: string; contract: string }): ActionSpec {
  return buildBuyRamBytes({ contract: opts.contract, payer: opts.actor, receiver: opts.actor, bytes: RAM_TOPUP_BYTES });
}

/** "0.0100 A" + "0.0100 A" = "0.0200 A"——两个都是同一种系统代币 */
export function sumAssets(a: string, b: string): string {
  const x = Asset.from(a);
  const y = Asset.from(b);
  return String(Asset.fromUnits(x.units.adding(y.units), x.symbol));
}

/** 余额付不付得起 cost。余额未知或两边符号对不上就当付得起——链上会给最终答案 */
export function exceedsBalance(cost: string, balance: string | null | undefined): boolean {
  if (!balance) return false;
  try {
    const c = Asset.from(cost);
    const b = Asset.from(balance);
    if (!c.symbol.equals(b.symbol)) return false;
    return b.units.lt(c.units);
  } catch {
    return false;
  }
}
