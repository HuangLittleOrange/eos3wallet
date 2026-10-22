// The confirmation must show the exact names that get encoded. `Name.from()`
// silently maps every character outside [a-z1-5] to '.', so a DApp can display
// "alice-smith" while the signed bytes contain "alice.smith".
import { ABI, Action, Transaction } from '@wharfkit/antelope';

import { assertResolvedActionsMatch } from '../transactionSafety';
import type { ActionSpec } from '../transact';

const transferAbi = ABI.from({
  structs: [{
    name: 'transfer',
    base: '',
    fields: [
      { name: 'from', type: 'name' },
      { name: 'to', type: 'name' },
      { name: 'quantity', type: 'asset' },
      { name: 'memo', type: 'string' },
    ],
  }],
  actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
});

function build(to: string): { transaction: Transaction; spec: ActionSpec } {
  const data = { from: 'alice', to, quantity: '1.0000 A', memo: '' };
  const action = Action.from({
    account: 'core.vaulta', name: 'transfer',
    authorization: [{ actor: 'alice', permission: 'active' }], data,
  }, transferAbi);
  const transaction = Transaction.from({
    expiration: new Date(Date.now() + 120_000).toISOString().split('.')[0],
    ref_block_num: 0,
    ref_block_prefix: 0,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions: [action],
    transaction_extensions: [],
  });
  return { transaction, spec: { account: 'core.vaulta', name: 'transfer', data } };
}

test('a displayed recipient that Name.from would rewrite is rejected', () => {
  const { transaction, spec } = build('alice-smith');
  // The bytes really say alice.smith; the sheet says alice-smith.
  expect(() => assertResolvedActionsMatch(transaction, [spec], 'alice', 'active'))
    .toThrow('Action name would be rewritten');
});

test('the same coercion through a space is rejected too', () => {
  const { transaction, spec } = build('alice smith');
  expect(() => assertResolvedActionsMatch(transaction, [spec], 'alice', 'active'))
    .toThrow('Action name would be rewritten');
});

test('an exact name is accepted', () => {
  const { transaction, spec } = build('alice.smith');
  expect(() => assertResolvedActionsMatch(transaction, [spec], 'alice', 'active')).not.toThrow();
});

test('a normal account name is accepted', () => {
  const { transaction, spec } = build('bob');
  expect(() => assertResolvedActionsMatch(transaction, [spec], 'alice', 'active')).not.toThrow();
});
