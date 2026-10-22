// EOSIO Signing Request (ESR / EEP-7) 处理
//
// ESR 是 Antelope 生态的**开放标准**,不是某个钱包私有的。
// Anchor 是它的一个实现;DApp 用 anchor-link 生成的登录/签名请求
// 本质就是一个 esr: URI,任何实现该规范的钱包都能处理。
//
// 我们在内置浏览器里拦截 anchor:// 与 esr:// 导航,直接用本钱包完成,
// 用户不需要再跳去 Anchor —— 他人已经在手机上了。
import { notifyTransactionApplied } from '../chain/walletDataEvents';
import { fetch as callbackFetch } from 'expo/fetch';
import { SigningRequest, ResolvedSigningRequest } from '@wharfkit/signing-request';
import { ABI, APIClient, Name, PublicKey, Serializer, Signature, SignedTransaction, TimePointSec } from '@wharfkit/antelope';
import { ESR_ZLIB } from './esrZlib';

import { getSigningAbi } from '../chain/signingAbi';
import { CHAINS, ChainConfig, ChainId, NodeInfo } from '../chain/config';
import { ActionSpec, Signer, signDigest, transactionFailure } from '../chain/transact';
import { getLinkIdentity, linkDeviceName } from './linkIdentity';
import { recordLinkSession } from './linkSessions';
import { t } from '../i18n';
import { preflightDappResources } from './resourcePreflight';
import { assertVisibleTransaction, decodeVisibleAction } from '../chain/transactionSafety';
import { normalizeEsr } from './esr-links';
import { readDappSessionFailure, DappSessionRejectedError } from './sessionFailure';

export { isEsrLink, normalizeEsr } from './esr-links';

/**
 * SigningRequest 需要一个 zlib 实现来解压缩紧凑编码的请求。
 * 必须用纯 JS 的 pako —— react-zlib-js 在 RN 运行时会引用不存在的
 * Browser 全局变量,直接白屏。解压上限见 esrZlib.ts。
 */
const zlibOpts = ESR_ZLIB;

export const ESR_IDENTITY_TIMEOUT_SECONDS = 5 * 60;

export class EsrIdentityExpiredError extends Error {
  constructor() {
    super(t('esrError.identityExpired'));
    this.name = 'EsrIdentityExpiredError';
  }
}

export function identityExpirationMs(resolved: ResolvedSigningRequest): number | null {
  return resolved.request.isIdentity() && resolved.request.version >= 3
    ? resolved.transaction.expiration.toMilliseconds()
    : null;
}

export function assertIdentityNotExpired(resolved: ResolvedSigningRequest): void {
  const expiration = identityExpirationMs(resolved);
  if (expiration === null) return; // ESR v2 has no expiring identity proof.
  const now = Date.now();
  if (!Number.isFinite(expiration) || expiration > now + ESR_IDENTITY_TIMEOUT_SECONDS * 1000) {
    throw new Error(t('esrError.identityInvalidExpiration'));
  }
  if (now >= expiration) throw new EsrIdentityExpiredError();
}

export type EsrRequest = {
  /** 原始 URI */
  uri: string;
  /** 身份请求(登录)还是交易请求 */
  isIdentity: boolean;
  /** 展示给用户确认的 action —— 身份请求为空 */
  actions: ActionSpec[];
  /** 请求方声明的 scope,身份请求里通常是 DApp 名 */
  scope?: string;
  callback?: string;
  callbackOrigin?: string;
  chainId: string;
  request: SigningRequest;
};

export function esrCallbackOrigin(callback: string): string | undefined {
  if (!callback) return undefined;
  try {
    const url = new URL(callback);
    if (url.protocol === 'https:' && !url.username && !url.password && !/[{}]/.test(url.origin)) return url.origin;
  } catch {}
  throw new Error(t('esrError.unrecognizedLink'));
}

/** 解析请求,填入本钱包账户 */
export async function parseEsr(
  url: string,
  opts: { actor: string; permission?: string; node: NodeInfo; config: ChainConfig }
): Promise<{ req: EsrRequest; resolved: ResolvedSigningRequest }> {
  const esr = normalizeEsr(url);
  if (!esr) throw new Error(t('esrError.unrecognizedLink'));
  // Real requests are a few KB; the cap also bounds uncompressed payloads that
  // never reach the inflate size limit.
  if (esr.length > 64_000) throw new Error(t('esrError.unrecognizedLink'));

  const request = SigningRequest.from(esr, zlibOpts);
  const callbackOrigin = esrCallbackOrigin(String(request.data.callback ?? ''));

  // 链 ID 必须和当前钱包所在的链对上。以前这里不查:用户停在 Vaulta 主网、扫一个
  // Jungle 的请求,会拿主网的 TAPOS 头 + 请求自带的链 ID 去 resolve/签名——签出来
  // 是对方那条链可用的签名,而确认弹窗上写的却是当前链的名字,用户以为在签主网。
  // 反过来(停在测试网签主网请求)更危险。以配置里抄录的 chainIdHash 为准(理由见
  // transact.ts 的 makeSession 注释),不信任节点自报的 chain_id。
  const walletChain = opts.config.chainIdHash.toLowerCase();
  if (request.isMultiChain()) {
    // 多链请求:chain_ids 为空表示"任意链都行",否则当前链必须在列表里
    const ids = request.getChainIds();
    if (ids && !ids.some((id) => String(id).toLowerCase() === walletChain)) {
      throw new Error(
        t('esrError.chainMismatch', { requested: ids.map((id) => chainLabel(String(id))).join(' / '), current: opts.config.name })
      );
    }
  } else {
    const requested = String(request.getChainId()).toLowerCase();
    if (requested !== walletChain) {
      throw new Error(t('esrError.chainMismatch', { requested: chainLabel(requested), current: opts.config.name }));
    }
  }

  const api = new APIClient({ url: opts.node.url });
  const info = await api.v1.chain.get_info();
  if (String(info.chain_id).toLowerCase() !== walletChain) throw new Error(t('esrError.chainMismatch', {
    requested: chainLabel(String(info.chain_id)), current: opts.config.name,
  }));

  // Resolve and display with corroborated schemas. Missing or disputed ABIs
  // stop the request before a confirmation can present misleading fields.
  const abis = new Map<string, ABI>();
  if (!request.isIdentity()) {
    await Promise.all(
      request.getRequiredAbis().map(async (acc) => {
        abis.set(String(acc), ABI.from(await getSigningAbi(walletChain, String(acc))));
      })
    );
  }

  // Identity proofs have no TAPOS dependency. Their lifetime must never be
  // extended by a node's self-reported head time.
  const header = request.isIdentity()
    ? { expiration: TimePointSec.from(new Date((Math.floor(Date.now() / 1000) + ESR_IDENTITY_TIMEOUT_SECONDS) * 1000)) }
    : info.getTransactionHeader(120);
  // 多链请求 resolve 时必须显式指定选用的链,单链请求传了也无妨(会被请求自带的覆盖)
  const resolved = request.resolve(
    abis,
    { actor: Name.from(opts.actor), permission: Name.from(opts.permission ?? 'active') },
    { ...header, chainId: walletChain }
  );

  if (!request.isIdentity()) assertVisibleTransaction(resolved.transaction);
  else {
    assertIdentityNotExpired(resolved);
    // Identity requests can explicitly specify an account/permission instead of placeholders.
    const auth = resolved.transaction.actions[0]?.authorization;
    if (auth?.length !== 1 || String(auth[0].actor) !== opts.actor ||
        String(auth[0].permission) !== (opts.permission ?? 'active')) {
      throw new Error(t('dappBrowser.requestChanged'));
    }
  }

  // 从实际待签名的 action 字节解码并检查完整性,避免展示另一份解析结果。
  const actions: ActionSpec[] = request.isIdentity()
    ? []
    : resolved.transaction.actions.map((a) => ({
        account: String(a.account),
        name: String(a.name),
        data: decodeVisibleAction(a, abis.get(String(a.account))!),
        authorization: a.authorization.map((auth) => ({ actor: String(auth.actor), permission: String(auth.permission) })),
      }));

  return {
    req: {
      uri: esr,
      isIdentity: request.isIdentity(),
      actions,
      scope: request.isIdentity() ? identityScope(request) : undefined,
      callback: request.data.callback ? String(request.data.callback) : undefined,
      callbackOrigin,
      chainId: walletChain,
      request,
    },
    resolved,
  };
}

/** 链 ID 哈希 → 人能看懂的名字;不认识的链就给个哈希前缀,总比 64 位十六进制强 */
function chainLabel(chainIdHex: string): string {
  const known = Object.values(CHAINS).find((c) => c.chainIdHash.toLowerCase() === chainIdHex.toLowerCase());
  return known ? known.name : `${chainIdHex.slice(0, 8)}…`;
}

/**
 * getCallback() 的 background 标志决定回调该怎么送达,两种截然不同:
 *   - background=true:  服务端接口,我们直接后台 POST 签名过去就完事,
 *     页面本身不需要跟着动。
 *   - background=false: 这个回调 URL 本身就是给浏览器"导航"过去的(GET,
 *     `{{sig}}` 这类占位符已经替换成真实签名,编进了 query string 里)——
 *     很多网页版 DApp 的登录流程就是靠这一跳:回调页面自己的前端代码用
 *     window.location.search 读出签名、在页面里完成登录状态切换。之前
 *     不管 background 是什么都无脑 fetch(POST),这种页面收不到任何东西:
 *     我们的 POST 请求走的是 App 自己的网络层,跟打开的这个网页毫无关系,
 *     页面上的"登录"按钮自然一直不会变——这正是签名成功但 DApp 那边
 *     "什么反应都没有"的原因。调用方需要按 kind 分别处理:'redirect' 时
 *     必须让 WebView 真的跳转到 callbackUrl,不能只是记录一下就算数。
 */
export type SignCallbackResult = (
  | { kind: 'none' }
  | { kind: 'posted'; callbackUrl: string }
  | { kind: 'redirect'; callbackUrl: string }
  | { kind: 'callbackFailed'; callbackUrl: string; txId: string; callbackFailure: 'session' | 'delivery' }
) & {
  signature: string;
  /** 请求要求钱包代广播(shouldBroadcast)且已经上链时的交易 ID;dApp 自己广播的请求没有 */
  txId?: string;
};

export async function signAndCallback(opts: {
  resolved: ResolvedSigningRequest;
  signer: Signer;
  chainId: string;
  /** 展示用的链 slug(vaulta/jungle4)——只在记录 Link 会话时用,和上面
   *  chainId(真正参与签名计算的链哈希)是两码事 */
  chainSlug: ChainId;
  actor: string;
  permission?: string;
  /** 请求要求钱包代广播时往哪个节点推 */
  node: NodeInfo;
  isCurrent?: () => boolean;
}): Promise<SignCallbackResult> {
  const checkContext = () => { if (opts.isCurrent && !opts.isCurrent()) throw new Error(t('dappBrowser.requestChanged')); };
  checkContext();
  assertIdentityNotExpired(opts.resolved);
  esrCallbackOrigin(String(opts.resolved.request.data?.callback ?? ''));
  if (!opts.resolved.request.isIdentity()) assertVisibleTransaction(opts.resolved.transaction);
  const broadcast = opts.resolved.request.shouldBroadcast();

  let txId: string | undefined;
  let blockNum: number | undefined;
  if (!broadcast && !opts.resolved.request.isIdentity()) {
    await preflightDappResources({ transaction: opts.resolved.transaction, actor: opts.actor, nodeUrl: opts.node.url });
  }
  checkContext();
  // signingDigest 是只读属性,链 id 已在 resolve 阶段固定进请求里
  const sig: Signature = await signDigest(opts.signer, opts.resolved.signingDigest, {
    transaction: opts.resolved.transaction, chainId: opts.chainId,
    permission: opts.permission ?? 'active', isCurrent: opts.isCurrent,
  });
  checkContext();
  // System authentication can outlast the proof even when it was valid before signing.
  assertIdentityNotExpired(opts.resolved);
  if (!opts.resolved.request.isIdentity()) assertVisibleTransaction(opts.resolved.transaction);
  const signature = String(sig);

  if (broadcast) {
    checkContext();
    // 请求的 broadcast 标志为真:规范要求由钱包把交易推上链,再把 tx id 回给
    // dApp。anchor-link 出的请求默认是 false(dApp 自己拿签名去广播),但支付
    // 二维码、纯 ESR 工具出的码常常是 true——以前不管这个标志一律只签不推,
    // 用户看到"已签名",链上什么都没有。
    const api = new APIClient({ url: opts.node.url });
    try {
      const res = await api.v1.chain.send_transaction(
        SignedTransaction.from({ ...opts.resolved.transaction, signatures: [sig] })
      );
      txId = String(res.transaction_id);
      notifyTransactionApplied(opts.chainSlug, opts.actor, opts.resolved.transaction.actions);
      blockNum = res.processed?.block_num ? Number(res.processed.block_num) : undefined;
    } catch (e) {
      // 资源不够(CPU/NET、RAM)带专门的 Error 子类抛出去,宿主据此弹一键修复;
      // ESR 交易的字节是 resolve 时定死的,修好资源后用户重新点一次签名即可
      throw await transactionFailure(e, { chainId: opts.chainSlug, node: opts.node, actor: opts.actor, permission: opts.permission, signer: opts.signer, isCurrent: opts.isCurrent });
    }
  }

  const cb = buildCallback(opts.resolved, { signature, txId, blockNum });
  if (!cb) return { kind: 'none', signature, txId };
  esrCallbackOrigin(cb.url);

  if (!cb.background) {
    return { kind: 'redirect', signature, callbackUrl: cb.url, txId };
  }

  let payload: Record<string, unknown> = cb.payload;
  // 身份请求的回调里额外带上本机常驻接收频道的信息(link_ch/link_key/link_name,
  // 参考协议 https://github.com/greymass/anchor-link/blob/master/protocol.md
  // 的「Creating a Session」一节)——dApp 拿到这个之后,后续要签的交易就能
  // 直接推到这条频道上,不用每次都再弹一次二维码。只在 background 回调里加,
  // 前面 redirect 那条分支是给"同设备直接跳转登录"用的,回调 URL 是照着
  // 模板占位符现成算好的固定字符串,没法再往里塞这几个没模板占位符的额外字段。
  if (opts.resolved.request.isIdentity()) {
    const requestKey = linkRequestKey(opts.resolved.request);
    if (requestKey) {
      const identity = await getLinkIdentity();
      checkContext();
      payload = {
        ...cb.payload,
        link_ch: identity.channelUrl,
        link_key: String(identity.publicKey),
        link_name: linkDeviceName(),
      };
      assertIdentityNotExpired(opts.resolved);
      // A DApp can push its next request as soon as it receives this callback.
      await recordLinkSession({
        requestKey,
        name: identityScope(opts.resolved.request),
        account: opts.actor,
        chainId: opts.chainSlug,
        createdAt: Date.now(),
      });
    }
    // 取不到对方的请求公钥(老式/非 anchor-link 的身份请求)——不建立持久
    // 频道,身份证明照常回给对方,退回"每次都重新扫码"的兜底路径。注意
    // **不能**在这里记一条占位的会话:会话表是推送鉴权的唯一依据,记了对不上
    // 的值,后续每条推送都会被当成陌生人丢掉(踩过这个坑,见 linkRequestKey)。
  }

  // 故意不用 net/fetchRetry.ts 的 fetchWithRetry:cb.url 是任意第三方 dApp 给的
  // 回调地址,不是我们自己的节点/后端,幂等性无法保证——连接失败时我们不知道
  // 对方到底收没收到,盲目重试可能让不幂等的回调被处理两次。失败了直接抛给
  // 调用方按业务语义处理,不在这里兜。
  assertIdentityNotExpired(opts.resolved);
  checkContext();
  // Use Expo's native fetch explicitly: the legacy RN fetch can ignore redirect policy.
  try {
    const r = await callbackFetch(cb.url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      // Only an explicit DApp login error qualifies. HTTP 401/403 alone can also
      // mean gateway configuration or missing access, and never proves expiry.
      if (r.status === 401 || r.status === 403) {
        const code = await readDappSessionFailure(r);
        if (code) throw new DappSessionRejectedError(code, t('dappBrowser.sessionInvalidHint'));
      }
      throw new Error(t('esrError.callbackFailed', { status: r.status }));
    }
  } catch (error) {
    // Broadcasting and notifying a DApp are independent outcomes. Once on-chain,
    // this request is complete even if delivery fails; never offer to sign it again.
    if (txId) return { kind: 'callbackFailed', signature, callbackUrl: cb.url, txId,
      callbackFailure: error instanceof DappSessionRejectedError ? 'session' : 'delivery' };
    throw error;
  }

  return { kind: 'posted', signature, callbackUrl: cb.url, txId };
}

/**
 * 按 ESR 回调模板拼出 payload 和 URL。wharfkit 自带的 getCallback() 只在钱包
 * 代广播时把 tx 填成实际上链的交易 ID;占位符的替换规则(`{{key}}` → payload[key],
 * 缺的填空串)照抄 getCallback,保持和规范一致。
 */
export function buildCallback(
  resolved: ResolvedSigningRequest,
  o: { signature: string; txId?: string; blockNum?: number }
): { background: boolean; payload: Record<string, string>; url: string } | null {
  const base = resolved.getCallback([o.signature], o.blockNum ?? 0);
  if (!base) return null;
  const payload: Record<string, string> = { ...(base.payload as Record<string, string>) };
  if (o.txId) payload.tx = o.txId;
  const template = String(resolved.request.data.callback);
  const url = template.replace(/({{([a-z0-9]+)}})/g, (_1, _2, key: string) => payload[key] ?? '');
  return { background: base.background, payload, url };
}

/** dApp 在身份请求里自报的名字/scope——展示用,对方自己填的,不保真 */
function identityScope(request: SigningRequest): string {
  return String((request.data.req as any)?.value?.scope ?? '');
}

/**
 * anchor-link v3(wharfkit/protocol-esr)把会话信息塞在 `link` 这个 info 字段里,
 * 是个结构体而不是裸公钥:
 *
 *     link_create { session_name: name, request_key: public_key, user_agent: string }
 *
 * 后续这个会话推给我们的每一条签名请求,密封消息的 `from` 就是这里的
 * `request_key`——也就是说,它才是"这条会话是谁"的唯一身份标识,会话表必须
 * 记它。老式 anchor-link v2 用的是 `req_key`(裸公钥),这里两种都认。
 *
 * ⚠️ 踩过的坑:`getInfoKey()` 取不到字段时**返回 undefined 而不是抛异常**,
 * 以前这里直接 `String(reqKey)` 就把字符串 "undefined" 当公钥存进了会话表,
 * 外面的 try/catch 也就永远不会触发。结果是登录看着成功、"已连接的 DApp"
 * 里也有记录,但之后每一条推送都跟 "undefined" 比对不上,被当陌生人丢掉——
 * 表现就是"网页一直转圈等 Anchor 响应,手机永远不弹确认框"。
 */
export function linkRequestKey(request: SigningRequest): string | null {
  const linkInfo = request.getRawInfo().link;
  if (linkInfo) {
    try {
      // 只声明用得上的前两个字段:ABI 是按顺序解的,后面的 user_agent 多出来
      // 的字节直接忽略,免得跟着对方的协议小版本(它是不是 optional)较劲。
      const decoded: any = Serializer.decode({
        data: linkInfo,
        type: 'link_create',
        abi: ABI.from({
          structs: [
            {
              name: 'link_create',
              base: '',
              fields: [
                { name: 'session_name', type: 'name' },
                { name: 'request_key', type: 'public_key' },
              ],
            },
          ],
        }),
      });
      return String(PublicKey.from(decoded.request_key));
    } catch {
      // 结构对不上(协议又变了)——当没有,走下面 v2 的路子
    }
  }
  const reqKey = request.getInfoKey('req_key', PublicKey);
  return reqKey ? String(reqKey) : null;
}
