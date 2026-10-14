import { buildInjectedTokenPocketScript } from './injected-token-pocket';
import { buildInjectedEsrScript } from './injected-esr';

/**
 * 注入到 DApp 页面的钱包 provider。
 *
 * ⚠️ 安全模型:这段代码运行在**不可信的页面上下文**里。
 * 它绝不能持有私钥,只能通过 postMessage 把请求转给 App,
 * 由 App 弹窗让用户逐字段确认后再签名。页面无法绕过确认。
 *
 * 兼容三套接口(EOS 生态没有统一标准,DApp 各认各的):
 *   window.scatter —— 事实标准,绝大多数 EOS DApp 支持
 *   window.tp      —— TokenPocket 自有接口
 *   ESR (esr:)     —— Antelope 官方签名请求协议,由 App 侧拦截链接处理
 *
 * window.scatter 这套按 scatter-js 2.0 的钱包契约给全:方法清单见
 * scatterjs-core 的 models/WalletInterface.js(WALLET_METHODS 是必须提供的
 * 方法,ALTERNATES 定义 login/logout/checkLogin 三个别名)。少一个方法的
 * 后果不是报错而是 DApp 静默连不上,所以 injected.test.ts 里对着这份清单
 * 逐项验收。
 *
 * 关键细节:Scatter 协议要求在注入后派发 `scatterLoaded` 事件 ——
 * DApp 若在注入前就执行,会挂监听等这个事件,不发就一直转圈。
 */
export function buildInjectedScript(opts: {
  account: string;
  publicKey: string;
  chainId: string;
  chainName: string;
  canSign: boolean;
  /** BCP47 标签,如 'zh-CN' —— 用来覆盖 navigator.language,让 DApp 能读到
   *  钱包当前语言,和真实浏览器暴露语言给网页的行为一致 */
  locale: string;
  /** 当前节点地址 —— TokenPocket 的 getNodeUrl 要用 */
  nodeUrl: string;
  /** 'android' | 'ios' —— TokenPocket 的 getAppInfo 要用 */
  platform: string;
  /** App 版本号 —— 同上 */
  appVersion: string;
  /** 系统版本号 —— TokenPocket 的 getAppInfo 里叫 sys_version */
  systemVersion: string;
  /** App 当前是否深色模式 —— TokenPocket 的 isDarkMode 要用 */
  darkMode: boolean;
  /** Native bridge capability; injected only into the top-level document. */
  bridgeToken?: string;
}): string {
  // Account identity enters the page only after native consent.
  const cfg = JSON.stringify({ ...opts, account: '', publicKey: '' });

  return `
(function () {
  if (window.__auroraInjected) return;
  window.__auroraInjected = true;

  var CFG = ${cfg};
  var pending = {};
  var seq = 0;
  var documentId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  window.__auroraDocumentId = documentId;

  // 让页面能读到钱包当前用的语言,和真实浏览器暴露 navigator.language/languages
  // 给网页的行为一致——DApp 常靠这个字段决定首屏用哪个语言渲染,不覆盖的话
  // 网页只能按系统/WebView 默认语言走,跟用户在钱包里选的语言对不上。
  // navigator.language 默认是只读 getter,直接赋值不会生效,要用 defineProperty。
  try {
    Object.defineProperty(navigator, 'language', {
      get: function () { return CFG.locale; },
      configurable: true,
    });
    Object.defineProperty(navigator, 'languages', {
      get: function () { return [CFG.locale]; },
      configurable: true,
    });
  } catch (e) {}

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = documentId + ':' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      window.ReactNativeWebView.postMessage(JSON.stringify({ id: id, documentId: documentId, bridgeToken: CFG.bridgeToken, method: method, params: params }));
    });
  }

  // App 回调入口
  window.__auroraResolve = function (id, ok, payload) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (ok) p.resolve(payload);
    else p.reject(typeof payload === 'string' ? new Error(payload) : payload);
  };

  // 当前账户变化时由 App 主动调用,通知 DApp
  window.__auroraSetAccount = function (account, publicKey) {
    CFG.account = account;
    CFG.publicKey = publicKey;
    if (scatter.identity) scatter.identity = buildIdentity();
    window.dispatchEvent(new Event('aurora#accountChanged'));
    fireScatterEvent('accountChanged', buildIdentity());
  };

  // scatter-js 2.0 的事件订阅(addEventHandler/listen)。DApp 用它监听用户
  // 在钱包里切账户/退出,不发通知的话页面会一直显示旧账户。
  var scatterHandlers = [];
  function fireScatterEvent(type, payload) {
    scatterHandlers.slice().forEach(function (entry) {
      try { entry.handler(type, payload); } catch (e) {}
    });
  }

  // eosjs2 的 serializedTransaction 是 Uint8Array,但经过某些封装后也可能
  // 已经是十六进制字符串。统一成十六进制再过 postMessage——二进制数组塞进
  // JSON 会变成 {"0":1,"1":2,...} 这种对象,到 App 侧就还原不回来了。
  function toHex(v) {
    if (typeof v === 'string') return v;
    var bytes = v && v.length !== undefined ? v : [];
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += ('0' + (bytes[i] & 255).toString(16)).slice(-2);
    }
    return out;
  }

  function signatureOf(r) {
    return r && typeof r === 'object' && r.signature ? r.signature : r;
  }

  function buildAccount() {
    return {
      name: CFG.account,
      authority: 'active',
      publicKey: CFG.publicKey,
      blockchain: 'eos',
      chainId: CFG.chainId,
      isHardware: false,
    };
  }

  function buildIdentity() {
    return {
      // Scatter 的 identity 需要一个稳定 hash,用账户名派生即可
      hash: CFG.account,
      publicKey: CFG.publicKey,
      name: CFG.account,
      kyc: false,
      accounts: [buildAccount()],
    };
  }

  function receiveIdentity(r) {
    if (!r || !r.account) throw new Error('Wallet connection required');
    CFG.account = r.account;
    CFG.publicKey = r.publicKey || '';
    scatter.identity = buildIdentity();
    return scatter.identity;
  }

  // ---------------- Scatter 兼容层 ----------------

  var scatter = {
    identity: null,
    isExtension: false,
    // 部分 DApp 用版本号判断能力
    version: { version: '11.0.0', build: 'eos3' },
    wallet: 'EOS³ Wallet',

    getIdentity: function () {
      return call('getIdentity').then(function (r) {
        return receiveIdentity(r);
      });
    },

    /** Silent permission check; it must never open a connection prompt. */
    getIdentityFromPermissions: function () {
      if (scatter.identity) return Promise.resolve(scatter.identity);
      return call('getIdentityFromPermissions')
        .then(receiveIdentity)
        .catch(function () { return null; });
    },

    forgetIdentity: function () {
      scatter.identity = null;
      CFG.account = '';
      CFG.publicKey = '';
      fireScatterEvent('logout', null);
      return call('forgetIdentity').catch(function () {}).then(function () { return true; });
    },

    /**
     * scatter-js 2.0 在 connect() 成功后会用 WalletInterface 把 login/logout/
     * checkLogin 补成 getIdentity/forgetIdentity/getIdentityFromPermissions 的别名。
     * 但很多 DApp 是直接对着注入对象调 window.scatter.login() 的,压根不走
     * connect(),那时候别名还不存在——所以这三个我们自己就得给出来。
     */
    login: function (requiredFields) {
      return scatter.getIdentity(requiredFields);
    },
    logout: function () {
      return scatter.forgetIdentity();
    },
    checkLogin: function () {
      return scatter.getIdentityFromPermissions();
    },

    /**
     * ScatterJS.connect(name, { network }) 里会无条件执行
     * window.scatter.useIdentity.bind(window.scatter)——这个方法不存在的话,
     * bind 直接在 undefined 上抛错,整个 2.0 的连接流程当场断掉,DApp 那边
     * 表现成"连不上钱包"。它本身只是把选中的身份回写给钱包对象。
     */
    useIdentity: function (identity) {
      if (identity) scatter.identity = identity;
      return true;
    },

    updateIdentity: function () {
      // 改身份名字/头像这类钱包内的事,不开放给页面改,当作没变化
      return Promise.resolve(scatter.identity);
    },

    getVersion: function () {
      return Promise.resolve(scatter.version.version);
    },

    isPaired: function () {
      return Promise.resolve(true);
    },

    /**
     * 身份在这条网络上有没有账户。我们一次只连一条链,所以只要页面给的
     * chainId 和当前链一致就算有;没给 chainId 就当它问的是当前链。
     */
    hasAccountFor: function (network) {
      var id = network && (network.chainId || network.chain_id);
      return Promise.resolve(!id || String(id) === String(CFG.chainId));
    },

    /** WalletInterface.bindBasics 会补这个helper,同样不能只等 connect() */
    account: function (blockchain) {
      if (!scatter.identity || !scatter.identity.accounts) return undefined;
      return scatter.identity.accounts.filter(function (a) {
        return a.blockchain === blockchain;
      })[0];
    },

    addEventHandler: function (handler, key) {
      if (typeof handler !== 'function') return;
      scatterHandlers.push({ handler: handler, key: key });
    },
    removeEventHandler: function (handler, key) {
      scatterHandlers = scatterHandlers.filter(function (entry) {
        if (key) return entry.key !== key;
        return entry.handler !== handler;
      });
    },
    listen: function (handler) {
      scatter.addEventHandler(handler);
    },

    /**
     * 简单转账。Scatter 的语义是钱包自己拼 transfer action 走确认弹窗,
     * 页面只给收款方和金额。精度必须由页面给准,拼错了链上会直接拒收,
     * 所以缺参数时明确报错,不猜。
     */
    requestTransfer: function (network, to, amount, options) {
      var opt = options || {};
      var symbol = opt.symbol || opt.tokenName;
      var contract = opt.contract || 'eosio.token';
      var precision = opt.precision === undefined ? opt.decimals : opt.precision;
      if (!to || !symbol) {
        return Promise.reject(new Error('requestTransfer 需要 to 和 options.symbol'));
      }
      var digits = precision === undefined ? 4 : Number(precision);
      var quantity = Number(amount).toFixed(digits) + ' ' + symbol;
      return call('requestSignature', {
        chainId: network && network.chainId,
        actions: [
          {
            account: contract,
            name: 'transfer',
            authorization: [{ actor: CFG.account, permission: 'active' }],
            data: { from: CFG.account, to: to, quantity: quantity, memo: opt.memo || '' },
          },
        ],
      });
    },

    // 下面这几个是钱包内部管理动作(往身份里挂新账户、往钱包里加代币、
    // 桌面版的待签事务)。我们不支持,明确抛错让 DApp 走它的兜底分支,
    // 比假装成功、让用户以为已经生效要好。
    linkAccount: function () {
      return Promise.reject(new Error('EOS³ Wallet 不支持 linkAccount'));
    },
    addToken: function () {
      return Promise.reject(new Error('EOS³ Wallet 不支持由页面添加代币'));
    },
    createTransaction: function () {
      return Promise.reject(new Error('EOS³ Wallet 不支持 createTransaction'));
    },

    // 网络建议 —— 我们只支持已配置的链,直接接受
    suggestNetwork: function () {
      return Promise.resolve(true);
    },

    // Scatter 约定这两个方法返回签名字符串本身。App 侧应答是
    // { signature, publicKey },这里拆出字符串——页面拿到后常直接喂给
    // Signature.from(...),给个对象进去当场抛错(1dex 登录签名就是这么写的)。
    authenticate: function (nonce) {
      return call('arbitrarySignature', { data: nonce }).then(signatureOf);
    },

    getArbitrarySignature: function (publicKey, data) {
      return call('arbitrarySignature', { data: data, publicKey: publicKey }).then(signatureOf);
    },

    getPublicKey: function () {
      return Promise.resolve(CFG.publicKey);
    },

    /**
     * 签名请求。Scatter 的 payload 在各实现之间形态不一样,分两条路走:
     *
     * 1. 页面自己已经把交易序列化好了(eosjs2 的 signatureProvider 就是这样,
     *    signargs 里带 serializedTransaction)。这种情况钱包只负责出签名,
     *    广播由页面的 eosjs 自己做——必须原样返回 { signatures },替它广播
     *    会让它拿着同一笔交易再推一次,链上按重复交易拒掉。
     * 2. 只给了 actions。这种形态下页面手里没有我们拼的那笔交易,光给签名它
     *    也广播不了,只能由钱包拼好、签名、推上链,返回交易号——TokenPocket
     *    在这种形态下也是这么做的。
     */
    requestSignature: function (payload) {
      var tx = (payload && payload.transaction) || {};
      if (tx.serializedTransaction) {
        return call('signTransaction', {
          serializedTransaction: toHex(tx.serializedTransaction),
          chainId: (payload.network && payload.network.chainId) || tx.chainId,
        });
      }
      var actions = tx.actions || (payload && payload.actions) || [];
      return call('requestSignature', { actions: actions, payload: payload });
    },

    requestTransaction: function (payload) {
      return scatter.requestSignature(payload);
    },

    /**
     * scatter.eos(network, Api, options) —— 有两代调用方式,按第二个参数区分:
     *
     * eosjs2:ScatterJS.eos(network, Api, { rpc }),第二个参数是 eosjs 的 Api
     *   类。调用方要的是一个真正的 Api 实例:wharfkit 的 Scatter 协议(1dex 等
     *   站点的 TokenPocket 通道就走它)会接着调 deserializeTransactionWithActions
     *   和 transact(tx, { broadcast: false }),期待拿回 { serializedTransaction,
     *   signatures }——签名归钱包,广播归页面。所以这里用页面自己给的 Api 类
     *   new 一个实例,只把 signatureProvider 换成我们的,签名请求落到 App 的
     *   "只签名"通道(解码交易、弹确认框、校验链、出签名),其余全用 eosjs 原生实现。
     *
     * eosjs1:scatter.eos(network, Eos, options),老站点用。返回一个带
     *   transact/transaction 的对象,钱包拼交易并广播。
     */
    eos: function (network, Api, options) {
      var isEosjs2Api = typeof Api === 'function' && Api.prototype && typeof Api.prototype.transact === 'function';
      if (isEosjs2Api) {
        var signatureProvider = {
          getAvailableKeys: function () {
            return Promise.resolve(CFG.publicKey ? [CFG.publicKey] : []);
          },
          sign: function (args) {
            // 带 context-free data 的交易,签名摘要要把它的哈希也算进去;App 侧
            // 按无 CFD 算摘要,签出来会是无效签名。这种交易极少见,明确拒绝,
            // 不给一个链上会被拒的签名。
            var cfd = args && args.serializedContextFreeData;
            if (cfd && cfd.length) {
              return Promise.reject(new Error('EOS³ Wallet 不支持带 context-free data 的交易'));
            }
            return call('signTransaction', {
              serializedTransaction: toHex(args.serializedTransaction),
              chainId: args.chainId,
            }).then(function (r) {
              return { signatures: (r && r.signatures) || [], serializedTransaction: args.serializedTransaction };
            });
          },
        };
        var opts = {};
        for (var k in options || {}) opts[k] = options[k];
        opts.signatureProvider = signatureProvider;
        return new Api(opts);
      }

      return {
        transact: function (tx) {
          return call('requestSignature', { actions: (tx && tx.actions) || [], chainId: (network && network.chainId) || (tx && tx.chainId) });
        },
        transaction: function (tx) {
          return call('requestSignature', { actions: (tx && tx.actions) || [], chainId: (network && network.chainId) || (tx && tx.chainId) });
        },
        getAccount: function (name) {
          return call('getAccount', { account: name });
        },
      };
    },

    connect: function () { return Promise.resolve(true); },
    disconnect: function () { return Promise.resolve(true); },
    isConnected: function () { return Promise.resolve(true); },
  };

  window.scatter = scatter;

  ${buildInjectedTokenPocketScript()}

  // Anchor/ESR page transport uses the same link rules as native navigation.
  ${buildInjectedEsrScript()}

  // ---------------- 就绪通知 ----------------
  // DApp 若先于注入执行,会挂 scatterLoaded 监听等这个事件。
  // 两种派发方式都发,覆盖不同实现。
  try {
    document.dispatchEvent(new CustomEvent('scatterLoaded'));
    window.dispatchEvent(new CustomEvent('scatterLoaded'));
  } catch (e) {}
  try {
    document.dispatchEvent(new CustomEvent('tpLoaded'));
  } catch (e) {}

  window.__aurora = { version: 'aurora-1', account: CFG.account };
  true;
})();
`;
}
