// 绑定协议的本地意图检查。应用公钥只存入 setbot；转账权限只交给固定
// paylimit 合约代码。额度必须写入链上，不能仅相信响应中的 assetLimits。
import { Asset, PublicKey } from '@wharfkit/antelope';
import { PAYLIMIT_CONTRACT, SPONSOR_ACCOUNT } from '../passkey/constants';
import { isValidAccountName } from './account';
import { TxIntentMismatchError } from './txIntentCheck';
import type { PlainTxAction, PlainTxJSON } from './eos3Sign';
import type { PayLimitAssetConfig } from './permissions';
import { t } from '../i18n';

export const PAY_TRANSFER_PERMISSION = 'paytransfer';
export type BindIdentity = { botIdHash: string; permission: string; publicKey: string };
export type BindIntent = {
  actor: string;
  chainId: string;
  identity: BindIdentity;
  assetLimits: PayLimitAssetConfig[];
};
export type BindChainState = {
  permissions: any[];
  bots: any[];
  limits: any[];
  allowedActions: any[];
};

function deny(): never {
  throw new TxIntentMismatchError(t('bindAuthorize.unsafe'));
}
function check(condition: unknown): asserts condition {
  if (!condition) deny();
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function same(a: unknown, b: unknown): void { check(stable(a) === stable(b)); }
function validPermission(permission: unknown): void {
  check(typeof permission === 'string' && isValidAccountName(permission));
  check(!['owner', 'active', PAY_TRANSFER_PERMISSION, 'eosio.code', 'eosio.any'].includes(permission));
}
export function bindIdentity(transaction: PlainTxJSON, actor: string): BindIdentity {
  check(Array.isArray(transaction?.actions));
  const actions = transaction.actions.filter((a) => a.account === PAYLIMIT_CONTRACT && a.name === 'setbot');
  check(actions.length === 1);
  const d = actions[0].data;
  check(d?.owner === actor && typeof d.bot_id_hash === 'string' && /^[a-f0-9]{64}$/.test(d.bot_id_hash));
  validPermission(d.permission);
  let publicKey: string;
  try { publicKey = String(PublicKey.from(d.app_public_key)); } catch { return deny(); }
  return { botIdHash: d.bot_id_hash, permission: d.permission, publicKey };
}
export function assertSameBindIdentity(a: BindIdentity, b: BindIdentity): void { same(a, b); }

/** 严格解析资产数量，不使用浮点数比较额度，也不允许负数或不同精度。 */
function limit(value: string | null | undefined, asset: PayLimitAssetConfig): { enabled: boolean; quantity: string } {
  const zero = Asset.fromUnits(0, `${asset.precision},${asset.symbol}`);
  if (value == null || value === '') return { enabled: false, quantity: String(zero) };
  check(typeof value === 'string' && /^\d+(?:\.\d+)? [A-Z]{1,7}$/.test(value));
  let amount: Asset;
  try { amount = Asset.from(value); } catch { return deny(); }
  check(String(amount.symbol) === `${asset.precision},${asset.symbol}`);
  const units = BigInt(String(amount.units));
  check(units >= 0n);
  return { enabled: units > 0n, quantity: String(amount) };
}
export function normalizeBindAssets(assets: PayLimitAssetConfig[]): PayLimitAssetConfig[] {
  check(Array.isArray(assets) && assets.length > 0 && assets.length <= 5);
  const seen = new Set<string>();
  return assets.map((a) => {
    check(a && typeof a.tokenContract === 'string' && isValidAccountName(a.tokenContract) &&
      typeof a.symbol === 'string' && /^[A-Z]{1,7}$/.test(a.symbol));
    check(Number.isInteger(a.precision) && a.precision >= 0 && a.precision <= 18);
    const id = `${a.tokenContract}:${a.precision},${a.symbol}`;
    check(!seen.has(id)); seen.add(id);
    const daily = limit(a.dailyLimit, a);
    const total = limit(a.totalBudget, a);
    // 本绑定页面没有独立单笔额度，协议要求单笔额度等于每日额度。
    const perTx = limit(a.perTxLimit, a);
    same(perTx, daily);
    check(daily.enabled || total.enabled);
    return { tokenContract: a.tokenContract, symbol: a.symbol, precision: a.precision,
      perTxLimit: daily.quantity, dailyLimit: daily.quantity, totalBudget: total.quantity };
  });
}
export function assertSameBindAssets(actual: PayLimitAssetConfig[], expected: PayLimitAssetConfig[]): void {
  const sorted = (assets: PayLimitAssetConfig[]) => normalizeBindAssets(assets)
    .sort((a, b) => `${a.tokenContract}:${a.symbol}`.localeCompare(`${b.tokenContract}:${b.symbol}`));
  same(sorted(actual), sorted(expected));
}

/** 协议中零额度表示该项未启用，不能向用户显示成“最多可花零”。 */
export function displayBindLimit(value: string | null | undefined, unlimited: string): string {
  return value && BigInt(String(Asset.from(value).units)) > 0n ? value : unlimited;
}

function authority(): Record<string, any> {
  return { threshold: 1, keys: [], accounts: [{ permission: { actor: PAYLIMIT_CONTRACT, permission: 'eosio.code' }, weight: 1 }], waits: [] };
}
function safeTransferPermission(p: any): boolean {
  return p?.parent === 'active' && stable(p.required_auth) === stable(authority());
}
function userAction(actor: string, account: string, name: string, data: Record<string, any>): PlainTxAction {
  return { account, name, authorization: [{ actor, permission: 'active' }], data };
}
function setLimit(intent: BindIntent, asset: PayLimitAssetConfig): PlainTxAction {
  const daily = limit(asset.dailyLimit, asset);
  const total = limit(asset.totalBudget, asset);
  return userAction(intent.actor, PAYLIMIT_CONTRACT, 'setlimit', {
    owner: intent.actor, bot_id_hash: intent.identity.botIdHash, permission: intent.identity.permission,
    token_contract: asset.tokenContract, token_symbol: `${asset.precision},${asset.symbol}`,
    has_per_tx_limit: daily.enabled, per_tx_limit: daily.quantity,
    has_daily_limit: daily.enabled, daily_limit: daily.quantity,
    has_total_budget: total.enabled, total_budget: total.quantity,
  });
}

/**
 * 校验整个交易并返回客户端重建的 action。未知操作（包括普通 Dapp action）
 * 不属于受限支付绑定协议，一律拒签。省略的权限/链接必须由链上现状证明安全。
 */
export function assertBindTxSafe(opts: { transaction: PlainTxJSON; intent: BindIntent; state: BindChainState }): PlainTxJSON {
  const { transaction: tx, intent, state } = opts;
  check(isValidAccountName(intent.actor));
  validPermission(intent.identity.permission);
  assertSameBindIdentity(bindIdentity(tx, intent.actor), intent.identity);
  const assets = normalizeBindAssets(intent.assetLimits);
  check(tx.delay_sec === 0 && Array.isArray(tx.context_free_actions) && tx.context_free_actions.length === 0);
  check(Array.isArray(tx.transaction_extensions) && tx.transaction_extensions.length === 0);
  const expiry = Date.parse(`${tx.expiration}Z`);
  check(Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + 600_000);
  check(Array.isArray(state.permissions) && Array.isArray(state.bots) && Array.isArray(state.limits) && Array.isArray(state.allowedActions));

  const matches = state.bots.filter((b) => b.bot_id_hash === intent.identity.botIdHash);
  check(matches.length <= 1);
  const bot = matches[0];
  if (bot) check(bot.owner === intent.actor && bot.permission === intent.identity.permission);
  check(!state.bots.some((b) => b.bot_id_hash !== intent.identity.botIdHash && b.permission === intent.identity.permission));
  const oldLimits = bot ? state.limits.filter((l) => String(l.botauth_id) === String(bot.id)) : [];
  const oldActions = bot ? state.allowedActions.filter((l) => String(l.botauth_id) === String(bot.id) && l.active !== false) : [];
  const selected = new Set(assets.map((a) => `${a.tokenContract}:${a.precision},${a.symbol}`));
  const deletions = oldLimits.filter((l) => !selected.has(`${l.token_contract}:${l.token_symbol}`));
  const expected = [
    userAction(intent.actor, PAYLIMIT_CONTRACT, 'setbot', {
      owner: intent.actor, bot_id_hash: intent.identity.botIdHash,
      permission: intent.identity.permission, app_public_key: intent.identity.publicKey,
    }),
    ...assets.map((a) => setLimit(intent, a)),
    ...deletions.map((l) => userAction(intent.actor, PAYLIMIT_CONTRACT, 'delasset', {
      owner: intent.actor, bot_id_hash: intent.identity.botIdHash,
      token_contract: l.token_contract, token_symbol: l.token_symbol,
    })),
  ];
  const remaining = expected.slice();
  let transfer = state.permissions.find((p) => p.perm_name === PAY_TRANSFER_PERMISSION);
  const linked = new Set<string>((transfer?.linked_actions ?? [])
    .filter((l: any) => l.action === 'transfer').map((l: any) => l.account));
  const contracts = new Set(assets.map((a) => a.tokenContract));
  const links = new Set<string>();
  let updated = false;
  let cleared = false;
  let noop = false;
  const actions: PlainTxAction[] = [];

  for (const a of tx.actions) {
    if (a.name === 'noop' && [PAYLIMIT_CONTRACT, SPONSOR_ACCOUNT].includes(a.account)) {
      check(!noop && actions.length === 0);
      check(a.authorization?.length === 1 && a.authorization[0].actor === a.account &&
        ['paycpu', 'active'].includes(a.authorization[0].permission));
      check(stable(a.data) === '{}' || stable(a.data) === stable({ memo: '' }));
      noop = true;
      actions.push(JSON.parse(JSON.stringify(a)));
      continue;
    }
    same(a.authorization, [{ actor: intent.actor, permission: 'active' }]);
    if (a.account === 'eosio' && a.name === 'updateauth') {
      check(!updated);
      const local = userAction(intent.actor, 'eosio', 'updateauth', {
        account: intent.actor, permission: PAY_TRANSFER_PERMISSION, parent: 'active', auth: authority(),
      });
      same(a, local); actions.push(local); updated = true;
      transfer = { parent: 'active', required_auth: authority() };
    } else if (a.account === 'eosio' && a.name === 'linkauth') {
      check(contracts.has(a.data?.code) && !links.has(a.data.code));
      const local = userAction(intent.actor, 'eosio', 'linkauth', {
        account: intent.actor, code: a.data.code, type: 'transfer', requirement: PAY_TRANSFER_PERMISSION,
      });
      same(a, local); actions.push(local); links.add(a.data.code); linked.add(a.data.code);
    } else if (a.account === PAYLIMIT_CONTRACT && a.name === 'clearacts') {
      check(!cleared);
      const local = userAction(intent.actor, PAYLIMIT_CONTRACT, 'clearacts', {
        owner: intent.actor, bot_id_hash: intent.identity.botIdHash,
      });
      same(a, local); actions.push(local); cleared = true;
    } else {
      const index = remaining.findIndex((local) => stable(a) === stable(local));
      check(index >= 0);
      actions.push(remaining.splice(index, 1)[0]);
    }
  }
  check(remaining.length === 0 && safeTransferPermission(transfer));
  check([...contracts].every((contract) => linked.has(contract)));
  check(oldActions.length === 0 || cleared);
  return { ...tx, actions };
}
