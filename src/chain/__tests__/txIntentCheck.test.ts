// 签名前意图核对的单测——重点是攻击场景:服务端(被攻破时)夹带、篡改、
// 抽走 action,每一种都必须拒签;服务端诚实时必须静默通过,不能误杀。
jest.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { ABI, Action, Serializer, Transaction } from '@wharfkit/antelope';

import { assertSponsoredTxMatchesIntent, TxIntentMismatchError } from '../txIntentCheck';
import type { ActionSpec } from '../transact';

const tokenAbi = ABI.from({
  structs: [
    {
      name: 'transfer',
      base: '',
      fields: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' },
      ],
    },
  ],
  actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
});

const noopAbi = ABI.from({
  structs: [{ name: 'noop', base: '', fields: [] }],
  actions: [{ name: 'noop', type: 'noop', ricardian_contract: '' }],
});

const getAbi = async (account: string) => (account === 'eosio.token' ? tokenAbi : noopAbi);

/** 模拟服务端拼交易:把 action 列表编码成待签名的原始字节(hex) */
function encodeTx(actions: Action[]): string {
  const tx = Transaction.from({
    expiration: new Date(Date.now() + 120_000).toISOString().split('.')[0],
    ref_block_num: 0,
    ref_block_prefix: 0,
    max_net_usage_words: 0,
    max_cpu_usage_ms: 0,
    delay_sec: 0,
    context_free_actions: [],
    actions,
    transaction_extensions: [],
  });
  return Serializer.encode({ object: tx }).hexString;
}

function transferAct(data: Record<string, string>, auth = [{ actor: 'alice', permission: 'active' }]): Action {
  return Action.from({ account: 'eosio.token', name: 'transfer', authorization: auth, data }, tokenAbi);
}

const noopAct = Action.from(
  { account: 'paycpu', name: 'noop', authorization: [{ actor: 'paycpu', permission: 'active' }], data: {} },
  noopAbi
);

const userSpec: ActionSpec = {
  account: 'eosio.token',
  name: 'transfer',
  data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' },
};
const userAct = transferAct(userSpec.data as Record<string, string>);
const feeData = { from: 'alice', to: 'feecollect', quantity: '0.0100 A', memo: 'fee' };

const baseOpts = {
  actor: 'alice',
  permission: 'active',
  userActions: [userSpec],
  feeTokenContract: 'eosio.token',
  getAbi,
};
const paidOpts = { ...baseOpts, sponsorFee: '0.0100 A', sponsorFeeReceiver: 'feecollect' };

test('backend cannot reorder user actions even when every individual action matches', async () => {
  const second = { ...userSpec, data: { ...userSpec.data, to: 'carol' } };
  await expect(assertSponsoredTxMatchesIntent({ ...baseOpts, userActions: [userSpec, second],
    serializedTransaction: encodeTx([noopAct, transferAct(second.data), userAct]) })).rejects.toBeInstanceOf(TxIntentMismatchError);
});
test('fee cannot silently require owner or duplicate authorizations', async () => {
  for (const auth of [[{ actor: 'alice', permission: 'owner' }],
    [{ actor: 'alice', permission: 'active' }, { actor: 'alice', permission: 'owner' }]]) {
    await expect(assertSponsoredTxMatchesIntent({ ...paidOpts,
      serializedTransaction: encodeTx([noopAct, userAct, transferAct(feeData, auth)]) })).rejects.toThrow('feeMismatch');
  }
});
test.each([{ delay_sec: 1 }, { transaction_extensions: [{ type: 0, data: '00' }] },
  { expiration: '2020-01-01T00:00:00' }, { expiration: '2099-01-01T00:00:00' }])('rejects undisplayed or invalid header fields: %j', async (fields) => {
  const original = Serializer.decode({ data: encodeTx([noopAct, userAct]), type: Transaction });
  const changed = Transaction.from({ ...Serializer.objectify(original), ...fields });
  await expect(assertSponsoredTxMatchesIntent({ ...baseOpts,
    serializedTransaction: Serializer.encode({ object: changed }).hexString })).rejects.toBeInstanceOf(TxIntentMismatchError);
});

describe('assertSponsoredTxMatchesIntent', () => {
  it('免费项目:noop + 用户确认过的 action,原样通过', async () => {
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, userAct]) })
    ).resolves.toBeUndefined();
  });

  it('收费项目:noop + 用户 action + 与报价一致的手续费,通过', async () => {
    await expect(
      assertSponsoredTxMatchesIntent({
        ...paidOpts,
        serializedTransaction: encodeTx([noopAct, userAct, transferAct(feeData)]),
      })
    ).resolves.toBeUndefined();
  });

  it('夹带一条用户没确认过的转账:拒签', async () => {
    const evil = transferAct({ from: 'alice', to: 'attacker', quantity: '9999.0000 A', memo: '' });
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, userAct, evil]) })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
  });

  it('用户 action 的内容被篡改(金额不同):拒签', async () => {
    const tampered = transferAct({ ...feeData, from: 'alice', to: 'bob', quantity: '9999.0000 A', memo: '' });
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, tampered]) })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
  });

  it('用户 action 被换成别的权限(owner)签:拒签', async () => {
    const ownerAuth = transferAct(userSpec.data as Record<string, string>, [{ actor: 'alice', permission: 'owner' }]);
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, ownerAuth]) })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
  });

  it('用户确认过的 action 被服务端抽掉:拒签', async () => {
    await expect(
      assertSponsoredTxMatchesIntent({
        ...paidOpts,
        serializedTransaction: encodeTx([noopAct, transferAct(feeData)]),
      })
    ).rejects.toThrow('txCheck.missingAction');
  });

  it('手续费金额和报价不一致:拒签', async () => {
    const inflated = transferAct({ ...feeData, quantity: '5.0000 A' });
    await expect(
      assertSponsoredTxMatchesIntent({
        ...paidOpts,
        serializedTransaction: encodeTx([noopAct, userAct, inflated]),
      })
    ).rejects.toThrow('txCheck.feeMismatch');
  });

  it('免费项目却冒出手续费转账:拒签', async () => {
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, userAct, transferAct(feeData)]) })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
  });

  it('同一条用户 action 被复制两份(一份可能垫背另一份被换):拒签', async () => {
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, userAct, userAct]) })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
  });

  it('sponsor 自己授权的 noop 不带用户授权,不参与核对', async () => {
    // noop 排在哪、有几条都无所谓——它用不了用户的权限
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, userAct, noopAct]) })
    ).resolves.toBeUndefined();
  });

  it('无授权的 action 不能冒充 sponsor 自己的 action 混进来', async () => {
    const noAuth = Action.from({
      account: 'eosio.token', name: 'transfer', authorization: [], data: feeData,
    }, tokenAbi);
    await expect(
      assertSponsoredTxMatchesIntent({ ...baseOpts, serializedTransaction: encodeTx([noopAct, userAct, noAuth]) })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
  });
});
