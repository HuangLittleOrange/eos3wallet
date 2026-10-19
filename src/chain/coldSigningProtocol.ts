import { PublicKey, Serializer, Signature, Transaction } from '@wharfkit/antelope';
import { t } from '../i18n';

export type ColdTransaction = { transaction: Transaction; chainId: string; actor: string; permission: string };
const invalid = () => new Error(t('coldSigning.invalidResponse'));

export function tokenPocketSigningQr(request: ColdTransaction, publicKey: string): string {
  const key = PublicKey.from(publicKey);
  const data = { tx: Serializer.objectify(request.transaction), account: request.actor,
    publicKey: key.type === 'K1' ? key.toLegacyString() : String(key) };
  return `eosio:signTransaction-version=1.0&protocol=TokenPocket&network=eosio&chain_id=${request.chainId}&data=${JSON.stringify(data)}`;
}

/** Parse only this result format. Never navigate to a scanned callback URL. */
export function tokenPocketResult(raw: string): Record<string, any> {
  if (raw.length > 65_536) throw invalid();
  let data = raw.trim();
  if (data.startsWith('eosio:')) {
    const marker = '&data=';
    const at = data.indexOf(marker);
    if (!data.startsWith('eosio:signTransactionSignature-version=1.0&') || at < 0) throw invalid();
    const params = new URLSearchParams(data.slice(data.indexOf('&') + 1, at));
    if (params.getAll('protocol').length !== 1 || params.getAll('network').length !== 1 ||
        params.get('protocol') !== 'TokenPocket' || params.get('network') !== 'eosio' ||
        params.getAll('chain_id').length !== 1) throw invalid();
    const payload = data.slice(at + marker.length);
    data = payload.startsWith('{') ? payload : decodeURIComponent(payload);
    const result = JSON.parse(data);
    return { ...result, chain_id: params.get('chain_id') };
  }
  // Some TP versions return the signed-transaction JSON without its URI envelope.
  const result = JSON.parse(data);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid();
  return result;
}

/** Compare bytes when the signer returns a transaction, then verify the signature
 * against OUR original digest and the selected, independently verified public key.
 * Returned transactions are never used for broadcasting or as a new signing intent.
 */
export function verifyColdResult(request: ColdTransaction, publicKey: string,
  payload: Record<string, any>): Signature {
  try {
    if (payload.chain_id != null && payload.chain_id !== request.chainId) throw invalid();
    if (typeof payload.tx === 'string' && payload.tx !== String(request.transaction.id)) throw invalid();
    if (payload.account != null && payload.account !== request.actor) throw invalid();
    if (payload.publicKey != null && !PublicKey.from(payload.publicKey).equals(PublicKey.from(publicKey))) throw invalid();
    const returned = payload.tx && typeof payload.tx === 'object' ? payload.tx
      : payload.transaction ?? (payload.actions ? payload : undefined);
    const original = Serializer.encode({ object: request.transaction }).hexString;
    if (returned && Serializer.encode({ object: Transaction.from(returned) }).hexString !== original) throw invalid();
    if (payload.packed_trx != null && (payload.compression && payload.compression !== 'none' ||
        String(payload.packed_trx).toLowerCase() !== original.toLowerCase())) throw invalid();
    if (payload.context_free_data?.length || payload.packed_context_free_data && payload.packed_context_free_data !== '') throw invalid();
    const values = payload.signatures ?? [payload.sig ?? payload.signature];
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 256) throw invalid();
    const signature = Signature.from(values[0]);
    if (!signature.verifyDigest(request.transaction.signingDigest(request.chainId), PublicKey.from(publicKey))) throw invalid();
    return signature;
  } catch { throw invalid(); }
}
