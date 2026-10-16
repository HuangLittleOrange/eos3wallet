import { Platform } from 'react-native';
import { EOS3_BASE_URL } from '../passkey/constants';
import { generateKey, findAccountsByKey, type KeyAccountMatch } from '../crypto/keys';
import {
  importStoredPendingDeviceKey, discardStoredPendingDeviceKey, loadPendingDeviceKey,
  newWalletId, removeSecret, savePendingDeviceKey, saveSecret, verifyMasterPassword,
  WrongPasswordError, type DeviceKeyMeta, type PendingDeviceKey, type StoredWallet,
} from '../crypto/vault';
import { CHAINS, type ChainId } from './config';
import { t } from '../i18n';
import { fetchWithRetry } from '../net/fetchRetry';

export function deviceLabel(): string {
  const c = (Platform.constants ?? {}) as { Brand?: string; Model?: string; Manufacturer?: string };
  const brand = (c.Brand ?? c.Manufacturer ?? '').trim();
  const model = (c.Model ?? '').trim();
  const label = [brand, model].filter(Boolean).join(' ').trim();
  return (label || (Platform.OS === 'android' ? 'Android' : Platform.OS)).slice(0, 40);
}

export const DEVICE_KEY_AUTH_RETURN_URL = 'eos3wallet://device-key-authorized';

export function deviceKeyAuthorizeUrl(
  meta: Pick<DeviceKeyMeta, 'publicKey' | 'label'>,
  baseUrl: string = EOS3_BASE_URL,
  returnTo?: string
): string {
  const u = new URL(`${baseUrl}/account`);
  u.searchParams.set('deviceKey', meta.publicKey);
  if (meta.label) u.searchParams.set('deviceLabel', meta.label);
  if (returnTo) u.searchParams.set('returnTo', returnTo);
  return u.toString();
}

export async function createPendingDeviceKey(password: string, chainId: ChainId): Promise<PendingDeviceKey> {
  if (!Object.prototype.hasOwnProperty.call(CHAINS, chainId)) throw new Error(t('deviceKey.chainMismatch'));
  if (!(await verifyMasterPassword(password))) throw new WrongPasswordError();
  if (await loadPendingDeviceKey()) throw new Error(t('vaultError.pendingKeyExists'));
  const key = generateKey();
  const pending: PendingDeviceKey = {
    id: newWalletId(),
    publicKey: key.publicKey,
    legacyPublicKey: key.legacyPublicKey,
    label: deviceLabel(),
    createdAt: Date.now(),
    chainId,
  };
  await saveSecret(pending.id, key.privateKey, password);
  try {
    await savePendingDeviceKey(pending);
  } catch (error) {
    await removeSecret(pending.id).catch(() => {});
    throw error;
  }
  return pending;
}

export async function discardPendingDeviceKey(pending: PendingDeviceKey, node: { url: string }, chainId: ChainId): Promise<void> {
  if (!pending.chainId) throw new Error(t('deviceKey.legacyPendingRecovery'));
  assertPendingDeviceChain(pending, chainId);
  // 跨设备授权可能没有回调；任何链查询失败都不能证明删除安全。
  const references = await Promise.allSettled((Object.keys(CHAINS) as ChainId[]).map((chain) =>
    findDeviceKeyAccountsStrict(chain === chainId ? node : CHAINS[chain].nodes[0], pending, chain)));
  const failed = references.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  if (references.some((result) => result.status === 'fulfilled' && result.value.length)) {
    throw new Error(t('deviceKey.authorizedImportFirst'));
  }
  await discardStoredPendingDeviceKey(pending);
}

export function assertPendingDeviceChain(pending: PendingDeviceKey, chainId: ChainId): void {
  if (pending.chainId !== undefined && pending.chainId !== chainId) throw new Error(t('deviceKey.chainMismatch'));
}

async function readChainJSON(node: { url: string }, endpoint: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const response = await fetchWithRetry(`${node.url}/v1/chain/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  }, { attempts: 2, timeoutMs: 8_000 });
  if (!response.ok) throw new Error(t('signupError.queryFailed', { status: response.status }));
  return response.json();
}

async function assertNodeChain(node: { url: string }, chainId: ChainId, signal?: AbortSignal): Promise<void> {
  const info = await readChainJSON(node, 'get_info', {}, signal);
  if (!CHAINS[chainId] || typeof info.chain_id !== 'string' ||
    info.chain_id !== CHAINS[chainId].chainIdHash) throw new Error(t('deviceKey.queryChainMismatch'));
}

async function findDeviceKeyAccountsStrict(node: { url: string }, pending: PendingDeviceKey, chainId: ChainId): Promise<string[]> {
  await assertNodeChain(node, chainId);
  const accounts = new Set<string>();
  for (const key of [pending.publicKey, pending.legacyPublicKey]) {
    const result = await readChainJSON(node, 'get_accounts_by_authorizers', { keys: [key] });
    if (!Array.isArray(result.accounts)) throw new Error(t('signupError.pendingReadFailed'));
    for (const entry of result.accounts) {
      if (typeof entry.account_name !== 'string' || !entry.account_name) throw new Error(t('signupError.pendingReadFailed'));
      accounts.add(entry.account_name);
    }
  }
  return Array.from(accounts);
}

/** 兼容新旧公钥编码；Hyperion 未提供权限时只返回账户候选。 */
export async function findAccountsForDeviceKey(
  node: { url: string },
  historyNode: { url: string } | undefined,
  pending: Pick<PendingDeviceKey, 'publicKey' | 'legacyPublicKey'>
): Promise<string[]> {
  const chainUrl = node.url;
  const hyperion = historyNode?.url;
  let matches = await findAccountsByKey(chainUrl, pending.publicKey, hyperion).catch(() => [] as KeyAccountMatch[]);
  if (!matches.length) {
    matches = await findAccountsByKey(chainUrl, pending.legacyPublicKey, hyperion).catch(() => [] as KeyAccountMatch[]);
  }
  return accountsWithActive(matches);
}

export function accountsWithActive(matches: KeyAccountMatch[]): string[] {
  return matches.filter((m) => !m.permissions.length || m.permissions.includes('active')).map((m) => m.account);
}

/** 导入已加密的待授权密钥，并原子清除 pending 记录。 */
export async function importPendingDeviceKey(pending: PendingDeviceKey, account: string, chainId: ChainId, node: { url: string }, signal?: AbortSignal): Promise<StoredWallet> {
  assertPendingDeviceChain(pending, chainId);
  if (signal?.aborted) throw new Error(t('anchorImport.cancelled'));
  await assertNodeChain(node, chainId, signal);
  if (signal?.aborted) throw new Error(t('anchorImport.cancelled'));
  const onChain = await readChainJSON(node, 'get_account', { account_name: account }, signal);
  const active = onChain.permissions?.find((permission: any) => permission.perm_name === 'active');
  if (onChain.account_name !== account || !Array.isArray(active?.required_auth?.keys) ||
    !Number.isSafeInteger(active.required_auth.threshold) || active.required_auth.threshold < 1 ||
    !active.required_auth.keys.some((key: any) => typeof key.key === 'string' &&
      Number.isSafeInteger(key.weight) && key.weight >= active.required_auth.threshold && samePublicKey(key.key, pending.publicKey))) {
    throw new Error(t('deviceKeyImport.notYet'));
  }
  const wallet: StoredWallet = {
    id: pending.id,
    account,
    publicKey: pending.publicKey,
    createdAt: pending.createdAt,
    source: 'privatekey',
    chainId,
    authPermissions: ['active'],
    deviceKey: { publicKey: pending.publicKey, label: pending.label, createdAt: pending.createdAt, authorizedAt: Date.now() },
  };
  if (signal?.aborted) throw new Error(t('anchorImport.cancelled'));
  return importStoredPendingDeviceKey(pending, wallet);
}

function samePublicKey(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const { PublicKey } = require('@wharfkit/antelope') as typeof import('@wharfkit/antelope');
    return PublicKey.from(a).equals(PublicKey.from(b));
  } catch {
    return false;
  }
}
