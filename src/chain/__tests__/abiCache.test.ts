// ABI 缓存的单测——重点是"少打请求"的三条性质(TTL 内命中、并发去重、
// invalidate 强制刷新)和"失败不缓存"(一次网络抖动不能把这个合约钉死十分钟)。
// 缓存是模块级单例,各用例用不同的合约名隔离,互不踩缓存。
jest.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { getCachedAbi, invalidateAbi } from '../abiCache';

const NODE = 'https://node.test';
const FAKE_ABI = { version: 'eosio::abi/1.2', structs: [], actions: [] };

function mockFetch(impl: (url: string, init: any) => Promise<any>) {
  const fn = jest.fn(impl);
  (globalThis as any).fetch = fn;
  return fn;
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getCachedAbi', () => {
  it('TTL 内第二次调用命中缓存,不再打节点', async () => {
    const fetchMock = mockFetch(async () => okResponse({ account_name: 'ct.hit', abi: FAKE_ABI }));
    const a = await getCachedAbi(NODE, 'ct.hit');
    const b = await getCachedAbi(NODE, 'ct.hit');
    expect(a).toEqual(FAKE_ABI);
    expect(b).toEqual(FAKE_ABI);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${NODE}/v1/chain/get_abi`);
    expect(JSON.parse(init.body).account_name).toBe('ct.hit');
  });

  it('并发请求同一份 ABI:第二个等第一个的在途请求,不各拉各的', async () => {
    let resolveFetch!: (v: any) => void;
    const fetchMock = mockFetch(() => new Promise((r) => (resolveFetch = r)));
    const p1 = getCachedAbi(NODE, 'ct.race');
    const p2 = getCachedAbi(NODE, 'ct.race');
    resolveFetch(okResponse({ account_name: 'ct.race', abi: FAKE_ABI }));
    await expect(p1).resolves.toEqual(FAKE_ABI);
    await expect(p2).resolves.toEqual(FAKE_ABI);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('请求失败不缓存失败结果,下一次会重新拉', async () => {
    // fetchAbiDef 内部走 fetchWithRetry(3 次尝试)——前 3 次(第一次 getCachedAbi
    // 调用的全部重试)都失败,第 4 次(下一次 getCachedAbi 重新发起)才成功。
    const fetchMock = mockFetch(async () => {
      if (fetchMock.mock.calls.length <= 3) throw new Error('network down');
      return okResponse({ account_name: 'ct.retry', abi: FAKE_ABI });
    });
    await expect(getCachedAbi(NODE, 'ct.retry')).rejects.toThrow('network down');
    await expect(getCachedAbi(NODE, 'ct.retry')).resolves.toEqual(FAKE_ABI);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('合约没有 ABI(响应里缺 abi 字段):抛可读错误,同样不缓存', async () => {
    const fetchMock = mockFetch(async () => okResponse({ account_name: 'ct.noabi' }));
    await expect(getCachedAbi(NODE, 'ct.noabi')).rejects.toThrow('eos3Error.abiFetchFailed');
    await expect(getCachedAbi(NODE, 'ct.noabi')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateAbi 之后强制重新拉取', async () => {
    const fetchMock = mockFetch(async () => okResponse({ account_name: 'ct.inval', abi: FAKE_ABI }));
    await getCachedAbi(NODE, 'ct.inval');
    invalidateAbi(NODE, 'ct.inval');
    await getCachedAbi(NODE, 'ct.inval');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超过 TTL 后过期重拉', async () => {
    const fetchMock = mockFetch(async () => okResponse({ account_name: 'ct.ttl', abi: FAKE_ABI }));
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);
    await getCachedAbi(NODE, 'ct.ttl');
    nowSpy.mockReturnValue(realNow + 11 * 60 * 1000);
    await getCachedAbi(NODE, 'ct.ttl');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('不同节点各自一份缓存——切换节点不会拿到别的节点的旧 ABI', async () => {
    const fetchMock = mockFetch(async () => okResponse({ account_name: 'ct.node', abi: FAKE_ABI }));
    await getCachedAbi('https://a.test', 'ct.node');
    await getCachedAbi('https://b.test', 'ct.node');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
