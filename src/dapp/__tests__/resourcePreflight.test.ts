jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));

import { Transaction } from '@wharfkit/antelope';
import { preflightDappResources } from '../resourcePreflight';
import { CpuNetExhaustedError } from '../../chain/sponsor';

const tx = (actors = ['alice']) => Transaction.from({
  expiration: '2099-01-01T00:00:00', ref_block_num: 1, ref_block_prefix: 2,
  actions: actors.map((actor) => ({
    account: 'eosio.token', name: 'transfer', authorization: [{ actor, permission: 'active' }], data: '00',
  })),
});
const opts = () => ({ transaction: tx(), actor: 'alice', nodeUrl: 'https://node.invalid/' });
const respond = (cpu: number, net = 1000, max = 1000) => {
  (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    cpu_limit: { max, available: cpu }, net_limit: { max, available: net },
  }) });
};

it('只签名请求 CPU 不足也抛修复错误,不广播交易', async () => {
  respond(0);
  await expect(preflightDappResources(opts())).rejects.toBeInstanceOf(CpuNetExhaustedError);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(jest.mocked(fetch).mock.calls[0][0]).toBe('https://node.invalid/v1/chain/get_account');
});

it('NET 连交易字节都容纳不下时也修复', async () => {
  respond(1000, 0);
  await expect(preflightDappResources(opts())).rejects.toBeInstanceOf(CpuNetExhaustedError);
});

it('正常额度和无限额度都放行', async () => {
  respond(1000);
  await expect(preflightDappResources(opts())).resolves.toBeUndefined();
  respond(-1, -1, -1);
  await expect(preflightDappResources(opts())).resolves.toBeUndefined();
});

it('DApp 已附加其他授权/代付和身份交易不触发充值检查', async () => {
  respond(0);
  await preflightDappResources({ ...opts(), transaction: tx(['sponsor', 'alice']) });
  await preflightDappResources({ ...opts(), transaction: tx([]) });
  expect(fetch).not.toHaveBeenCalled();
});

it('网络失败或接口不支持不妨碍签名', async () => {
  (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('offline'));
  await expect(preflightDappResources(opts())).resolves.toBeUndefined();
  (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: false });
  await expect(preflightDappResources(opts())).resolves.toBeUndefined();
});
