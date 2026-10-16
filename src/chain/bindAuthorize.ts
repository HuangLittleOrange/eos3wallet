// 服务端提供绑定资料；客户端核对完整受限支付协议并重建 action 后才签名。
import { notifyWalletDataChanged } from './walletDataEvents';
import { eos3Request, signPlainTransactionJSON, type PlainTxJSON } from './eos3Sign';
import { CHAINS, type ChainId, type NodeInfo } from './config';
import { PAYLIMIT_CONTRACT } from '../passkey/constants';
import { fetchWithRetry } from '../net/fetchRetry';
import { TxIntentMismatchError } from './txIntentCheck';
import {
  assertBindTxSafe, assertSameBindAssets, assertSameBindIdentity, bindIdentity, normalizeBindAssets,
  type BindChainState, type BindIdentity, type BindIntent,
} from './bindIntent';
import type { PayLimitAssetConfig } from './permissions';
import type { Signer } from './transact';
import { t } from '../i18n';

export type { PayLimitAssetConfig, BindIdentity };
export { assertBindTxSafe, bindIdentity } from './bindIntent';
export type BindAuthorizationInfo = {
  eosAccount: string;
  chainId: string;
  botUsername?: string;
  projectName?: string;
  projectDescription?: string;
  assetLimits: PayLimitAssetConfig[];
  transaction: PlainTxJSON;
};

export function buildBindAuthorization(opts: {
  bindId: string; eosAccount: string; assetLimits?: PayLimitAssetConfig[];
}): Promise<BindAuthorizationInfo> {
  return eos3Request<{
    tgpayBind: { transaction: PlainTxJSON; botUsername?: string; assetLimits: PayLimitAssetConfig[] };
    eosAccount: string; chainId: string; projectName?: string; projectDescription?: string;
  }>('/api/eos-wallet/tp-bind/build', opts).then((res) => ({
    eosAccount: res.eosAccount, chainId: res.chainId, botUsername: res.tgpayBind.botUsername,
    projectName: res.projectName, projectDescription: res.projectDescription,
    assetLimits: res.tgpayBind.assetLimits, transaction: res.tgpayBind.transaction,
  }));
}

export type PreparedBindAuthorization = {
  bindId: string;
  chain: ChainId;
  node: NodeInfo;
  intent: BindIntent;
  build: BindAuthorizationInfo;
};
// 只有实际经过 prepare 的不可变计划才能进入签名入口。
const prepared = new WeakSet<PreparedBindAuthorization>();
function unsafe(): never { throw new TxIntentMismatchError(t('bindAuthorize.unsafe')); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

async function chainJSON(node: NodeInfo, endpoint: string, body: unknown): Promise<any> {
  const response = await fetchWithRetry(node.url + '/v1/chain/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { attempts: 2, timeoutMs: 8_000 });
  if (!response.ok) throw new Error(t('signupError.queryFailed', { status: response.status }));
  return response.json();
}
async function readBindState(node: NodeInfo, intent: BindIntent): Promise<BindChainState> {
  const info = await chainJSON(node, 'get_info', {});
  if (info.chain_id !== intent.chainId) unsafe();
  // 不接受不完整的表查询：截断会遗漏已有的额度或额外权限。
  const table = async (name: string) => {
    const rows: any[] = [];
    let lowerBound = '';
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await chainJSON(node, 'get_table_rows', {
        json: true, code: PAYLIMIT_CONTRACT, scope: intent.actor, table: name, limit: 100,
        lower_bound: lowerBound,
      });
      if (!Array.isArray(result.rows)) unsafe();
      rows.push(...result.rows);
      if (result.more === false || result.more === '') return rows;
      if (!result.next_key || seen.has(String(result.next_key))) unsafe();
      lowerBound = String(result.next_key); seen.add(lowerBound);
    }
    return unsafe();
  };
  const [account, bots, limits, allowedActions] = await Promise.all([
    chainJSON(node, 'get_account', { account_name: intent.actor }),
    table('botauth'), table('assetlimit'), table('actionallow'),
  ]);
  if (account.account_name !== intent.actor || !Array.isArray(account.permissions)) unsafe();
  return { permissions: account.permissions, bots, limits, allowedActions };
}

/** 用户输入、初次看到的应用身份和选定网络都是独立的校验基准。 */
export async function prepareBindAuthorization(opts: {
  bindId: string; eosAccount: string; chain: ChainId; node: NodeInfo;
  build: BindAuthorizationInfo; preview: BindAuthorizationInfo; assetLimits: PayLimitAssetConfig[];
}): Promise<PreparedBindAuthorization> {
  // 所有调用参数在第一次 await 前复制，避免刷新或编辑在校验途中改掉原件。
  const snapshot = copy(opts);
  const chainId = CHAINS[snapshot.chain]?.chainIdHash;
  if (!chainId || snapshot.build.chainId !== chainId || snapshot.preview.chainId !== chainId ||
    snapshot.build.eosAccount !== snapshot.eosAccount || snapshot.preview.eosAccount !== snapshot.eosAccount) unsafe();
  const identity = bindIdentity(snapshot.preview.transaction, snapshot.eosAccount);
  assertSameBindIdentity(bindIdentity(snapshot.build.transaction, snapshot.eosAccount), identity);
  if (snapshot.build.projectName !== snapshot.preview.projectName ||
    snapshot.build.botUsername !== snapshot.preview.botUsername) unsafe();
  const assetLimits = normalizeBindAssets(snapshot.assetLimits);
  assertSameBindAssets(snapshot.build.assetLimits, assetLimits);
  const intent: BindIntent = { actor: snapshot.eosAccount, chainId, identity, assetLimits };
  const transaction = assertBindTxSafe({
    transaction: snapshot.build.transaction, intent, state: await readBindState(snapshot.node, intent),
  });
  const plan = freeze({
    bindId: snapshot.bindId, chain: snapshot.chain, node: snapshot.node, intent,
    build: { ...snapshot.build, assetLimits, transaction },
  });
  prepared.add(plan);
  return plan;
}

/** 只签用户确认过的冻结计划；认证期间切换钱包/网络时拒绝继续。 */
export async function signAndCompleteBindAuthorization(opts: {
  plan: PreparedBindAuthorization;
  getSigner: () => Promise<Signer>;
  isCurrent: () => boolean;
}): Promise<{ txId?: string }> {
  const { plan } = opts;
  if (!prepared.has(plan) || !opts.isCurrent()) unsafe();
  // 链上权限可能在预览后改变。重新核对省略的 updateauth/linkauth 是否仍安全。
  assertBindTxSafe({ transaction: plan.build.transaction, intent: plan.intent, state: await readBindState(plan.node, plan.intent) });
  if (!opts.isCurrent()) unsafe();
  const signer = await opts.getSigner();
  if (!opts.isCurrent()) unsafe();
  const { signature, serializedTransaction } = await signPlainTransactionJSON({
    transactionJson: plan.build.transaction, chainId: plan.intent.chainId, node: plan.node, signer,
  });
  if (!opts.isCurrent()) unsafe();
  const result = await eos3Request<{ ok: boolean; eosAccount: string; txid?: string }>('/api/eos-wallet/tp-bind/complete', {
    bindId: plan.bindId, eosAccount: plan.intent.actor,
    signedTransaction: { signatures: [signature], serializedTransaction, transaction: plan.build.transaction },
    assetLimits: plan.intent.assetLimits,
  });
  notifyWalletDataChanged({ chainId: plan.chain, accounts: [plan.intent.actor], permissions: true });
  return { txId: result.txid };
}
