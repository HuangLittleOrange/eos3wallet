// PowerUp 定价——精确复刻 eosio.system 系统合约 powerup.cpp 里的公式
// (price_function / price_integral_delta / calc_powerup_fee),不是简化近似值。
// 逐行核对自官方源码,连同 "amount = frac*weight/powerup_frac" 这条换算,已经
// 拿一笔真实上链的 powerup 交易反向验证过(cpu_frac=50000000000 在当时的
// weight 下换算出的权重量和链上 powupresult 回报的 powup_cpu 完全一致)。
// 参照:
// https://github.com/eosnetworkfoundation/eos-system-contracts/blob/main/contracts/eosio.system/src/powerup.cpp
//
// !!单位陷阱:powup.state 里 weight/utilization 以及 powupresult 回报的量,
// 全都是「资源权重」——和 delegatebw 抵押产生的 cpu_weight/net_weight 同一个
// 单位,不是 CPU 微秒/NET 字节。权重折合成实际可用 µs/字节的比例取决于全网
// 总权重和链的容量配置,只能采样现成账户算出来(eosio.reserv 的
// cpu_limit.max / cpu_weight,见 client.getPowerupState)。主网上 1 权重
// ≈ 0.00009 µs——曾经把 µs 直接当权重用,CPU 成本被低估约一万倍,
// 「充 0.01 就显示能转十几万笔」就是这么来的。
//
// 之前 ResourceScreen 的 PowerUp 表单里,「最高支付」这个输入框只是传给链上
// 当滑点保护用的 max_payment 上限,cpu_frac/net_frac 是两个跟输入金额完全
// 无关的写死比例——用户填多填少,实际租到的资源量根本不会变,输入框形同虚设。
// 这里反过来:先按输入的预算算出这份钱能租多少资源,再据此换算 frac 提交,
// 「花多少钱」和「租多少资源」才是真的挂上钩的。

/** powup.state 表里单个资源(NET 或 CPU)那一半的字段,单位见各字段注释 */
export type PowerupResourceState = {
  /** 可租总量,单位是「资源权重」(同抵押的 cpu_weight/net_weight,不是 µs/字节!) */
  weight: number;
  exponent: number;
  decaySecs: number;
  /** 价格曲线两端,单位是系统代币最小单位(即 Asset.units,不是浮点数量) */
  minPrice: number;
  maxPrice: number;
  utilization: number;
  adjustedUtilization: number;
  /** 链上最后一次落定 adjustedUtilization 的时间——秒级 unix 时间戳 */
  utilizationTimestamp: number;
};

export type PowerupMarket = {
  net: PowerupResourceState;
  cpu: PowerupResourceState;
  powerupDays: number;
  /** 单笔费用低于这个值(代币最小单位)链上会直接拒绝——"try powering up with more resources" */
  minPowerupFee: number;
  /** 1 单位 CPU 权重折合多少微秒(采样自 eosio.reserv,见 client.getPowerupState) */
  cpuUsPerWeight: number;
  /** 1 单位 NET 权重折合多少字节 */
  netBytesPerWeight: number;
};

/** eosio.system 里的 powerup_frac 常量——1.0(100%)用 1e15 表示 */
export const POWERUP_FRAC = 1_000_000_000_000_000;

/**
 * CPU/NET 的预算分配比例,来自一笔小型转账样本。
 * 抽样了 2026-08-27 主网上一笔真实的单 action eosio.token::transfer
 * (0.0100 EOS、6 位数字 memo)的链上实际计费,cpu_usage_us=232、
 * net_usage_words=17(136 字节),这里在其上留了一点余量,覆盖稍长的 memo/
 * 收款账户名差异。这仅用于分配购买权重,不能当作可完成的转账笔数:
 * 合约执行、通知、账户已用资源和网络负载都会影响实际可用次数。
 */
export const ASSUMED_TRANSFER_CPU_US = 300;
export const ASSUMED_TRANSFER_NET_BYTES = 200;

/**
 * 把「每笔转账约 µs/字节」的假设按采样比例换算成权重。估算笔数
 * (estimateTransfersForBudget)和提交时反推 frac(fracForResourceUnits)必须
 * 用同一份换算结果,「显示的估算」和「真正买到的」才是同一个数。
 * 采样比例异常时返回 null,上层按「市场数据不可用」处理。
 */
export function perTransferResourceWeights(m: {
  cpuUsPerWeight: number;
  netBytesPerWeight: number;
}): { cpuWeight: number; netWeight: number } | null {
  const cpuWeight = ASSUMED_TRANSFER_CPU_US / m.cpuUsPerWeight;
  const netWeight = ASSUMED_TRANSFER_NET_BYTES / m.netBytesPerWeight;
  if (!Number.isFinite(cpuWeight) || cpuWeight <= 0 || !Number.isFinite(netWeight) || netWeight <= 0) {
    return null;
  }
  return { cpuWeight, netWeight };
}

/**
 * 没人来买的时候,adjusted_utilization 会随时间朝 utilization 指数衰减回落
 * ——查询这一刻链上存的值大概率已经"过期"了一段时间,先按 decay_secs 衰减到当前。
 * 逐字对应源码 update_utilization()。
 */
function decayedAdjustedUtilization(s: PowerupResourceState, nowSec: number): number {
  if (nowSec <= s.utilizationTimestamp) return s.adjustedUtilization;
  if (s.utilization >= s.adjustedUtilization) return s.utilization;
  const diff = s.adjustedUtilization - s.utilization;
  const delta = diff * Math.exp(-(nowSec - s.utilizationTimestamp) / s.decaySecs);
  return s.utilization + Math.max(0, Math.min(delta, diff));
}

/**
 * 买 increase 单位资源权重要花多少代币(最小单位,向上取整)。
 * 逐字对应源码 calc_powerup_fee():价格曲线在 [utilization, adjusted_utilization]
 * 这一段是常数(按当前边际价),超出 adjusted_utilization 的部分才走真正的积分。
 */
export function calcPowerupFee(s: PowerupResourceState, increase: number, nowSec: number): number {
  if (increase <= 0 || s.weight <= 0) return 0;
  const adjUtil = decayedAdjustedUtilization(s, nowSec);

  const priceFunction = (utilization: number) => {
    const e = s.exponent - 1.0;
    if (e <= 0) return s.maxPrice;
    return s.minPrice + (s.maxPrice - s.minPrice) * Math.pow(utilization / s.weight, e);
  };
  const priceIntegralDelta = (startUtilization: number, endUtilization: number) => {
    const coefficient = (s.maxPrice - s.minPrice) / s.exponent;
    const startU = startUtilization / s.weight;
    const endU = endUtilization / s.weight;
    return (
      s.minPrice * endU -
      s.minPrice * startU +
      coefficient * Math.pow(endU, s.exponent) -
      coefficient * Math.pow(startU, s.exponent)
    );
  };

  let fee = 0;
  let start = s.utilization;
  const end = start + increase;

  if (start < adjUtil) {
    fee += (priceFunction(adjUtil) * Math.min(increase, adjUtil - start)) / s.weight;
    start = adjUtil;
  }
  if (start < end) fee += priceIntegralDelta(start, end);

  return Math.ceil(fee);
}

/** 把想要的资源权重数换算成提交 powerup action 用的 frac(0~POWERUP_FRAC) */
export function fracForResourceUnits(units: number, weight: number): number {
  if (weight <= 0) return 0;
  return Math.max(0, Math.floor((units * POWERUP_FRAC) / weight));
}

/**
 * 给定预算(代币最小单位),CPU/NET 两边同时按「每笔转账大约消耗多少资源」的比例买,
 * 二分出预算最多能覆盖几笔——cpu 和 net 各自的花费函数都是凸的(买得越多边际价越贵),
 * 两者之和随笔数单调递增,所以直接对"笔数"整体二分,不需要先分别决定 cpu/net 预算怎么分。
 *
 * 注意:perTransferCpuWeight / perTransferNetWeight 是每笔转账折合的**权重**,
 * 不是 µs/字节——调用方要先用 cpuUsPerWeight/netBytesPerWeight 换算
 * (见 perTransferResourceWeights)。
 */
export function estimateTransfersForBudget(
  cpu: PowerupResourceState,
  net: PowerupResourceState,
  budgetRaw: number,
  nowSec: number,
  perTransferCpuWeight: number,
  perTransferNetWeight: number
): number {
  if (budgetRaw <= 0 || cpu.weight <= 0 || net.weight <= 0) return 0;
  if (!(perTransferCpuWeight > 0) || !(perTransferNetWeight > 0)) return 0;

  const cpuAvail = Math.max(0, cpu.weight - cpu.utilization);
  const netAvail = Math.max(0, net.weight - net.utilization);
  let hi = Math.min(cpuAvail / perTransferCpuWeight, netAvail / perTransferNetWeight);
  if (!Number.isFinite(hi) || hi <= 0) return 0;

  const feeForN = (n: number) =>
    calcPowerupFee(cpu, n * perTransferCpuWeight, nowSec) + calcPowerupFee(net, n * perTransferNetWeight, nowSec);

  // 预算大到能买光全网可租额度这种荒谬情况几乎不会发生,但二分区间必须有限——
  // hi 已经封顶在"资源池还剩多少"了,不够的话直接把这个上限当结果返回。
  if (feeForN(hi) <= budgetRaw) return Math.floor(hi);

  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (feeForN(mid) <= budgetRaw) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo);
}

/**
 * 报价留 3% 余量:powup.state 是查询那一刻的快照,提交时价格可能已经动了,
 * 按满额估算会让链上以 max_payment 不足拒掉。估算和提交共用这一个系数。
 */
export const POWERUP_QUOTE_SAFETY = 0.97;

/**
 * 按预算购买的资源组合单位数,资源页和修复弹窗共用。
 * 单位按上述样本比例分配 CPU/NET,不代表实际可转账次数,不能直接在 UI 展示。
 * 市场数据缺失或金额不正时返回 null。
 */
export function estimateTransfersForPayment(market: PowerupMarket, payment: number, precision: number): number | null {
  const weights = perTransferResourceWeights(market);
  if (!weights || !(payment > 0)) return null;
  const budgetRaw = Math.round(payment * 10 ** precision * POWERUP_QUOTE_SAFETY);
  if (budgetRaw <= 0) return null;
  return estimateTransfersForBudget(
    market.cpu,
    market.net,
    budgetRaw,
    Math.floor(Date.now() / 1000),
    weights.cpuWeight,
    weights.netWeight
  );
}
