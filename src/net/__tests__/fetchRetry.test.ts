import { fetchWithRetry } from '../fetchRetry';

afterEach(() => jest.useRealTimers());

it('为报价请求设置每次超时,连接挂起后有界重试并结束', async () => {
  jest.useFakeTimers();
  (globalThis as any).fetch = jest.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('timeout')));
  }));
  const result = fetchWithRetry('https://sponsor.invalid', {}, { attempts: 2, timeoutMs: 100, backoffMs: 10 });
  const assertion = expect(result).rejects.toThrow('timeout');
  await jest.advanceTimersByTimeAsync(210);
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});
