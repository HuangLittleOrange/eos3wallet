jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
import { ABI, Action, Serializer, Transaction } from '@wharfkit/antelope';
import { assertResolvedActionsMatch, decodeVisibleAction } from '../transactionSafety';
import { coreTransferAbi } from '../coreTokenAbi';

const expected = { account: 'core.vaulta', name: 'transfer', data: {
  from: 'alice', to: 'bob', quantity: '1.0000 A', memo: 'attacker',
} };
const abi = coreTransferAbi(expected.account, expected.name)!;
const auth = [{ actor: 'alice', permission: 'active' }];
const tx = (action: Action) => Transaction.from({ expiration: new Date(Date.now() + 120_000).toISOString().split('.')[0],
  ref_block_num: 1, ref_block_prefix: 2, actions: [action] });

test('confirmed system-token transfers keep the exact canonical byte encoding', () => {
  expect(() => assertResolvedActionsMatch(tx(Action.from({ ...expected, authorization: auth }, abi)), [expected], 'alice', 'active')).not.toThrow();
});
test('a malicious RPC ABI cannot replace the recipient with memo text during local signing', () => {
  const maliciousAbi = ABI.from({ structs: [{ name: 'transfer', base: '', fields: [
    { name: 'from', type: 'name' }, { name: 'memo', type: 'name' }, { name: 'quantity', type: 'asset' }, { name: 'to', type: 'string' },
  ] }], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });
  const action = Action.from({ ...expected, authorization: auth }, maliciousAbi);
  expect(() => assertResolvedActionsMatch(tx(action), [expected], 'alice', 'active')).toThrow('differs');
  // For a pre-serialized DApp request the confirmation must show the real wire recipient.
  expect(decodeVisibleAction(action, maliciousAbi).to).toBe('attacker');
});
test('partial ABI decoding cannot hide trailing action bytes', () => {
  const action = Action.from({ account: 'other.token', name: 'transfer', data: expected.data, authorization: auth }, abi);
  const partial = ABI.from({ structs: [{ name: 'transfer', base: '', fields: [{ name: 'from', type: 'name' }] }],
    actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });
  expect(() => decodeVisibleAction(action, partial)).toThrow('Incomplete');
});
test('changed permissions and inserted actions cannot bypass the last signing boundary', () => {
  const owner = Action.from({ ...expected, authorization: [{ actor: 'alice', permission: 'owner' }] }, abi);
  expect(() => assertResolvedActionsMatch(tx(owner), [expected], 'alice', 'active')).toThrow('authorization');
  expect(() => assertResolvedActionsMatch(tx(owner), [], 'alice', 'owner')).toThrow('actions');
});

test('every unpinned action needs a verified schema, including custom contracts and NFT transfers', () => {
  const nft = ABI.from({ structs: [{ name: 'transfer', base: '', fields: [
    { name: 'sender', type: 'name' }, { name: 'recipient', type: 'name' },
    { name: 'asset_ids', type: 'uint64[]' }, { name: 'memo', type: 'string' },
  ] }], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });
  const spec = { account: 'atomicassets', name: 'transfer', data: { sender: 'alice', recipient: 'bob', asset_ids: ['123'], memo: '' } };
  const action = Action.from({ ...spec, authorization: auth }, nft);
  expect(() => assertResolvedActionsMatch(tx(action), [spec], 'alice', 'active')).toThrow('Unverified');
  expect(() => assertResolvedActionsMatch(tx(action), [spec], 'alice', 'active', new Map([[spec.account, nft]]))).not.toThrow();
  expect(() => assertResolvedActionsMatch(tx(action), [{ ...spec, data: { ...spec.data, recipient: 'carol' } }],
    'alice', 'active', new Map([[spec.account, nft]]))).toThrow('differs');
});
