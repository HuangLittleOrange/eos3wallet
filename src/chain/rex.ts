import type { ChainClient } from './client';
import { assertAccountName } from './account';
import { t } from '../i18n';

const MAINNET = 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906';
const MAX_ASSET = (1n << 62n) - 1n;
export type RexOperation = 'buy' | 'unlock' | 'sell' | 'withdraw' | 'cancel';
export type RexBalances = {
  account: string; liquid: string; total: string; savings: string; available: string; fund: string;
  maturityDays: number; autoSell: boolean;
  maturities: { at: string; quantity: string }[];
  order: { open: boolean; requested: string } | null;
};

/** Do not round, parseFloat, accept exponents, or reuse a REX number as core tokens. */
export function rexQuantity(value: string, symbol: string): string {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]{1,4})?$/.test(value.trim()) || !/^[A-Z]{1,7}$/.test(symbol)) throw new Error(t('rex.invalidAmount'));
  const [whole, fraction = ''] = value.trim().split('.');
  const units = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  if (units <= 0n || units > MAX_ASSET) throw new Error(t('rex.invalidAmount'));
  return rexFormat(units, symbol);
}
export function rexFormat(units: bigint, symbol: string): string {
  if (units < 0n || units > MAX_ASSET) throw new Error(t('rex.loadFailed'));
  const digits = units.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)} ${symbol}`;
}
export function rexAssetUnits(asset: unknown, symbol: string): bigint {
  const match = String(asset).match(/^([0-9]+)\.([0-9]{4}) ([A-Z]{1,7})$/);
  if (!match || match[3] !== symbol) throw new Error(t('rex.loadFailed'));
  const units = BigInt(match[1]) * 10000n + BigInt(match[2]);
  if (units > MAX_ASSET) throw new Error(t('rex.loadFailed'));
  return units;
}
function coreUnits(asset: unknown): bigint {
  const symbol = String(asset).split(' ')[1];
  if (symbol !== 'EOS' && symbol !== 'A') throw new Error(t('rex.loadFailed'));
  return rexAssetUnits(asset, symbol);
}
function flag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(t('rex.loadFailed'));
}
function integer(value: unknown): bigint {
  if (!/^[0-9]+$/.test(String(value))) throw new Error(t('rex.loadFailed'));
  const n = BigInt(String(value));
  if (n > MAX_ASSET) throw new Error(t('rex.loadFailed'));
  return n;
}
export function decodeRexBalances(account: string, now: number, rows: any[][], liquid: string): RexBalances {
  const own = (data: any[]) => {
    if (data.length > 1 || (data[0] && String(data[0].owner) !== account)) throw new Error(t('rex.loadFailed'));
    return data[0];
  };
  const bal = own(rows[0]), fund = own(rows[1]), order = own(rows[2]), policy = rows[3]?.[0];
  if (!Number.isFinite(now) || !policy || rows[3].length !== 1 || !Number.isInteger(policy.num_of_maturity_buckets) || policy.num_of_maturity_buckets <= 0) throw new Error(t('rex.loadFailed'));
  const total = bal ? rexAssetUnits(bal.rex_balance, 'REX') : 0n;
  let available = bal ? integer(bal.matured_rex) : 0n;
  let savings = 0n;
  const maturities: RexBalances['maturities'] = [];
  for (const bucket of bal?.rex_maturities ?? []) {
    const at = Date.parse(String(bucket.first).replace(/Z?$/, 'Z'));
    const quantity = integer(bucket.second);
    if (!Number.isFinite(at)) throw new Error(t('rex.loadFailed'));
    if (at === 4294967295000) savings += quantity;
    else if (at <= now) available += quantity;
    else maturities.push({ at: new Date(at).toISOString(), quantity: rexFormat(quantity, 'REX') });
  }
  if (savings + available > total) throw new Error(t('rex.loadFailed'));
  let availableFund = fund ? coreUnits(fund.balance) : 0n;
  let pending: RexBalances['order'] = null;
  if (order) {
    const requested = rexAssetUnits(order.rex_requested, 'REX');
    const open = flag(order.is_open);
    pending = { open, requested: rexFormat(requested, 'REX') };
    if (open) available = available > requested ? available - requested : 0n;
    else availableFund += coreUnits(order.proceeds);
  }
  rexAssetUnits(liquid, 'A');
  return { account, liquid, total: rexFormat(total, 'REX'), savings: rexFormat(savings, 'REX'), available: rexFormat(available, 'REX'), fund: rexFormat(availableFund, 'A'),
    maturityDays: policy.num_of_maturity_buckets, autoSell: flag(policy.sell_matured_rex), maturities, order: pending };
}
export async function readRexBalances(client: ChainClient, account: string): Promise<RexBalances> {
  assertAccountName(account, t('accountError.labelAccount'));
  if (client.config.chainIdHash !== MAINNET || client.config.resourceContract !== 'core.vaulta' || client.config.symbol !== 'A') throw new Error(t('rex.loadFailed'));
  const info = await client.getInfo();
  if (info.chainId !== MAINNET) throw new Error(t('rex.loadFailed'));
  const [balances, ...tables] = await Promise.all([
    client.getBalance('core.vaulta', account, 'A'),
    ...['rexbal', 'rexfund', 'rexqueue', 'rexmaturity'].map((table, index) => client.getTableRows({ json: true, code: 'eosio', scope: 'eosio', table, limit: 1,
      ...(index < 3 ? { key_type: 'name', lower_bound: account, upper_bound: account } : {}) })),
  ]);
  if (tables.some((table) => !Array.isArray(table.rows))) throw new Error(t('rex.loadFailed'));
  const liquid = (balances as { raw: string }[])[0]?.raw ?? '0.0000 A';
  return decodeRexBalances(account, Date.parse(info.chainTime), tables.map((table) => table.rows), liquid);
}
export function rexOperationError(operation: RexOperation, value: string, state: RexBalances): string | null {
  try {
    if (operation === 'cancel') return state.order?.open ? null : t('rex.noOrder');
    const symbol = operation === 'sell' || operation === 'unlock' ? 'REX' : 'A';
    const amount = rexAssetUnits(rexQuantity(value, symbol), symbol);
    const cap = operation === 'buy' ? state.liquid : operation === 'unlock' ? state.savings : operation === 'sell' ? state.available : state.fund;
    if (operation === 'sell' && state.order?.open) return t('rex.pending');
    if (amount > rexAssetUnits(cap, symbol) || (operation === 'sell' && rexQuantity(value, symbol) !== state.available)) return t('rex.insufficient');
    return null;
  } catch { return t('rex.invalidAmount'); }
}
