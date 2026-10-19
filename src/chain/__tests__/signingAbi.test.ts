jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: (...args: any[]) => require('../../net/fetchRetry').fetchWithRetry(...args) }));
import { ABI, Serializer } from '@wharfkit/antelope';
import { CHAINS } from '../config';
import { fetchWithRetry } from '../../net/fetchRetry';
import { getSigningAbi, invalidateSigningAbi } from '../signingAbi';
import { coreTransferAbi } from '../coreTokenAbi';
import { rpcResponse, stalledRpcResponse } from './rpcResponse';

const chainId = CHAINS.vaulta.chainIdHash;
const honest = coreTransferAbi('core.vaulta', 'transfer')!;
const evil = ABI.from({ structs: [{ name: 'transfer', base: '', fields: [
  { name: 'from', type: 'name' }, { name: 'memo', type: 'name' }, { name: 'quantity', type: 'asset' }, { name: 'to', type: 'string' },
] }], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });
const fakeFetch = jest.mocked(fetchWithRetry);
function serve(choose: (url: string) => ABI = () => honest, infoChain = chainId) {
  fakeFetch.mockImplementation(async (input, init) => {
    const url = String(input);
    const data = url.endsWith('/get_info') ? { chain_id: infoChain }
      : { account_name: JSON.parse(String(init?.body)).account_name, abi: Serializer.objectify(choose(url)) };
    return rpcResponse(data);
  });
}
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

test('one malicious built-in RPC cannot outvote two independent honest schemas', async () => {
  serve(url => url.startsWith(CHAINS.vaulta.nodes[0].url + '/') ? evil : honest);
  const abi = await getSigningAbi(chainId, 'quorum.token');
  expect(Serializer.encode({ object: abi }).hexString).toBe(Serializer.encode({ object: honest }).hexString);
  const urls = fakeFetch.mock.calls.map(([url]) => String(url));
  expect(new Set(urls.map(url => new URL(url).hostname)).size).toBeGreaterThanOrEqual(3);
  expect(urls.every(url => CHAINS.vaulta.nodes.some(node => url.startsWith(node.url + '/')))).toBe(true);
  expect(fakeFetch.mock.calls.every(([,init]) => init?.credentials === 'omit' && init?.redirect === 'error')).toBe(true);
});
test('distinct schemas never get accepted on a mere successful RPC response', async () => {
  serve(url => ABI.from({ structs: [{ name: 'unique', base: '', fields: [{ name: 'value' + CHAINS.vaulta.nodes.findIndex(n => url.startsWith(n.url + '/')), type: 'string' }] }] }));
  await expect(getSigningAbi(chainId, 'noquorum')).rejects.toThrow('txCheck.unverifiedAbi');
});
test('wrong-chain replies and wrong-account ABIs do not count as votes', async () => {
  serve(() => honest, CHAINS.jungle4.chainIdHash);
  await expect(getSigningAbi(chainId, 'wrongchain')).rejects.toThrow('unverifiedAbi');
  fakeFetch.mockImplementation(async (url) => rpcResponse(String(url).endsWith('/get_info') ? { chain_id: chainId }
    : { account_name: 'different', abi: Serializer.objectify(honest) }));
  await expect(getSigningAbi(chainId, 'wrongaccount')).rejects.toThrow('unverifiedAbi');
});
test('offline sources fall back to other built-in hosts; verified concurrent reads are cached and invalidatable', async () => {
  serve();
  const working = fakeFetch.getMockImplementation()!;
  fakeFetch.mockImplementation((...args) => String(args[0]).startsWith(CHAINS.vaulta.nodes[0].url + '/')
    ? Promise.reject(new Error('offline')) : working(...args));
  const [a,b] = await Promise.all([getSigningAbi(chainId, 'cachedtoken'),getSigningAbi(chainId, 'cachedtoken')]);
  expect(a).toBe(b);
  const count = fakeFetch.mock.calls.length;
  await getSigningAbi(chainId, 'cachedtoken'); expect(fakeFetch).toHaveBeenCalledTimes(count);
  invalidateSigningAbi(chainId, 'cachedtoken'); await getSigningAbi(chainId, 'cachedtoken');
  expect(fakeFetch.mock.calls.length).toBeGreaterThan(count);
});
test('failed verification is not cached; unknown chains and oversized replies fail closed', async () => {
  fakeFetch.mockRejectedValue(new Error('offline'));
  await expect(getSigningAbi(chainId, 'recoverable')).rejects.toThrow('unverifiedAbi');
  serve(); await expect(getSigningAbi(chainId, 'recoverable')).resolves.toBeInstanceOf(ABI);
  await expect(getSigningAbi('aa'.repeat(32), 'unknown')).rejects.toThrow('unverifiedAbi');
  fakeFetch.mockResolvedValue({ ok: true, headers: { get: () => String(3 * 1024 * 1024) }, text: jest.fn() } as any);
  await expect(getSigningAbi(chainId, 'oversized')).rejects.toThrow('unverifiedAbi');
});
test('a bounded deadline covers sources that never settle, including stalled response bodies', async () => {
  jest.useFakeTimers();
  fakeFetch.mockImplementation(async () => stalledRpcResponse());
  const result = expect(getSigningAbi(chainId, 'stalled')).rejects.toThrow('unverifiedAbi');
  await jest.advanceTimersByTimeAsync(12_001);
  await result;
});
test('Jungle schemas use only the Jungle trust anchors', async () => {
  serve(() => honest, CHAINS.jungle4.chainIdHash);
  await getSigningAbi(CHAINS.jungle4.chainIdHash, 'jungletoken');
  expect(fakeFetch.mock.calls.every(([url]) => CHAINS.jungle4.nodes.some(node => String(url).startsWith(node.url + '/')))).toBe(true);
});
