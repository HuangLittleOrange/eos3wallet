import AsyncStorage from '@react-native-async-storage/async-storage';
import { ReadCache } from '../readCache';
const valid = (data: unknown): data is number[] => Array.isArray(data) && data.every(Number.isFinite);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(async () => { jest.useFakeTimers(); jest.clearAllMocks(); await AsyncStorage.clear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('coalesces concurrent readers, accepts empty data, expires by actual success time and supports force', async () => {
  const cache = new ReadCache<number[]>(60000);
  const load = jest.fn(async () => []);
  await Promise.all([cache.fetch('alice', load), cache.fetch('alice', load)]);
  expect(load).toHaveBeenCalledTimes(1);
  await cache.fetch('alice', load); expect(load).toHaveBeenCalledTimes(1);
  await cache.fetch('alice', load, true); expect(load).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(60000); await cache.fetch('alice', load);
  expect(load).toHaveBeenCalledTimes(3);
  await cache.fetch('bob', load); expect(load).toHaveBeenCalledTimes(4);
});

test('pending and failed refreshes retain visible data/time; automatic failures are throttled and explicit retry works', async () => {
  const cache = new ReadCache<number[]>(60000); cache.remember('a', [1]);
  const saved = cache.get('a'); let fail!: (e: Error) => void;
  const load = jest.fn(() => new Promise<number[]>((_, reject) => { fail = reject; }));
  const pending = cache.fetch('a', load, true); await flush();
  expect(cache.get('a').data).toBe(saved.data); expect(cache.get('a').refreshing).toBe(true);
  fail(new Error('offline')); await expect(pending).rejects.toThrow('offline');
  expect(cache.get('a')).toMatchObject({ data: [1], updatedAt: saved.updatedAt, refreshing: false });
  jest.advanceTimersByTime(60000);
  const offline = jest.fn(async () => { throw new Error('offline'); });
  await expect(cache.fetch('a', offline)).rejects.toThrow('offline');
  await expect(cache.fetch('a', offline)).rejects.toThrow('offline'); expect(offline).toHaveBeenCalledTimes(1);
  await cache.fetch('a', async () => [2], true); expect(cache.get('a').data).toEqual([2]);
});

test('disk hydration survives restart, ignores corrupt/future data and cannot overwrite a newer response', async () => {
  const cache = new ReadCache<number[]>(60000, { storagePrefix: 'test.', validate: valid });
  await AsyncStorage.setItem('test.a', JSON.stringify({ version: 1, data: [7], updatedAt: Date.now() - 1 }));
  await cache.hydrate('a'); expect(cache.get('a').data).toEqual([7]);
  for (const [i, raw] of ['{bad', JSON.stringify({ version: 1, data: [1], updatedAt: Date.now() + 1 }),
    JSON.stringify({ version: 1, data: [null], updatedAt: 1 })].entries()) {
    await AsyncStorage.setItem('test.bad' + i, raw); await cache.hydrate('bad' + i);
    expect(cache.get('bad' + i).data).toBeUndefined();
  }
  let finish!: (raw: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = cache.hydrate('race'); cache.remember('race', [9]);
  finish(JSON.stringify({ version: 1, data: [1], updatedAt: 1 })); await old;
  expect(cache.get('race').data).toEqual([9]);
});

test('mutation invalidation rejects an older in-flight response and keeps newer results on disk', async () => {
  const cache = new ReadCache<number[]>(60000, { storagePrefix: 'mutate.', validate: valid });
  cache.remember('a', [1]); let finish!: (rows: number[]) => void;
  const old = cache.fetch('a', () => new Promise(resolve => { finish = resolve; }), true); await flush();
  cache.invalidate('a'); expect(cache.get('a').data).toEqual([1]);
  await cache.fetch('a', async () => [2]);
  finish([0]); await expect(old).rejects.toThrow('superseded'); await flush();
  expect(cache.get('a').data).toEqual([2]);
  expect(JSON.parse((await AsyncStorage.getItem('mutate.a'))!).data).toEqual([2]);
});

test('hung and late requests cannot pin the cache or overwrite a successful retry', async () => {
  const cache = new ReadCache<number[]>(60000); let finish!: (rows: number[]) => void;
  const request = cache.fetch('a', () => new Promise(resolve => { finish = resolve; }));
  const rejected = expect(request).rejects.toThrow('timed out');
  await jest.advanceTimersByTimeAsync(30000); await rejected;
  expect(cache.get('a').refreshing).toBe(false);
  await cache.fetch('a', async () => [2], true); finish([1]); await flush();
  expect(cache.get('a').data).toEqual([2]);
});

test('equivalent results keep list identity and storage failures do not hide successful data', async () => {
  const cache = new ReadCache<number[]>(60000, { storagePrefix: 'same.', validate: valid,
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  await cache.fetch('a', async () => [1]); const previous = cache.get('a').data;
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await cache.fetch('a', async () => [1], true); expect(cache.get('a').data).toBe(previous);
});
