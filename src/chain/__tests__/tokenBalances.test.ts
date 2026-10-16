import { readTokenBalances } from '../tokenBalances';
const token = (amount: number) => ({ contract: 'core.vaulta', symbol: 'A', precision: 4, amount, raw: `${amount}.0000 A` });
const client = () => ({ config: { systemToken: 'core.vaulta', symbol: 'A', precision: 4 },
  getTokens: jest.fn(async () => [token(8)]), getBalance: jest.fn(async (_contract: string, _account: string) => [token(2)]) }) as any;

test('ordinary balance updates share only in-flight bulk reads and do not make extra RPC requests', async () => {
  const rpc = client();
  await Promise.all([readTokenBalances(rpc, 'alice'), readTokenBalances(rpc, 'alice')]);
  expect(rpc.getTokens).toHaveBeenCalledTimes(1); expect(rpc.getBalance).not.toHaveBeenCalled();
  await readTokenBalances(rpc, 'alice'); expect(rpc.getTokens).toHaveBeenCalledTimes(2);
});
test('post-transfer refresh bypasses old reads and indexer lag using affected contracts', async () => {
  const rpc = client(); let finish!: (rows: any[]) => void;
  rpc.getTokens.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = readTokenBalances(rpc, 'alice'); await Promise.resolve();
  const usdt = { contract: 'tethertether', symbol: 'USDT', amount: 1, precision: 6, raw: '1.000000 USDT' };
  rpc.getBalance.mockImplementation(async (contract: string) => contract === 'core.vaulta' ? [token(2)] : [usdt]);
  const fresh = await readTokenBalances(rpc, 'alice', true, ['tethertether']);
  expect(fresh).toEqual([token(2), usdt]); expect(rpc.getTokens).toHaveBeenCalledTimes(2);
  finish([token(99)]); await old;
  expect(fresh).toEqual([token(2), usdt]);
});
test('confirmed zero RPC balances replace stale positive history balances', async () => {
  const rpc = client(); rpc.getBalance.mockResolvedValue([]);
  const fresh = await readTokenBalances(rpc, 'alice', true);
  expect(fresh[0]).toMatchObject({ symbol: 'A', amount: 0 });
});
test('an empty indexer response reuses the post-mutation native read instead of requesting it twice', async () => {
  const rpc = client(); rpc.getTokens.mockResolvedValue([]);
  expect(await readTokenBalances(rpc, 'alice', true)).toEqual([token(2)]);
  expect(rpc.getBalance).toHaveBeenCalledTimes(1);
});
