import { fetchWithRetry, fetchWithTimeout } from '../fetchRetry';

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

it('retries an Android connection abort and succeeds without retrying an HTTP error',async()=>{
 const response={ok:true} as Response;
 globalThis.fetch=jest.fn().mockRejectedValueOnce(new TypeError('fetch failed: java.net.SocketException: Software caused connection abort')).mockResolvedValue(response);
 await expect(fetchWithRetry('https://rpc.test',{}, {attempts:2,backoffMs:1,timeoutMs:1000})).resolves.toBe(response);
 expect(fetch).toHaveBeenCalledTimes(2);
 globalThis.fetch=jest.fn().mockResolvedValue({ok:false,status:400});
 await expect(fetchWithRetry('https://rpc.test')).resolves.toEqual({ok:false,status:400});expect(fetch).toHaveBeenCalledTimes(1);
});

it('caller cancellation aborts the timed request and prevents any retry',async()=>{
 jest.useFakeTimers();const controller=new AbortController();let requestSignal!:AbortSignal;
 globalThis.fetch=jest.fn().mockImplementation((_url,init)=>new Promise((_resolve,reject)=>{
  requestSignal=init.signal;requestSignal.addEventListener('abort',()=>reject(new Error('aborted')));
 }));
 const result=fetchWithRetry('https://rpc.test',{signal:controller.signal},{attempts:3,timeoutMs:1000});
 const assertion=expect(result).rejects.toMatchObject({name:'AbortError'});
 controller.abort();await assertion;
 expect(requestSignal.aborted).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);expect(jest.getTimerCount()).toBe(0);
});

it('cancellation during backoff clears the wait and never starts another request',async()=>{
 jest.useFakeTimers();const controller=new AbortController();
 globalThis.fetch=jest.fn().mockRejectedValue(new Error('offline'));
 const result=fetchWithRetry('https://rpc.test',{signal:controller.signal},{attempts:3,backoffMs:1000});
 const assertion=expect(result).rejects.toMatchObject({name:'AbortError'});
 await jest.advanceTimersByTimeAsync(0);controller.abort();await assertion;
 expect(fetch).toHaveBeenCalledTimes(1);expect(jest.getTimerCount()).toBe(0);
});

it('an already cancelled request never reaches the network',async()=>{
 const controller=new AbortController();controller.abort();globalThis.fetch=jest.fn();
 await expect(fetchWithTimeout('https://rpc.test',{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
 expect(fetch).not.toHaveBeenCalled();
});
