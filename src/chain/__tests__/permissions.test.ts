// paylimit 管理 action 的构建器:字段名/格式必须和合约 ABI(paylimit.cpp)一致,
// 拼错链上直接拒收;撤销的顺序(先解绑、再删 bot、最后删权限)也不能乱。
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

import {
  buildRemoveAssetActions,
  buildResetUsageActions,
  buildRevokeActions,
  buildSaveAssetActions,
  type AuthorizedApp,
} from '../permissions';
import { PAYLIMIT_CONTRACT } from '../../passkey/constants';

const app: AuthorizedApp = {
  permission: 'lolkmco31.tg',
  parent: 'active',
  managedByPayLimit: true,
  active: true,
  botIdHash: 'ab'.repeat(32),
  assets: [],
  threshold: 1,
  keys: 1,
  accounts: 1,
  linkedActions: 2,
};
const asset = { tokenContract: 'core.vaulta', symbol: 'A', precision: 4 };

it('resettotal:owner/bot_id_hash/代币三元组,symbol 用 "精度,符号" 格式', () => {
  expect(buildResetUsageActions({ account: 'alice', app, asset })).toEqual([
    {
      account: PAYLIMIT_CONTRACT,
      name: 'resettotal',
      data: { owner: 'alice', bot_id_hash: 'ab'.repeat(32), token_contract: 'core.vaulta', token_symbol: '4,A' },
    },
  ]);
});

it('delasset:和 resettotal 同一组参数', () => {
  const [action] = buildRemoveAssetActions({ account: 'alice', app, asset });
  expect(action.name).toBe('delasset');
  expect(action.data.token_symbol).toBe('4,A');
});

it('setlimit:每日/总预算按 (has_x, x) 成对给,单笔上限跟每日上限取同一个值', () => {
  const [action] = buildSaveAssetActions({ account: 'alice', app, asset, draft: { dailyLimit: '12.5', totalBudget: '' } });
  expect(action).toEqual({
    account: PAYLIMIT_CONTRACT,
    name: 'setlimit',
    data: {
      owner: 'alice',
      bot_id_hash: 'ab'.repeat(32),
      permission: 'lolkmco31.tg',
      token_contract: 'core.vaulta',
      token_symbol: '4,A',
      has_per_tx_limit: true,
      per_tx_limit: '12.5000 A',
      has_daily_limit: true,
      daily_limit: '12.5000 A',
      has_total_budget: false,
      total_budget: '0.0000 A',
    },
  });
});

it('setlimit:两项都没填——合约要求至少一项限额,本地就拒绝', () => {
  expect(() => buildSaveAssetActions({ account: 'alice', app, asset, draft: { dailyLimit: '', totalBudget: '0' } })).toThrow(
    'permission.limitRequired'
  );
});

it('setlimit:不是数字的输入拒绝', () => {
  expect(() => buildSaveAssetActions({ account: 'alice', app, asset, draft: { dailyLimit: 'abc', totalBudget: '' } })).toThrow(
    'permission.invalidAmount'
  );
});

it('没有 bot_id_hash 的权限拼不出 paylimit action', () => {
  expect(() => buildResetUsageActions({ account: 'alice', app: { ...app, botIdHash: undefined }, asset })).toThrow(
    'permission.missingBotId'
  );
});

it('撤销:逐条 unlinkauth → delbot → deleteauth,顺序不能乱', () => {
  const actions = buildRevokeActions({
    account: 'alice',
    app,
    linkedActions: [
      { contract: 'core.vaulta', action: 'transfer' },
      { contract: PAYLIMIT_CONTRACT, action: '' },
    ],
  });
  expect(actions.map((a) => `${a.account}::${a.name}`)).toEqual([
    'eosio::unlinkauth',
    'eosio::unlinkauth',
    `${PAYLIMIT_CONTRACT}::delbot`,
    'eosio::deleteauth',
  ]);
  expect(actions[0].data).toEqual({ account: 'alice', code: 'core.vaulta', type: 'transfer' });
  expect(actions[1].data).toEqual({ account: 'alice', code: PAYLIMIT_CONTRACT, type: '' });
  expect(actions[2].data).toEqual({ owner: 'alice', bot_id_hash: 'ab'.repeat(32) });
  expect(actions[3].data).toEqual({ account: 'alice', permission: 'lolkmco31.tg' });
});

it('撤销:不是 paylimit 管的权限没有 bot,跳过 delbot', () => {
  const actions = buildRevokeActions({ account: 'alice', app: { ...app, managedByPayLimit: false, botIdHash: undefined }, linkedActions: [] });
  expect(actions.map((a) => a.name)).toEqual(['deleteauth']);
});
