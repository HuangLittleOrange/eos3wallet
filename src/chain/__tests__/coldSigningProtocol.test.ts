jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { Action, PrivateKey, PublicKey, Serializer, Transaction } from '@wharfkit/antelope';
import { CHAINS } from '../config';
import { coreActionAbi } from '../coreTokenAbi';
import { tokenPocketResult, tokenPocketSigningQr, verifyColdResult } from '../coldSigningProtocol';
import { TokenPocketQrCollector, tokenPocketQrFrames } from '../tokenPocketQr';

const key = PrivateKey.generate('K1');
const chainId = CHAINS.vaulta.chainIdHash;
function request() {
  return { chainId, actor: 'alice', permission: 'active', transaction: Transaction.from({
    expiration: new Date(Date.now() + 120000).toISOString().slice(0, 19), ref_block_num: 0, ref_block_prefix: 0,
    actions: [Action.from({ account: 'core.vaulta', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }],
      data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' } }, coreActionAbi('core.vaulta', 'transfer')!)] }) };
}
const response = (r = request()) => ({ ...Serializer.objectify(r.transaction),
  signatures: [String(key.signDigest(r.transaction.signingDigest(r.chainId)))] });

test('TP v1 QR contains the original full transaction and a legacy K1 public key, never a digest-only signing request', () => {
  const r = request();
  const qr = tokenPocketSigningQr(r, String(key.toPublic()));
  const payload = JSON.parse(qr.slice(qr.indexOf('&data=') + 6));
  expect(qr).toContain(`&network=eosio&chain_id=${chainId}`);
  expect(payload.account).toBe('alice');
  expect(payload.publicKey).toBe(key.toPublic().toLegacyString());
  expect(Serializer.encode({ object: Transaction.from(payload.tx) }).hexString)
    .toBe(Serializer.encode({ object: r.transaction }).hexString);
});
test('TP plain JSON and raw/URL-encoded v1 response envelopes verify against the original transaction', () => {
  const r = request(), data = response(r);
  for (const suffix of [JSON.stringify(data), encodeURIComponent(JSON.stringify(data))]) {
    const parsed = tokenPocketResult(`eosio:signTransactionSignature-version=1.0&protocol=TokenPocket&network=eosio&chain_id=${chainId}&data=${suffix}`);
    expect(verifyColdResult(r, String(key.toPublic()), parsed).verifyDigest(r.transaction.signingDigest(chainId), key.toPublic())).toBe(true);
  }
  expect(verifyColdResult(r, String(key.toPublic()), tokenPocketResult(JSON.stringify(data)))).toBeDefined();
});
test.each(['network=ethereum', 'network=eosio&network=ethereum', 'protocol=Other'])('rejects mismatched or ambiguous URI metadata: %s', bad => {
  const header = bad.startsWith('protocol') ? `${bad}&network=eosio` : `protocol=TokenPocket&${bad}`;
  expect(() => tokenPocketResult(`eosio:signTransactionSignature-version=1.0&${header}&chain_id=${chainId}&data={}`)).toThrow();
});
test.each([
  { chain_id: CHAINS.jungle4.chainIdHash }, { account: 'mallory' }, { publicKey: String(PrivateKey.generate('K1').toPublic()) },
  { tx: '0'.repeat(64) }, { ref_block_num: 1 }, { ref_block_prefix: 1 }, { expiration: '2099-01-01T00:00:00' },
  { signatures: [] }, { signatures: ['invalid'] }, { context_free_data: ['00'] }, { packed_trx: '00' },
])('rejects modified results without substituting returned bytes: %j', fields => {
  const r = request();
  expect(() => verifyColdResult(r, String(key.toPublic()), { ...response(r), ...fields })).toThrow('coldSigning.invalidResponse');
});
test('a signature for different content or a different key cannot authorize the original transaction', () => {
  const r = request(), other = request(); other.transaction.ref_block_num = other.transaction.ref_block_num.adding(1);
  for (const signature of [key.signDigest(other.transaction.signingDigest(chainId)), PrivateKey.generate('K1').signDigest(r.transaction.signingDigest(chainId))]) {
    expect(() => verifyColdResult(r, String(key.toPublic()), { signatures: [String(signature)] })).toThrow();
  }
});
test('real TP 2.29.0 large-transaction response reassembles and verifies the original request', () => {
  const fixture = require('./fixtures/tokenPocket-tp229-large.json');
  const r = { ...fixture.request, transaction: Transaction.from(fixture.request.transaction) };
  expect(tokenPocketQrFrames(tokenPocketSigningQr(r, fixture.publicKey))).toHaveLength(7);
  const collector = new TokenPocketQrCollector();
  const frames: string[] = [...fixture.signedFrames].reverse();
  expect(frames).toHaveLength(22);
  collector.accept(frames[0]);
  let result;
  for (const frame of frames) result = collector.accept(frame);
  const parsed = tokenPocketResult(result!.text!);
  expect(verifyColdResult(r, fixture.publicKey, parsed).verifyDigest(
    r.transaction.signingDigest(r.chainId), PublicKey.from(fixture.publicKey),
  )).toBe(true);
  r.transaction.ref_block_num = r.transaction.ref_block_num.adding(1);
  expect(() => verifyColdResult(r, fixture.publicKey, parsed)).toThrow();
});
