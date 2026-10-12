// 资源代付(直连 powerup.eos3.app / eos-resource-sponsor)的单测。
// 网络层整个 mock 掉 global.fetch——这里要测的是"请求体拼对了没"
// "报价怎么被核对""报错文案映射对不对",不是真的打线上服务。
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../passkey/webauthnSigning', () => ({
  signDigestWithPasskey: jest.fn(),
}));
jest.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import { ABI, Action, PrivateKey, Serializer, Transaction } from '@wharfkit/antelope';
import {
  friendlyChainErrorMessage,
  requestSponsoredBuild,
  signAndPushSponsored,
  SponsorError,
  toBroadcastError,
  CpuNetExhaustedError,
  RamExhaustedError,
} from '../sponsor';
import { TxIntentMismatchError } from '../txIntentCheck';
import type { ActionSpec, Signer } from '../transact';

const baseIntent = {
  sponsorRequestId: 'req-1',
  projectId: 'eos3-wallet-web',
  account: 'alice',
  reference: 'wallet:aabbccdd',
  serializedTransaction: 'deadbeef',
  transaction: {},
  status: 'pending',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function mockFetchOnce(status: number, body: unknown) {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  (globalThis as any).fetch = fn;
  return fn;
}

const transferAction: ActionSpec = {
  account: 'eosio.token',
  name: 'transfer',
  data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' },
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('requestSponsoredBuild', () => {
  it('免费项目:响应体没有 sponsorFee,build 结果也不带手续费', async () => {
    mockFetchOnce(200, baseIntent);
    const build = await requestSponsoredBuild({ actor: 'alice', permission: 'active', actions: [transferAction] });
    expect(build.sponsorFee).toBeUndefined();
    expect(build.sponsorRequestId).toBe('req-1');
  });

  it('收费项目:原样透传 sponsorFee/sponsorFeeReceiver,不在客户端计算或修改金额', async () => {
    mockFetchOnce(200, { ...baseIntent, sponsorFee: '0.0100 A', sponsorFeeReceiver: 'eos3powerup1' });
    const build = await requestSponsoredBuild({ actor: 'alice', permission: 'active', actions: [transferAction] });
    expect(build.sponsorFee).toBe('0.0100 A');
    expect(build.sponsorFeeReceiver).toBe('eos3powerup1');
  });

  it('收款人不是钉死的 Sponsor 账户:build 作废——弹窗不显示收款人,服务端被攻破换了收款人用户看不出来', async () => {
    mockFetchOnce(200, { ...baseIntent, sponsorFee: '0.0100 A', sponsorFeeReceiver: 'attacker' });
    await expect(requestSponsoredBuild({ actor: 'alice', permission: 'active', actions: [transferAction] })).rejects.toThrow(
      'txCheck.feeReceiverMismatch'
    );
  });

  it('报价超过客户端上限:build 作废,不靠用户手滑', async () => {
    mockFetchOnce(200, { ...baseIntent, sponsorFee: '100.0000 A', sponsorFeeReceiver: 'eos3powerup1' });
    await expect(requestSponsoredBuild({ actor: 'alice', permission: 'active', actions: [transferAction] })).rejects.toBeInstanceOf(
      TxIntentMismatchError
    );
  });

  it('免费 build 不校验收款人(没有手续费就没有收款人)', async () => {
    mockFetchOnce(200, { ...baseIntent, sponsorFeeReceiver: 'whatever' });
    await expect(requestSponsoredBuild({ actor: 'alice', permission: 'active', actions: [transferAction] })).resolves.toBeDefined();
  });

  it('非 active 权限:请求体里原样带上实际权限,不硬编码 active', async () => {
    const fetchMock = mockFetchOnce(200, baseIntent);
    await requestSponsoredBuild({ actor: 'alice', permission: 'owner', actions: [transferAction] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://powerup.eos3.app/v1/sponsored-transactions');
    expect((init.headers as Record<string, string>)['X-Project-ID']).toBe('eos3-wallet-web');
    expect(init.headers).not.toHaveProperty('X-Project-Password');
    const body = JSON.parse(init.body as string);
    expect(body.actions[0].authorization[0]).toEqual({ actor: 'alice', permission: 'owner' });
    // 每次请求都要带一个新的幂等 reference,不能不传或写死同一个值
    expect(typeof body.reference).toBe('string');
    expect(body.reference.length).toBeGreaterThan(0);
  });

  it('权限缺省时才落回 active,不是无条件硬编码', async () => {
    const fetchMock = mockFetchOnce(200, baseIntent);
    await requestSponsoredBuild({ actor: 'alice', actions: [transferAction] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.actions[0].authorization[0].permission).toBe('active');
  });
});

describe('friendlyChainErrorMessage', () => {
  it('顶层只有 HTTP 500 时仍能识别 RPC 内部的资源错误', () => {
    const err = { message: 'Internal Service Error', response: { json: { error: {
      name: 'tx_cpu_usage_exceeded', what: 'unspecified', details: [{ message: 'CPU limit exceeded' }],
    } } } };
    expect(toBroadcastError(err)).toBeInstanceOf(CpuNetExhaustedError);
    expect(toBroadcastError({ response: { json: { error: { details: [{ message: 'insufficient ram' }] } } } })).toBeInstanceOf(RamExhaustedError);
    expect(toBroadcastError({ error: { name: 'ram_usage_exceeded' } })).toBeInstanceOf(RamExhaustedError);
    expect(toBroadcastError(new Error('HTTP 500'))).not.toBeInstanceOf(CpuNetExhaustedError);
  });
  it('过期交易 —— 提示重新确认,不能复用旧签名', () => {
    expect(friendlyChainErrorMessage(new Error('sponsor request expired'))).toBe('sponsorError.expired');
    expect(friendlyChainErrorMessage(new Error('serialized transaction does not match stored intent'))).toBe(
      'sponsorError.expired'
    );
  });

  it('手续费余额不足', () => {
    expect(
      friendlyChainErrorMessage(new Error('assertion failure with message: overdrawn balance'))
    ).toBe('sponsorError.feeInsufficientBalance');
  });

  it('CPU/NET 不足 —— 节点的几种报法都映射到同一条可读文案,不把原始英文丢给用户', () => {
    for (const raw of [
      'transaction exceeded the current CPU usage limit imposed on the transaction',
      'transaction net usage is too high: 200 > 100',
      'tx_cpu_usage_exceeded',
      'billed CPU time (300 us) is greater than the maximum billable CPU time',
    ]) {
      expect(friendlyChainErrorMessage(new Error(raw))).toBe('sponsorError.cpuNetInsufficient');
    }
  });

  it('RAM 不足、白名单外、请求过多,分别映射到各自的文案', () => {
    expect(friendlyChainErrorMessage(new Error('insufficient ram'))).toBe('sponsorError.ramInsufficient');
    expect(friendlyChainErrorMessage(new Error('action eosio.token::transfer is not allowed'))).toBe(
      'sponsorError.notEligible'
    );
    expect(friendlyChainErrorMessage(new Error('too many actions'))).toBe('sponsorError.tooManyActions');
  });
});

describe('signAndPushSponsored', () => {
  // 签名前的意图核对需要一笔"服务端拼好"的真实字节——这里用 wharfkit 现拼:
  // [sponsor noop, 用户确认过的 transfer],和服务端约定的结构一致
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

  function encodeTx(actions: Action[]): string {
    return Serializer.encode({
      object: Transaction.from({
        expiration: new Date(Date.now() + 120_000).toISOString().split('.')[0],
        ref_block_num: 0,
        ref_block_prefix: 0,
        max_net_usage_words: 0,
        max_cpu_usage_ms: 0,
        delay_sec: 0,
        context_free_actions: [],
        actions,
        transaction_extensions: [],
      }),
    }).hexString;
  }

  const noopAct = Action.from(
    { account: 'paycpu', name: 'noop', authorization: [{ actor: 'paycpu', permission: 'active' }], data: {} },
    noopAbi
  );
  const userAct = Action.from(
    { account: 'eosio.token', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }], data: transferAction.data },
    tokenAbi
  );
  const sponsoredHex = encodeTx([noopAct, userAct]);

  const intent = {
    actor: 'alice',
    permission: 'active',
    actions: [transferAction],
    feeTokenContract: 'eosio.token',
    getAbi: async () => tokenAbi,
  };

  it('对服务端返回的原始字节签名并提交,不重新序列化交易', async () => {
    const key = PrivateKey.generate('K1');
    const signer: Signer = { kind: 'privatekey', privateKey: String(key) };
    const submitResponse = { ...baseIntent, status: 'pushed', txid: 'a'.repeat(64) };
    const fetchMock = mockFetchOnce(200, submitResponse);

    const { txId } = await signAndPushSponsored({
      build: { ...baseIntent, serializedTransaction: sponsoredHex },
      node: { url: 'https://unused.invalid', label: 'x' } as any,
      chainId: '0'.repeat(64),
      signer,
      intent,
    });

    expect(txId).toBe('a'.repeat(64));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://powerup.eos3.app/v1/sponsored-transactions/${baseIntent.sponsorRequestId}/submit`);
    const body = JSON.parse(init.body as string);
    // 必须原样带回服务端给的字节,而不是本地重新拼一份
    expect(body.serializedTransaction).toBe(sponsoredHex);
    expect(body.signatures).toHaveLength(1);
    expect(typeof body.signatures[0]).toBe('string');
  });

  it('服务端字节里夹带了用户没确认过的转账:拒签,连提交请求都不发', async () => {
    const key = PrivateKey.generate('K1');
    const signer: Signer = { kind: 'privatekey', privateKey: String(key) };
    const fetchMock = mockFetchOnce(200, { ...baseIntent, status: 'pushed', txid: 'a'.repeat(64) });
    const evil = Action.from(
      {
        account: 'eosio.token',
        name: 'transfer',
        authorization: [{ actor: 'alice', permission: 'active' }],
        data: { from: 'alice', to: 'attacker', quantity: '9999.0000 A', memo: '' },
      },
      tokenAbi
    );

    await expect(
      signAndPushSponsored({
        build: { ...baseIntent, serializedTransaction: encodeTx([noopAct, userAct, evil]) },
        node: { url: 'https://unused.invalid', label: 'x' } as any,
        chainId: '0'.repeat(64),
        signer,
        intent,
      })
    ).rejects.toBeInstanceOf(TxIntentMismatchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('提交失败(比如交易已过期)时抛出可读的错误,不静默吞掉', async () => {
    const key = PrivateKey.generate('K1');
    const signer: Signer = { kind: 'privatekey', privateKey: String(key) };
    mockFetchOnce(400, { error: 'sponsor request expired' });

    await expect(
      signAndPushSponsored({
        build: { ...baseIntent, serializedTransaction: sponsoredHex },
        node: { url: 'https://unused.invalid', label: 'x' } as any,
        chainId: '0'.repeat(64),
        signer,
        intent,
      })
    ).rejects.toBeInstanceOf(SponsorError);
  });
});
