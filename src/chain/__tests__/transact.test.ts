// transact():只直连、不预检、不自动转代付——资源类失败带专门的 Error 子类抛出,
// 好让 UI 弹一键修复。sponsoredTransact():修复交易走 Sponsor 的路,重点是
// "报价必须等于用户点头过的""意图过期自动重 build"。链和 Sponsor 网络层全部
// mock,只测分支走向和传参。
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

const mockSessionTransact = jest.fn();
jest.mock('@wharfkit/session', () => {
  const actual = jest.requireActual('@wharfkit/session');
  return {
    ...actual,
    Session: jest.fn().mockImplementation(() => ({
      permissionLevel: { actor: 'alice', permission: 'active' },
      transact: (...args: unknown[]) => mockSessionTransact(...args),
    })),
  };
});

jest.mock('../sponsor', () => ({
  ...jest.requireActual('../sponsor'),
  requestSponsoredBuild: jest.fn(),
  signAndPushSponsored: jest.fn(),
}));

import { PrivateKey } from '@wharfkit/antelope';
import { getCachedSponsorFee } from '../sponsorFeeCache';
import { sponsoredTransact, transact, type ActionSpec, type Signer } from '../transact';
import {
  CpuNetExhaustedError,
  RamExhaustedError,
  SponsorFeeChangedError,
  requestSponsoredBuild,
  signAndPushSponsored,
  type SponsoredBuildResult,
} from '../sponsor';

const mockBuild = requestSponsoredBuild as jest.MockedFunction<typeof requestSponsoredBuild>;
const mockPush = signAndPushSponsored as jest.MockedFunction<typeof signAndPushSponsored>;

const signer: Signer = { kind: 'privatekey', privateKey: String(PrivateKey.generate('K1')) };
const transfer: ActionSpec = {
  account: 'core.vaulta',
  name: 'transfer',
  data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' },
};
const baseOpts = {
  chainId: 'vaulta' as const,
  node: { url: 'https://unused.invalid', name: 'x' } as any,
  actor: 'alice',
  signer,
  permission: 'active',
  actions: [transfer],
};
const build = (extra: Partial<SponsoredBuildResult> = {}): SponsoredBuildResult => ({
  sponsorRequestId: 'req-1',
  projectId: 'p',
  account: 'alice',
  reference: 'wallet:1',
  serializedTransaction: 'deadbeef',
  transaction: {},
  status: 'pending',
  expiresAt: '2099-01-01T00:00:00.000Z',
  ...extra,
});
const cpuError = new Error('transaction exceeded the current CPU usage limit imposed on the transaction');

beforeEach(() => {
  jest.clearAllMocks();
  mockPush.mockResolvedValue({ txId: 'b'.repeat(64), signature: 'SIG_K1_sponsored' });
});

describe('transact', () => {
  it('直接广播成功,不碰 Sponsor', async () => {
    mockSessionTransact.mockResolvedValue({ resolved: { transaction: { id: 'a'.repeat(64) } }, response: {} });
    const res = await transact(baseOpts);
    expect(res.txId).toBe('a'.repeat(64));
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('CPU/NET 不够:抛 CpuNetExhaustedError(带可读文案),不自动转代付', async () => {
    mockSessionTransact.mockRejectedValue(cpuError);
    const err = await transact(baseOpts).catch((e) => e);
    expect(err).toBeInstanceOf(CpuNetExhaustedError);
    expect(err.message).toBe('sponsorError.cpuNetInsufficient');
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('RAM 不够:抛 RamExhaustedError', async () => {
    mockSessionTransact.mockRejectedValue(new Error('account alice has insufficient ram; needs 300 bytes'));
    const err = await transact(baseOpts).catch((e) => e);
    expect(err).toBeInstanceOf(RamExhaustedError);
    expect(err.message).toBe('sponsorError.ramInsufficient');
  });

  it('其它失败:普通 Error,文案翻译过', async () => {
    mockSessionTransact.mockRejectedValue(new Error('assertion failure with message: overdrawn balance'));
    const err = await transact(baseOpts).catch((e) => e);
    expect(err).not.toBeInstanceOf(CpuNetExhaustedError);
    expect(err).not.toBeInstanceOf(RamExhaustedError);
    expect(err.message).toBe('sponsorError.feeInsufficientBalance');
  });
});

describe('sponsoredTransact', () => {
  const paid = () => build({ sponsorFee: '0.0100 A', sponsorFeeReceiver: 'eos3powerup1' });

  it('报价和用户点头过的一致:build → 按报价核对签名 → 交回广播', async () => {
    mockBuild.mockResolvedValue(paid());
    const res = await sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' });
    expect(res.txId).toBe('b'.repeat(64));
    expect(mockSessionTransact).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0].build.sponsorRequestId).toBe('req-1');
    expect(mockPush.mock.calls[0][0].intent.approvedFee).toEqual({ quantity: '0.0100 A', receiver: 'eos3powerup1' });
    expect(mockPush.mock.calls[0][0].intent.actions).toEqual([transfer]);
    expect((await getCachedSponsorFee('vaulta'))?.fee).toBe('0.0100 A');
    expect(mockBuild).toHaveBeenCalledTimes(1);
  });

  it('Sponsor 报的价和用户看到的不一样:不替用户点头,抛 SponsorFeeChangedError 带新报价,不签不推', async () => {
    mockBuild.mockResolvedValue(build({ sponsorFee: '0.0200 A', sponsorFeeReceiver: 'eos3powerup1' }));
    const err = await sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' }).catch((e) => e);
    expect(err).toBeInstanceOf(SponsorFeeChangedError);
    expect(err.fee).toBe('0.0200 A');
    expect(mockPush).not.toHaveBeenCalled();
    expect((await getCachedSponsorFee('vaulta'))?.fee).toBe('0.0200 A');
  });

  it('用户看到的是免费、现在要收费:同样抛出', async () => {
    mockBuild.mockResolvedValue(paid());
    const err = await sponsoredTransact(baseOpts).catch((e) => e);
    expect(err).toBeInstanceOf(SponsorFeeChangedError);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('后台改为免费也更新缓存并要求重新确认', async () => {
    mockBuild.mockResolvedValue(build());
    const err = await sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' }).catch((e) => e);
    expect(err).toBeInstanceOf(SponsorFeeChangedError);
    expect(err.fee).toBe('');
    expect((await getCachedSponsorFee('vaulta'))?.fee).toBe('');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('免费:不带 approvedFee,intent 里也没有手续费', async () => {
    mockBuild.mockResolvedValue(build());
    await sponsoredTransact(baseOpts);
    expect(mockPush.mock.calls[0][0].intent.approvedFee).toBeUndefined();
    expect((await getCachedSponsorFee('vaulta'))?.fee).toBe('');
  });

  it('价格变化后用户重新同意新报价才签名', async () => {
    mockBuild.mockResolvedValue(build({ sponsorFee: '0.0200 A', sponsorFeeReceiver: 'eos3powerup1' }));
    await expect(sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' })).rejects.toBeInstanceOf(SponsorFeeChangedError);
    expect(mockPush).not.toHaveBeenCalled();
    await sponsoredTransact({ ...baseOpts, approvedFee: '0.0200 A' });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0].intent.approvedFee?.quantity).toBe('0.0200 A');
  });

  describe('代付意图 60 秒过期后的自动重试', () => {
    const expired = new Error('sponsor request expired');

    it('过期 + 重新 build 的报价没变:静默重签,不打扰用户', async () => {
      mockPush.mockRejectedValueOnce(expired).mockResolvedValueOnce({ txId: 'c'.repeat(64), signature: 'SIG' });
      mockBuild
        .mockResolvedValueOnce(build({ sponsorRequestId: 'req-old', sponsorFee: '0.0100 A', sponsorFeeReceiver: 'eos3powerup1' }))
        .mockResolvedValueOnce(build({ sponsorRequestId: 'req-new', sponsorFee: '0.0100 A', sponsorFeeReceiver: 'eos3powerup1' }));

      const res = await sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' });
      expect(res.txId).toBe('c'.repeat(64));
      expect(mockBuild).toHaveBeenCalledTimes(2);
      expect(mockPush).toHaveBeenCalledTimes(2);
      expect(mockPush.mock.calls[1][0].build.sponsorRequestId).toBe('req-new');
      expect(mockPush.mock.calls[1][0].intent.approvedFee).toEqual({ quantity: '0.0100 A', receiver: 'eos3powerup1' });
    });

    it('过期 + 重新 build 的报价变了:抛 SponsorFeeChangedError,让用户重新看一遍', async () => {
      mockPush.mockRejectedValue(expired);
      mockBuild
        .mockResolvedValueOnce(paid())
        .mockResolvedValueOnce(build({ sponsorFee: '0.0200 A', sponsorFeeReceiver: 'eos3powerup1' }));
      const err = await sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' }).catch((e) => e);
      expect(err).toBeInstanceOf(SponsorFeeChangedError);
      expect(mockPush).toHaveBeenCalledTimes(1);
    });

    it('不是过期的失败不重试,按原因报错', async () => {
      mockBuild.mockResolvedValue(paid());
      mockPush.mockRejectedValue(new Error('assertion failure with message: overdrawn balance'));
      const err = await sponsoredTransact({ ...baseOpts, approvedFee: '0.0100 A' }).catch((e) => e);
      expect(err.message).toBe('sponsorError.feeInsufficientBalance');
      expect(mockBuild).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
  });
});
