jest.mock('../../chain/signingAbi', () => ({ getSigningAbi: jest.fn() }));
import { ABI, Serializer, Transaction } from '@wharfkit/antelope';
import { getSigningAbi } from '../../chain/signingAbi';
import { CHAINS } from '../../chain/config';
import { decodeSerializedTransaction } from '../decodeTx';

const abi = ABI.from({ version: 'eosio::abi/1.2', types: [], structs: [
  { name: 'transfer', base: '', fields: [{ name: 'from', type: 'name' }, { name: 'to', type: 'name' }, { name: 'quantity', type: 'asset' }, { name: 'memo', type: 'string' }] },
], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }], tables: [], ricardian_clauses: [], variants: [] });
function encoded(overrides: Record<string, any> = {}) {
  const tx = Transaction.from({
    expiration: new Date(Date.now() + 120_000).toISOString().split('.')[0],
    ref_block_num: 1, ref_block_prefix: 1, max_net_usage_words: 0, max_cpu_usage_ms: 0, delay_sec: 0,
    context_free_actions: [], transaction_extensions: [],
    actions: [{ account: 'eosio.token', name: 'transfer', authorization: [{ actor: 'alice', permission: 'owner' }, { actor: 'bob', permission: 'active' }],
      data: Serializer.encode({ object: { from: 'alice', to: 'bob', quantity: '1.0000 EOS', memo: 'test' }, type: 'transfer', abi }).hexString }],
    ...overrides,
  });
  return Serializer.encode({ object: tx }).hexString;
}
beforeEach(() => { jest.resetAllMocks(); (getSigningAbi as jest.Mock).mockResolvedValue(abi); });
test('preserves every actual authorization and decoded field for confirmation', async () => {
  const decoded = await decodeSerializedTransaction(encoded(), { nodeUrl: 'https://rpc.example', actor: 'alice', chainId: CHAINS.vaulta.chainIdHash });
  expect(decoded.permission).toBe('owner');
  expect(decoded.actions[0].authorization).toEqual([{ actor: 'alice', permission: 'owner' }, { actor: 'bob', permission: 'active' }]);
  expect(decoded.actions[0].data.quantity).toBe('1.0000 EOS');
});
test('rejects undecodable actions instead of offering a blind signature', async () => {
  (getSigningAbi as jest.Mock).mockRejectedValue(new Error('offline'));
  await expect(decodeSerializedTransaction(encoded(), { nodeUrl: 'https://rpc.example', actor: 'alice', chainId: CHAINS.vaulta.chainIdHash })).rejects.toThrow('Cannot decode');
});
test('third-party token confirmation shows the real wire recipient using a corroborated ABI', async () => {
  const { Action } = require('@wharfkit/antelope');
  const malicious = ABI.from({ structs: [{ name: 'transfer', base: '', fields: [
    { name: 'from', type: 'name' }, { name: 'memo', type: 'name' }, { name: 'quantity', type: 'asset' }, { name: 'to', type: 'string' },
  ] }], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });
  const action = Action.from({ account: 'other.token', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }],
    data: { from: 'alice', to: 'bob', quantity: '1.0000 EOS', memo: 'attacker' } }, malicious);
  const decoded = await decodeSerializedTransaction(encoded({ actions: [action] }),
    { nodeUrl: 'https://evil.invalid', actor: 'alice', chainId: CHAINS.vaulta.chainIdHash });
  expect(decoded.actions[0].data.to).toBe('attacker');
  expect(getSigningAbi).toHaveBeenCalledWith(CHAINS.vaulta.chainIdHash, 'other.token');
});
test.each([
  { delay_sec: 1 },
  { actions: [] },
  { expiration: '2020-01-01T00:00:00' },
  { expiration: '2099-01-01T00:00:00' },
  { transaction_extensions: [{ type: 0, data: '00' }] },
])('rejects hidden/unsupported or expired fields: %j', async (fields) => {
  await expect(decodeSerializedTransaction(encoded(fields), { nodeUrl: 'https://rpc.example', actor: 'alice', chainId: CHAINS.vaulta.chainIdHash })).rejects.toThrow();
});
