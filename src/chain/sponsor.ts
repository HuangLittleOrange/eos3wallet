// 资源不足时构建修复交易，确认操作与手续费后由代付服务补签并广播。
// 签名前核对原始交易字节与用户确认内容，不重新序列化服务端交易。
import 'react-native-get-random-values';

import { Asset } from '@wharfkit/antelope';

import { getCachedAbi, invalidateAbi } from './abiCache';
import { Eos3SignError, signSerializedTransaction } from './eos3Sign';
import {
  SPONSOR_ACCOUNT,
  SPONSOR_BASE_URL,
  SPONSOR_MAX_FEE,
  SPONSOR_PROJECT_ID,
} from '../passkey/constants';
import { assertSponsoredTxMatchesIntent, TxIntentMismatchError, type AbiProvider } from './txIntentCheck';
import type { NodeInfo } from './config';
import type { ActionSpec, Signer } from './transact';
import { t } from '../i18n';
import { fetchWithRetry } from '../net/fetchRetry';

export class SponsorError extends Eos3SignError {}

/** 广播失败,原因是账户 RAM 不够——UI 据此弹"一键买 1KB RAM"的修复弹窗 */
export class RamExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RamExhaustedError';
  }
}

/** 广播失败,原因是账户 CPU/NET 不够——UI 据此弹"买 PowerUp 充值"的修复弹窗 */
export class CpuNetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CpuNetExhaustedError';
  }
}

/**
 * Sponsor 报的代付费和用户在修复弹窗里看到、同意的那份不一样。不能替用户
 * 点头:抛出来让弹窗把新报价亮给用户,再点一次才签。
 */
export class SponsorFeeChangedError extends Error {
  /** 新报价,如 "0.0100 A";空串 = 现在免费 */
  readonly fee: string;
  constructor(fee: string) {
    super(t('sponsorError.feeChanged'));
    this.name = 'SponsorFeeChangedError';
    this.fee = fee;
  }
}

function resourceErrorText(err: unknown, depth = 0): string {
  if (err == null || depth > 8) return '';
  if (typeof err !== 'object') return String(err).toLowerCase();
  if (Array.isArray(err)) return err.map((value) => resourceErrorText(value, depth + 1)).join(' ');
  const value = err as Record<string, unknown>;
  // Wharfkit/RPC 错误有时顶层只有 HTTP 500,真实原因在 error.name/details。
  return ['message', 'name', 'what', 'error', 'details', 'response', 'json', 'processed', 'except']
    .map((key) => resourceErrorText(value[key], depth + 1)).join(' ');
}

export function isCpuNetExhaustedError(err: unknown): boolean {
  const message = resourceErrorText(err);
  return (
    message.includes('cpu usage') ||
    message.includes('net usage') ||
    message.includes('cpu_usage_exceeded') ||
    message.includes('net_usage_exceeded') ||
    message.includes('billed cpu') ||
    message.includes('account_resource_exceeded') ||
    message.includes('insufficient cpu') || message.includes('insufficient net')
  );
}

export function isRamExhaustedError(err: unknown): boolean {
  const message = resourceErrorText(err);
  return message.includes('ram usage') || message.includes('ram_usage_exceeded') || message.includes('insufficient ram');
}

/**
 * 服务端存的代付意图只活 60 秒——用户在弹窗上看久一点、passkey 认证慢一点就会
 * 撞上。这种失败不是内容有问题,同样的 action 重新 build 一份再签就行。
 */
export function isSponsorIntentExpiredError(err: unknown): boolean {
  const message = String((err as any)?.message ?? err ?? '').toLowerCase();
  return message.includes('sponsor request expired') || message.includes('does not match stored intent');
}

/**
 * 把签名/广播过程中的任何错误归一成 UI 能分流的形态:资源类错误(CPU/NET、RAM)
 * 用专门的 Error 子类标出来好弹修复弹窗,其余翻译成用户看得懂的文案。已经是
 * 归一过的错误原样返回,多层 catch 不会把类型抹掉。
 */
export function toBroadcastError(err: unknown): Error {
  if (
    err instanceof RamExhaustedError ||
    err instanceof CpuNetExhaustedError ||
    err instanceof SponsorFeeChangedError ||
    err instanceof TxIntentMismatchError
  ) {
    return err;
  }
  const message = friendlyChainErrorMessage(err);
  if (isRamExhaustedError(err)) return new RamExhaustedError(message);
  if (isCpuNetExhaustedError(err)) return new CpuNetExhaustedError(message);
  return new Error(message);
}

type SponsorAction = {
  account: string;
  name: string;
  authorization: { actor: string; permission: string }[];
  data: Record<string, any>;
};

/** eos-resource-sponsor 的 intent 返回体(build/submit 共用同一个形状) */
export type SponsoredBuildResult = {
  sponsorRequestId: string;
  projectId: string;
  account: string;
  reference: string;
  serializedTransaction: string;
  transaction: Record<string, any>;
  /** 只有走 /presigned 才会有,这里用的是 build+submit 两步流程,始终为空 */
  sponsorSignature?: string;
  /** 免费时不带这个字段;带了就是收费,必须在签名前把这个数字展示给用户 */
  sponsorFee?: string;
  sponsorFeeReceiver?: string;
  status: string;
  expiresAt: string;
  txid?: string;
};

/** 每笔代付请求一个唯一的业务幂等 ID —— 服务端按这个去重,同一笔重复提交不会被重复处理 */
function newReference(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `wallet:${hex}`;
}

function toSponsorActions(actions: ActionSpec[], actor: string, permission: string): SponsorAction[] {
  return actions.map((a) => ({
    account: a.account,
    name: a.name,
    authorization: [{ actor, permission }],
    data: a.data,
  }));
}

/** 把节点/Sponsor 服务返回的英文报错,翻译成用户看得懂、知道该怎么办的提示 */
export function friendlyChainErrorMessage(err: unknown): string {
  const message = String((err as any)?.message ?? err ?? '');
  const lower = resourceErrorText(err);
  if (isRamExhaustedError(err)) {
    return t('sponsorError.ramInsufficient');
  }
  if (isCpuNetExhaustedError(err)) {
    return t('sponsorError.cpuNetInsufficient');
  }
  if (lower.includes('is not allowed')) {
    return t('sponsorError.notEligible');
  }
  if (isSponsorIntentExpiredError(err)) {
    return t('sponsorError.expired');
  }
  if (lower.includes('no balance object found')) {
    return t('chainError.noTokenBalance');
  }
  if (lower.includes('overdrawn balance') || lower.includes('insufficient balance')) {
    return t('sponsorError.feeInsufficientBalance');
  }
  if (lower.includes('too many actions')) {
    return t('sponsorError.tooManyActions');
  }
  if (lower.includes('invalid project credentials')) {
    return t('sponsorError.notConfigured');
  }
  if (lower.includes('missing required authority') || lower.includes('unsatisfied_authorization') ||
      lower.includes('provided keys, permissions, and delays do not satisfy')) {
    return t('chainError.authorization');
  }
  if (lower.includes('expired transaction') || lower.includes('tx_expired') || lower.includes('invalid reference block')) {
    return t('chainError.expired');
  }
  if (lower.includes('network request failed') || lower.includes('failed to fetch') || lower.includes('fetch failed')) {
    return t('eos3Error.unstableNetwork');
  }
  if (lower.includes('assertion failure') || lower.includes('assertion_failure') ||
      lower.includes('internal service error') || /^http 5\d\d\b/.test(lower.trim())) {
    return t('chainError.rejected');
  }
  return message || t('send.signOrBroadcastFailed');
}

/**
 * 请求本身的错误处理跟 eos3Sign.ts 里的 eos3Request 是同一套思路(网络抖动
 * 重试——见 net/fetchRetry.ts 的 fetchWithRetry、非 2xx 抛错),这里单独写
 * 一份是因为要带 Sponsor 的公开项目标识,跟 eos3.app 自己那套接口不是一回事,
 * 不适合共用同一个函数。
 */
async function sponsorRequest<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${SPONSOR_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Project-ID': SPONSOR_PROJECT_ID,
      },
      body: JSON.stringify(body),
    }, { timeoutMs: 8000 });
  } catch {
    // 只有"连接本身失败"(fetch 直接 throw)这种一过性抖动才会走到这里——
    // fetchWithRetry 已经重试过,仍然失败才真的判定为网络不稳定
    throw new SponsorError(t('eos3Error.unstableNetwork'));
  }
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new SponsorError(res.ok ? t('eos3Error.badResponseFormat') : t('eos3Error.requestFailed', { status: res.status }));
  }
  // 服务端已经返回了业务错误(非 2xx)属于确定性结果,不重试
  if (!res.ok) throw new SponsorError(parsed?.error ?? t('eos3Error.requestFailed', { status: res.status }));
  return parsed as T;
}

/**
 * 报价本身的合理性——在拿到 build 的当口就核对,不等到签名:
 *   - 收款人必须是钉死在客户端的 Sponsor 账户。弹窗只给用户看金额、不看收款人,
 *     服务端被攻破后把收款人换掉,用户在弹窗上看不出任何区别,所以不能采信
 *     它自报的 sponsorFeeReceiver;
 *   - 金额不能超过客户端认定的上限,防止报个离谱数字靠用户手滑通过。
 * 对不上的 build 直接作废(抛 TxIntentMismatchError)。
 */
function assertBuildAcceptable(build: SponsoredBuildResult): void {
  if (!build.sponsorFee) return;
  if (build.sponsorFeeReceiver !== SPONSOR_ACCOUNT) {
    throw new TxIntentMismatchError(t('txCheck.feeReceiverMismatch'));
  }
  let fee: number;
  try {
    fee = Asset.from(build.sponsorFee).value;
  } catch {
    throw new TxIntentMismatchError(t('txCheck.feeTooHigh', { fee: build.sponsorFee }));
  }
  if (!(fee <= SPONSOR_MAX_FEE)) {
    throw new TxIntentMismatchError(t('txCheck.feeTooHigh', { fee: build.sponsorFee }));
  }
}

/** 第一步:把要执行的 action 报给 Sponsor,换回一笔待签名的代付交易(+可能的代付费报价) */
export async function requestSponsoredBuild(opts: {
  actor: string;
  permission?: string;
  actions: ActionSpec[];
}): Promise<SponsoredBuildResult> {
  const permission = opts.permission ?? 'active';
  const build = await sponsorRequest<SponsoredBuildResult>('/v1/sponsored-transactions', {
    account: opts.actor,
    reference: newReference(),
    actions: toSponsorActions(opts.actions, opts.actor, permission),
  });
  assertBuildAcceptable(build);
  return build;
}

/** 校验代付交易用的"用户原始意图"——都是本地弹窗那一侧的数据,不来自服务端 */
export type SponsorIntent = {
  actor: string;
  permission: string;
  /** 用户在弹窗里同意的 action 列表 */
  actions: ActionSpec[];
  /** 代付费只允许走这条链的系统代币合约 */
  feeTokenContract: string;
  /**
   * 用户在弹窗里**看到过**的代付费报价。不传就是"只允许免费代付",交易里
   * 冒出任何手续费都会被当成未确认操作拒签。
   */
  approvedFee?: { quantity: string; receiver: string };
  /** 测试注入用;不传就从 node 现建 APIClient 拉链上 ABI */
  getAbi?: AbiProvider;
};

function nodeAbiProvider(node: NodeInfo): AbiProvider {
  return (account: string) => getCachedAbi(node.url, account);
}

/**
 * 第二步:对 build() 返回的原始字节签名(不重新序列化),连同签名一起提交给
 * Sponsor——服务端逐字节核对跟它存的意图一致后,追加自己的签名并广播,
 * 返回值里的 txid 就是最终链上交易 ID。
 *
 * 签名之前必须先过 assertSponsoredTxMatchesIntent:服务端返回的字节是不可信
 * 输入,得先解码核对"以用户身份授权的内容 = 用户确认过的 action + 报过价的
 * 代付费",对不上直接拒签——服务端被攻破时它唯一的筹码就是这串字节,这里
 * 拦住了它就什么都做不了(详见 txIntentCheck.ts)。
 */
export async function signAndPushSponsored(opts: {
  build: SponsoredBuildResult;
  node: NodeInfo;
  chainId: string;
  signer: Signer;
  intent: SponsorIntent;
  isCurrent?: () => boolean;
}): Promise<{ txId: string; signature: string }> {
  const checkContext = () => { if (opts.isCurrent && !opts.isCurrent()) throw new Error(t('dappBrowser.requestChanged')); };
  checkContext();
  const runIntentCheck = () =>
    assertSponsoredTxMatchesIntent({
      serializedTransaction: opts.build.serializedTransaction,
      actor: opts.intent.actor,
      permission: opts.intent.permission,
      userActions: opts.intent.actions,
      sponsorFee: opts.intent.approvedFee?.quantity,
      sponsorFeeReceiver: opts.intent.approvedFee?.receiver,
      feeTokenContract: opts.intent.feeTokenContract,
      getAbi: opts.intent.getAbi ?? nodeAbiProvider(opts.node),
    });
  try {
    await runIntentCheck();
  } catch (e) {
    // 核对失败大概率是真夹带,但也可能是链上合约恰好在这个当口升级了 ABI——
    // 缓存里的旧版编出来的字节和服务端用新版拼的对不上。清掉相关合约的缓存、
    // 用新鲜 ABI 再核一次,仍然对不上才是真的有问题。只对默认的缓存 provider
    // 这样做;测试注入的 getAbi 没有缓存这一说,重跑一遍也是同样结果。
    if (!(e instanceof TxIntentMismatchError) || opts.intent.getAbi) throw e;
    for (const a of opts.intent.actions) invalidateAbi(opts.node.url, a.account);
    invalidateAbi(opts.node.url, opts.intent.feeTokenContract);
    await runIntentCheck();
  }

  checkContext();
  const { signature } = await signSerializedTransaction({
    serializedTransaction: opts.build.serializedTransaction,
    chainId: opts.chainId,
    signer: opts.signer,
  });
  checkContext();

  const result = await sponsorRequest<SponsoredBuildResult>(
    `/v1/sponsored-transactions/${encodeURIComponent(opts.build.sponsorRequestId)}/submit`,
    {
      serializedTransaction: opts.build.serializedTransaction,
      signatures: [signature],
    }
  );

  if (!result.txid) throw new SponsorError(t('send.signOrBroadcastFailed'));
  return { txId: result.txid, signature };
}
