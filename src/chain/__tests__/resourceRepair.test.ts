// 一键买资源的纯逻辑:拼出来的 powerup 是不是"自己付、自己收、按预算买",
// 费用合计和余额比较对不对。
jest.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import { buildPowerupTopUp, buildRamTopUp, exceedsBalance, formatPayment, sumAssets } from '../resourceRepair';
import type { PowerupMarket } from '../powerupPricing';

// 2026-08-27 从 Vaulta 主网实测的 powup.state + eosio.reserv 采样(见 powerupPricing.test.ts)
const market: PowerupMarket = {
  cpu: {
    weight: 381816116585640,
    exponent: 2,
    decaySecs: 86400,
    minPrice: 25000000,
    maxPrice: 750000000,
    utilization: 10260208112123,
    adjustedUtilization: 11050865899215,
    utilizationTimestamp: 0,
  },
  net: {
    weight: 95454029146410,
    exponent: 2,
    decaySecs: 86400,
    minPrice: 2500000,
    maxPrice: 75000000,
    utilization: 100000000000,
    adjustedUtilization: 120000000000,
    utilizationTimestamp: 0,
  },
  powerupDays: 1,
  minPowerupFee: 1,
  cpuUsPerWeight: 9.0303e-5,
  netBytesPerWeight: 1.8942,
};

describe('buildPowerupTopUp', () => {
  it('自己付、自己收、max_payment 就是用户填的金额、按比例买 CPU 和 NET', () => {
    const { action, transfers } = buildPowerupTopUp({
      market,
      payment: 0.01,
      actor: 'alice',
      contract: 'core.vaulta',
      symbol: 'A',
      precision: 4,
    });
    expect(action.account).toBe('core.vaulta');
    expect(action.name).toBe('powerup');
    expect(action.data.payer).toBe('alice');
    expect(action.data.receiver).toBe('alice');
    expect(action.data.days).toBe(1);
    expect(action.data.max_payment).toBe('0.0100 A');
    expect(action.data.cpu_frac).toBeGreaterThan(0);
    expect(action.data.net_frac).toBeGreaterThan(0);
    expect(transfers).toBeGreaterThan(0);
  });

  it('金额小到买不到一笔转账的资源:拒绝,不拼出一个空 powerup', () => {
    expect(() =>
      buildPowerupTopUp({ market, payment: 0.0001, actor: 'alice', contract: 'core.vaulta', symbol: 'A', precision: 4 })
    ).toThrow('resource.estimateTooSmall');
  });
});

it('buildRamTopUp:给自己买 1KB', () => {
  const action = buildRamTopUp({ actor: 'alice', contract: 'core.vaulta' });
  expect(action).toEqual({ account: 'core.vaulta', name: 'buyrambytes', data: { payer: 'alice', receiver: 'alice', bytes: 1024 } });
});

describe('费用合计与余额', () => {
  it('sumAssets:PowerUp 金额 + 代付费 = 资源费用合计', () => {
    expect(sumAssets('0.0100 A', '0.0100 A')).toBe('0.0200 A');
  });

  it('formatPayment:按精度格式化', () => {
    expect(formatPayment(0.01, 'A', 4)).toBe('0.0100 A');
  });

  it('exceedsBalance:余额不够才算不够;余额未知/符号不同不拦', () => {
    expect(exceedsBalance('0.0200 A', '0.0100 A')).toBe(true);
    expect(exceedsBalance('0.0200 A', '0.0200 A')).toBe(false);
    expect(exceedsBalance('0.0200 A', null)).toBe(false);
    expect(exceedsBalance('0.0200 A', '1.0000 EOS')).toBe(false);
  });
});
