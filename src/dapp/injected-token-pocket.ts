/** TokenPocket SDK/global adapters. Runs in the untrusted page, with explicit
 * dependencies on the shared bridge, consented identity and signature helpers.
 * Both window.tp and TPJSBrigeClient preserve the SDK response/callback contracts.
 */
export function buildInjectedTokenPocketScript(): string {
  return `
  (function (CFG, call, receiveIdentity, signatureOf) {
  // ---------------- TokenPocket 兼容层 ----------------
  //
  // 接入 TokenPocket 有两种写法,都得支持:
  //
  //   a) 页面把官方的 tp-js-sdk 打进自己的包里。那个 SDK 不看 window.tp,
  //      它把请求发给原生桥 window.TPJSBrigeClient.callMessage(方法名,
  //      JSON 参数, 回调函数名),再等着钱包回头调 window[回调函数名](JSON 字符串)。
  //      桥不存在时 SDK 不报错也不 reject,promise 就一直挂着——页面表现成
  //      点了没反应。所以桥本身必须实现。
  //   b) 页面直接用全局 window.tp。
  //
  // 两种写法共用下面这张分发表,返回值一律是 SDK 文档写的
  // { result, data, msg } 三层结构——过去我们把钱包对象直接摊平返回,
  // 页面按 res.data.name 取值就是 undefined。

  function tpOk(data) { return { result: true, data: data, msg: 'success' }; }
  function tpFail(e) { return { result: false, data: null, msg: String((e && e.message) || e) }; }

  // SDK 用数字编码区分链,EOS 是 4(见 tp-js-sdk 的 TYPE_MAP)。SDK 收到应答后
  // 会把 blockchain_id / blockChainId 翻译回 'eos',所以两套字段都给。
  var TP_EOS_ID = 4;
  function isEosType(t) {
    if (t === undefined || t === null || t === '') return true;
    var v = String(t).toLowerCase();
    return v === 'eos' || v === String(TP_EOS_ID);
  }

  function tpWallet() {
    // SDK 文档里 EOS 钱包的 address 就是公钥,账户名在 name。
    return { name: CFG.account, address: CFG.publicKey, blockchain: 'eos', blockchain_id: TP_EOS_ID };
  }

  function txIdOf(r) { return r && (r.transaction_id || r.transactionId); }

  var NOT_EOS = 'EOS³ Wallet 只支持 EOS / Vaulta,不支持这条链';

  /**
   * 官方 SDK 的每个方法都在这里有一个分支,按用途分四类:
   *   钱包与链上数据 —— 真实实现
   *   页面/壳层操作(扫码、分享、返回、关闭、全屏、存图……)—— 交给 App 处理
   *   我们确实没有的能力 —— 回 result:false 并说明原因
   *   其它链(ETH/Cosmos/MOAC/ENU/BTC/USDT……)—— 我们只管 EOS / Vaulta 的私钥,
   *     签不了别的链,统一回 result:false
   * 没有一个方法会让 promise 一直挂着。
   */
  function tpDispatch(method, params) {
    var p = params || {};
    switch (method) {
      // ---- 钱包与账户 ----
      case 'getCurrentWallet':
        return call('getIdentity').then(function (r) { receiveIdentity(r); return tpOk(tpWallet()); });
      case 'getWallets':
        return call('getIdentity').then(function (r) { receiveIdentity(r); return tpOk([tpWallet()]); });
      case 'getWalletList':
        if (!isEosType(p.type)) return Promise.resolve(tpOk([]));
        return call('getIdentity').then(function (r) { receiveIdentity(r); return tpOk([tpWallet()]); });
      case 'getWallet': {
        var types = p.walletTypes || [];
        var wantsEos = !types.length || types.some(isEosType);
        if (!wantsEos) return Promise.resolve(tpFail(NOT_EOS));
        return call('getIdentity').then(function (r) { receiveIdentity(r); return tpOk([tpWallet()]); });
      }
      case 'getCurrentBalance':
        return call('getBalance', {}).then(function (rows) {
          // 用链上原始字符串里的数字部分,保留代币自己的精度(amount 是浮点数,
          // 0.1 这种值会丢掉末尾的 0)
          var first = Array.isArray(rows) ? rows[0] : rows;
          var balance = first && first.raw ? String(first.raw).split(' ')[0] : '0';
          return tpOk({ balance: balance });
        });

      // ---- App 与环境信息 ----
      case 'getAppInfo':
        return Promise.resolve(tpOk({
          name: 'EOS³ Wallet',
          system: CFG.platform,
          version: CFG.appVersion,
          sys_version: CFG.systemVersion,
        }));
      case 'getDeviceId':
        return call('getDeviceId').then(function (id) {
          var res = tpOk(id);
          res.device_id = id;
          return res;
        });
      case 'isDarkMode':
        return Promise.resolve(tpOk(!!CFG.darkMode));
      case 'getNodeUrl':
        if (!isEosType(p.blockChainId || p.blockchain)) return Promise.resolve(tpFail(NOT_EOS));
        return Promise.resolve(tpOk({ nodeUrl: CFG.nodeUrl, blockchain: 'eos', blockChainId: TP_EOS_ID, chainId: CFG.chainId }));

      // ---- EOS 交易与签名 ----
      case 'pushEosAction':
        return call('requestSignature', { actions: p.actions || [], chainId: p.chainId }).then(function (r) {
          return tpOk({ transactionId: txIdOf(r) });
        });
      case 'eosTokenTransfer': {
        var digits = p.precision === undefined ? 4 : Number(p.precision);
        var quantity = Number(p.amount).toFixed(digits) + ' ' + p.tokenName;
        return call('requestSignature', {
          chainId: p.chainId,
          actions: [
            {
              account: p.contract,
              name: 'transfer',
              authorization: [{ actor: p.from || CFG.account, permission: 'active' }],
              data: { from: p.from || CFG.account, to: p.to, quantity: quantity, memo: p.memo || '' },
            },
          ],
        }).then(function (r) {
          return tpOk({ transactionId: txIdOf(r) });
        });
      }
      case 'eosAuthSign':
        return call('arbitrarySignature', {
          data: p.signdata !== undefined ? p.signdata : p.data,
          publicKey: p.publicKey,
        }).then(function (r) {
          return tpOk({ signature: signatureOf(r) });
        });
      // tp.sign 在 SDK 文档里没写参数形态。只有带文本内容时才当作文本签名处理
      // (走同一条要用户确认、只签可读文本的通道),其它形态不猜。
      case 'sign': {
        var text = typeof p.data === 'string' ? p.data : typeof p.message === 'string' ? p.message : null;
        if (text === null) return Promise.resolve(tpFail('tp.sign 只支持对文本签名'));
        return call('arbitrarySignature', { data: text }).then(function (r) {
          return tpOk({ signature: signatureOf(r) });
        });
      }

      // ---- EOS 链上读取 ----
      case 'getEosBalance':
        return call('getBalance', { account: p.account, contract: p.contract, symbol: p.symbol }).then(tpOk);
      case 'getEosAccountInfo':
        return call('getAccount', { account: p.account }).then(tpOk);
      case 'getTableRows':
      case 'getEosTableRows':
        return call('getTableRows', p).then(tpOk);
      case 'getEosTransactionRecord':
        return call('getActions', {
          account: p.account,
          start: p.start || 0,
          count: p.count || 10,
          sort: p.sort,
          token: p.token,
          contract: p.contract,
        }).then(tpOk);

      // ---- 页面与壳层操作,交给 App ----
      case 'invokeQRScanner':
        return call('scanQR').then(function (text) {
          var res = tpOk(text);
          res.qrResult = text;
          return res;
        });
      case 'shareNewsToSNS':
        return call('share', { title: p.title, description: p.description || p.desc, url: p.url }).then(tpOk);
      case 'back':
        return call('goBack').then(tpOk);
      case 'close':
        return call('closeBrowser').then(tpOk);
      case 'fullScreen':
        return call('fullScreen', { on: Number(p.fullScreen) === 1 }).then(tpOk);
      case 'setMenubar':
        return call('setMenubar', { visible: Number(p.flag) === 1 }).then(tpOk);
      case 'importWallet':
        if (!isEosType(p.blockChainId || p.type)) return Promise.resolve(tpFail(NOT_EOS));
        return call('importWallet').then(tpOk);
      case 'saveImage':
        return call('saveImage', { url: p.url }).then(tpOk);
      case 'forwardNavigationGesturesEnable':
        return call('setNavGestures', { enabled: !!(p.enable !== undefined ? p.enable : p.enabled) }).then(tpOk);
      case 'addDAppToDiscover':
        return call('addFavorite', { url: p.url, name: p.name }).then(tpOk);

      // ---- 我们确实没有的能力 ----
      case 'startChat':
        return Promise.resolve(tpFail('EOS³ Wallet 没有聊天功能'));
      case 'rollHorizontal':
        return Promise.resolve(tpFail('EOS³ Wallet 只支持竖屏'));
      case 'popGestureRecognizerEnable':
        return Promise.resolve(tpFail('EOS³ Wallet 的 DApp 浏览器没有侧滑关闭手势'));

      // ---- 其它链 ----
      default:
        return Promise.resolve(tpFail(NOT_EOS + '(tp.' + method + ')'));
    }
  }

  // 官方 SDK 唯一依赖的入口。参数是 JSON 字符串,应答也必须是 JSON 字符串,
  // 而且只能通过全局回调函数名回传——SDK 里写死了这套约定。返回、关闭、
  // 全屏这类方法 SDK 传的回调名是空串,不需要应答。
  window.TPJSBrigeClient = {
    callMessage: function (method, paramsJson, callbackName) {
      var params = {};
      try { params = paramsJson ? JSON.parse(paramsJson) : {}; } catch (e) {}
      tpDispatch(method, params)
        .catch(tpFail)
        .then(function (res) {
          var fn = callbackName && window[callbackName];
          if (typeof fn === 'function') fn(JSON.stringify(res));
        });
    },
  };

  // 直接用全局 window.tp 的页面走这里,方法名和返回结构跟官方 SDK 对齐。
  // 失败也 resolve 成 { result:false },不 reject —— SDK 里只有 JSON 解析失败
  // 才会 reject,业务失败一律走 result 字段。页面普遍只写 .then 不写 .catch,
  // 这里 reject 出去会变成没人处理的 promise 异常,表现成点了没反应。
  function tpMethod(name) {
    return function (params) { return tpDispatch(name, params).catch(tpFail); };
  }

  window.tp = {
    version: '3.7.14',
    isConnected: function () { return true; },

    getCurrentWallet: tpMethod('getCurrentWallet'),
    getWallets: tpMethod('getWallets'),
    // 下面几个方法 SDK 会先在页面侧校验参数、不合法直接抛错,行为照抄
    getWalletList: function (type) {
      if (!type) throw new Error('type invalid');
      return tpDispatch('getWalletList', { type: type }).catch(tpFail);
    },
    getWallet: function (params) { return tpDispatch('getWallet', params || {}).catch(tpFail); },
    getCurrentBalance: tpMethod('getCurrentBalance'),

    getAppInfo: tpMethod('getAppInfo'),
    getDeviceId: tpMethod('getDeviceId'),
    isDarkMode: tpMethod('isDarkMode'),
    getNodeUrl: tpMethod('getNodeUrl'),

    pushEosAction: tpMethod('pushEosAction'),
    eosTokenTransfer: tpMethod('eosTokenTransfer'),
    eosAuthSign: tpMethod('eosAuthSign'),
    sign: tpMethod('sign'),

    getEosBalance: function (params) {
      var q = params || {};
      if (!q.account || !q.contract || !q.symbol) {
        throw new Error('missing params; "account", "contract", "symbol" is required ');
      }
      return tpDispatch('getEosBalance', q).catch(tpFail);
    },
    getEosAccountInfo: tpMethod('getEosAccountInfo'),
    getTableRows: tpMethod('getTableRows'),
    getEosTableRows: tpMethod('getEosTableRows'),
    getEosTransactionRecord: function (params) {
      var q = params || {};
      if (!q.account) throw new Error('missing params; "account" is required ');
      return tpDispatch('getEosTransactionRecord', q).catch(tpFail);
    },

    // SDK 里扫码直接 resolve 扫到的字符串,不是三层结构
    invokeQRScanner: function () {
      return tpDispatch('invokeQRScanner').then(function (r) { return r.qrResult || ''; }, function () { return ''; });
    },
    // 以下在 SDK 里都是"发出去就不管"的调用,没有返回值
    shareNewsToSNS: function (params) { tpDispatch('shareNewsToSNS', params).catch(function () {}); },
    back: function () { tpDispatch('back').catch(function () {}); },
    close: function () { tpDispatch('close').catch(function () {}); },
    fullScreen: function (params) { tpDispatch('fullScreen', params).catch(function () {}); },
    setMenubar: function (params) { tpDispatch('setMenubar', params).catch(function () {}); },
    importWallet: function (type) {
      if (!type) throw new Error('type invalid');
      tpDispatch('importWallet', { type: type }).catch(function () {});
    },
    saveImage: function (params) { tpDispatch('saveImage', params).catch(function () {}); },
    forwardNavigationGesturesEnable: function (params) { tpDispatch('forwardNavigationGesturesEnable', params).catch(function () {}); },
    popGestureRecognizerEnable: function (params) { tpDispatch('popGestureRecognizerEnable', params).catch(function () {}); },
    rollHorizontal: function (params) { tpDispatch('rollHorizontal', params).catch(function () {}); },
    startChat: function (params) { tpDispatch('startChat', params).catch(function () {}); },
  };

  // 官方 SDK 里其它链的方法。我们只有 EOS / Vaulta 的私钥,签不了这些链,
  // 但方法本身得在:页面按 SDK 调过来拿到 result:false 还能走自己的兜底,
  // 方法不存在就是 "is not a function",整段逻辑直接崩掉。
  [
    'enuTokenTransfer', 'pushEnuAction', 'getEnuBalance', 'getEnuTableRows', 'getEnuAccountInfo',
    'getEnuTransactionRecord', 'pushMoacTransaction', 'moacTokenTransfer', 'sendMoacTransaction',
    'signMoacTransaction', 'sendEthTransaction', 'signEthTransaction', 'signCosmosTransaction',
    'cosmosArbitrarySignature', 'signJingtumTransaction', 'signOkexchainTransaction',
    'btcTokenTransfer', 'usdtTokenTransfer', 'getUsdtAddress',
  ].forEach(function (name) {
    window.tp[name] = tpMethod(name);
  });

  })(CFG, call, receiveIdentity, signatureOf);
`;
}
