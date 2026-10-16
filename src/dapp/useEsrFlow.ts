// Anchor/ESR 签名请求的公共流程:解析(带 loading)→ 确认弹窗数据 → 签名回调
// → 成功提示/redirect。之前 DappBrowserScreen(网页内深链)和 EsrRequestHost
// (扫码/推送)各抄一份几乎逐行相同的实现,唯一的分叉是 redirect 回调该怎么
// 打开——浏览器场景是让当前 WebView 跳过去,独立场景是 openDapp() 新开一页。
// 这是签名路径,两份拷贝意味着修任何一处都可能漏掉另一处,收拢到这里,
// 分叉点收敛成一个 onRedirect 参数。
//
// 只订阅会话半边(useWalletSession)——这条流程用到的都是账户/节点/配置,
// 不需要余额行情那些实时数据。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import type { ResolvedSigningRequest } from '@wharfkit/signing-request';

import { useWalletSession } from '../chain/WalletContext';
import { biometricSigner, passkeySigner, passwordSigner, type SignerGetter } from '../chain/signers';
import { useResourceRepair } from '../components/ResourceRepairSheet';
import { signingPermission } from '../crypto/vault';
import { shouldInvalidateBackground } from '../crypto/systemAuthentication';
import type { ActionSpec, Signer } from '../chain/transact';
import { useI18n } from '../i18n';
import { assertIdentityNotExpired, EsrRequest, identityExpirationMs, parseEsr, signAndCallback } from './esr';

export type EsrFlowState = { req: EsrRequest; resolved: ResolvedSigningRequest } | null;

export function useEsrFlow(opts: {
  /** signAndCallback 返回 'redirect' 时怎么打开回调网址——两个宿主的唯一分叉点 */
  onRedirect: (url: string) => void;
}) {
  const w = useWalletSession();
  const { t } = useI18n();

  const wallet = w.currentWallet;
  const canSign = !!wallet && wallet.source !== 'watch';
  const permission = signingPermission(wallet);

  const [esr, setEsr] = useState<EsrFlowState>(null);
  /** parseEsr 内部要打一次链上 get_info,节点慢的时候点击/扫码到弹出确认框
   *  之间会有明显空档——给个即时反馈,不然像是没反应 */
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const activeRequestRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const walletContext = JSON.stringify([wallet?.id, w.account, w.chainId, w.node.url]);
  const contextRef = useRef(walletContext);
  contextRef.current = walletContext;
  const invalidate = useCallback(() => {
    generationRef.current++;
    activeRequestRef.current = null;
    setEsr(null);
    setErr(null);
    setParsing(false);
    setBusy(false);
  }, []);
  useEffect(invalidate, [walletContext, invalidate]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && shouldInvalidateBackground()) invalidate();
    });
    return () => sub.remove();
  }, [invalidate]);
  // 钱包广播失败或只签名请求的 CPU/NET 预检查不足时弹修复。
  const repair = useResourceRepair(w, { onCancel: setErr });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRequestRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!esr) return;
    const expiration = identityExpirationMs(esr.resolved);
    if (expiration === null) return;
    const remaining = expiration - Date.now();
    if (remaining <= 0) {
      setErr(t('esrError.identityExpired'));
      return;
    }
    const timer = setTimeout(() => setErr(t('esrError.identityExpired')), remaining);
    return () => clearTimeout(timer);
  }, [esr, t]);

  /** 接收一条 esr:/anchor:// 请求:解析并弹确认框;只读账户直接提示不能登录 */
  const open = useCallback(
    async (uri: string) => {
      // Reserve synchronously: both the page bridge and navigation may intercept the same link.
      if (!mountedRef.current || activeRequestRef.current !== null || submittingRef.current) return;
      if (!canSign) {
        Alert.alert(t('dappBrowser.cannotLoginTitle'), t('dappBrowser.cannotLoginBody'));
        return;
      }
      const generation = ++generationRef.current;
      activeRequestRef.current = generation;
      setParsing(true);
      try {
        const parsed = await parseEsr(uri, { actor: w.account, permission, node: w.node, config: w.client.config });
        if (!mountedRef.current || generationRef.current !== generation) return;
        setErr(null);
        setEsr(parsed);
        if (!parsed.req.isIdentity) repair.prepare(permission);
      } catch (e: any) {
        if (!mountedRef.current || generationRef.current !== generation) return;
        activeRequestRef.current = null;
        Alert.alert(t('dappBrowser.cannotParseTitle'), e?.message ?? t('dappBrowser.cannotParseBody'));
      } finally {
        if (mountedRef.current && generationRef.current === generation) setParsing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canSign, w.account, permission, w.node, w.client, t]
  );

  const close = useCallback(() => {
    if (submittingRef.current) return;
    generationRef.current += 1;
    activeRequestRef.current = null;
    setParsing(false);
    setEsr(null);
    setErr(null);
  }, []);

  const submit = async (getSigner: SignerGetter) => {
    if (!esr || !wallet || activeRequestRef.current === null || submittingRef.current || !mountedRef.current) return;
    const generation = generationRef.current;
    const capturedContext = contextRef.current;
    const isCurrent = () => mountedRef.current && AppState.currentState !== 'background' &&
      generationRef.current === generation && contextRef.current === capturedContext;
    submittingRef.current = true;
    setBusy(true);
    setErr(null);
    let signer: Signer | null = null;
    try {
      assertIdentityNotExpired(esr.resolved);
      signer = await getSigner();
      if (!mountedRef.current || generationRef.current !== generation) return;
      const r = await signAndCallback({
        resolved: esr.resolved,
        signer,
        chainId: esr.req.chainId,
        chainSlug: w.chainId,
        actor: w.account,
        permission,
        node: w.node,
        isCurrent,
      });
      if (!mountedRef.current || generationRef.current !== generation) return;
      const wasIdentity = esr.req.isIdentity;
      activeRequestRef.current = null;
      setEsr(null);
      if (r.kind === 'redirect') {
        // 非后台回调——这个 URL 是给浏览器"导航"过去的(签名已经编进 query
        // string),不是后台接口,必须真的打开它,见 esr.ts 里的详细说明。
        opts.onRedirect(r.callbackUrl);
        return;
      }
      if (r.txId) {
        // 钱包代广播的请求:已经上链了,告诉用户 tx id,而不是笼统的"已签名"
        Alert.alert(t('dappBrowser.broadcastedTitle'), t('dappBrowser.broadcastedBody', { txId: r.txId }), [
          { text: t('permission.ok') },
        ]);
        return;
      }
      Alert.alert(
        wasIdentity && r.kind === 'posted' ? t('dappBrowser.authorizationSentTitle') : t('dappBrowser.signedTitle'),
        wasIdentity
          ? t(r.kind === 'posted' ? 'dappBrowser.authorizationSentBody' : 'dappBrowser.identitySignedBody', { account: w.account })
          : t('dappBrowser.signedBody', { posted: r.kind === 'posted' ? t('dappBrowser.postedSuffix') : '' }),
        [{ text: t('permission.ok') }]
      );
    } catch (e: any) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      // 资源不够(CPU/NET、RAM):弹一键修复,复用刚拿到手的 signer;修好后用户再点一次签名
      if (!repair.offer(e, signer, permission)) setErr(e?.message ?? t('dappBrowser.signFailed'));
    } finally {
      submittingRef.current = false;
      if (mountedRef.current && generationRef.current === generation) setBusy(false);
    }
  };

  const submitPassword = (password: string) => submit(passwordSigner(wallet!, password));
  const submitBiometric = () => submit(biometricSigner(wallet!));
  const submitPasskey = () => submit(passkeySigner(wallet!));

  /**
   * 给 ConfirmTxSheet 的 actions:身份请求(登录)合成一张"是谁在请求登录"
   * 的说明卡,交易请求原样给解析出来的 action 列表。requesterFallback 是
   * scope 缺失时的兜底展示——浏览器场景给当前页面 host,独立场景没有网页
   * 可兜底就留空(不用一个不相关的网址去凑)。
   */
  const sheetActions = (requesterFallback = ''): ActionSpec[] => {
    if (!esr) return [];
    if (!esr.req.isIdentity) return esr.req.actions;
    return [
      {
        account: t('dappBrowser.esrLoginLabel'),
        name: 'identity',
        data: {
          [t('dappBrowser.esrRequester')]: esr.req.scope || requesterFallback,
          [t('dappBrowser.esrAccount')]: w.account,
          [t('dappBrowser.esrPermission')]: permission,
          [t('dappBrowser.esrNote')]: t('dappBrowser.esrOwnershipOnly'),
        },
      },
    ];
  };

  return {
    esr,
    parsing,
    busy,
    err,
    open,
    close,
    invalidate,
    submitPassword,
    submitBiometric,
    submitPasskey,
    sheetActions,
    /** 资源修复弹窗——宿主和 ConfirmTxSheet 一起渲染出来 */
    repairElement: repair.element,
    /** 弹窗展示要用的会话信息,和流程内部用的是同一份,不用宿主自己再取一遍 */
    wallet,
    permission,
    account: w.account,
    chainConfig: w.client.config,
  };
}
