import { buildInjectedScript } from '../injected';
import { DappAccessGuard } from '../accessGuard';
import { Serializer, Transaction } from '@wharfkit/antelope';

// 注入脚本是"字符串里的代码",tsc 检查不到它——语法错了要到真机 WebView
// 里才炸,而且表现是 DApp 静默连不上钱包,很难排查。这里至少把语法兜住。
describe('buildInjectedScript', () => {
  const script = buildInjectedScript({
    account: 'alice',
    publicKey: 'PUB_K1_test',
    chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
    chainName: 'Vaulta',
    canSign: true,
    locale: 'zh-CN',
    nodeUrl: 'https://eos.greymass.com',
    platform: 'android',
    appVersion: '1.0.0',
    systemVersion: '14',
    darkMode: false,
  });

  it('生成的脚本是合法 JavaScript(new Function 仅解析不执行)', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('注入的是真实 chain_id 哈希,且账户/语言按传入值嵌入', () => {
    expect(script).toContain('aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906');
    expect(script).not.toContain('alice');
    expect(script).not.toContain('PUB_K1_test');
    expect(script).toContain('zh-CN');
  });

  it('页面侧深链判定与 App 侧 isEsrLink 口径一致:eosio: 只认 //link', () => {
    // 直接在 Node 里执行页面侧的 isSignReq 定义,验证行为而不只是字面
    const m = script.match(/function isSignReq\(u\) \{[\s\S]*?\n  \}/);
    expect(m).not.toBeNull();
    const isSignReq = new Function(`${m![0]}; return isSignReq;`)() as (u: string) => boolean;
    expect(isSignReq('esr://abc')).toBe(true);
    expect(isSignReq('anchor://link?x')).toBe(true);
    expect(isSignReq('eosio://link?x')).toBe(true);
    expect(isSignReq('eosio:binancecleos?amount=1.0000&memo=1')).toBe(false);
    expect(isSignReq('https://bloks.io')).toBe(false);
  });
});

/**
 * 上面那组只保证脚本"能解析"。这一组真的把它跑起来,对着 scatter-js 2.0 的
 * 接口清单逐项验收——注入对象少一个方法,表现是 DApp 那边连不上钱包或者
 * 签名按钮点了没反应,光看代码看不出来。
 *
 * 清单来源:scatterjs-core 的 models/WalletInterface.js,里面 WALLET_METHODS
 * 列出钱包必须提供的方法,ALTERNATES 定义 login/logout/checkLogin 三个别名。
 */
function runInjected() {
  const script = buildInjectedScript({
    account: 'alice',
    publicKey: 'PUB_K1_test',
    chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
    chainName: 'Vaulta',
    canSign: true,
    locale: 'zh-CN',
    nodeUrl: 'https://eos.greymass.com',
    platform: 'android',
    appVersion: '1.0.0',
    systemVersion: '14',
    darkMode: false,
  });

  const sent: any[] = [];
  const listeners: Record<string, Function[]> = {};
  const target = {
    addEventListener: (type: string, fn: Function) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent: () => true,
  };
  const win: any = {
    ...target,
    location: { assign: () => {}, replace: () => {} },
    ReactNativeWebView: { postMessage: (raw: string) => sent.push(JSON.parse(raw)) },
  };
  const doc: any = { ...target };
  const nav: any = {};
  const Ev = function () {} as any;

  new Function('window', 'document', 'navigator', 'Event', 'CustomEvent', script)(
    win,
    doc,
    nav,
    Ev,
    Ev
  );

  /** 模拟 App 侧对某次请求的应答 */
  const settle = (method: string, payload: any, ok = true) => {
    const msg = sent.filter((m) => m.method === method).pop();
    win.__auroraResolve(msg.id, ok, payload);
  };

  const clickLink = (href: string) => {
    const event = { target: { tagName: 'A', getAttribute: () => href }, preventDefault: jest.fn(), stopPropagation: jest.fn() };
    listeners.click.forEach((listener) => listener(event));
    return event;
  };
  return { win, sent, settle, clickLink };
}

it('a clicked ESR link on a LAN HTTP page reaches native confirmation without wallet access', () => {
  const { win, sent, clickLink } = runInjected();
  const page = 'http://192.168.31.51:8787/';
  const guard = new DappAccessGuard();
  guard.navigate(page, 'wallet');
  const click = clickLink('esr://request-payload');
  expect(click.preventDefault).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(1);
  const request = sent[0];
  expect(request.method).toBe('esrRequest');
  expect(request.params.uri).toBe('esr://request-payload');
  expect(guard.accept(request.id, request.documentId, page, 'wallet', request.method)).toBe(true);
  expect(guard.connect(request.id, 'wallet')).toBe(false);
  win.__auroraResolve(request.id, true, true);
  expect(win.scatter.identity).toBeNull();
});

describe('scatter-js 2.0 接口契约', () => {
  // WalletInterface.js 的 WALLET_METHODS + ALTERNATES
  const REQUIRED = [
    'disconnect', 'isConnected', 'isPaired', 'addEventHandler', 'removeEventHandler',
    'listen', 'getVersion', 'getIdentity', 'getIdentityFromPermissions', 'forgetIdentity',
    'updateIdentity', 'authenticate', 'getArbitrarySignature', 'getPublicKey', 'linkAccount',
    'hasAccountFor', 'suggestNetwork', 'requestTransfer', 'requestSignature',
    'createTransaction', 'addToken',
    'login', 'logout', 'checkLogin',
  ];

  it('注入对象提供了清单上的每一个方法', () => {
    const { win } = runInjected();
    const missing = REQUIRED.filter((m) => typeof win.scatter[m] !== 'function');
    expect(missing).toEqual([]);
  });

  it('useIdentity 可以被 bind —— ScatterJS.connect({network}) 就卡在这一步', () => {
    const { win } = runInjected();
    expect(() => win.scatter.useIdentity.bind(win.scatter)).not.toThrow();
  });

  it('login() 拿到的身份带账户名与权限,登录后 account("eos") 能取到它', async () => {
    const { win, settle } = runInjected();
    const p = win.scatter.login();
    settle('getIdentity', { account: 'alice', publicKey: 'PUB_K1_test' });
    const identity = await p;
    expect(identity.accounts[0].name).toBe('alice');
    expect(identity.accounts[0].authority).toBe('active');
    expect(win.scatter.account('eos').publicKey).toBe('PUB_K1_test');
  });

  it('logout() 会通知已注册的事件订阅者,并清掉身份', async () => {
    const { win, settle } = runInjected();
    const events: string[] = [];
    win.scatter.addEventHandler((type: string) => events.push(type));

    const p = win.scatter.login();
    settle('getIdentity', { account: 'alice', publicKey: 'PUB_K1_test' });
    await p;

    win.scatter.logout();
    expect(events).toContain('logout');
    expect(win.scatter.identity).toBeNull();
  });

  it('hasAccountFor 只认当前链的 chainId', async () => {
    const { win } = runInjected();
    await expect(
      win.scatter.hasAccountFor({ chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906' })
    ).resolves.toBe(true);
    await expect(win.scatter.hasAccountFor({ chainId: 'deadbeef' })).resolves.toBe(false);
  });

  it('requestTransfer 按页面给的精度拼 quantity,缺符号时直接报错', async () => {
    const { win, sent } = runInjected();
    win.scatter.requestTransfer(null, 'bob', 1.5, { symbol: 'A', contract: 'core.vaulta', precision: 4 });
    const msg = sent.filter((m) => m.method === 'requestSignature').pop();
    expect(msg.params.actions[0].data.quantity).toBe('1.5000 A');
    expect(msg.params.actions[0].account).toBe('core.vaulta');

    await expect(win.scatter.requestTransfer(null, 'bob', 1.5, {})).rejects.toThrow();
  });

  it('不支持的钱包内部动作明确抛错,而不是假装成功', async () => {
    const { win } = runInjected();
    await expect(win.scatter.addToken()).rejects.toThrow();
    await expect(win.scatter.linkAccount()).rejects.toThrow();
    await expect(win.scatter.createTransaction()).rejects.toThrow();
  });
});

describe('Scatter 签名请求的分流', () => {
  it('页面已序列化好的交易走只签名通道,字节转成十六进制传给 App', () => {
    const { win, sent } = runInjected();
    win.scatter.requestSignature({
      transaction: { serializedTransaction: new Uint8Array([0xde, 0xad, 0x00, 0xff]) },
      network: { chainId: 'aca376f2' },
    });
    const msg = sent.pop();
    expect(msg.method).toBe('signTransaction');
    expect(msg.params.serializedTransaction).toBe('dead00ff');
    expect(msg.params.chainId).toBe('aca376f2');
  });

  it('只给了 actions 时仍然走"钱包拼交易并广播"那条通道', () => {
    const { win, sent } = runInjected();
    win.scatter.requestSignature({ transaction: { actions: [{ account: 'eosio.token', name: 'transfer' }] } });
    const msg = sent.pop();
    expect(msg.method).toBe('requestSignature');
    expect(msg.params.actions).toHaveLength(1);
  });
});

/**
 * TokenPocket 的官方 tp-js-sdk 不看 window.tp:它把请求发给原生桥
 * window.TPJSBrigeClient.callMessage(方法名, JSON 参数, 回调函数名),
 * 再等钱包回头调 window[回调函数名](JSON 字符串)。桥缺席时 SDK 既不报错也不
 * reject,页面表现成"点了没反应",所以这套约定必须逐字对上。
 */
describe('TokenPocket 原生桥', () => {
  const bridgeCall = (win: any, method: string, params: any) =>
    new Promise<any>((resolve) => {
      const cb = 'tp_callback_test';
      win[cb] = (raw: string) => resolve(JSON.parse(raw));
      win.TPJSBrigeClient.callMessage(method, JSON.stringify(params), cb);
    });

  it('getCurrentWallet 回的是 SDK 文档写的三层结构,address 放公钥、name 放账户名', async () => {
    const { win, settle } = runInjected();
    const p = bridgeCall(win, 'getCurrentWallet', {});
    settle('getIdentity', { account: 'alice', publicKey: 'PUB_K1_test' });
    await expect(p).resolves.toEqual({
      result: true,
      data: { name: 'alice', address: 'PUB_K1_test', blockchain: 'eos', blockchain_id: 4 },
      msg: 'success',
    });
  });

  it('pushEosAction 把交易号包成 data.transactionId', async () => {
    const { win, sent, settle } = runInjected();
    const p = bridgeCall(win, 'pushEosAction', { actions: [{ account: 'eosio.token', name: 'transfer' }] });
    expect(sent[sent.length - 1].method).toBe('requestSignature');
    settle('requestSignature', { transaction_id: 'abc123' });
    await expect(p).resolves.toEqual({ result: true, data: { transactionId: 'abc123' }, msg: 'success' });
  });

  it('eosTokenTransfer 按页面给的精度拼 quantity', async () => {
    const { win, sent } = runInjected();
    bridgeCall(win, 'eosTokenTransfer', {
      from: 'alice', to: 'bob', amount: 2, tokenName: 'A', contract: 'core.vaulta', precision: 4, memo: 'hi',
    });
    const msg = sent.pop();
    expect(msg.params.actions[0].data).toEqual({ from: 'alice', to: 'bob', quantity: '2.0000 A', memo: 'hi' });
  });

  it('不认识的方法回 result:false,而不是让 promise 一直挂着', async () => {
    const { win } = runInjected();
    const res = await bridgeCall(win, 'signCosmosTransaction', {});
    expect(res.result).toBe(false);
  });
});

describe('window.tp 全局对象', () => {
  it('方法名与官方 SDK 对齐,不再暴露 SDK 里根本没有的名字', () => {
    const { win } = runInjected();
    ['getCurrentWallet', 'getWallets', 'getWalletList', 'pushEosAction', 'eosTokenTransfer',
     'eosAuthSign', 'getEosBalance', 'getEosAccountInfo', 'getEosTableRows', 'getNodeUrl', 'getAppInfo']
      .forEach((m) => expect(typeof win.tp[m]).toBe('function'));
    expect(win.tp.pushEosTransaction).toBeUndefined();
    expect(win.tp.signEosTransaction).toBeUndefined();
  });

  it('业务失败也 resolve 成 result:false,不往外 reject', async () => {
    const { win, settle } = runInjected();
    const p = win.tp.getCurrentWallet();
    settle('getIdentity', 'no account', false);
    await expect(p).resolves.toEqual({ result: false, data: null, msg: 'no account' });
  });

  it('getWalletList 缺链类型参数时抛错,行为照抄 SDK', () => {
    const { win } = runInjected();
    expect(() => win.tp.getWalletList()).toThrow('type invalid');
  });

  it('eosAuthSign 走任意文本签名通道,回的是 data.signature', async () => {
    const { win, sent, settle } = runInjected();
    const p = win.tp.eosAuthSign({ from: 'alice', signdata: 'login-nonce' });
    expect(sent[sent.length - 1].params.data).toBe('login-nonce');
    settle('arbitrarySignature', { signature: 'SIG_K1_x' });
    await expect(p).resolves.toEqual({ result: true, data: { signature: 'SIG_K1_x' }, msg: 'success' });
  });
});

/**
 * 改了 UA 之后,1dex 这类站点的 TokenPocket 通道走 wharfkit 的 Scatter 协议,
 * 它的调用顺序是(读自 1dex 线上包里的 @wharfkit/protocol-scatter):
 *   ScatterJS.eos(network, Api, { rpc })  → 期待拿到一个真正的 eosjs2 Api 实例
 *   api.transact(tx, { broadcast: false }) → 期待 { serializedTransaction, signatures }
 *   window.scatter.authenticate(nonce)     → 期待签名字符串,直接喂给 Signature.from
 * 这里用一个形状一致的假 Api 类代替 eosjs,只验收我们这一侧的约定。
 */
class FakeEosjs2Api {
  opts: any;
  constructor(opts: any) {
    this.opts = opts;
  }
  async transact(_tx: any, cfg: { broadcast: boolean }) {
    const signed = await this.opts.signatureProvider.sign({
      chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
      requiredKeys: [],
      serializedTransaction: new Uint8Array([1, 2, 255]),
    });
    return cfg.broadcast ? { transaction_id: 'x' } : signed;
  }
}

// Reproduce the legacy eosjs check bundled by protocol-scatter, using real
// Antelope transaction bytes to verify that the bridge never changes them.
class LegacyTaposApi extends FakeEosjs2Api {
  hasRequiredTaposFields(tx: any) {
    return !!(tx.expiration && tx.ref_block_num && tx.ref_block_prefix);
  }
  async transact(tx: any, cfg: { broadcast: boolean }) {
    if (!this.hasRequiredTaposFields(tx)) {
      throw new Error('Required configuration or TAPOS fields are not present');
    }
    const signed = await this.opts.signatureProvider.sign({
      chainId: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906',
      serializedTransaction: Serializer.encode({ object: Transaction.from(tx) }).array,
    });
    return cfg.broadcast ? this.opts.rpc.push_transaction(signed) : signed;
  }
}

describe('scatter.eos() 对接 eosjs2', () => {
  const challenge = (num: number, prefix: number) => ({
    expiration: new Date(Date.now() + 120_000).toISOString().slice(0, 19),
    ref_block_num: num, ref_block_prefix: prefix,
    actions: [{ account: 'eoseyespower', name: 'noop',
      authorization: [{ actor: 'alice', permission: 'active' }], data: '' }],
  });

  it.each([[0, 0], [0, 123], [123, 0], [123, 456], [65535, 4294967295]])(
    '旧 eosjs 接受合法参考区块 %i/%i,原样签名且不广播', async (num, prefix) => {
      const { win, sent, settle } = runInjected();
      const rpc = { get_info: jest.fn(), push_transaction: jest.fn() };
      const api = win.scatter.eos({}, LegacyTaposApi, { rpc });
      const tx = challenge(num, prefix);
      const before = JSON.stringify(tx);
      const expectedBytes = Serializer.encode({ object: Transaction.from(tx) });
      // Observe rejection immediately so a regression fails without an unhandled promise.
      const completion = api.transact(tx, { broadcast: false }).then(
        (result: any) => ({ result }), (error: Error) => ({ error })
      );
      expect(sent).toHaveLength(1);
      expect(sent[0].method).toBe('signTransaction');
      expect(sent[0].params.serializedTransaction).toBe(expectedBytes.hexString);
      expect(sent[0].params.chainId).toBe('aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906');
      settle('signTransaction', { signatures: ['SIG_K1_challenge'] });
      const { result } = await completion;
      expect(result.signatures).toEqual(['SIG_K1_challenge']);
      expect(Array.from(result.serializedTransaction)).toEqual(Array.from(expectedBytes.array));
      expect(JSON.stringify(tx)).toBe(before);
      expect(rpc.get_info).not.toHaveBeenCalled();
      expect(rpc.push_transaction).not.toHaveBeenCalled();
    }
  );

  it.each([
    { expiration: undefined }, { ref_block_num: undefined }, { ref_block_prefix: undefined },
    { ref_block_num: '0' }, { ref_block_prefix: '0' },
    { ref_block_num: -1 }, { ref_block_num: 65536 }, { ref_block_num: 0.5 },
    { ref_block_prefix: -1 }, { ref_block_prefix: 4294967296 },
    { ref_block_prefix: NaN }, { ref_block_prefix: Infinity },
  ])('旧 eosjs 仍拒绝缺失或非法的 TAPOS 字段: %j', async (fields) => {
    const { win, sent } = runInjected();
    const api = win.scatter.eos({}, LegacyTaposApi, { rpc: {} });
    await expect(api.transact({ ...challenge(0, 0), ...fields }, { broadcast: false }))
      .rejects.toThrow('TAPOS');
    expect(sent).toHaveLength(0);
  });

  it('零参考区块请求被用户拒绝时保留拒绝结果,不广播', async () => {
    const { win, sent, settle } = runInjected();
    const rpc = { push_transaction: jest.fn() };
    const api = win.scatter.eos({}, LegacyTaposApi, { rpc });
    const pending = api.transact(challenge(0, 0), { broadcast: false });
    const rejected = expect(pending).rejects.toThrow('User rejected');
    if (sent.length) settle('signTransaction', 'User rejected', false);
    await rejected;
    expect(rpc.push_transaction).not.toHaveBeenCalled();
  });

  it('用页面给的 Api 类建实例,保留页面的 rpc,只换掉 signatureProvider', () => {
    const { win } = runInjected();
    const rpc = { endpoint: 'https://node' };
    const api = win.scatter.eos({}, FakeEosjs2Api, { rpc });
    expect(api).toBeInstanceOf(FakeEosjs2Api);
    expect(api.opts.rpc).toBe(rpc);
    expect(typeof api.opts.signatureProvider.sign).toBe('function');
  });

  it('transact(broadcast:false) 走只签名通道,拿回签名和原样的交易字节', async () => {
    const { win, sent, settle } = runInjected();
    const api = win.scatter.eos({}, FakeEosjs2Api, { rpc: {} });
    const p = api.transact({}, { broadcast: false });
    await Promise.resolve();

    const msg = sent[sent.length - 1];
    expect(msg.method).toBe('signTransaction');
    expect(msg.params.serializedTransaction).toBe('0102ff');
    expect(msg.params.chainId).toBe('aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906');

    settle('signTransaction', { signatures: ['SIG_K1_abc'] });
    const res = await p;
    expect(res.signatures).toEqual(['SIG_K1_abc']);
    expect(Array.from(res.serializedTransaction)).toEqual([1, 2, 255]);
  });

  it('带 context-free data 的交易明确拒绝,不给一个链上会被拒的签名', async () => {
    const { win } = runInjected();
    const api = win.scatter.eos({}, FakeEosjs2Api, { rpc: {} });
    await expect(
      api.opts.signatureProvider.sign({ serializedTransaction: new Uint8Array([1]), serializedContextFreeData: new Uint8Array([9]) })
    ).rejects.toThrow('context-free');
  });

  it('老式 eosjs1 调用仍然返回钱包拼交易并广播的那个对象', () => {
    const { win } = runInjected();
    const legacy = win.scatter.eos({}, function Eos() {}, {});
    expect(typeof legacy.transact).toBe('function');
    expect(typeof legacy.getAccount).toBe('function');
  });

  it('authenticate 返回签名字符串本身,而不是 { signature } 对象', async () => {
    const { win, settle } = runInjected();
    const p = win.scatter.authenticate('nonce-1');
    settle('arbitrarySignature', { signature: 'SIG_K1_xyz', publicKey: 'PUB_K1_test' });
    await expect(p).resolves.toBe('SIG_K1_xyz');
  });
});

describe('checkLogin 在页面刷新之后', () => {
  it('内存里没有身份时去钱包取一次,钱包有账户就返回身份', async () => {
    const { win, sent, settle } = runInjected();
    const p = win.scatter.checkLogin();
    expect(sent[sent.length - 1].method).toBe('getIdentityFromPermissions');
    settle('getIdentityFromPermissions', { account: 'alice', publicKey: 'PUB_K1_test' });
    const id = await p;
    expect(id.accounts[0].name).toBe('alice');
  });

  it('钱包没有账户时按 Scatter 约定返回 null,而不是 reject', async () => {
    const { win, settle } = runInjected();
    const p = win.scatter.checkLogin();
    settle('getIdentityFromPermissions', 'no account', false);
    await expect(p).resolves.toBeNull();
  });
});


/**
 * tp-js-sdk 3.7.14(src/tp.js)导出的全部方法。每一个都必须在 window.tp 上,
 * 并且通过原生桥调用时都得有应答——官方 SDK 在桥没回话时既不报错也不
 * reject,页面就一直等下去。
 */
const TP_SDK_METHODS = [
  'isConnected', 'invokeQRScanner', 'shareNewsToSNS', 'getAppInfo', 'getDeviceId', 'getWalletList',
  'getWallets', 'getCurrentWallet', 'sign', 'back', 'fullScreen', 'setMenubar', 'close', 'importWallet',
  'startChat', 'getNodeUrl', 'saveImage', 'rollHorizontal', 'popGestureRecognizerEnable',
  'forwardNavigationGesturesEnable', 'isDarkMode', 'eosTokenTransfer', 'pushEosAction', 'getEosBalance',
  'getTableRows', 'getEosTableRows', 'getEosAccountInfo', 'getEosTransactionRecord', 'eosAuthSign',
  'enuTokenTransfer', 'pushEnuAction', 'getEnuBalance', 'getEnuTableRows', 'getEnuAccountInfo',
  'getEnuTransactionRecord', 'pushMoacTransaction', 'moacTokenTransfer', 'sendMoacTransaction',
  'sendEthTransaction', 'signMoacTransaction', 'signEthTransaction', 'signCosmosTransaction',
  'cosmosArbitrarySignature', 'signJingtumTransaction', 'signOkexchainTransaction', 'getCurrentBalance',
  'btcTokenTransfer', 'usdtTokenTransfer', 'getUsdtAddress', 'getWallet',
];

describe('TokenPocket SDK 全量方法', () => {
  it('官方 SDK 的每个方法 window.tp 上都有', () => {
    const { win } = runInjected();
    const missing = TP_SDK_METHODS.filter((m) => typeof win.tp[m] !== 'function');
    expect(missing).toEqual([]);
  });

  it('经原生桥调用的每个方法都会应答,没有一个把页面晾着', async () => {
    const { win, sent } = runInjected();
    const answered: Record<string, any> = {};
    const pending = TP_SDK_METHODS.filter((m) => m !== 'isConnected').map(
      (m, i) =>
        new Promise<void>((resolve) => {
          const cb = `tp_cb_${i}`;
          win[cb] = (raw: string) => {
            answered[m] = JSON.parse(raw);
            resolve();
          };
          win.TPJSBrigeClient.callMessage(m, JSON.stringify({ account: 'alice', type: 'eos' }), cb);
        })
    );
    // 需要 App 参与的调用一律按"成功、返回空"应答,只验证链路通不通
    await Promise.resolve();
    sent.forEach((msg) => win.__auroraResolve(msg.id, true, msg.method === 'getIdentity' ? { account: 'alice', publicKey: 'PUB_K1_test' } : null));
    await Promise.all(pending);
    const silent = TP_SDK_METHODS.filter((m) => m !== 'isConnected' && !answered[m]);
    expect(silent).toEqual([]);
  });

  it('其它链的方法回 result:false 并说明原因', async () => {
    const { win } = runInjected();
    for (const m of ['sendEthTransaction', 'signCosmosTransaction', 'btcTokenTransfer', 'getUsdtAddress']) {
      const res = await win.tp[m]({});
      expect(res.result).toBe(false);
      expect(res.msg).toContain('EOS');
    }
  });

  it('getAppInfo 字段名按 SDK 文档:name / system / version / sys_version', async () => {
    const { win } = runInjected();
    await expect(win.tp.getAppInfo()).resolves.toEqual({
      result: true,
      data: { name: 'EOS³ Wallet', system: 'android', version: '1.0.0', sys_version: '14' },
      msg: 'success',
    });
  });

  it('getNodeUrl 带上 blockchain 与 SDK 的链编号', async () => {
    const { win } = runInjected();
    const res = await win.tp.getNodeUrl({ blockchain: 'eos' });
    expect(res.data).toMatchObject({ nodeUrl: 'https://eos.greymass.com', blockchain: 'eos', blockChainId: 4 });
    expect((await win.tp.getNodeUrl({ blockChainId: '1' })).result).toBe(false);
  });

  it('invokeQRScanner 直接 resolve 扫到的字符串,和 SDK 一致', async () => {
    const { win, sent, settle } = runInjected();
    const p = win.tp.invokeQRScanner();
    await Promise.resolve();
    expect(sent[sent.length - 1].method).toBe('scanQR');
    settle('scanQR', 'eos3aiagent2');
    await expect(p).resolves.toBe('eos3aiagent2');
  });

  it('返回、关闭、全屏这类调用按 SDK 约定不返回值,但会通知到 App', () => {
    const { win, sent } = runInjected();
    expect(win.tp.back()).toBeUndefined();
    expect(win.tp.fullScreen({ fullScreen: 1 })).toBeUndefined();
    const methods = sent.map((m) => m.method);
    expect(methods).toEqual(expect.arrayContaining(['goBack', 'fullScreen']));
    expect(sent.find((m) => m.method === 'fullScreen').params).toEqual({ on: true });
  });

  it('getEosBalance / getEosTransactionRecord 缺必填参数时抛错,照抄 SDK 的页面侧校验', () => {
    const { win } = runInjected();
    expect(() => win.tp.getEosBalance({ account: 'alice' })).toThrow('missing params');
    expect(() => win.tp.getEosTransactionRecord({})).toThrow('missing params');
  });

  it('getCurrentBalance 用链上原始字符串,保留代币精度', async () => {
    const { win, settle } = runInjected();
    const p = win.tp.getCurrentBalance();
    settle('getBalance', [{ symbol: 'A', contract: 'core.vaulta', amount: 0.1, precision: 4, raw: '0.1000 A' }]);
    await expect(p).resolves.toEqual({ result: true, data: { balance: '0.1000' }, msg: 'success' });
  });
});
