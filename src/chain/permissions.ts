// "已授权应用"——eos3.app 的 paylimit 合约那套给 Bot/DApp 发受限权限(自定义
// permission + updateauth/linkauth,配单笔/每日/总预算上限)的管理。
// 这是查看+管理已有权限,不是让 eostp 自己的 DApp 浏览器去创建这种权限
// (新建走 bindAuthorize.ts)。
//
// 查看(fetchAuthorizedApps)仍然问 eos3.app 后端——bot 用户名、项目名这些元数据
// 只有它有,链上只有 bot_id_hash。管理操作则**不再让后端拼交易**:这些 action
// 的全部参数(bot_id_hash、权限名、代币三元组、额度)客户端在概览里都拿到了,
// 直接按合约 ABI 自己拼 ActionSpec,走和转账同一条 transact() 链路——自己拼、
// 自己签、自己广播,资源不够时自动转代付。签的每个字节都是自己写的,不存在
// "核对别人拼的交易"这回事,以前那份 action 白名单也就不需要了。
//
// 参数名对照合约源码 eospasskey/contracts/paylimit.cpp,所有管理 action 都是
// require_auth(permission_level{owner, "active"}):声明的授权必须恰好是 active,
// 只导入了 owner 私钥的钱包做不了这些操作(UI 层负责提示)。
import { Asset } from '@wharfkit/antelope';

import { eos3Get } from './eos3Sign';
import { PAYLIMIT_CONTRACT } from '../passkey/constants';
import type { ActionSpec } from './transact';
import { t } from '../i18n';

export type AuthorizedAppAsset = {
  tokenContract: string;
  symbol: string;
  precision: number;
  perTxLimit: string | null;
  dailyLimit: string | null;
  dailySpent: string | null;
  totalBudget: string | null;
  totalSpent: string | null;
};

export type AuthorizedApp = {
  permission: string;
  parent: string;
  managedByPayLimit: boolean;
  active: boolean;
  botIdHash?: string;
  botUsername?: string;
  deviceLabel?: string;
  displayName?: string;
  projectName?: string;
  projectDescription?: string;
  createdAt?: string;
  assets: AuthorizedAppAsset[];
  threshold: number;
  keys: number;
  accounts: number;
  linkedActions: number;
};

/** 后端配置的"可授权代币目录"——新增授权代币时能选的候选列表,同一个账号概览接口顺带返回 */
export type PayLimitAssetConfig = {
  tokenContract: string;
  symbol: string;
  precision: number;
  perTxLimit?: string | null;
  dailyLimit?: string | null;
  totalBudget?: string | null;
};

export type AuthorizedAppsOverview = {
  eosAccount: string;
  permissions: AuthorizedApp[];
  assetCatalog: PayLimitAssetConfig[];
};

/** 拉取某账号的已授权应用列表 —— 不需要 eos3.app 平台登录态,按账号名查 */
export function fetchAuthorizedApps(account: string): Promise<AuthorizedAppsOverview> {
  return eos3Get<AuthorizedAppsOverview>(`/api/passkey-chain/permissions/account/${encodeURIComponent(account)}`);
}

// ---------- 拼管理 action(只拼,不签;签名/广播交给 transact()) ----------

type AssetRef = Pick<AuthorizedAppAsset, 'tokenContract' | 'symbol' | 'precision'>;

/** 合约里 symbol 类型的字符串形式:"4,EOS" */
function tokenSymbol(asset: AssetRef): string {
  return `${asset.precision},${asset.symbol}`;
}

/** paylimit 表按 bot_id_hash 定位记录;概览里没有它的权限不是 paylimit 管的,拼不出 action */
function botIdHashOf(app: Pick<AuthorizedApp, 'botIdHash'>): string {
  const hash = (app.botIdHash ?? '').trim();
  if (!hash) throw new Error(t('permission.missingBotId'));
  return hash;
}

/** 把某个已授权应用对某个代币的"已用额度"清零,不改变它的限额设置 */
export function buildResetUsageActions(opts: { account: string; app: AuthorizedApp; asset: AssetRef }): ActionSpec[] {
  return [
    {
      account: PAYLIMIT_CONTRACT,
      name: 'resettotal',
      data: {
        owner: opts.account,
        bot_id_hash: botIdHashOf(opts.app),
        token_contract: opts.asset.tokenContract,
        token_symbol: tokenSymbol(opts.asset),
      },
    },
  ];
}

/** 单独删掉某个已授权应用对某个代币的额度配置(不动这个权限本身,也不影响其它代币) */
export function buildRemoveAssetActions(opts: { account: string; app: AuthorizedApp; asset: AssetRef }): ActionSpec[] {
  return [
    {
      account: PAYLIMIT_CONTRACT,
      name: 'delasset',
      data: {
        owner: opts.account,
        bot_id_hash: botIdHashOf(opts.app),
        token_contract: opts.asset.tokenContract,
        token_symbol: tokenSymbol(opts.asset),
      },
    },
  ];
}

export type LimitDraft = { dailyLimit: string; totalBudget: string };

/**
 * 新增/编辑一个代币的限额走同一条 action —— 合约的 setlimit 本来就是"配置这个
 * 代币的额度",记录不存在就建、存在就改,不区分新增和修改。
 *
 * 每个限额都是 (has_x, x) 一对:关掉的项 has_x=false 且 x 必须是 0;合约要求
 * 至少开着一项。单笔上限没有单独的输入口,跟每日上限取同一个值(和旧 web 版
 * AccountPermissionsPage 一致)。
 */
export function buildSaveAssetActions(opts: {
  account: string;
  app: AuthorizedApp;
  asset: AssetRef;
  draft: LimitDraft;
}): ActionSpec[] {
  const dailyLimit = amountFromInput(opts.draft.dailyLimit, opts.asset.symbol, opts.asset.precision);
  const totalBudget = amountFromInput(opts.draft.totalBudget, opts.asset.symbol, opts.asset.precision);
  if (dailyLimit === null || totalBudget === null) throw new Error(t('permission.invalidAmount'));
  const hasDaily = Asset.from(dailyLimit).value > 0;
  const hasTotal = Asset.from(totalBudget).value > 0;
  if (!hasDaily && !hasTotal) throw new Error(t('permission.limitRequired'));
  return [
    {
      account: PAYLIMIT_CONTRACT,
      name: 'setlimit',
      data: {
        owner: opts.account,
        bot_id_hash: botIdHashOf(opts.app),
        permission: opts.app.permission,
        token_contract: opts.asset.tokenContract,
        token_symbol: tokenSymbol(opts.asset),
        has_per_tx_limit: hasDaily,
        per_tx_limit: dailyLimit,
        has_daily_limit: hasDaily,
        daily_limit: dailyLimit,
        has_total_budget: hasTotal,
        total_budget: totalBudget,
      },
    },
  ];
}

export type LinkedAction = { contract: string; action: string };

/**
 * 彻底撤销一个已授权应用:先把这个自定义权限 linkauth 过的 action 逐条解绑
 * (不解绑 deleteauth 会失败),再让 paylimit 合约删掉 bot 及其所有额度记录,
 * 最后删掉自定义权限本身(释放 RAM)。linkedActions 由调用方用
 * client.getLinkedActions() 从链上现查——概览接口只给了个数。
 */
export function buildRevokeActions(opts: { account: string; app: AuthorizedApp; linkedActions: LinkedAction[] }): ActionSpec[] {
  const actions: ActionSpec[] = opts.linkedActions.map((la) => ({
    account: 'eosio',
    name: 'unlinkauth',
    data: { account: opts.account, code: la.contract, type: la.action },
  }));
  if (opts.app.managedByPayLimit && opts.app.botIdHash) {
    actions.push({
      account: PAYLIMIT_CONTRACT,
      name: 'delbot',
      data: { owner: opts.account, bot_id_hash: botIdHashOf(opts.app) },
    });
  }
  actions.push({
    account: 'eosio',
    name: 'deleteauth',
    data: { account: opts.account, permission: opts.app.permission },
  });
  return actions;
}

// ---- 纯展示/格式化辅助 —— 从旧 web 版 accountFormatters.ts / permissionChanges.ts 移植,
// 逻辑不变,只是把模块级 resolveWebTranslator 换成调用方传入的 t() ----

function parseAmount(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.split(' ')[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAssetAmount(value: number, symbol: string, precision: number): string {
  return `${value.toFixed(precision)} ${symbol}`;
}

/** 把存储格式("12.3400 SYM")转成编辑框里要显示的纯数字("12.3400") */
export function amountInput(value?: string | null): string {
  return value?.split(' ')[0] ?? '';
}

/** 把编辑框里的纯数字转回存储格式;输入不是合法数字时返回 null,调用方据此拒绝提交 */
export function amountFromInput(value: string, symbol: string, precision: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) return formatAssetAmount(0, symbol, precision);
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return formatAssetAmount(parsed, symbol, precision);
}

export function amountOrUnlimited(value: string | null | undefined, symbol: string, precision: number): string {
  const parsed = parseAmount(value);
  if (parsed === null) return formatAssetAmount(0, symbol, precision);
  return formatAssetAmount(parsed, symbol, precision);
}

export function remainingAmount(limit: string | null | undefined, spent: string | null | undefined, symbol: string, precision: number): string {
  const limitValue = parseAmount(limit);
  if (limitValue === null) return formatAssetAmount(0, symbol, precision);
  return formatAssetAmount(Math.max(0, limitValue - (parseAmount(spent) ?? 0)), symbol, precision);
}

/** "今日还能花多少"——每日限额和总预算两条线里更紧的那条 */
export function todayRemainingAmount(asset: Pick<AuthorizedAppAsset, 'dailyLimit' | 'dailySpent' | 'totalBudget' | 'totalSpent' | 'symbol' | 'precision'>): string {
  const dailyLimit = parseAmount(asset.dailyLimit);
  const totalBudget = parseAmount(asset.totalBudget);
  const candidates: number[] = [];
  if (dailyLimit !== null) candidates.push(Math.max(0, dailyLimit - (parseAmount(asset.dailySpent) ?? 0)));
  if (totalBudget !== null) candidates.push(Math.max(0, totalBudget - (parseAmount(asset.totalSpent) ?? 0)));
  if (candidates.length === 0) return formatAssetAmount(0, asset.symbol, asset.precision);
  return formatAssetAmount(Math.min(...candidates), asset.symbol, asset.precision);
}

export function formatCreatedAt(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

type TFn = (key: any, vars?: Record<string, string | number>) => string;

export function permissionDisplayAppType(app: Pick<AuthorizedApp, 'permission' | 'botUsername' | 'deviceLabel'>, t: TFn): string {
  const device = (app.deviceLabel ?? '').toLowerCase();
  if (app.botUsername?.trim() || device.includes('telegram') || app.permission.startsWith('tg') || app.permission.endsWith('.tg')) {
    return t('permission.telegramMiniApp');
  }
  return t('permission.webApp');
}

export function permissionDisplayBot(app: Pick<AuthorizedApp, 'botUsername'>): string | null {
  const botUsername = app.botUsername?.trim();
  if (!botUsername) return null;
  return botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
}

export function permissionDisplayDevice(app: Pick<AuthorizedApp, 'deviceLabel'>): string | null {
  return app.deviceLabel?.trim() || null;
}

/** 列表页/详情页共用的 key——同一个 bot 在同一个权限名下应该是同一行 */
export function permissionKey(app: Pick<AuthorizedApp, 'botIdHash' | 'permission'>): string {
  return `${app.botIdHash ?? app.permission}:${app.permission}`;
}

export function fullAssetKey(asset: Pick<AuthorizedAppAsset, 'tokenContract' | 'symbol' | 'precision'>): string {
  return `${asset.tokenContract}:${asset.symbol}:${asset.precision}`;
}

export function sameAsset(
  left: Pick<AuthorizedAppAsset, 'tokenContract' | 'symbol' | 'precision'>,
  right: Pick<AuthorizedAppAsset, 'tokenContract' | 'symbol' | 'precision'>
): boolean {
  return fullAssetKey(left) === fullAssetKey(right);
}

/** 新增授权代币时能选的候选——目录里排除掉这个应用已经有额度的代币 */
export function selectableAssetCatalog(catalog: PayLimitAssetConfig[], existingAssets: AuthorizedAppAsset[]): PayLimitAssetConfig[] {
  return catalog.filter((candidate) => !existingAssets.some((asset) => sameAsset(asset, candidate)));
}

/** 把资产目录里的候选转成可编辑的 AuthorizedAppAsset(已用额度都是 0,还没提交过) */
export function editableAsset(candidate: PayLimitAssetConfig): AuthorizedAppAsset {
  return {
    tokenContract: candidate.tokenContract,
    symbol: candidate.symbol,
    precision: candidate.precision,
    perTxLimit: candidate.perTxLimit ?? null,
    dailyLimit: candidate.dailyLimit ?? null,
    dailySpent: '0',
    totalBudget: candidate.totalBudget ?? null,
    totalSpent: '0',
  };
}

export function initialDraft(asset: Pick<AuthorizedAppAsset, 'dailyLimit' | 'totalBudget'>): LimitDraft {
  return { dailyLimit: amountInput(asset.dailyLimit), totalBudget: amountInput(asset.totalBudget) };
}
