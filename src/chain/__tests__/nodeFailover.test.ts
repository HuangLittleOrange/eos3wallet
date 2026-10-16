jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithTimeout: jest.fn() }));
import { fetchWithTimeout } from '../../net/fetchRetry';
import { ReadNodePool, type ReadNodeKind } from '../nodeFailover';
import { ChainClient } from '../client';
import { CHAINS } from '../config';

const node = (id: string) => ({ id, name: id, url: `https://${id}.example` });
const a = node('a'), b = node('b'), c = node('c');
const rpcInfo = { chain_id: CHAINS.vaulta.chainIdHash, head_block_num: 123 };
const health = { health: [{ service: 'NodeosRPC', service_data: { chain_id: CHAINS.vaulta.chainIdHash } }] };
const response = (json: any, status = 200) => ({ status, text: async () => JSON.stringify(json),
  headers: { forEach: () => {} } }) as any;
const network = jest.mocked(fetchWithTimeout);
let switched: jest.Mock;
let candidates: jest.Mock;
function pool(kind: ReadNodeKind = 'rpc') {
  return new ReadNodePool('vaulta', kind, a, { candidates, onSwitch: switched });
}
beforeEach(() => {
  jest.clearAllMocks();
  switched = jest.fn(); candidates = jest.fn(async () => [a, b]);
});
afterEach(() => jest.useRealTimers());

test('caller cancellation stops a read without selecting another endpoint',async()=>{
  const controller=new AbortController();
  network.mockImplementation(async (_url,init)=>new Promise((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')));
  }));
  const pending=pool().read('/v1/chain/get_info',{signal:controller.signal});
  const assertion=expect(pending).rejects.toThrow('aborted');
  controller.abort();await assertion;
  expect(network).toHaveBeenCalledTimes(1);expect(candidates).not.toHaveBeenCalled();expect(switched).not.toHaveBeenCalled();
});

test('RPC connection failures retry the read on a verified same-chain node', async () => {
  network.mockImplementation(async (url: any) => {
    if (url.startsWith(a.url)) throw new Error('offline');
    return response(url.endsWith('/get_info') ? rpcInfo : { rows: [1] });
  });
  const result = await pool().read('/v1/chain/get_table_rows');
  expect(result.json.rows).toEqual([1]);
  expect(switched).toHaveBeenCalledTimes(1);
  expect(switched).toHaveBeenCalledWith('rpc', b);
});

test('a healthy history health endpoint cannot mask a broken token or actions endpoint', async () => {
  network.mockImplementation(async (url: any) => response(url.endsWith('/health') ? health
    : url.startsWith(a.url) ? {} : { tokens: [], actions: [] }));
  const client = new ChainClient('vaulta', a, a, { candidates, onSwitch: switched });
  expect(await client.getTokens('alice')).toEqual([]);
  expect(await client.getActions('alice')).toEqual({ actions: [], hasMore: false });
  expect(switched).toHaveBeenCalledWith('history', b);
  expect(network.mock.calls.filter(([url]) => String(url).includes('/v2/state/get_tokens'))).toHaveLength(2);
  expect(network.mock.calls.at(-1)![0]).toContain(b.url + '/v2/history/get_actions');
});

test.each([429, 500, 502, 503, 504])('HTTP %s endpoint errors select a replacement', async status => {
  network.mockImplementation(async (url: any) => url.startsWith(a.url) ? response({}, status) : response(rpcInfo));
  await pool().read('/v1/chain/get_info');
  expect(switched).toHaveBeenCalledWith('rpc', b);
});

test('structured nodeos business errors remain unchanged and do not switch nodes', async () => {
  network.mockResolvedValue(response({ error: { name: 'unknown_account', details: [{ message: 'unknown account' }] } }, 500));
  const result = await pool().read('/v1/chain/get_account');
  expect(result.status).toBe(500);
  expect(candidates).not.toHaveBeenCalled();
  expect(switched).not.toHaveBeenCalled();
});

test('rejects wrong-chain replacements before sending the account read', async () => {
  network.mockImplementation(async (url: any) => {
    if (url.startsWith(a.url)) throw new Error('offline');
    return response({ ...rpcInfo, chain_id: CHAINS.jungle4.chainIdHash });
  });
  await expect(pool().read('/v1/chain/get_account')).rejects.toThrow('offline');
  expect(network.mock.calls.some(([url]) => String(url).startsWith(b.url) && String(url).endsWith('/get_account'))).toBe(false);
  expect(switched).not.toHaveBeenCalled();
});

test('history replacements must report the expected chain ID', async () => {
  network.mockImplementation(async (url: any) => {
    if (url.startsWith(a.url)) throw new Error('offline');
    return response({ health: [{ service: 'NodeosRPC', service_data: { chain_id: CHAINS.jungle4.chainIdHash } }] });
  });
  await expect(pool('history').read('/v2/history/get_actions')).rejects.toThrow();
  expect(switched).not.toHaveBeenCalled();
});

test('concurrent failures share replacement discovery and announce the selection once', async () => {
  network.mockImplementation(async (url: any) => {
    if (url.startsWith(a.url)) throw new Error('offline');
    return response(rpcInfo);
  });
  const reader = pool();
  await Promise.all([reader.read('/v1/chain/get_account'), reader.read('/v1/chain/get_table_rows')]);
  expect(network.mock.calls.filter(([url]) => String(url).endsWith('/get_info'))).toHaveLength(1);
  expect(switched).toHaveBeenCalledTimes(1);
});

test('tries another candidate when its health works but its actual read is broken, without looping', async () => {
  candidates.mockResolvedValue([a, b, c]);
  network.mockImplementation(async (url: any) => {
    if (url.endsWith('/get_info')) return response(rpcInfo);
    if (!url.startsWith(c.url)) throw new Error('broken account API');
    return response({ rows: [] });
  });
  await expect(pool().read('/v1/chain/get_table_rows')).resolves.toMatchObject({ json: { rows: [] } });
  expect(switched).toHaveBeenCalledWith('rpc', c);
});

test('all nodes unavailable terminates without repeated selections', async () => {
  network.mockRejectedValue(new Error('offline'));
  await expect(pool().read('/v1/chain/get_info')).rejects.toThrow('offline');
  expect(network).toHaveBeenCalledTimes(2);
  expect(switched).not.toHaveBeenCalled();
});

test('a stalled response has a deadline and automatically falls back', async () => {
  jest.useFakeTimers();
  network.mockImplementation(async (url: any) => url.startsWith(a.url)
    ? new Promise(() => {}) : response(rpcInfo));
  const read = pool().read('/v1/chain/get_info');
  await jest.advanceTimersByTimeAsync(4000);
  await expect(read).resolves.toMatchObject({ json: rpcInfo });
  expect(switched).toHaveBeenCalledWith('rpc', b);
});

test('the pool refuses signed transaction broadcasts', async () => {
  await expect(pool().read('/v1/chain/push_transaction')).rejects.toThrow('Only chain reads');
  expect(network).not.toHaveBeenCalled();
});

test('ChainClient RPC reads use failover and preserve WharfKit request serialization', async () => {
  network.mockImplementation(async (url: any) => {
    if (url.startsWith(a.url)) throw new Error('offline');
    return response(url.endsWith('/get_info') ? rpcInfo : ['2.0000 A']);
  });
  const client = new ChainClient('vaulta', a, a, { candidates, onSwitch: switched });
  expect(await client.getBalance('core.vaulta', 'alice', 'A')).toMatchObject([{ amount: 2, symbol: 'A' }]);
  expect(JSON.parse(String(network.mock.calls.at(-1)![1]!.body))).toEqual({ code: 'core.vaulta', account: 'alice', symbol: 'A' });
  expect(switched).toHaveBeenCalledWith('rpc', b);
});

test.each(['vaulta', 'jungle4'] as const)('full RAM quote reads raw reserve units and includes chain fees on %s', async chainId => {
  network.mockResolvedValue(response({ rows: [{ base: { balance: '75027854801 RAM' },
    quote: { balance: '25419523.8353 EOS' } }] }));
  const client = new ChainClient(chainId, a);
  expect(await client.getRamQuote(1024)).toMatchObject({
    chainFee: `0.0018 ${CHAINS[chainId].symbol}`, total: `0.3486 ${CHAINS[chainId].symbol}`,
  });
  expect(JSON.parse(String(network.mock.calls.at(-1)![1]!.body))).toMatchObject({
    code: 'eosio', scope: 'eosio', table: 'rammarket', json: true, limit: 1,
  });
});

test('a missing RAM market never looks like a free RAM quote', async () => {
  network.mockResolvedValue(response({ rows: [] }));
  await expect(new ChainClient('vaulta', a).getRamQuote(1024)).rejects.toThrow('repair.ramQuoteUnavailable');
});
