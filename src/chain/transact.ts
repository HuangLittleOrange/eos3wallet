// 交易构建、签名与广播
import { PrivateKey, Name, Asset, Checksum256, Signature } from '@wharfkit/antelope';
import { Session, TransactHookTypes } from '@wharfkit/session';
import type { WalletPlugin } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';

import { CHAINS, ChainId, NodeInfo } from './config';
import { assertAccountName } from './account';
import { WalletPluginPasskey } from './walletPluginPasskey';
import { signDigestWithPasskey } from '../passkey/webauthnSigning';
import { fetchWithRetry } from '../net/fetchRetry';
import {
  isSponsorIntentExpiredError,
  requestSponsoredBuild,
  signAndPushSponsored,
  SponsorFeeChangedError,
  toBroadcastError,
} from './sponsor';
import { t } from '../i18n';
import { rememberSponsorFee } from './sponsorFeeCache';
import { notifyTransactionApplied } from './walletDataEvents';
import { assertResolvedActionsMatch } from './transactionSafety';
import { AuthorizationFailureError, explainAuthorizationFailure, isAuthorizationFailure } from './authorizationError';

export type ActionSpec = {
  account: string; // 合约账户
  name: string; // action 名
  data: Record<string, any>;
  /** Original authorization when displaying a serialized transaction. */
  authorization?: { actor: string; permission: string }[];
};

export type TransactResult = {
  txId: string;
  blockNum?: number;
  explorerUrl: string;
};

/** 签名者:本机明文私钥,或 eos3.app 的 passkey(每次签名都现场发起系统认证) */
export type Signer =
  | { kind: 'privatekey'; privateKey: string }
  | { kind: 'passkey'; credentialIdHex: string; chainPublicKey: string };

function walletPluginFor(signer: Signer): WalletPlugin {
  if (signer.kind === 'passkey') {
    return new WalletPluginPasskey({ credentialIdHex: signer.credentialIdHex, chainPublicKey: signer.chainPublicKey });
  }
  return new WalletPluginPrivateKey(PrivateKey.from(signer.privateKey));
}

/**
 * 构建 session —— 每次交易临时创建,不持久化私钥。JS 内存的回收时间不可保证。
 * 链 ID 用配置里实测抄录的 chainIdHash(见 config.ts 注释),不再为了问链 ID
 * 先打一次 get_info——TAPOS(过期时间/参考块)由 session.transact() 内部自己
 * 拉取,这一次往返本来就是重复的。附带的安全收益:哪怕某个自定义节点其实
 * 指向别的链,签名也是按用户选定的链算的,别的链不会认。
 *
 * 注入 fetchWithRetry(见 net/fetchRetry.ts):session 内部拉 get_info 和最终
 * push_transaction 广播用的都是这个 fetch,原来是裸的,一次 TLS 握手抖动
 * 就把原始系统异常糊给用户看,还得手动重新走一遍 passkey 认证。重放已签名的
 * push_transaction 是安全的:节点对同一笔交易会去重,不会重复入账。
 */
function makeSession(chainId: ChainId, node: NodeInfo, actor: string, signer: Signer, permission = 'active', isCurrent?: () => boolean, actions?: ActionSpec[], onRpcFailure?: (error: unknown) => void) {
  const checkContext = () => { if (isCurrent && !isCurrent()) throw new Error(t('dappBrowser.requestChanged')); };
  const walletPlugin = walletPluginFor(signer);
  const originalSign = walletPlugin.sign.bind(walletPlugin);
  walletPlugin.sign = (resolved, context) => {
    checkContext();
    if (actions) assertResolvedActionsMatch(resolved.transaction, actions, actor, permission);
    return originalSign(resolved, context);
  };
  return new Session(
    {
      chain: { id: CHAINS[chainId].chainIdHash, url: node.url },
      actor: Name.from(actor),
      permission: Name.from(permission),
      walletPlugin,
    },
    {
      fetch: async (...args: Parameters<typeof fetchWithRetry>) => {
        checkContext();
        const response = await fetchWithRetry(...args);
        checkContext();
        // Session discards RPC error metadata and assumes details[0] exists.
        // Preserve permission failures before that normalization, without
        // changing the response or retrying/restricting the original operation.
        if (!response.ok && onRpcFailure && typeof response.clone === 'function') {
          try {
            const body: unknown = await response.clone().json();
            if (isAuthorizationFailure(body)) onRpcFailure(body);
          } catch { /* Keep the original SDK failure if the body is unreadable. */ }
          checkContext();
        }
        return response;
      },
      transactPlugins: isCurrent ? [{ id: 'wallet-request-context', register(context) {
        context.addHook(TransactHookTypes.beforeSign, async () => { checkContext(); });
        context.addHook(TransactHookTypes.afterSign, async () => { checkContext(); });
      } }] : undefined,
    }
  );
}

/**
 * 构建 transfer action。
 * 数量必须用 Asset 处理 —— 精度错误会被节点直接拒绝,
 * 而用 JS 浮点数拼字符串极易产生精度偏差。
 */
export function buildTransfer(opts: {
  contract: string;
  from: string;
  to: string;
  amount: number;
  symbol: string;
  precision: number;
  memo: string;
}): ActionSpec {
  // 账户名必须严格校验 —— Name.from 对非法输入会静默改写而非报错,
  // 用户多打一个 6/7/8/9/0 就会把钱转到另一个账户,且不可逆。
  const contract = assertAccountName(opts.contract, t('accountError.labelContract'));
  const from = assertAccountName(opts.from, t('accountError.labelPayer'));
  const to = assertAccountName(opts.to, t('accountError.labelReceiver'));

  if (!(opts.amount > 0)) throw new Error(t('transactError.amountPositive'));
  // Memo 上链后不可更改,超长会被节点拒绝
  if ((opts.memo ?? '').length > 256) throw new Error(t('transactError.memoTooLong'));

  const quantity = Asset.fromFloat(opts.amount, `${opts.precision},${opts.symbol}`);
  if (quantity.units.equals(0)) throw new Error(t('transactError.amountTooSmall'));

  return {
    account: contract,
    name: 'transfer',
    data: {
      from,
      to,
      quantity: String(quantity),
      memo: opts.memo ?? '',
    },
  };
}

type TransactOpts = {
  chainId: ChainId;
  node: NodeInfo;
  actor: string;
  signer: Signer;
  permission?: string;
  actions: ActionSpec[];
  isCurrent?: () => boolean;
};

/** Error explanation only; successful transactions incur no extra RPC calls. */
export async function transactionFailure(err: unknown, opts: Pick<TransactOpts, 'chainId' | 'node' | 'actor' | 'permission' | 'signer' | 'isCurrent'>): Promise<Error> {
  const failure = toBroadcastError(err, { actor: opts.actor, permission: opts.permission ?? 'active' });
  if (!(failure instanceof AuthorizationFailureError)) return failure;
  let publicKey: string | undefined;
  try { publicKey = opts.signer.kind === 'passkey' ? opts.signer.chainPublicKey : PrivateKey.from(opts.signer.privateKey).toPublic().toString(); }
  catch { /* Never expose a private key or key-parser error in diagnostics. */ }
  return explainAuthorizationFailure(failure, {
    nodeUrl: opts.node.url, chainId: CHAINS[opts.chainId].chainIdHash, publicKey, isCurrent: opts.isCurrent,
  });
}

/**
 * 本地拼、本地签、直接广播到节点——不预检资源、失败了也不自动转代付。
 * 资源不够(CPU/NET、RAM)的失败带着专门的 Error 子类抛出去,UI 据此弹
 * 修复弹窗让用户一键买资源,充完再回来点一次(见 ResourceRepairSheet)。
 */
export async function transact(opts: TransactOpts): Promise<TransactResult> {
  let rpcFailure: unknown;
  try {
    if (opts.isCurrent && !opts.isCurrent()) throw new Error(t('dappBrowser.requestChanged'));
    // Snapshot before the first asynchronous operation. The UI's authorization must
    // match the permission this broadcast path actually assigns to every action.
    const actions = JSON.parse(JSON.stringify(opts.actions)) as ActionSpec[];
    for (const action of actions) {
      if (action.authorization && (action.authorization.length !== 1 ||
          action.authorization[0].actor !== opts.actor ||
          action.authorization[0].permission !== (opts.permission ?? 'active'))) {
        throw new Error(t('dappBrowser.requestChanged'));
      }
    }
    const session = makeSession(opts.chainId, opts.node, opts.actor, opts.signer, opts.permission, opts.isCurrent, actions, failure => { rpcFailure = failure; });
    const result = await session.transact(
      {
        actions: actions.map((a) => ({
          account: Name.from(a.account),
          name: Name.from(a.name),
          authorization: [session.permissionLevel],
          data: a.data,
        })),
      },
      { broadcast: true, allowModify: false }
    );
    const txId = String(result.resolved?.transaction.id ?? result.response?.transaction_id ?? '');
    notifyTransactionApplied(opts.chainId, opts.actor, actions);
    return {
      txId,
      blockNum: result.response?.processed?.block_num,
      explorerUrl: explorerTx(opts.chainId, txId),
    };
  } catch (err) {
    throw await transactionFailure(rpcFailure ?? err, opts);
  }
}

/**
 * 走 Sponsor 代付:build → 核对 → 本地签名 → 交回 Sponsor 补签广播。只给
 * "买资源"这种用户自己发不出去的修复交易用(见 sponsor.ts 顶部说明)。
 *
 * approvedFee 是用户在修复弹窗里看到并同意的代付费(空 = 免费)。Sponsor 现报的
 * 价和它不一样就抛 SponsorFeeChangedError——不能替用户点头,让弹窗把新报价
 * 亮出来再点一次。
 */
export async function sponsoredTransact(opts: TransactOpts & { approvedFee?: string }): Promise<TransactResult> {
  const checkContext = () => { if (opts.isCurrent && !opts.isCurrent()) throw new Error(t('dappBrowser.requestChanged')); };
  const requestBuild = async () => {
    checkContext();
    const build = await requestSponsoredBuild({ actor: opts.actor, permission: opts.permission, actions: opts.actions });
    checkContext();
    // 当前报价先更新本地,不同价仍须用户再次确认,绝不按缓存价直接签。
    void rememberSponsorFee(opts.chainId, build.sponsorFee ?? '').catch(() => {});
    if ((build.sponsorFee ?? '') !== (opts.approvedFee ?? '')) throw new SponsorFeeChangedError(build.sponsorFee ?? '');
    return build;
  };
  try {
    let build = await requestBuild();
    const signAndPush = () =>
      signAndPushSponsored({
        build,
        node: opts.node,
        chainId: CHAINS[opts.chainId].chainIdHash,
        signer: opts.signer,
        isCurrent: opts.isCurrent,
        // 签名前按这份"用户点头过的原件"核对服务端返回的字节,见 txIntentCheck.ts
        intent: {
          actor: opts.actor,
          permission: opts.permission ?? 'active',
          actions: opts.actions,
          feeTokenContract: CHAINS[opts.chainId].systemToken,
          approvedFee: build.sponsorFee ? { quantity: build.sponsorFee, receiver: build.sponsorFeeReceiver ?? '' } : undefined,
        },
      });
    let txId: string;
    try {
      ({ txId } = await signAndPush());
    } catch (e) {
      // 服务端的代付意图只活 60 秒,用户在弹窗上多看一会儿、passkey 认证慢一点
      // 就会过期。内容本身没问题,同样的 action 重新 build 一份再签(报价变了
      // requestBuild 会抛出去)。重签意味着 passkey 会再弹一次系统认证,避不开。
      if (!isSponsorIntentExpiredError(e)) throw e;
      build = await requestBuild();
      ({ txId } = await signAndPush());
    }
    notifyTransactionApplied(opts.chainId, opts.actor, opts.actions);
    return { txId, explorerUrl: explorerTx(opts.chainId, txId) };
  } catch (err) {
    throw await transactionFailure(err, opts);
  }
}

/**
 * 对一个已经算好的摘要出签名 —— 两种签名者的差异只有这一处,收拢在这里。
 * 用在"交易不是我们拼的、只负责签"的场景:ESR 请求、DApp 通过 Scatter 的
 * requestSignature 递过来的已序列化交易。正常自己拼交易走 transact(),
 * 那条路由 session 内部签名,不经过这里。
 */
export async function signDigest(signer: Signer, digest: Checksum256): Promise<Signature> {
  if (signer.kind === 'passkey') {
    return signDigestWithPasskey({
      digest: digest.array,
      chainPublicKey: signer.chainPublicKey,
      credentialIdHex: signer.credentialIdHex,
    });
  }
  return PrivateKey.from(signer.privateKey).signDigest(digest);
}

// eoseyes.com 按链分子域名:主网是裸域名,Jungle4 测试网是 jungle4.eoseyes.com——
// 这个规律是直接在 eoseyes.com 上把网络切换器切到 Jungle4 Testnet、看地址栏实测出来的,
// 不是猜的。/tx/{64位十六进制哈希}、/account/{账户名} 两条路径也是照实测的链接抄的。
const EOSEYES_HOST: Record<ChainId, string> = {
  vaulta: 'eoseyes.com',
  jungle4: 'jungle4.eoseyes.com',
};

export function explorerTx(chainId: ChainId, txId: string): string {
  return `https://${EOSEYES_HOST[chainId]}/tx/${txId}`;
}

/** 账户在区块浏览器上的主页——代币详情页"在浏览器查看更多记录"用 */
export function explorerAccount(chainId: ChainId, account: string): string {
  return `https://${EOSEYES_HOST[chainId]}/account/${account}`;
}
