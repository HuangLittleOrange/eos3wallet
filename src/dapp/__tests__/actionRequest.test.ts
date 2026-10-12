import { assertActionRequestChain, prepareActionRequest } from '../actionRequest';
const action = { account: 'eosio.token', name: 'transfer', data: {
  from: 'alice', to: 'bob', quantity: '1.0000 EOS', memo: '',
} };
test('displays the exact permission applied to every broadcast action, using a data snapshot', () => {
  const explicit = { ...action, authorization: [{ actor: 'alice', permission: 'owner' }] };
  const prepared = prepareActionRequest([explicit, action], 'alice', 'active');
  expect(prepared.permission).toBe('owner');
  expect(prepared.actions.every((a) => a.authorization?.[0].permission === 'owner')).toBe(true);
  explicit.data.to = 'carol'; expect(prepared.actions[0].data.to).toBe('bob'); action.data.to = 'bob';
});
test.each([
  [{ ...action, authorization: [{ actor: 'alice', permission: 'active' }] }, { ...action, authorization: [{ actor: 'alice', permission: 'owner' }] }],
  [{ ...action, authorization: [{ actor: 'bob', permission: 'active' }] }],
  [{ ...action, authorization: [{ actor: 'alice', permission: 'active' }, { actor: 'bob', permission: 'active' }] }],
  [{ ...action, account: 'EOSIO.token' }],
  [{ ...action, name: 'transfer9' }],
  [{ ...action, data: '00' }],
  [null, action],
])('rejects ambiguous, silently rewritten or blind requests: %j', (...actions) => {
  expect(() => prepareActionRequest(actions, 'alice', 'active')).toThrow();
});
test('legacy code/action/args aliases and implicit wallet authorization remain supported', () => {
  const prepared = prepareActionRequest({ code: 'eosio.token', action: 'transfer', args: action.data }, 'alice', 'active');
  expect(prepared.actions[0].authorization).toEqual([{ actor: 'alice', permission: 'active' }]);
});
test('checks direct and nested chain declarations including conflicting declarations', () => {
  expect(() => assertActionRequestChain({}, 'aa')).not.toThrow();
  expect(() => assertActionRequestChain({ payload: { network: { chainId: 'AA' } } }, 'aa')).not.toThrow();
  expect(() => assertActionRequestChain({ payload: { network: { chainId: 'bb' } } }, 'aa')).toThrow();
  expect(() => assertActionRequestChain({ chainId: 'aa', payload: { transaction: { chainId: 'bb' } } }, 'aa')).toThrow();
});
