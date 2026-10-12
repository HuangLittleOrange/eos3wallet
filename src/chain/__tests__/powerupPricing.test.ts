import {
  ASSUMED_TRANSFER_CPU_US,
  ASSUMED_TRANSFER_NET_BYTES,
  calcPowerupFee,
  estimateTransfersForBudget,
  fracForResourceUnits,
  perTransferResourceWeights,
  POWERUP_FRAC,
  PowerupResourceState,
} from '../powerupPricing';

// 用 2026-08-27 从 Vaulta 主网实测的 powup.state(CPU 那一半)当基准数据——
// 不是随手编的数字,是真实链上状态,好让这些用例贴近真实场景。
const REAL_CPU_STATE: PowerupResourceState = {
  weight: 381816116585640,
  exponent: 2,
  decaySecs: 86400,
  minPrice: 25000000, // "2500.0000 EOS" 的最小单位
  maxPrice: 750000000, // "75000.0000 EOS" 的最小单位
  utilization: 10260208112123,
  adjustedUtilization: 11050865899215,
  utilizationTimestamp: 0,
};

describe('fracForResourceUnits', () => {
  it('换算结果和一笔真实上链的 powerup 交易完全吻合', () => {
    // 真实交易:cpu_frac=50000000000,链上 powupresult 回报 powup_cpu=19090805829,
    // 反过来验证同一个 weight 下 frac→units 的换算是否一致(1e15 精度内允许四舍五入)。
    const units = (50000000000 * REAL_CPU_STATE.weight) / POWERUP_FRAC;
    expect(Math.round(units)).toBe(19090805829);

    // 反过来:同一批 units 换算回 frac,应该落回原来的量级(向下取整,不会超过原 frac)
    const frac = fracForResourceUnits(19090805829, REAL_CPU_STATE.weight);
    expect(frac).toBeLessThanOrEqual(50000000000);
    expect(frac).toBeGreaterThan(49999999000);
  });

  it('weight 非正时返回 0,不会除零', () => {
    expect(fracForResourceUnits(100, 0)).toBe(0);
    expect(fracForResourceUnits(100, -1)).toBe(0);
  });
});

describe('calcPowerupFee', () => {
  it('买 0 单位不要钱', () => {
    expect(calcPowerupFee(REAL_CPU_STATE, 0, 0)).toBe(0);
  });

  it('买得越多,费用单调不减——曲线是凸的,边际价只会越来越贵', () => {
    const fee1 = calcPowerupFee(REAL_CPU_STATE, 1_000_000, 0);
    const fee2 = calcPowerupFee(REAL_CPU_STATE, 2_000_000, 0);
    const fee3 = calcPowerupFee(REAL_CPU_STATE, 4_000_000, 0);
    expect(fee2).toBeGreaterThanOrEqual(fee1);
    expect(fee3).toBeGreaterThanOrEqual(fee2);
    // 凸曲线:后一倍的边际费用不会比前一倍更便宜
    expect(fee3 - fee2).toBeGreaterThanOrEqual(fee2 - fee1);
  });

  it('adjusted_utilization 会随时间衰减,买同样的量隔久一点更便宜', () => {
    const feeNow = calcPowerupFee(REAL_CPU_STATE, 5_000_000, 0);
    const feeLater = calcPowerupFee(REAL_CPU_STATE, 5_000_000, 10 * 86400); // 10 个衰减周期后,基本衰减到底
    expect(feeLater).toBeLessThanOrEqual(feeNow);
  });
});

// 2026-09-01 从主网 eosio.reserv 实测的采样比例(cpu_limit.max/cpu_weight、
// net_limit.max/net_weight)——1 单位 CPU 权重只折合约 0.00009 µs,这正是
// 「把 µs 直接当权重用」会把成本低估上万倍的原因。
const REAL_SAMPLE = { cpuUsPerWeight: 9.0303e-5, netBytesPerWeight: 1.8942 };

describe('perTransferResourceWeights', () => {
  it('µs/字节按采样比例换算成权重——CPU 差 4 个数量级', () => {
    const w = perTransferResourceWeights(REAL_SAMPLE)!;
    expect(w.cpuWeight).toBeCloseTo(ASSUMED_TRANSFER_CPU_US / REAL_SAMPLE.cpuUsPerWeight, 3);
    expect(w.netWeight).toBeCloseTo(ASSUMED_TRANSFER_NET_BYTES / REAL_SAMPLE.netBytesPerWeight, 3);
    // 300µs 的 CPU 折合权重是百万量级,绝不是 300
    expect(w.cpuWeight).toBeGreaterThan(1_000_000);
  });

  it('采样比例异常(0/NaN)时返回 null,不产出 Infinity', () => {
    expect(perTransferResourceWeights({ cpuUsPerWeight: 0, netBytesPerWeight: 1.9 })).toBeNull();
    expect(perTransferResourceWeights({ cpuUsPerWeight: NaN, netBytesPerWeight: 1.9 })).toBeNull();
  });
});

describe('estimateTransfersForBudget', () => {
  const netState: PowerupResourceState = {
    ...REAL_CPU_STATE,
    weight: REAL_CPU_STATE.weight / 4, // 主网实测 net weight 大致是 cpu 的 1/4 量级
    utilization: REAL_CPU_STATE.utilization / 4,
    adjustedUtilization: REAL_CPU_STATE.adjustedUtilization / 4,
  };
  const { cpuWeight: CPU_W, netWeight: NET_W } = perTransferResourceWeights(REAL_SAMPLE)!;

  it('预算为 0 时支持 0 笔', () => {
    expect(estimateTransfersForBudget(REAL_CPU_STATE, netState, 0, 0, CPU_W, NET_W)).toBe(0);
  });

  it('预算越多,支持的笔数不会变少', () => {
    const small = estimateTransfersForBudget(REAL_CPU_STATE, netState, 100, 0, CPU_W, NET_W);
    const big = estimateTransfersForBudget(REAL_CPU_STATE, netState, 100_000, 0, CPU_W, NET_W);
    expect(big).toBeGreaterThanOrEqual(small);
  });

  it('回归:0.01 A 预算估出来是几百笔的量级,不是把 µs 当权重时的十几万笔', () => {
    const n = estimateTransfersForBudget(REAL_CPU_STATE, netState, 100, 0, CPU_W, NET_W);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(2000);
  });

  it('算出来的笔数拿去反推的 frac,花费不超过预算(这正是 review() 提交前依赖的不变式)', () => {
    const budget = 5000; // 0.5 A(4 位精度)
    const n = estimateTransfersForBudget(REAL_CPU_STATE, netState, budget, 0, CPU_W, NET_W);
    expect(n).toBeGreaterThan(0);
    const fee =
      calcPowerupFee(REAL_CPU_STATE, n * CPU_W, 0) + calcPowerupFee(netState, n * NET_W, 0);
    expect(fee).toBeLessThanOrEqual(budget);
  });

  it('市场权重为 0(查不到数据的兜底)时返回 0,不抛异常', () => {
    const empty: PowerupResourceState = { ...REAL_CPU_STATE, weight: 0 };
    expect(estimateTransfersForBudget(empty, netState, 10000, 0, CPU_W, NET_W)).toBe(0);
  });

  it('每笔权重非正(采样缺失误传)时返回 0,不会除零跑飞', () => {
    expect(estimateTransfersForBudget(REAL_CPU_STATE, netState, 10000, 0, 0, NET_W)).toBe(0);
  });
});
