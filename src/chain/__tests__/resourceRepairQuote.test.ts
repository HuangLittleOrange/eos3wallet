jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../sponsor', () => ({ requestSponsoredBuild: jest.fn() }));
jest.mock('../resourceRepair', () => ({
  POWERUP_TOPUP_DEFAULT: '0.01',
  buildPowerupTopUp: jest.fn(() => ({ action: { account: 'core.vaulta', name: 'powerup', data: { max_payment: '0.0100 A' } } })),
}));

// 模拟磁盘跨模块重载保留,用 resetModules 模拟重启应用。
const mockDisk = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockDisk.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { mockDisk.set(key, value); }),
  },
}));

import type { ChainClient } from '../client';
import type { ChainId } from '../config';

let quotes: typeof import('../resourceRepairQuote');
let fees: typeof import('../sponsorFeeCache');
let mockBuild: jest.Mock;
const now = Date.parse('2026-10-06T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const makeClient = (chainId: ChainId = 'vaulta') => ({
  chainId,
  config: require('../config').CHAINS[chainId],
  getPowerupState: jest.fn().mockResolvedValue({ powerupDays: 1 }),
}) as unknown as ChainClient;

function restart() {
  jest.resetModules();
  quotes = require('../resourceRepairQuote');
  fees = require('../sponsorFeeCache');
  mockBuild = require('../sponsor').requestSponsoredBuild;
  mockBuild.mockResolvedValue({ sponsorFee: '0.0100 A', serializedTransaction: 'deadbeef', sponsorRequestId: 'req', expiresAt: new Date(now + 60_000).toISOString() });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDisk.clear();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  restart();
});
afterEach(() => jest.restoreAllMocks());

it('钱包启动和打开弹窗合并进行中的报价请求', async () => {
  const client = makeClient();
  const first = quotes.refreshResourceRepairFee(client, 'alice', 'active');
  const second = quotes.refreshResourceRepairFee(makeClient(), 'bob', 'owner');
  expect(second).toBe(first);
  expect((await first).fee).toBe('0.0100 A');
  expect(client.getPowerupState).toHaveBeenCalledTimes(1);
  expect(mockBuild).toHaveBeenCalledTimes(1);
});

it('24 小时内切账户/权限/节点也直接读取同项目费率,不重新查询市场或 Sponsor', async () => {
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  jest.mocked(Date.now).mockReturnValue(now + DAY - 1);
  const client = makeClient();
  await quotes.refreshResourceRepairFee(client, 'bob', 'owner');
  expect(client.getPowerupState).not.toHaveBeenCalled();
  expect(mockBuild).toHaveBeenCalledTimes(1);
});

it('重启应用仍复用报价,只持久化费用与时间,不保存过期交易', async () => {
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  expect(JSON.parse([...mockDisk.values()][0])).toEqual({ fee: '0.0100 A', updatedAt: now });
  restart();
  expect((await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active')).fee).toBe('0.0100 A');
  expect(mockBuild).not.toHaveBeenCalled();
});

it('正好过 24 小时会重新请求并更新持久化价格', async () => {
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  jest.mocked(Date.now).mockReturnValue(now + DAY);
  mockBuild.mockResolvedValue({ sponsorFee: '0.0200 A' });
  expect((await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active')).fee).toBe('0.0200 A');
  expect(mockBuild).toHaveBeenCalledTimes(2);
  expect(JSON.parse([...mockDisk.values()][0]).updatedAt).toBe(now + DAY);
});

it('刷新失败保留旧报价与旧时间,随后可重试', async () => {
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  jest.mocked(Date.now).mockReturnValue(now + DAY);
  mockBuild.mockRejectedValueOnce(new Error('offline'));
  await expect(quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active')).rejects.toThrow('offline');
  expect(await fees.getCachedSponsorFee('vaulta')).toEqual({ fee: '0.0100 A', updatedAt: now });
  await expect(quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active')).resolves.toBeDefined();
  expect(mockBuild).toHaveBeenCalledTimes(3);
});

it('免费报价的空字符串是有效缓存,不会每天内反复获取', async () => {
  mockBuild.mockResolvedValue({});
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  restart();
  expect((await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active')).fee).toBe('');
  expect(mockBuild).not.toHaveBeenCalled();
});

it('主网和测试网项目费率隔离,传入实际权限', async () => {
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  mockBuild.mockResolvedValue({ sponsorFee: '0.0100 EOS' });
  await quotes.refreshResourceRepairFee(makeClient('jungle4'), 'testuser', 'owner');
  expect(mockBuild).toHaveBeenCalledTimes(2);
  expect(mockBuild.mock.calls[1][0].permission).toBe('owner');
  expect((await fees.getCachedSponsorFee('vaulta'))?.fee).toBe('0.0100 A');
  expect((await fees.getCachedSponsorFee('jungle4'))?.fee).toBe('0.0100 EOS');
});

it('充值时已获取新价,较慢的后台旧报价不能覆盖它', async () => {
  let finish!: (value: unknown) => void;
  mockBuild.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  // 等到市场读取和 Sponsor 请求已经开始。
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  expect(finish).toBeDefined();
  await fees.rememberSponsorFee('vaulta', '0.0200 A');
  finish({ sponsorFee: '0.0100 A' });
  expect((await pending).fee).toBe('0.0200 A');
  expect((await fees.getCachedSponsorFee('vaulta'))?.fee).toBe('0.0200 A');
});

it('PowerUp 市场只缓存 30 秒,每日费用不阻止市场更新', async () => {
  const client = makeClient();
  const a = quotes.getResourceRepairMarket(client);
  expect(quotes.getResourceRepairMarket(client)).toBe(a);
  await a;
  jest.mocked(Date.now).mockReturnValue(now + 30_000);
  await quotes.getResourceRepairMarket(client);
  expect(client.getPowerupState).toHaveBeenCalledTimes(2);
  expect(mockBuild).not.toHaveBeenCalled();
});

it.each([
  '{bad json',
  JSON.stringify({ fee: '100.0000 A', updatedAt: now }),
  JSON.stringify({ fee: '0.0100 EOS', updatedAt: now }),
  JSON.stringify({ fee: null, updatedAt: now }),
  JSON.stringify({ fee: '0.0100 A', updatedAt: now + 1 }),
])('损坏或不可信的持久化数据不当成免费报价: %s', async (raw) => {
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  mockDisk.set([...mockDisk.keys()][0], raw);
  restart();
  expect(await fees.getCachedSponsorFee('vaulta')).toBeNull();
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  expect(mockBuild).toHaveBeenCalledTimes(1);
});

it('本地存储失败仍在当前会话复用已获取的费率', async () => {
  const storage = require('@react-native-async-storage/async-storage').default;
  storage.setItem.mockRejectedValueOnce(new Error('disk full'));
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  await quotes.refreshResourceRepairFee(makeClient(), 'alice', 'active');
  expect(mockBuild).toHaveBeenCalledTimes(1);
});
