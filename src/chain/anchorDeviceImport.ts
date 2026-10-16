import { fetchWithRetry } from '../net/fetchRetry';
import { EOS3_BASE_URL } from '../passkey/constants';
import type { PendingDeviceKey } from '../crypto/vault';
import { CHAINS, type ChainId } from './config';
import { assertPendingDeviceChain } from './deviceKey';
import { validateDeviceKeyReview, type DeviceKeyReview, type DeviceKeyBuild } from './anchorDeviceReview';
import { signWithAnchorWeb, type AnchorWebSession } from './anchorWeb';
import { t } from '../i18n';

async function jsonRequest(url: string, body: unknown) {
  // A signed push must never be retried automatically after an uncertain response.
  const response = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { attempts: 1, timeoutMs: 15000 });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t('deviceKey.failed'));
  return result;
}
export async function prepareAnchorDeviceImport(session: AnchorWebSession, pending: PendingDeviceKey, node: { url: string }, chainId: ChainId): Promise<DeviceKeyReview | null> {
  assertPendingDeviceChain(pending, chainId);
  if (chainId !== 'vaulta') throw new Error(t('anchorImport.mainnetOnly'));
  const [info, account] = await Promise.all([
    jsonRequest(node.url + '/v1/chain/get_info', {}),
    jsonRequest(node.url + '/v1/chain/get_account', { account_name: session.account }),
  ]);
  if (info.chain_id !== CHAINS.vaulta.chainIdHash || account.account_name !== session.account) throw new Error(t('anchorImport.invalidResponse'));
  const current = account.permissions?.find((permission: any) => permission.perm_name === 'active');
  if (!current || current.required_auth?.threshold !== 1) throw new Error(t('anchorImport.multisig'));
  const built = await jsonRequest(EOS3_BASE_URL + '/api/passkey-chain/device-keys/account/build', { eosAccount: session.account, publicKey: pending.publicKey, label: pending.label, op: 'add', remove: [] });
  // The caller still checks the chain before importing an already-authorized key.
  if (built.alreadyAuthorized) return null;
  return validateDeviceKeyReview(built as DeviceKeyBuild, current, { account: session.account, publicKey: pending.publicKey, label: pending.label, remove: [] });
}
export async function submitAnchorDeviceImport(session: AnchorWebSession, review: DeviceKeyReview, signal?: AbortSignal): Promise<void> {
  const { built, hex, label } = review;
  if (built.eosAccount !== session.account || hex !== built.transaction.serializedTransaction || Date.now() + 5000 >= review.expiresAt) throw new Error(t('anchorImport.expired'));
  const signatures = await signWithAnchorWeb(session, hex, signal);
  if (signal?.aborted) throw new Error(t('anchorImport.cancelled'));
  await jsonRequest(EOS3_BASE_URL + '/api/passkey-chain/device-keys/account/push', { eosAccount: session.account, publicKey: built.publicKey, label, op: 'add', remove: [], signedTransaction: {
    signatures, serializedTransaction: hex, transaction: built.transaction, sponsorRequestId: built.transaction.sponsorRequestId,
  } });
}
export type { DeviceKeyReview };
