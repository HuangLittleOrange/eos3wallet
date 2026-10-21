import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Linking,
  Share,
  Platform,
  Image,
  Keyboard,
  AppState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { captureRef } from 'react-native-view-shot';

import { colors, spacing } from '../theme';
import { currentAppVersion } from '../update/appUpdate';
import { useWallet } from '../chain/WalletContext';
import ConfirmTxSheet from '../components/ConfirmTxSheet';
import DappMoreSheet from '../components/DappMoreSheet';
import WalletListSheet from '../components/WalletListSheet';
import { Checksum256, Transaction } from '@wharfkit/antelope';
import { ActionSpec, Signer, signDigest, transact } from '../chain/transact';
import { useResourceRepair } from '../components/ResourceRepairSheet';
import { signingPermission } from '../crypto/vault';
import { biometricSigner, passkeySigner, passwordSigner } from '../chain/signers';
import { buildInjectedScript } from '../dapp/injected';
import { DappAccessGuard, dappPageOrigin, secureDappOrigin } from '../dapp/accessGuard';
import { dappSessionFailureCode } from '../dapp/sessionFailure';
import EsrFlowOverlay from '../dapp/esr-flow-overlay';
import { navigationRef } from '../navigation/navigationRef';
import { decodeSerializedTransaction } from '../dapp/decodeTx';
import { assertActionRequestChain, prepareActionRequest } from '../dapp/actionRequest';
import { assertVisibleTransaction } from '../chain/transactionSafety';
import { shouldInvalidateBackground } from '../crypto/systemAuthentication';
import { useBrowserEsr } from '../dapp/use-browser-esr';
import { useTokenPocketBrowser } from '../dapp/use-token-pocket-browser';
import { transactionWallet } from '../chain/transactionWallet';
import { tokenPocketUserAgent } from '../dapp/token-pocket-user-agent';
import { preflightDappResources } from '../dapp/resourcePreflight';
import { addDappHistory, isDappFavorite, listDappHistory, setDappThumbnail, toggleDappFavorite } from '../dapp/dappGate';
import { useDappSession } from '../dapp/DappSessionContext';
import { addBackHandler } from '../components/ModalHost';
import { useI18n, BCP47 } from '../i18n';

const BLUE = '#1E88FF';

/** 顶栏钱包头像右下角的链角标 —— 跟 TokenPocket 一样,一眼看出当前签名用的是哪条链 */
const CHAIN_BADGE: Record<string, any> = {
  vaulta: require('../../assets/tokens/vaulta.png'),
  jungle4: require('../../assets/tokens/eos.png'),
};

// Google 翻译的目标语言代码,跟着 App 当前语言走,不再写死中文
const TRANSLATE_TARGET: Record<string, string> = { zh: 'zh-CN', en: 'en', ko: 'ko', vi: 'vi', ja: 'ja', ru: 'ru' };

type Req = { id: string; method: string; params?: any; isCurrent?: () => boolean };

export default function DappBrowserScreen() {
  const insets = useSafeAreaInsets();
  const { session, minimize: minimizeSession, close: closeSession } = useDappSession();
  const w = useWallet();
  const { locale, t } = useI18n();
  const webRef = useRef<WebView>(null);
  const urlInputRef = useRef<TextInput>(null);
  /** 包住 WebView 的容器 —— 截图只截页面本身,不带地址栏/连接状态条 */
  const webWrapRef = useRef<View>(null);

  // DappOverlayHost 只在 session 非空时才挂载这个组件,session.url 这里
  // 理论上总是有值——`?? 'about:blank'` 纯粹是防御性兜底,不依赖任何
  // 第三方站点(历史上这里还接过扫码/推送来的签名请求、用 'https://bloks.io'
  // 当占位页,那类请求现在整个搬到 EsrRequestHost.tsx 去了,不再经过这里)。
  const initial = session?.url ?? 'about:blank';
  const [url, setUrl] = useState(initial);
  const [input, setInput] = useState(initial);
  /** WebView 实际所在的页面地址(含站内跳转)——锁图标、请求来源展示都跟着它走,
   *  不能跟着 url(那只是"最近一次主动前往"的地址,页面自己跳走了它不变) */
  const [navUrl, setNavUrl] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  /** DApp 是否已通过 getIdentity 建立连接 */
  const [connected, setConnected] = useState(false);
  const access = useRef(new DappAccessGuard());
  const bridgeToken = useRef(Crypto.randomUUID());
  const currentUrl = useRef(initial);
  const pendingRequest = useRef<string | null>(null);
  const submitting = useRef(false);
  const pendingConnection = useRef<string | null>(null);
  const sessionFailureNotice = useRef<object | null>(null);
  const mounted = useRef(true);

  const [req, setReq] = useState<Req | null>(null);
  const [actions, setActions] = useState<ActionSpec[] | null>(null);
  /**
   * 这次确认弹窗按下去要做什么:
   *   broadcast —— 页面只给了 actions,交易由钱包拼好、签名、推上链
   *   signOnly  —— 页面自己把交易序列化好了,钱包只出签名,广播归页面
   *   message   —— 对一段文本出签名(登录验证),不涉及任何链上动作
   */
  const [pendingKind, setPendingKind] = useState<'broadcast' | 'signOnly' | 'message'>('broadcast');
  const [pendingTx, setPendingTx] = useState<Transaction | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  /** 底部工具栏的前进/后退按钮要按页面历史置灰 */
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  /** 顶栏平时只显示域名,点一下才展开成完整网址供编辑——参考 TokenPocket */
  const [editingUrl, setEditingUrl] = useState(false);
  /** 底部工具栏标签页按钮上的数字,和发现页右上角那个是同一份数据 */
  const [tabCount, setTabCount] = useState(0);
  /** dApp 在 requestSignature 里为当前账户显式指定的权限(如 owner/自定义权限)——
   *  没指定或多个 action 指定不一致时为 null,退回钱包卡片的默认权限 */
  const [reqPermission, setReqPermission] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const repair = useResourceRepair(w, { onCancel: setTxErr });

  const browserEsr = useBrowserEsr(setUrl);

  /** 右上角「更多」面板 —— 对齐 TP 的网站工具面板 */
  const [moreSheet, setMoreSheet] = useState(false);
  const [walletSheet, setWalletSheet] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [siteName, setSiteName] = useState('');
  const browserUserAgent = useMemo(() => tokenPocketUserAgent(Platform.OS, Platform.Version, (Platform as any).constants), []);

  const wallet = transactionWallet(w);
  const isPasskey = wallet?.source === 'passkey';
  // 本机密钥(明文私钥/助记词或 passkey)均可在任意网络签名广播,含主网
  const canSign = !!wallet;
  // 钱包卡片默认权限;dApp 在请求里为当前账户显式指定了权限时优先用它
  // (见 prepareActionRequest)——确认弹窗会原样展示 actor@permission,
  // owner 权限另有醒目警告,用户看到的就是实际要签的。
  const permission = signingPermission(wallet);
  const effectivePermission = reqPermission ?? permission;


  const activeKey =
    wallet?.publicKey || w.resources?.permissions.find((p) => p.name === 'active')?.keys[0] || '';
  const walletContext = JSON.stringify([wallet?.id, w.account, w.client.config.chainIdHash, w.node.url, activeKey]);
  const contextRef = useRef(walletContext);
  contextRef.current = walletContext;

  useEffect(() => {
    sessionFailureNotice.current = null;
    access.current.navigate(currentUrl.current, walletContext);
    pendingRequest.current = null;
    pendingConnection.current = null;
    setConnected(false);
    setActions(null);
    setReq(null);
    setPendingTx(null);
    setPendingMessage(null);
    webRef.current?.reload();
  }, [walletContext]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      access.current.navigate('about:blank', '');
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'background' || !shouldInvalidateBackground()) return;
      access.current.cancelPending();
      pendingRequest.current = null;
      pendingConnection.current = null;
      setActions(null); setReq(null); setPendingTx(null); setPendingMessage(null);
    });
    return () => sub.remove();
  }, []);

  const injected = useMemo(
    () =>
      buildInjectedScript({
        account: w.account,
        publicKey: activeKey,
        // 必须是链的真实 chain_id 哈希——Scatter 生态的 DApp 拿这个字段和它
        // 自己配置的网络比对,给内部 slug('vaulta')是对不上的
        chainId: w.client.config.chainIdHash,
        chainName: w.client.config.name,
        canSign,
        locale: BCP47[locale],
        nodeUrl: w.node.url,
        platform: Platform.OS,
        appVersion: currentAppVersion(),
        systemVersion: String(Platform.Version),
        // app.json 固定 userInterfaceStyle: light,App 没有深色模式
        darkMode: false,
        bridgeToken: bridgeToken.current,
      }),
    [w.account, activeKey, w.client.config, w.node.url, canSign, locale]
  );

  const reply = useCallback((id: string, ok: boolean, payload: any) => {
    if (!mounted.current || !access.current.finish(id, contextRef.current)) return;
    if (pendingRequest.current === id) pendingRequest.current = null;
    if (pendingConnection.current === id) pendingConnection.current = null;
    const js = `window.__auroraResolve(${JSON.stringify(id)}, ${ok}, ${JSON.stringify(payload)}); true;`;
    webRef.current?.injectJavaScript(js);
  }, []);

  const tokenPocket = useTokenPocketBrowser({
    client: w.client, account: w.account, url, pageUrl: navUrl, reply,
    isConnected: () => access.current.connected(),
    goBack: () => webRef.current?.goBack(),
    close: () => { void close(); },
    importWallet: async () => {
      await minimize();
      if (navigationRef.isReady()) navigationRef.navigate('Import');
    },
    onFavorited: () => setFavorited(true),
  });
  const { fullScreen, menubarInFullScreen, navGestures } = tokenPocket;

  const onMessage = useCallback(
    async (e: WebViewMessageEvent) => {
      let msg: Req;
      try {
        if (e.nativeEvent.data.length > 1_048_576) return;
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }

      const envelope = msg as Req & { documentId?: unknown; bridgeToken?: unknown };
      if (envelope.bridgeToken !== bridgeToken.current ||
          !access.current.accept(msg.id, envelope.documentId, e.nativeEvent.url, contextRef.current, msg.method)) return;
      // Only this native-created closure can bind a request to its original instance.
      const requestIsCurrent = access.current.capture(msg.id, contextRef.current);
      const capturedRequest = { ...msg, isCurrent: requestIsCurrent };
      // Async replies and native Alert callbacks belong to this request instance.
      const replyCurrent: typeof reply = (id, ok, payload) => {
        if (requestIsCurrent()) reply(id, ok, payload);
      };
      if (browserEsr.handleBridgeRequest(msg, () => replyCurrent(msg.id, true, true))) return;
      if (msg.method === 'dappSessionFailure') {
        const recognized = !!dappSessionFailureCode(msg.params?.status, { code: msg.params?.code });
        const canNotify = recognized && !submitting.current && !pendingRequest.current && !pendingConnection.current;
        replyCurrent(msg.id, true, canNotify);
        if (!canNotify || sessionFailureNotice.current) return;
        const notice = {};
        sessionFailureNotice.current = notice;
        const capturedContext = contextRef.current;
        const sourceUrl = currentUrl.current;
        Alert.alert(t('dappBrowser.sessionInvalidTitle'), t('dappBrowser.sessionInvalidBody'), [
          { text: t('walletDetail.cancel'), style: 'cancel' },
          { text: t('dappBrowser.sessionLoginAgain'), onPress: () => {
            // This notice is informational until the user chooses to disconnect.
            // Never interrupt a transaction or a newer document/wallet context.
            if (!mounted.current || contextRef.current !== capturedContext || currentUrl.current !== sourceUrl ||
                sessionFailureNotice.current !== notice) return;
            if (submitting.current || pendingRequest.current || pendingConnection.current) {
              Alert.alert(t('dappBrowser.requestPending'));
              return;
            }
            access.current.disconnect();
            setConnected(false);
            webRef.current?.injectJavaScript('window.scatter && window.scatter.forgetIdentity(); true;');
          } },
        ], { cancelable: false });
        return;
      }
      if (msg.method === 'getActions' && !msg.params?.account && !access.current.connected()) {
        replyCurrent(msg.id, false, t('dappBrowser.connectionRequired')); return;
      }
      // A reopened DApp may restore its own login while this browser has no grant.
      // Consent belongs to this exact request; resume it only after native approval.
      const ensureConnection = () => new Promise<boolean>((resolve) => {
        if (!w.hasAccount) { replyCurrent(msg.id, false, 'no account'); resolve(false); return; }
        const capturedContext = contextRef.current;
        let decided = false;
        const disclose = () => {
          if (decided) return;
          decided = true;
          if (!requestIsCurrent() || !access.current.connect(msg.id, capturedContext)) { resolve(false); return; }
          pendingConnection.current = null;
          sessionFailureNotice.current = null;
          setConnected(true);
          webRef.current?.injectJavaScript(`window.__auroraSetAccount(${JSON.stringify(w.account)}, ${JSON.stringify(activeKey)}); true;`);
          resolve(true);
        };
        if (access.current.connected()) disclose();
        else if (pendingConnection.current) {
          replyCurrent(msg.id, false, t('dappBrowser.requestPending'));
          resolve(false);
        } else {
          pendingConnection.current = msg.id;
          Alert.alert(t('dappBrowser.connectTitle'), t('dappBrowser.connectBody', {
            origin: secureDappOrigin(currentUrl.current) ?? '', account: w.account,
          }), [
            { text: t('walletDetail.cancel'), style: 'cancel', onPress: () => {
              if (decided) return;
              decided = true;
              replyCurrent(msg.id, false, t('dappBrowser.userRejected'));
              resolve(false);
            } },
            { text: t('dappBrowser.connectAllow'), onPress: disclose },
          ], { cancelable: false });
        }
      });
      const needsConnection = ['arbitrarySignature', 'signTransaction', 'requestSignature'].includes(msg.method);
      if (needsConnection) {
        if (!access.current.connected() && !await ensureConnection()) return;
        if (!requestIsCurrent()) return;
        if (pendingRequest.current) { replyCurrent(msg.id, false, t('dappBrowser.requestPending')); return; }
        pendingRequest.current = msg.id;
      }

      switch (msg.method) {
        case 'getIdentity':
          if (await ensureConnection() && requestIsCurrent()) {
            replyCurrent(msg.id, true, { account: w.account, publicKey: activeKey });
          }
          return;

        case 'getIdentityFromPermissions':
          setConnected(w.hasAccount && access.current.connected());
          replyCurrent(msg.id, true, w.hasAccount && access.current.connected() ? { account: w.account, publicKey: activeKey } : null);
          return;

        case 'forgetIdentity':
          sessionFailureNotice.current = null;
          // Acknowledge this request before revoking every outstanding instance.
          replyCurrent(msg.id, true, true);
          access.current.disconnect();
          pendingRequest.current = null;
          pendingConnection.current = null;
          tokenPocket.cancelScan();
          setActions(null);
          setReq(null);
          setReqPermission(null);
          setPendingTx(null);
          setPendingMessage(null);
          setConnected(false);
          return;

        case 'getAccount':
          if (!msg.params?.account && !access.current.connected()) { replyCurrent(msg.id, false, t('dappBrowser.connectionRequired')); return; }
          w.client
            .getAccount(String(msg.params?.account ?? w.account))
            .then((r) => replyCurrent(msg.id, true, r))
            .catch((err) => replyCurrent(msg.id, false, String(err?.message ?? err)));
          return;

        case 'getBalance':
          if (!msg.params?.account && !access.current.connected()) { replyCurrent(msg.id, false, t('dappBrowser.connectionRequired')); return; }
          w.client
            .getBalance(
              String(msg.params?.contract ?? w.client.config.systemToken),
              String(msg.params?.account ?? w.account)
            )
            .then((r) => replyCurrent(msg.id, true, r))
            .catch((err) => replyCurrent(msg.id, false, String(err?.message ?? err)));
          return;

        case 'getTableRows':
          w.client
            .getTableRows(msg.params ?? {})
            .then((r) => replyCurrent(msg.id, true, r))
            .catch((err) => replyCurrent(msg.id, false, String(err?.message ?? err)));
          return;

        /**
         * 对一段文本出签名 —— Scatter 的 authenticate/getArbitrarySignature、
         * TokenPocket 的 eosAuthSign 都走这里,DApp 普遍用它做登录验证:
         * 页面给一段挑战文本,钱包签名,后端验签名恢复出的公钥是不是这个账户的。
         *
         * 这里以前是一律拒绝的,理由是"能被滥用成让用户签下他不理解的内容"。
         * 真正的风险只有一个:页面把某笔交易的签名摘要原料塞进来,骗到一个
         * 链上有效的交易签名。签名签的是 sha256(文本的 UTF-8 字节),而交易摘要
         * 的原料是 chain_id 拼上打包后的交易——chain_id 里满是 0x80 以上的字节,
         * UTF-8 编码根本产生不出那样的单字节,页面拼不出这段原料。所以只要
         * 限定"只签可打印文本"并把原文摆给用户看,这条路就是安全的,不需要
         * 整个关掉、连带把正常登录也堵死。
         */
        case 'arbitrarySignature': {
          if (wallet?.source === 'watch') {
            replyCurrent(msg.id, false, t('coldSigning.unsupportedMessage'));
            return;
          }
          const raw = msg.params?.data;
          const text = typeof raw === 'string' ? raw : '';
          // eslint-disable-next-line no-control-regex
          if (!text || /[\u0000-\u0008\u000e-\u001f]/.test(text) || text.length > 512) {
            replyCurrent(msg.id, false, t('dappBrowser.messageNotPlainText'));
            return;
          }
          if (!canSign) {
            replyCurrent(msg.id, false, t('dappBrowser.readOnlyRejected'));
            Alert.alert(t('dappBrowser.rejectedTitle'), t('dappBrowser.rejectedBody'));
            return;
          }
          setReq(capturedRequest);
          setPendingKind('message');
          setPendingMessage(text);
          setActions([]);
          setReqPermission(null);
          return;
        }

        /**
         * 页面自己把交易序列化好了,只要签名(eosjs2 的 signatureProvider)。
         * 广播归页面,我们不碰——替它推一次会让它拿着同一笔交易再推,链上按
         * 重复交易拒掉。
         */
        case 'signTransaction': {
          if (!canSign) {
            replyCurrent(msg.id, false, t('dappBrowser.readOnlyRejected'));
            Alert.alert(t('dappBrowser.rejectedTitle'), t('dappBrowser.rejectedBody'));
            return;
          }
          const wantedChain = String(msg.params?.chainId ?? '').toLowerCase();
          // 页面指定了链就必须和钱包当前所在的链一致。不校验的话,签出来的东西
          // 在另一条链上有效,而用户是在这条链的确认界面上点的确认。
          if (wantedChain && wantedChain !== w.client.config.chainIdHash.toLowerCase()) {
            replyCurrent(msg.id, false, t('dappBrowser.chainMismatch'));
            return;
          }
          decodeSerializedTransaction(String(msg.params?.serializedTransaction ?? ''), {
            nodeUrl: w.node.url,
            actor: w.account,
            chainId: w.client.config.chainIdHash,
          })
            .then((decoded) => {
              if (!requestIsCurrent()) return;
              setReq(capturedRequest);
              setPendingKind('signOnly');
              setPendingTx(decoded.transaction);
              setActions(decoded.actions);
              setReqPermission(decoded.permission);
              repair.prepare(decoded.permission ?? permission);
            })
            .catch((err) => { if (requestIsCurrent()) replyCurrent(msg.id, false, String(err?.message ?? err)); });
          return;
        }

        case 'requestSignature': {
          if (!canSign) {
            replyCurrent(msg.id, false, t('dappBrowser.readOnlyRejected'));
            Alert.alert(t('dappBrowser.rejectedTitle'), t('dappBrowser.rejectedBody'));
            return;
          }
          try {
            assertActionRequestChain(msg.params, w.client.config.chainIdHash);
            const prepared = prepareActionRequest(msg.params?.actions, w.account, permission);
            setReq(capturedRequest);
            setPendingKind('broadcast');
            setActions(prepared.actions);
            setReqPermission(prepared.permission);
            repair.prepare(prepared.permission);
          } catch {
            replyCurrent(msg.id, false, t('dappBrowser.noRecognizableAction'));
          }
          return;
        }

        default:
          if (tokenPocket.handleRequest(capturedRequest)) return;
          replyCurrent(msg.id, false, t('dappBrowser.unsupportedMethod', { method: msg.method }));
      }
    },
    [w, activeKey, canSign, reply, browserEsr.handleBridgeRequest, tokenPocket.handleRequest, t]
  );

  /** 弹窗关闭、状态归位 —— 三条路成功后都走这一下 */
  const clearPending = () => {
    pendingRequest.current = null;
    setActions(null);
    setReq(null);
    setReqPermission(null);
    setPendingTx(null);
    setPendingMessage(null);
  };

  const broadcast = async (getSigner: () => Promise<Signer>) => {
    if (!actions || !wallet || !req || submitting.current || !access.current.current(req.id, contextRef.current)) return;
    submitting.current = true;
    const capturedContext = contextRef.current;
    const isCurrent = () => mounted.current && AppState.currentState !== 'background' &&
      access.current.connected() && !!req.isCurrent?.() && contextRef.current === capturedContext;
    setBusy(true);
    setTxErr(null);
    let signer: Signer | null = null;
    try {
      signer = await getSigner();
      if (!isCurrent()) throw new Error(t('dappBrowser.requestChanged'));

      // 只出签名:交易是页面拼好的,原样签、原样还回去,不推链
      if (pendingKind === 'signOnly' && pendingTx) {
        await preflightDappResources({ transaction: pendingTx, actor: w.account, nodeUrl: w.node.url });
        if (!isCurrent()) throw new Error(t('dappBrowser.requestChanged'));
        assertVisibleTransaction(pendingTx);
        const sig = await signDigest(signer, pendingTx.signingDigest(w.client.config.chainIdHash), {
          transaction: pendingTx, chainId: w.client.config.chainIdHash, permission: effectivePermission, isCurrent,
        });
        if (!isCurrent()) throw new Error(t('dappBrowser.requestChanged'));
        reply(req.id, true, { signatures: [String(sig)] });
        clearPending();
        return;
      }

      // 只签文本,钱包不广播;第三方仍可能把签名用于登录或其他授权。
      if (pendingKind === 'message' && pendingMessage !== null) {
        const digest = Checksum256.hash(new TextEncoder().encode(pendingMessage));
        const sig = await signDigest(signer, digest);
        if (!isCurrent()) throw new Error(t('dappBrowser.requestChanged'));
        reply(req.id, true, { signature: String(sig), publicKey: activeKey });
        clearPending();
        return;
      }

      const res = await transact({ chainId: w.chainId, node: w.node, actor: w.account, signer, permission: effectivePermission, actions, isCurrent });
      reply(req.id, true, { transaction_id: res.txId, processed: { id: res.txId } });
      clearPending();
      Alert.alert(t('dappBrowser.broadcastedTitle'), t('dappBrowser.broadcastedBody', { txId: res.txId }), [
        { text: t('dappBrowser.viewExplorer'), onPress: () => Linking.openURL(res.explorerUrl) },
        { text: t('dappBrowser.done') },
      ]);
    } catch (e: any) {
      // 资源不够(CPU/NET、RAM):弹一键修复,复用刚拿到手的 signer,不再让用户认证一遍
      if (isCurrent() && !repair.offer(e, signer, effectivePermission)) setTxErr(e?.message ?? t('dappBrowser.signFailed'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // 每次跳到新地址(打开、地址栏手动前往)都记一笔 —— 标签页管理器复用这份历史,
  // 不然从「+新建标签」打开的页面找不到入口再回来。siteName 是异步拿到的
  // 页面标题,拿到后再记一遍把标题补上,标签卡片才能显示网站名而不是光秃秃的网址
  React.useEffect(() => {
    addDappHistory(url, siteName || undefined)
      .then(listDappHistory)
      .then((list) => setTabCount(list.length))
      .catch(() => {});
  }, [url, siteName]);

  const submit = (password: string) =>
    broadcast(passwordSigner(wallet!, password));
  const submitBiometric = () =>
    broadcast(biometricSigner(wallet!));
  const submitPasskey = () =>
    broadcast(passkeySigner(wallet!));

  const reject = () => {
    if (req) reply(req.id, false, t('dappBrowser.userRejected'));
    clearPending();
    setTxErr(null);
  };

  const go = () => {
    const v = input.trim();
    if (!v) return;
    setUrl(/^https?:\/\//.test(v) ? v : `https://${v}`);
  };

  const host = useMemo(() => {
    try {
      return new URL(navUrl).host;
    } catch {
      return navUrl;
    }
  }, [navUrl]);

  /** 当前页面是否 https——锁图标必须照实画,明文 http 配上注入的钱包 provider,
   *  中间人可以完整伪造 dApp 界面骗签名,不能给它挂一把绿色的锁装样子 */
  const secure = /^https:/i.test(navUrl);

  useEffect(() => {
    isDappFavorite(url).then(setFavorited);
  }, [url]);

  /** 「更多」面板里各功能的实际动作 */
  const handleMoreAction = async (key: string) => {
    switch (key) {
      case 'copy':
        await Clipboard.setStringAsync(url).catch(() => {});
        Alert.alert(t('dappBrowser.copied'), url);
        return;
      case 'openBrowser':
        Linking.openURL(url).catch(() => Alert.alert(t('dappBrowser.cannotOpenTitle'), t('dappBrowser.cannotOpenBody')));
        return;
      case 'share':
        Share.share({ message: url, url }).catch(() => {});
        return;
      case 'favorite': {
        const nowOn = await toggleDappFavorite(url, host);
        setFavorited(nowOn);
        return;
      }
      case 'details':
        Alert.alert(
          t('dappBrowser.detailsTitle'),
          t('dappBrowser.detailsBody', {
            host,
            url,
            connState: connected ? t('dappBrowser.connected') : t('dappBrowser.notConnected'),
            account: w.account,
            readOnly: canSign ? '' : t('dappBrowser.readOnlySuffix'),
          })
        );
        return;
      case 'translate':
        setUrl(`https://translate.google.com/translate?sl=auto&tl=${TRANSLATE_TARGET[locale]}&u=${encodeURIComponent(url)}`);
        return;
      case 'clearCache':
        webRef.current?.clearCache?.(true);
        webRef.current?.clearHistory?.();
        Alert.alert(t('dappBrowser.clearedTitle'), t('dappBrowser.clearedBody'));
        return;
    }
  };

  /**
   * 关闭/最小化前截一张当前页面的快照,给标签页列表当缩略图用。
   * 页面不保活、每次重新打开都会重新加载,缩略图只是"上次长这样"的留念,
   * 不是实时画面。截图失败(个别机型/GPU 配置下 WebView 截不出来)就算了,
   * 不能让这一步拖住关闭/最小化本身。
   */
  const captureThumbnail = async () => {
    if (!webWrapRef.current) return;
    try {
      const uri = await captureRef(webWrapRef, { format: 'jpg', quality: 0.5, result: 'data-uri' });
      await setDappThumbnail(url, uri);
    } catch {
      // 截不出来就用占位图标,不影响关闭/最小化
    }
  };

  const minimize = async () => {
    await captureThumbnail();
    minimizeSession();
  };

  const close = async () => {
    await captureThumbnail();
    closeSession();
    // DappBrowserScreen 是挂在 App 根部的悬浮层,不是路由栈里的一屏 —— 关掉它
    // 只是把这层遮罩收起来,底下露出来的本就是打开 DApp 之前停留的那个页面
    // (发现页打开的关掉回发现页,「我的」页打开的关掉回「我的」页……),
    // 不需要、也不该在这里额外插一脚导航。之前这里硬编码跳回资产首页,
    // 导致不管从哪个入口打开、关闭后都被强制拽回首页,而不是回到原来在看的
    // 页面——见 2026-08-27 反馈。
  };

  /**
   * 标签页管理是导航栈里的一页,而 DApp 浏览器是盖在整个导航栈上的悬浮层——
   * 直接跳过去会被浏览器盖在底下。先最小化再跳;在标签页里点开任意一个,
   * openDapp 会把浮层重新展开。
   */
  const openTabs = async () => {
    await minimize();
    if (navigationRef.isReady()) navigationRef.navigate('DappTabs');
  };

  // 编辑网址时收起键盘(安卓返回键第一下只收键盘,不会让输入框失焦)就退回
  // 只显示域名的样子,不留一个选中了整条网址、却没有键盘的半截状态
  useEffect(() => {
    if (!editingUrl) return;
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      setEditingUrl(false);
      setInput(navUrl);
    });
    return () => sub.remove();
  }, [editingUrl, navUrl]);

  // 安卓实体返回键:网页能后退就后退,退到第一页再按就关掉浏览器——跟 TokenPocket
  // 一致。浏览器是盖在导航栈上的悬浮层,不在路由里,不接管的话返回键会把底下
  // 那一页(用户根本看不见)弹出栈,关掉浏览器后才发现自己被带回了别的地方。
  // 有底部弹层/居中对话框开着时,addBackHandler 会让路,返回键先关弹层。
  useEffect(() => {
    const sub = addBackHandler(() => {
      if (editingUrl) {
        setEditingUrl(false);
        return true;
      }
      if (canGoBack) {
        webRef.current?.goBack();
        return true;
      }
      close();
      return true;
    });
    return () => sub.remove();
    // close 每次渲染都是新函数,但它只调 captureThumbnail/closeSession 两个稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canGoBack, editingUrl]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* 顶栏 —— 参考 TokenPocket:左边关闭/最小化胶囊,中间只显示域名的地址框,
          右边当前钱包头像(带链角标)。刷新和「更多」挪到了底部工具栏。
          页面调了 tp.fullScreen 就整条收起,把整屏让给页面。 */}
      {fullScreen ? null : (
        <View style={styles.bar}>
          <View style={styles.capsule}>
            <TouchableOpacity onPress={close} hitSlop={6} style={styles.capsuleBtn}>
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.capsuleDivider} />
            <TouchableOpacity onPress={minimize} hitSlop={6} style={styles.capsuleBtn}>
              <Ionicons name="remove" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          {editingUrl ? (
            <View style={styles.urlBox}>
              <TextInput
                value={input}
                onChangeText={setInput}
                onSubmitEditing={() => {
                  go();
                  setEditingUrl(false);
                }}
                onBlur={() => {
                  setEditingUrl(false);
                  setInput(navUrl);
                }}
                style={styles.urlInput}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                // 进入编辑就把整条网址选中,直接输入即替换——安卓上 autoFocus 触发的
                // 聚焦不会让 selectTextOnFocus 生效,光标停在开头,新打的字会插进
                // 旧网址中间,所以聚焦时手动全选一次
                onFocus={() => urlInputRef.current?.setSelection(0, input.length)}
                selectTextOnFocus
                ref={urlInputRef}
                keyboardType="url"
                returnKeyType="go"
              />
            </View>
          ) : (
            <TouchableOpacity style={styles.urlBox} activeOpacity={0.7} onPress={() => setEditingUrl(true)}>
              {/* https 站点不再挂锁(和 TokenPocket 一样干净),但明文 http 仍然标红——
                  这是用户唯一能一眼看出"这个页面可能被中间人篡改"的地方,不能省 */}
              {!secure ? <Ionicons name="warning" size={13} color="#E5484D" /> : null}
              <Text style={styles.urlHost} numberOfLines={1}>
                {host || navUrl}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity onPress={() => setWalletSheet(true)} hitSlop={6} style={styles.walletBtn}>
            {w.hasAccount ? (
              <Text style={styles.walletLetter}>{w.account.slice(0, 1)}</Text>
            ) : (
              <Ionicons name="person-outline" size={18} color={colors.text} />
            )}
            {CHAIN_BADGE[w.chainId] ? <Image source={CHAIN_BADGE[w.chainId]} style={styles.walletBadge} /> : null}
          </TouchableOpacity>
        </View>
      )}

      {/* 全屏时的悬浮胶囊。TokenPocket 的约定是 setMenubar 默认关、全屏下什么
          按钮都不留——那样页面一旦全屏,用户就只剩系统返回键能退出,在 iOS 上
          连这个都没有,等于被页面困住。所以关闭按钮始终保留,setMenubar
          只控制要不要把「更多」也露出来。 */}
      {fullScreen ? (
        <View style={[styles.fsCapsule, { top: insets.top + 8 }]}>
          {menubarInFullScreen ? (
            <TouchableOpacity onPress={() => setMoreSheet(true)} hitSlop={8} style={styles.fsCapsuleBtn}>
              <Ionicons name="ellipsis-horizontal" size={17} color="#fff" />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={close} hitSlop={8} style={styles.fsCapsuleBtn}>
            <Ionicons name="close" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? <View style={[styles.progress, { width: `${progress * 100}%` }]} /> : null}

      {/* DApp 浏览器是铺满全屏的常驻悬浮层(见 DappOverlayHost),不像其它页面
          走的是 Tab.Navigator/Stack.Navigator 那套自带 safe-area 处理的布局 ——
          不补 insets.bottom 的话,网页最下面一截会被安卓系统导航栏(三键或手势条)
          盖住,很多 DApp 自己的底部 tab/按钮就是这么被挡住的。平时由底部工具栏
          来垫这段安全区;全屏时工具栏收起了,改由网页容器自己垫。 */}
      <View ref={webWrapRef} style={{ flex: 1, paddingBottom: fullScreen ? insets.bottom : 0 }} collapsable={false}>
        <WebView
          ref={webRef}
          // headers 只在首次请求生效(同源后续跳转/XHR 不会带上),真正让页面
          // 全程都能读到语言靠的是 injected 里覆盖 navigator.language——这个
          // Accept-Language 头是给会做服务端语言判断的站点多一层信号,两边都做。
          source={{ uri: url, headers: { 'Accept-Language': BCP47[locale] } }}
          originWhitelist={browserEsr.originWhitelist}
          injectedJavaScriptBeforeContentLoaded={injected}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          injectedJavaScript={injected}
          injectedJavaScriptForMainFrameOnly
          onMessage={onMessage}
          onOpenWindow={browserEsr.onOpenWindow}
          onLoadStart={(e) => {
            sessionFailureNotice.current = null;
            browserEsr.invalidate();
            tokenPocket.cancelScan();
            currentUrl.current = e.nativeEvent.url;
            access.current.navigate(e.nativeEvent.url, contextRef.current);
            pendingRequest.current = null;
            pendingConnection.current = null;
            setActions(null);
            setReq(null);
            setPendingTx(null);
            setPendingMessage(null);
            setLoading(true);
            setConnected(false);
          }}
          onLoadEnd={() => setLoading(false)}
          onLoadProgress={(e) => setProgress(e.nativeEvent.progress)}
          onNavigationStateChange={(s) => {
            currentUrl.current = s.url;
            if (!editingUrl) setInput(s.url);
            setNavUrl(s.url);
            setCanGoBack(s.canGoBack);
            setCanGoForward(s.canGoForward);
            if (s.title) setSiteName(s.title);
          }}
          onShouldStartLoadWithRequest={(r) => {
            if (browserEsr.interceptUrl(r.url)) return false;
            if (r.isTopFrame && dappPageOrigin(r.url) !== dappPageOrigin(currentUrl.current)) {
              sessionFailureNotice.current = null;
              browserEsr.invalidate();
              tokenPocket.cancelScan();
              currentUrl.current = r.url;
              access.current.navigate(r.url, contextRef.current);
              pendingRequest.current = null;
              pendingConnection.current = null;
              setActions(null);
              setReq(null);
              setConnected(false);
            }
            return true;
          }}
          style={{ flex: 1 }}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          startInLoadingState
          userAgent={browserUserAgent.userAgent}
          // iOS 上 userAgent 为空、用系统默认 UA,TokenPocket 标记只能靠这个属性
          // 追加;安卓设了完整 userAgent(标记已在里面),这里会被覆盖掉
          applicationNameForUserAgent={browserUserAgent.applicationNameForUserAgent}
          // tp.forwardNavigationGesturesEnable:iOS 上左右滑动前进后退,安卓忽略
          allowsBackForwardNavigationGestures={navGestures}
          renderLoading={() => (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={BLUE} />
            </View>
          )}
        />
      </View>

      {/* 底部工具栏 —— 参考 TokenPocket:后退、前进、标签页、刷新、更多。
          前进后退按页面历史置灰,标签页按钮上的数字和发现页右上角的是同一份。 */}
      {fullScreen ? null : (
        <View style={[styles.toolbar, { paddingBottom: insets.bottom }]}>
          <TouchableOpacity
            style={styles.toolBtn}
            disabled={!canGoBack}
            onPress={() => webRef.current?.goBack()}
          >
            <Ionicons name="chevron-back" size={24} color={canGoBack ? colors.text : colors.textFaint} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.toolBtn}
            disabled={!canGoForward}
            onPress={() => webRef.current?.goForward()}
          >
            <Ionicons name="chevron-forward" size={24} color={canGoForward ? colors.text : colors.textFaint} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={openTabs}>
            <View style={styles.tabsBox}>
              <Text style={styles.tabsCount} numberOfLines={1}>
                {tabCount > 99 ? '99+' : Math.max(tabCount, 1)}
              </Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={() => webRef.current?.reload()}>
            <Ionicons name="reload" size={22} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={() => setMoreSheet(true)}>
            <Ionicons name="ellipsis-horizontal" size={24} color={colors.text} />
            {favorited ? <View style={styles.moreBadge} /> : null}
          </TouchableOpacity>
        </View>
      )}

      {tokenPocket.scanElement}

      <EsrFlowOverlay flow={browserEsr.flow} origin={host} />

      <ConfirmTxSheet
        visible={actions !== null}
        onClose={reject}
        actions={actions ?? []}
        message={pendingMessage}
        chainName={w.client.config.name}
        testnet={w.client.config.testnet}
        actor={w.account}
        permission={effectivePermission}
        busy={busy}
        error={txErr}
        walletId={wallet?.id}
        passkey={isPasskey}
        external={wallet?.source === 'watch'}
        origin={host}
        onConfirm={submit}
        onConfirmBiometric={submitBiometric}
        onConfirmPasskey={submitPasskey}
      />
      {repair.element}

      <DappMoreSheet
        visible={moreSheet}
        onClose={() => setMoreSheet(false)}
        host={host}
        siteName={siteName}
        favorited={favorited}
        account={w.account}
        activeKey={activeKey}
        onAction={handleMoreAction}
        onSwitchAccount={() => setWalletSheet(true)}
      />
      <WalletListSheet visible={walletSheet} onClose={() => setWalletSheet(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  fsCapsule: {
    position: 'absolute',
    right: 12,
    zIndex: 10,
    flexDirection: 'row',
    gap: 2,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 18,
    paddingHorizontal: 4,
  },
  fsCapsuleBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  root: { flex: 1, backgroundColor: colors.white },

  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 54 },

  // 左边的关闭/最小化胶囊
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F2F3F5',
    paddingHorizontal: 4,
  },
  capsuleBtn: { width: 38, height: 40, alignItems: 'center', justifyContent: 'center' },
  capsuleDivider: { width: 1, height: 16, backgroundColor: '#D9DCE3' },

  // 中间的地址框:平时只显示域名,点开才是可编辑的完整网址
  urlBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F2F3F5',
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 16,
  },
  urlHost: { flex: 1, fontSize: 15, color: colors.text },
  urlInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0, outlineStyle: 'none' as any },

  // 右边的当前钱包头像 + 链角标
  walletBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F2F3F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletLetter: { fontSize: 17, fontWeight: '500', color: colors.text },
  walletBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.white,
  },

  // 底部工具栏
  toolbar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.white,
  },
  toolBtn: { flex: 1, height: 50, alignItems: 'center', justifyContent: 'center' },
  tabsBox: {
    minWidth: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.6,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  tabsCount: { fontSize: 12, fontWeight: '700', color: colors.text },
  moreBadge: {
    position: 'absolute',
    top: 12,
    right: '32%',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#F5A623',
    borderWidth: 1.5,
    borderColor: colors.white,
  },

  progress: { height: 2, backgroundColor: BLUE },
  loadingBox: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
