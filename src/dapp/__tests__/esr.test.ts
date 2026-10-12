jest.mock('../../i18n', () => ({
  t: (key: string) => key,
}));
jest.mock('../../passkey/webauthnSigning', () => ({
  signDigestWithPasskey: jest.fn(),
}));
jest.mock('../linkIdentity', () => ({ getLinkIdentity: jest.fn(), linkDeviceName: () => 'Test wallet' }));
jest.mock('../linkSessions', () => ({ recordLinkSession: jest.fn() }));

import { isEsrLink, normalizeEsr } from '../esr';

describe('isEsrLink', () => {
  it('esr: / anchor: / eosio://link 都算签名请求链接', () => {
    expect(isEsrLink('esr://abc')).toBe(true);
    expect(isEsrLink('anchor://link?x')).toBe(true);
    expect(isEsrLink('eosio://link?x')).toBe(true);
    expect(isEsrLink('ESR://ABC')).toBe(true); // 大小写不敏感
  });
  it('普通网址/账户名不算', () => {
    expect(isEsrLink('https://bloks.io')).toBe(false);
    expect(isEsrLink('alice')).toBe(false);
  });
  it('回归:eosio:账户名 形式的旧收款码不是签名请求', () => {
    expect(isEsrLink('eosio:binancecleos?amount=1.0000&memo=905112')).toBe(false);
    expect(isEsrLink('eosio:alice')).toBe(false);
  });
});

describe('normalizeEsr', () => {
  it('esr: 原样返回', () => {
    expect(normalizeEsr('esr://payload')).toBe('esr://payload');
  });
  it('anchor://link?payload 归一成 esr://payload', () => {
    expect(normalizeEsr('anchor://link?gWNgZGA')).toBe('esr://gWNgZGA');
    expect(normalizeEsr('anchor://link/gWNgZGA')).toBe('esr://gWNgZGA');
    expect(normalizeEsr('eosio://link?gWNgZGA')).toBe('esr://gWNgZGA');
  });
  it('识别不了的返回 null', () => {
    expect(normalizeEsr('https://bloks.io')).toBeNull();
    expect(normalizeEsr('anchor://link')).toBeNull(); // 没有负载
  });
});

// ---- parseEsr 的链 ID 校验 + buildCallback 的字段覆盖 ----
// 用身份请求(identity)做样本:不需要合约 ABI 就能 create/resolve,足够覆盖链校验分支。
import { deflateRaw, inflateRaw } from 'pako';
import { SigningRequest } from '@wharfkit/signing-request';
import { PrivateKey, Transaction } from '@wharfkit/antelope';
import { assertIdentityNotExpired, buildCallback, EsrIdentityExpiredError, linkRequestKey, parseEsr, signAndCallback } from '../esr';
import { CHAINS } from '../../chain/config';
import { CpuNetExhaustedError } from '../../chain/sponsor';
import { getLinkIdentity } from '../linkIdentity';
import { recordLinkSession } from '../linkSessions';
import { signDigestWithPasskey } from '../../passkey/webauthnSigning';

const zlib = {
  zlib: {
    deflateRaw: (d: Uint8Array) => deflateRaw(d),
    inflateRaw: (d: Uint8Array) => inflateRaw(d),
  },
};
const VAULTA = CHAINS.vaulta.chainIdHash;
const JUNGLE = CHAINS.jungle4.chainIdHash;

/** 节点 get_info 的最小可用应答——parseEsr 只用它算 TAPOS 头 */
function mockGetInfo(chainId: string) {
  const body = {
    server_version: '0',
    chain_id: chainId,
    head_block_num: 1000,
    last_irreversible_block_num: 990,
    last_irreversible_block_id: '000003de' + 'ab'.repeat(28),
    head_block_id: '000003e8' + 'cd'.repeat(28),
    head_block_time: '2099-01-01T00:00:00.000',
    head_block_producer: 'eosio',
    virtual_block_cpu_limit: 0,
    virtual_block_net_limit: 0,
    block_cpu_limit: 0,
    block_net_limit: 0,
  };
  // wharfkit 的 FetchProvider 读的是 response.text() 和 headers.entries()
  (globalThis as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { entries: () => [['content-type', 'application/json']] },
    text: async () => JSON.stringify(body),
  });
}

const identityOn = (chainId: string | null, chainIds?: string[]) =>
  SigningRequest.identity(
    { callback: { url: 'https://dapp.example/cb', background: true }, scope: 'dapp', chainId, chainIds } as any,
    zlib
  ).encode();

const parseOpts = {
  actor: 'alice',
  permission: 'active',
  node: { url: 'https://node.invalid', name: 'x' } as any,
  config: CHAINS.vaulta,
};

describe('ESR 的 DApp 广播交易也检查资源', () => {
  const transaction = Transaction.from({
    expiration: new Date(Date.now() + 120_000).toISOString().split('.')[0], ref_block_num: 1, ref_block_prefix: 2,
    actions: [{ account: 'eosio.token', name: 'transfer', data: '00', authorization: [{ actor: 'alice', permission: 'active' }] }],
  });
  const resolved = {
    transaction,
    signingDigest: transaction.signingDigest(VAULTA),
    request: { shouldBroadcast: () => false, isIdentity: () => false },
    getCallback: () => null,
  } as any;
  const options = {
    resolved, signer: { kind: 'privatekey' as const, privateKey: String(PrivateKey.generate('K1')) },
    chainId: VAULTA, chainSlug: 'vaulta' as const, actor: 'alice', node: parseOpts.node,
  };

  it('不足时不把签名交回 DApp,留在钱包供宿主弹充值窗口', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
      cpu_limit: { max: 1000, available: 0 }, net_limit: { max: 1000, available: 1000 },
    }) });
    await expect(signAndCallback(options)).rejects.toBeInstanceOf(CpuNetExhaustedError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetch).mock.calls[0][0]).toContain('/get_account');
  });

  it('额度充足时只签名,不替 DApp 广播', async () => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
      cpu_limit: { max: 1000, available: 1000 }, net_limit: { max: 1000, available: 1000 },
    }) });
    const result = await signAndCallback(options);
    expect(result.signature).toMatch(/^SIG_K1_/);
    expect(result.txId).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('parseEsr 链 ID 校验', () => {
  beforeEach(() => mockGetInfo(VAULTA));

  it('单链请求:和当前钱包同一条链,正常解析', async () => {
    const { req } = await parseEsr(identityOn(VAULTA), parseOpts);
    expect(req.isIdentity).toBe(true);
    expect(req.chainId).toBe(VAULTA);
  });

  it('login proofs last five minutes from the node head time', async () => {
    const { resolved } = await parseEsr(identityOn(VAULTA), parseOpts);
    expect(String(resolved.transaction.expiration)).toBe('2099-01-01T00:05:00');
  });

  it('单链请求:给别的链的,拒掉并点名对方链和当前链——不能拿主网 TAPOS 去签测试网请求', async () => {
    await expect(parseEsr(identityOn(JUNGLE), parseOpts)).rejects.toThrow('esrError.chainMismatch');
  });

  it('多链请求:chain_ids 为空表示任意链,当前链直接用', async () => {
    const { req } = await parseEsr(identityOn(null), parseOpts);
    expect(req.chainId).toBe(VAULTA);
  });

  it('多链请求:列表里有当前链就放行,没有就拒', async () => {
    await expect(parseEsr(identityOn(null, [JUNGLE, VAULTA]), parseOpts)).resolves.toBeTruthy();
    await expect(parseEsr(identityOn(null, [JUNGLE]), parseOpts)).rejects.toThrow('esrError.chainMismatch');
  });
});

describe('identity expiration and callback delivery', () => {
  const key = PrivateKey.generate('K1');
  const now = new Date('2026-10-09T01:00:00Z');
  const expiration = new Date('2026-10-09T01:05:00Z');
  const makeResolved = (background = true, withLink = false, callback = 'https://dapp.example/cb') => {
    const request = SigningRequest.identity({ scope: 'dapp', chainId: VAULTA,
      callback: { url: callback, background } }, zlib);
    if (withLink) request.setInfoKey('req_key', key.toPublic());
    return request.resolve(new Map(), { actor: 'alice', permission: 'active' }, {
      expiration: '2026-10-09T01:05:00',
    });
  };
  const options = (resolved: any) => ({ resolved,
    signer: { kind: 'privatekey' as const, privateKey: String(key) },
    chainId: VAULTA, chainSlug: 'vaulta' as const, actor: 'alice', node: parseOpts.node });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.clearAllMocks();
    (globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    jest.mocked(getLinkIdentity).mockResolvedValue({ publicKey: key.toPublic(), privateKey: key,
      channelUrl: 'https://cb.anchor.link/test-channel' });
  });
  afterEach(() => jest.useRealTimers());

  it('rejects at the exact expiration boundary without posting a callback', async () => {
    const resolved = makeResolved();
    jest.setSystemTime(expiration);
    expect(() => assertIdentityNotExpired(resolved)).toThrow(EsrIdentityExpiredError);
    await expect(signAndCallback(options(resolved))).rejects.toThrow('esrError.identityExpired');
    expect(fetch).not.toHaveBeenCalled();
    expect(recordLinkSession).not.toHaveBeenCalled();
  });

  it('never sends or redirects a proof that expires during system authentication', async () => {
    for (const background of [true, false]) {
      jest.setSystemTime(now);
      const resolved = makeResolved(background);
      const signature = key.signDigest(resolved.signingDigest);
      jest.mocked(signDigestWithPasskey).mockImplementationOnce(async () => {
        jest.setSystemTime(expiration);
        return signature;
      });
      await expect(signAndCallback({ ...options(resolved), signer: {
        kind: 'passkey', credentialIdHex: '00', chainPublicKey: String(key.toPublic()),
      } })).rejects.toBeInstanceOf(EsrIdentityExpiredError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks expiry after loading the channel and does not create a phantom session', async () => {
    const resolved = makeResolved(true, true);
    jest.mocked(getLinkIdentity).mockImplementationOnce(async () => {
      jest.setSystemTime(expiration);
      return { publicKey: key.toPublic(), privateKey: key, channelUrl: 'https://cb.anchor.link/test-channel' };
    });
    await expect(signAndCallback(options(resolved))).rejects.toBeInstanceOf(EsrIdentityExpiredError);
    expect(fetch).not.toHaveBeenCalled();
    expect(recordLinkSession).not.toHaveBeenCalled();
  });

  it('delivers a valid proof once with the receiving session already registered', async () => {
    const resolved = makeResolved(true, true);
    const result = await signAndCallback(options(resolved));
    expect(result.kind).toBe('posted');
    expect(fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(jest.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(jest.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(payload).toMatchObject({ sa: 'alice', sp: 'active', ex: '2026-10-09T01:05:00', link_name: 'Test wallet' });
    expect(payload.sig).toMatch(/^SIG_K1_/);
    expect(recordLinkSession).toHaveBeenCalledWith(expect.objectContaining({ account: 'alice', requestKey: String(key.toPublic()) }));
    expect(jest.mocked(recordLinkSession).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(fetch).mock.invocationCallOrder[0]);
  });

  it('callback rejection is returned as an error, not reported as delivered', async () => {
    jest.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(signAndCallback(options(makeResolved(true, true)))).rejects.toThrow('esrError.callbackFailed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['http://dapp.example/cb', 'https://user:password@dapp.example/cb', 'javascript:alert(1)', 'https://{{sa}}.example/cb'])(
    'rejects an unsafe signature recipient before signing: %s', async (url) => {
      const resolved = makeResolved(true, false, url);
      await expect(signAndCallback(options(resolved))).rejects.toThrow('esrError.unrecognizedLink');
      expect(fetch).not.toHaveBeenCalled();
      expect(signDigestWithPasskey).not.toHaveBeenCalled();
    }
  );

  it('keeps foreground callbacks as redirects and missing callbacks as sign-only', async () => {
    expect((await signAndCallback(options(makeResolved(false)))).kind).toBe('redirect');
    expect((await signAndCallback(options(makeResolved(true, false, '')))).kind).toBe('none');
    expect(fetch).not.toHaveBeenCalled();
    expect(recordLinkSession).not.toHaveBeenCalled();
  });

  it('legacy v2 identity requests without proof expiration are still supported', () => {
    const request = SigningRequest.identity({ chainId: VAULTA, callback: 'https://dapp.example/cb' }, zlib);
    expect(request.version).toBe(2);
    const resolved = request.resolve(new Map(), { actor: 'alice', permission: 'active' });
    expect(() => assertIdentityNotExpired(resolved)).not.toThrow();
  });
});

describe('buildCallback', () => {
  it('默认和 wharfkit getCallback 一致;钱包代广播时 tx 换成实际上链的交易 ID,模板占位符跟着变', () => {
    const request = SigningRequest.identity(
      { callback: 'https://dapp.example/cb?tx={{tx}}&sig={{sig}}&rbn={{rbn}}&nope={{unknown}}', scope: 'dapp', chainId: VAULTA } as any,
      zlib
    );
    const resolved = request.resolve(new Map(), { actor: 'alice', permission: 'active' }, {
      expiration: '2099-01-01T00:00:00',
      ref_block_num: 1,
      ref_block_prefix: 2,
      chainId: VAULTA,
    });
    const sig = String(PrivateKey.generate('K1').signDigest(resolved.signingDigest));

    const plain = buildCallback(resolved, { signature: sig })!;
    const ref = resolved.getCallback([sig], 0)!;
    expect(plain.url).toBe(ref.url);
    expect(plain.payload.tx).toBe(ref.payload.tx);

    const broadcasted = buildCallback(resolved, { signature: sig, txId: 'f'.repeat(64), blockNum: 4242 })!;
    expect(broadcasted.payload.tx).toBe('f'.repeat(64));
    expect(broadcasted.payload.sig).toBe(sig);
    expect(broadcasted.url).toBe(`https://dapp.example/cb?tx=${'f'.repeat(64)}&sig=${sig}&rbn=${ref.payload.rbn}&nope=`);
    // 请求本体等不受影响的字段原样保留
    expect(broadcasted.payload.req).toBe(ref.payload.req);
    expect(broadcasted.payload.sa).toBe('alice');
  });
});

describe('linkRequestKey', () => {
  // 2026-09-10 从 unicove 真实抓下来的身份请求(anchor-link v3 /
  // wharfkit protocol-esr 1.6.1):info 里带的是 `link` 结构体,没有 `req_key`。
  // 同一条会话后续推来的签名请求,密封消息的 from 就是这里的 request_key。
  const UNICOVE_IDENTITY =
    'esr:g0WQMUvDQBzFE1t16CdwO1xs0dwljUmsRag4qLShQwXdwvX6LzlyyYXLtULBL6DioDj4FdxcHYRugqujo4uLn8DBFiryhgeP33vDM8ySYRit9PLj3VhqxlrnxS4hrI9pxmKpsOBZQnaANnyo21bgemBtUwisvuMNLNtvzLwxpOC55fIcfTH_17obnavg4elxWt807xz4WintXV9MP8vPP2_fN2uv97dm6zymaphwTXIltWRSWFAo5GAfOyiUEy4EJR62UTWkjGdaFnETHWcaBJoFqNtDZ8ixI8eLghraz3MBp9Bvz-Y8N8Cuj6rto5Ows4UETwAdAktkDR3ESqZAHK-O7blQjw6p4ovKcsFkDqujjDM5hkpBU4gGMOYMTLOiQI9UFuVUx-t_Ty1IzGRKJjEZ05HQlBSQDX4B';
  const UNICOVE_REQUEST_KEY = 'PUB_K1_5VMDwKjEPjaqJJsuu5Yuc1H7ojeJL5YWccNUuRBwYHoVwmqEpS';

  const parse = (uri: string) => SigningRequest.from(uri, zlib);

  it('anchor-link v3:从 link 结构体里取出 request_key', () => {
    expect(linkRequestKey(parse(UNICOVE_IDENTITY))).toBe(UNICOVE_REQUEST_KEY);
  });

  it('回归:两个字段都没有时返回 null,不能返回字符串 "undefined"', () => {
    // 没有 link 也没有 req_key 的普通身份请求——以前这里 String(undefined)
    // 会把 "undefined" 当公钥记进会话表,导致之后每条推送都匹配不上被丢弃
    const plain = SigningRequest.identity({ callback: 'https://example.com/cb' }, zlib);
    expect(linkRequestKey(plain)).toBeNull();
  });
});
