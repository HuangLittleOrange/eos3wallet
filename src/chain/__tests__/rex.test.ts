jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { ABI, Action, Serializer, Transaction } from '@wharfkit/antelope';
import { buildRexDeposit, buildRexSell, buildRexUnlock, buildRexWithdraw, buildRexCancel } from '../resourceActions';
import { decodeRexBalances, readRexBalances, rexAssetUnits, rexOperationError, rexQuantity } from '../rex';
import { coreActionAbi } from '../coreTokenAbi';
import { assertResolvedActionsMatch, decodeVisibleAction } from '../transactionSafety';
import { assertSponsoredTxMatchesIntent } from '../txIntentCheck';

const owner = 'alice';
const opts = { contract: 'core.vaulta', owner, symbol: 'A', precision: 4 };
const rows = () => [[{ owner, rex_balance: '200.0000 REX', matured_rex: '100000', rex_maturities: [
  { first: '2026-10-13T00:00:00', second: '400000' },
  { first: '2026-11-01T00:00:00', second: '500000' },
  { first: '2106-02-07T06:28:15', second: '1000000' },
] }], [{ owner, balance: '2.0000 EOS' }], [], [{ num_of_maturity_buckets: 21, sell_matured_rex: 1 }]] as any[][];
const state = () => decodeRexBalances(owner, Date.parse('2026-10-14T00:00:00Z'), rows(), '10.0000 A');
const tx = (actions: Action[]) => Transaction.from({ expiration: new Date(Date.now() + 60000).toISOString().slice(0,19), ref_block_num: 1, ref_block_prefix: 2, actions });

test('selling REX never implicitly withdraws the same numeric amount of A', () => {
  expect(buildRexSell({ ...opts, rexAmount: '125.125' })).toEqual([{ account: 'core.vaulta', name: 'sellrex', data: { from: owner, rex: '125.1250 REX' } }]);
  expect(buildRexWithdraw({ ...opts, amount: '0.3125' })).toEqual([{ account: 'core.vaulta', name: 'withdraw', data: { owner, amount: '0.3125 A' } }]);
  expect(() => buildRexWithdraw({ ...opts, rexAmount: 125 } as any)).toThrow();
});
test('deposit remains deposit A + buy REX; unlock and cancellation do not move A', () => {
  expect(buildRexDeposit({ ...opts, amount: '1.1234' }).map(a => [a.name, a.data.amount])).toEqual([['deposit', '1.1234 A'], ['buyrex', '1.1234 A']]);
  expect(buildRexUnlock({ ...opts, rexAmount: '2' })[0].data).toEqual({ owner, rex: '2.0000 REX' });
  expect(buildRexCancel(owner)).toEqual([{ account: 'eosio', name: 'cnclrexorder', data: { owner } }]);
});
test.each(['1.00001', '-1', '0', 'NaN', 'Infinity', '1e2', '1 A', '1.2junk', '', '9999999999999999'])('rejects invalid or lossy amount %s', value => {
  expect(() => rexQuantity(value, 'A')).toThrow();
  expect(() => buildRexWithdraw({ ...opts, amount: value })).toThrow();
});
test('large exact quantities never pass through a JavaScript float', () => {
  expect(rexQuantity('900719925474.0993', 'A')).toBe('900719925474.0993 A');
  expect(rexAssetUnits('900719925474.0993 A', 'A')).toBe(9007199254740993n);
  expect(() => rexAssetUnits('1.0000 REX', 'A')).toThrow();
});
test('matured, savings and core fund are distinct balances, including due buckets', () => {
  expect(state()).toMatchObject({ total: '200.0000 REX', available: '50.0000 REX', savings: '100.0000 REX', fund: '2.0000 A', maturityDays: 21 });
  expect(state().maturities).toEqual([{ at: '2026-11-01T00:00:00.000Z', quantity: '50.0000 REX' }]);
});
test('open queued sales cannot be sold again; filled proceeds can be withdrawn', () => {
  const r = rows(); r[2] = [{ owner, rex_requested: '30.0000 REX', proceeds: '0.5000 EOS', is_open: true }];
  const pending = decodeRexBalances(owner, Date.parse('2026-10-14T00:00:00Z'), r, '10.0000 A');
  expect(pending.available).toBe('20.0000 REX'); expect(pending.fund).toBe('2.0000 A');
  expect(rexOperationError('sell','20',pending)).toBe('rex.pending');
  r[2][0].is_open = false;
  expect(decodeRexBalances(owner, Date.now(), r, '10.0000 A').fund).toBe('2.5000 A');
});
test('caps use the asset actually spent, and sell-all changes require new review', () => {
  const s = state();
  expect(rexOperationError('sell','50',s)).toBeNull();
  expect(rexOperationError('sell','40',s)).toBe('rex.insufficient');
  expect(rexOperationError('withdraw','2.0001',s)).toBe('rex.insufficient');
  expect(rexOperationError('unlock','100.0001',s)).toBe('rex.insufficient');
  expect(rexOperationError('buy','10.0001',s)).toBe('rex.insufficient');
  expect(rexOperationError('withdraw','0.3125',s)).toBeNull();
});
test('RPC balance reads are owner-bounded and reject another network', async () => {
  const r = rows();
  const client: any = { config: { chainIdHash: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906', resourceContract: 'core.vaulta', symbol: 'A' },
    getInfo: jest.fn(async () => ({ chainId: client.config.chainIdHash, chainTime: '2026-10-14T00:00:00Z' })),
    getBalance: jest.fn(async () => [{ raw: '10.0000 A' }]), getTableRows: jest.fn(async ({ table }) => ({ rows: r[['rexbal','rexfund','rexqueue','rexmaturity'].indexOf(table)] })) };
  await expect(readRexBalances(client, owner)).resolves.toMatchObject({ fund: '2.0000 A' });
  expect(client.getTableRows).toHaveBeenCalledWith(expect.objectContaining({ table: 'rexfund', lower_bound: owner, upper_bound: owner, key_type: 'name' }));
  client.getInfo.mockResolvedValue({ chainId: 'other' });
  await expect(readRexBalances(client, owner)).rejects.toThrow();
  r[0][0].owner = 'bob';
  expect(() => decodeRexBalances(owner, Date.now(), r, '10.0000 A')).toThrow();
});
test('REX canonical bytes match the confirmed operation at the final local signing boundary', () => {
  const plans = [buildRexDeposit({ ...opts, amount:'1' }), buildRexUnlock({ ...opts, rexAmount:'2' }), buildRexSell({ ...opts, rexAmount:'50' }), buildRexWithdraw({ ...opts, amount:'0.3125' }), buildRexCancel(owner)];
  for (const plan of plans) {
    const actual = plan.map(a => Action.from({ ...a, authorization: [{ actor: owner, permission: 'active' }] }, coreActionAbi(a.account,a.name)!));
    expect(() => assertResolvedActionsMatch(tx(actual), plan, owner, 'active')).not.toThrow();
  }
  const expected = buildRexWithdraw({ ...opts, amount:'0.3125' });
  const changed = Action.from({ ...expected[0], data: { owner, amount:'50.0000 A' }, authorization:[{actor:owner,permission:'active'}] },coreActionAbi(opts.contract,'withdraw')!);
  expect(() => assertResolvedActionsMatch(tx([changed]),expected,owner,'active')).toThrow('differs');
});
test('a malicious RPC ABI cannot reinterpret reviewed REX amount bytes for local or sponsor signing', async () => {
  const expected = buildRexWithdraw({ ...opts, amount:'0.3125' });
  const malicious = ABI.from({ structs:[{name:'withdraw',base:'',fields:[{name:'amount',type:'asset'},{name:'owner',type:'name'}]}],actions:[{name:'withdraw',type:'withdraw',ricardian_contract:''}] });
  const actual = Action.from({ ...expected[0],authorization:[{actor:owner,permission:'active'}] },malicious);
  expect(() => assertResolvedActionsMatch(tx([actual]),expected,owner,'active')).toThrow();
  await expect(assertSponsoredTxMatchesIntent({ serializedTransaction: Serializer.encode({object:tx([actual])}).hexString, actor:owner,permission:'active',userActions:expected,feeTokenContract:'core.vaulta',getAbi:async()=>malicious })).rejects.toThrow();
  expect(() => decodeVisibleAction(actual,malicious)).toThrow();
});
