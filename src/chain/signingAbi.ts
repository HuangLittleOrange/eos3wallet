import { ABI, Checksum256, Serializer } from '@wharfkit/antelope';
import { readTrustedRpc } from './trustedRpc';
import { t } from '../i18n';

const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; promise: Promise<ABI> }>();

/** Signing schemas cannot be supplied by the same untrusted RPC that prepares
 * the transaction. Require agreement from two distinct, built-in RPC hosts.
 * Remote node catalogs and custom endpoints never become schema trust anchors.
 * This tolerates a single malicious source, not collusion of two trust anchors.
 */
export function getSigningAbi(chainId: string, account: string): Promise<ABI> {
  const key = `${chainId.toLowerCase()}:${account}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = verifyAbi(chainId, account);
  cache.set(key, { at: Date.now(), promise });
  void promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}

export function invalidateSigningAbi(chainId: string, account: string): void {
  cache.delete(`${chainId.toLowerCase()}:${account}`);
}

async function verifyAbi(chainId: string, account: string): Promise<ABI> {
  return readTrustedRpc(chainId, async read => {
    const reply = await read('/v1/chain/get_abi', { account_name: account });
    if (reply.account_name !== account || !reply.abi) throw new Error();
    const abi = ABI.from(reply.abi);
    return { key: String(Checksum256.hash(Serializer.encode({ object: abi }).array)), value: abi };
  }, () => new Error(t('txCheck.unverifiedAbi')));
}
