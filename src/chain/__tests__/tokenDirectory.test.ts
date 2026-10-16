import AsyncStorage from '@react-native-async-storage/async-storage';
import { rememberTokenDirectory, tokenDirectoryCache, tokenDirectoryKey, TOKEN_DIRECTORY_TTL, tokensForSelection } from '../tokenDirectory';
const metadata = (precision = 4) => ({ contract: 'core.vaulta', symbol: 'A', precision });
const balance = (amount: number, precision = 4) => ({ ...metadata(precision), amount, raw: `${amount} A` });
beforeEach(async () => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-16T00:00:00Z')); await AsyncStorage.clear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('metadata lives for 24 hours independently of changing balances; newly discovered tokens appear immediately', async () => {
  const key = tokenDirectoryKey('vaulta', 'daily');
  await rememberTokenDirectory('vaulta', 'daily', [balance(10)]);
  const savedAt = tokenDirectoryCache.get(key).updatedAt;
  jest.advanceTimersByTime(60 * 60 * 1000);
  await rememberTokenDirectory('vaulta', 'daily', [balance(3, 6)]);
  expect(tokenDirectoryCache.get(key)).toMatchObject({ data: [metadata(4)], updatedAt: savedAt });
  const usdt = { contract: 'tethertether', symbol: 'USDT', precision: 6 };
  await rememberTokenDirectory('vaulta', 'daily', [usdt]);
  expect(tokenDirectoryCache.get(key)).toMatchObject({ data: [metadata(4), usdt], updatedAt: savedAt });
  jest.advanceTimersByTime(TOKEN_DIRECTORY_TTL - 60 * 60 * 1000);
  await rememberTokenDirectory('vaulta', 'daily', [balance(2, 6)]);
  expect(tokenDirectoryCache.get(key).data?.[0].precision).toBe(6);
  const raw = (await AsyncStorage.getItem('eos3.tokenDirectory.v1.' + key))!;
  expect(raw).not.toMatch(/amount|raw|balance/);
});

test('manual/operation refresh updates metadata immediately, and an older balance snapshot cannot roll it back', async () => {
  const key = tokenDirectoryKey('vaulta', 'operation');
  await rememberTokenDirectory('vaulta', 'operation', [balance(10)]); const oldAt = Date.now();
  jest.advanceTimersByTime(1000);
  await rememberTokenDirectory('vaulta', 'operation', [balance(8, 6)], true);
  await rememberTokenDirectory('vaulta', 'operation', [balance(10)], false, oldAt);
  expect(tokenDirectoryCache.get(key).data).toEqual([metadata(6)]);
});

test('directories are isolated by chain and account and cannot store monetary fields', async () => {
  await rememberTokenDirectory('vaulta', 'isolated', [balance(9)]);
  expect(tokenDirectoryCache.get(tokenDirectoryKey('jungle4', 'isolated')).data).toBeUndefined();
  expect(tokenDirectoryCache.get(tokenDirectoryKey('vaulta', 'other')).data).toBeUndefined();
  expect(() => tokenDirectoryCache.remember('invalid', [balance(999)] as any)).toThrow('Invalid cached response');
});

test('selection joins metadata with current balances, including zero balances, never restores a cached amount', () => {
  const usdt = { contract: 'tethertether', symbol: 'USDT', precision: 6 };
  const rows = tokensForSelection([metadata(), usdt], [balance(0, 6)]);
  expect(rows[0]).toEqual(balance(0, 6));
  expect(rows[1]).toEqual({ ...usdt, amount: 0, raw: '0.000000 USDT' });
});
