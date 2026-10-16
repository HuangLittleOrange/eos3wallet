const mockDisk = new Map<string, string>();
const mockFetch = jest.fn();
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithTimeout: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {
  getItem: async (key: string) => mockDisk.get(key) ?? null,
  setItem: async (key: string, value: string) => { mockDisk.set(key, value); }, removeItem: async (key: string) => { mockDisk.delete(key); },
} }));
let prices: typeof import('../prices');
const restart = () => { jest.resetModules(); prices = require('../prices'); };
const quote = () => ({ ok: true, json: async () => ({ vaulta: { usd: 0.08, usd_24h_change: 2 } }) });
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-16T00:00:00Z')); mockDisk.clear(); mockFetch.mockReset(); mockFetch.mockResolvedValue(quote()); restart(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('concurrent price reads coalesce, fresh reads reuse and manual refresh bypasses TTL', async () => {
  await Promise.all([prices.fetchPrices(), prices.fetchPrices()]); expect(mockFetch).toHaveBeenCalledTimes(1);
  await prices.fetchPrices(); expect(mockFetch).toHaveBeenCalledTimes(1);
  await prices.fetchPrices('coingecko', true); expect(mockFetch).toHaveBeenCalledTimes(2);
});
test('repeated failures retain the last real price and original timestamp', async () => {
  const saved = await prices.fetchPrices(); mockFetch.mockRejectedValue(new Error('offline'));
  jest.advanceTimersByTime(60000);
  for (let i = 0; i < 2; i++) {
    const stale = await prices.fetchPrices('coingecko', true);
    expect(stale.updatedAt).toBe(saved.updatedAt); expect(stale.stale).toBe(true);
    expect(prices.priceIn(stale, 'core.vaulta', 'A')).toBe(0.08);
  }
});
test('cold starts hydrate saved quotes before the network and isolate sources', async () => {
  await prices.fetchPrices(); for (let i = 0; i < 5; i++) await Promise.resolve();
  restart(); mockFetch.mockClear();
  expect(prices.peekPrices('coingecko')).toBeNull();
  expect(prices.priceIn(await prices.loadPriceSnapshot('coingecko'), 'core.vaulta', 'A')).toBe(0.08);
  expect(mockFetch).not.toHaveBeenCalled(); expect(await prices.loadPriceSnapshot('binance')).toBeNull();
  mockFetch.mockRejectedValue(new Error('offline'));
  expect(prices.priceIn(await prices.fetchPrices('coingecko', true), 'core.vaulta', 'A')).toBe(0.08);
});
test('invalid network quotes cannot replace good persisted prices', async () => {
  const saved = await prices.fetchPrices();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ vaulta: { usd: -1, usd_24h_change: 0 } }) });
  const result = await prices.fetchPrices('coingecko', true);
  expect(result.prices).toEqual(saved.prices); expect(result.stale).toBe(true);
});
