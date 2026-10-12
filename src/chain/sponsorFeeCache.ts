import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from '@wharfkit/antelope';
import { CHAINS, type ChainId } from './config';
import { SPONSOR_BASE_URL, SPONSOR_PROJECT_ID, SPONSOR_MAX_FEE } from '../passkey/constants';

export type SponsorFeeSnapshot = { fee: string; updatedAt: number };
export const SPONSOR_FEE_TTL_MS = 24 * 60 * 60 * 1000;

// 固定项目费率与账户/权限/节点无关。只持久化费用与时间,不保存待签交易或密钥。
const snapshots = new Map<ChainId, SponsorFeeSnapshot | null>();
const loads = new Map<ChainId, Promise<SponsorFeeSnapshot | null>>();
const writes = new Map<ChainId, Promise<void>>();
const keyFor = (chainId: ChainId) => `aurora.sponsorFee.v1.${JSON.stringify([SPONSOR_BASE_URL, SPONSOR_PROJECT_ID, CHAINS[chainId].chainIdHash])}`;

function validFee(chainId: ChainId, fee: unknown): fee is string {
  if (fee === '') return true;
  if (typeof fee !== 'string') return false;
  try {
    const asset = Asset.from(fee);
    const cfg = CHAINS[chainId];
    return asset.symbol.equals(Asset.Symbol.from(`${cfg.precision},${cfg.symbol}`)) && asset.value >= 0 && asset.value <= SPONSOR_MAX_FEE;
  } catch {
    return false;
  }
}

export function isSponsorFeeFresh(snapshot: SponsorFeeSnapshot): boolean {
  const age = Date.now() - snapshot.updatedAt;
  return age >= 0 && age < SPONSOR_FEE_TTL_MS;
}

/** 过期价格仍可展示,真正签名前必须用当次 build 核对。坏数据绝不当成免费。 */
export function getCachedSponsorFee(chainId: ChainId): Promise<SponsorFeeSnapshot | null> {
  if (snapshots.has(chainId)) return Promise.resolve(snapshots.get(chainId)!);
  const pending = loads.get(chainId);
  if (pending) return pending;
  const loading = (async () => {
    let snapshot: SponsorFeeSnapshot | null = null;
    try {
      const raw = await AsyncStorage.getItem(keyFor(chainId));
      const value = raw ? JSON.parse(raw) : null;
      if (validFee(chainId, value?.fee) && Number.isFinite(value?.updatedAt) && value.updatedAt >= 0 && value.updatedAt <= Date.now()) {
        snapshot = { fee: value.fee, updatedAt: value.updatedAt };
      }
    } catch {}
    // 读取期间可能已经拿到充值时的新报价,不能用旧磁盘内容覆盖。
    if (!snapshots.has(chainId)) snapshots.set(chainId, snapshot);
    return snapshots.get(chainId)!;
  })();
  loads.set(chainId, loading);
  return loading;
}

/** 当次服务端已校验过的 build 更新展示价,无论交易成功还是价格变化待确认。 */
export async function rememberSponsorFee(chainId: ChainId, fee: string): Promise<SponsorFeeSnapshot> {
  if (!validFee(chainId, fee)) throw new Error('Invalid sponsor fee');
  const snapshot = { fee, updatedAt: Date.now() };
  snapshots.set(chainId, snapshot);
  // 顺序写入,防止较慢的旧写入在较新的报价之后落盘。
  const writing = (writes.get(chainId) ?? Promise.resolve())
    .then(() => AsyncStorage.setItem(keyFor(chainId), JSON.stringify(snapshot)))
    .catch(() => {});
  writes.set(chainId, writing);
  await writing;
  return snapshot;
}
