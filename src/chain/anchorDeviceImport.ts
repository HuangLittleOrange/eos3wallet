import { fetchWithRetry } from '../net/fetchRetry';
import { EOS3_BASE_URL } from '../passkey/constants';
import type { PendingDeviceKey } from '../crypto/vault';
import { CHAINS, type ChainId } from './config';
import { assertPendingDeviceChain } from './deviceKey';
import { validateDeviceKeyReview, type DeviceKeyReview, type DeviceKeyBuild } from './anchorDeviceReview';
import { signWithAnchorWeb, type AnchorWebSession } from './anchorWeb';
import { t } from '../i18n';
import { ReadNodePool } from './nodeFailover';
import { AnchorImportNetworkError } from './anchorImportError';

async function jsonRequest(url: string, body: unknown, attempts: number, signal?: AbortSignal) {
  // A signed push must never be retried automatically after an uncertain response.
  let response: Response;
  try {
    response = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }, { attempts, timeoutMs: 15000, backoffMs: 500 });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AnchorImportNetworkError();
  }
  const result = await response.json().catch(error => {
    if (signal?.aborted) throw error;
    if (!(error instanceof SyntaxError)) throw new AnchorImportNetworkError();
    throw new Error(t('anchorImport.invalidResponse'));
  });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(t('anchorImport.invalidResponse'));
  if (!response.ok) throw new Error(result.error || t('deviceKey.failed'));
  return result;
}
export async function prepareAnchorDeviceImport(session: AnchorWebSession, pending: PendingDeviceKey, node: { url: string }, chainId: ChainId,
  options: { signal?: AbortSignal; onNodeSwitch?: (node: { url: string }) => void } = {}): Promise<DeviceKeyReview | null> {
  assertPendingDeviceChain(pending, chainId);
  if (chainId !== 'vaulta') throw new Error(t('anchorImport.mainnetOnly'));
  const pool = new ReadNodePool(chainId, 'rpc', { id: node.url, name: node.url, ...node }, {
    onSwitch: (_kind, replacement) => options.onNodeSwitch?.(replacement),
  });
  const read = async (path: string, body: unknown, valid: (json: any) => boolean) => {
    let reply;
    try {
      reply = await pool.read(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options.signal }, valid);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new AnchorImportNetworkError();
    }
    if (reply.status !== 200) throw new Error(t('signupError.queryFailed', { status: reply.status }));
    return reply.json;
  };
  // Verify the network before reading its authority; replacements are chain-checked too.
  const info = await read('/v1/chain/get_info', {}, json => json?.chain_id === CHAINS.vaulta.chainIdHash);
  const account = await read('/v1/chain/get_account', { account_name: session.account }, json => json?.account_name === session.account);
  if (info.chain_id !== CHAINS.vaulta.chainIdHash || account.account_name !== session.account) throw new Error(t('anchorImport.invalidResponse'));
  const current = account.permissions?.find((permission: any) => permission.perm_name === 'active');
  if (!current || current.required_auth?.threshold !== 1) throw new Error(t('anchorImport.multisig'));
  // Building an unsigned review may retry; only /push can broadcast a signature.
  const built = await jsonRequest(EOS3_BASE_URL + '/api/passkey-chain/device-keys/account/build', { eosAccount: session.account, publicKey: pending.publicKey, label: pending.label, op: 'add', remove: [] }, 3, options.signal);
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
  } }, 1, signal);
}
export type { DeviceKeyReview };
