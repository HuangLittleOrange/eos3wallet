jest.mock('../nativePasskey', () => ({ getPasskey: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Bytes, KeyType, PublicKey } from '@wharfkit/antelope';
import { getPasskey } from '../nativePasskey';
import { bytesToBase64url } from '../base64url';
import { EOS3_RP_ID } from '../constants';
import { PasskeySignatureMismatchError, signDigestWithPasskey } from '../webauthnSigning';

// Synthetic fixture key only; never associated with an account or funds.
const privateKey = new Uint8Array(32).fill(1);
const digest = new Uint8Array(32).fill(9);
const params = { digest, credentialIdHex: '010203', chainPublicKey: String(new PublicKey(KeyType.WA,
  Bytes.from(Uint8Array.from([...p256.getPublicKey(privateKey), 2, EOS3_RP_ID.length, ...new TextEncoder().encode(EOS3_RP_ID)])))) };
function assertion(overrides: any = {}, flags = 5, rpId = EOS3_RP_ID, credentialId = 'AQID') {
  const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: bytesToBase64url(digest),
    origin: 'https://eos3.app', ...overrides }));
  const authData = Uint8Array.from([...sha256(new TextEncoder().encode(rpId)), flags, 0, 0, 0, 1]);
  const message = Uint8Array.from([...authData, ...sha256(clientData)]);
  const signature = p256.sign(message, privateKey, { format: 'der', prehash: true });
  return { id: credentialId, rawId: credentialId, type: 'public-key', response: {
    clientDataJSON: bytesToBase64url(clientData), authenticatorData: bytesToBase64url(authData), signature: bytesToBase64url(signature),
  } } as any;
}
test('valid hardware-style assertion retains WA signing and public-key recovery', async () => {
  jest.mocked(getPasskey).mockResolvedValueOnce(assertion());
  expect(String(await signDigestWithPasskey(params))).toMatch(/^SIG_WA_/);
});
test.each([
  [{ challenge: bytesToBase64url(new Uint8Array(32).fill(7)) }, 5, EOS3_RP_ID, 'AQID'],
  [{ type: 'webauthn.create' }, 5, EOS3_RP_ID, 'AQID'],
  [{ crossOrigin: true }, 5, EOS3_RP_ID, 'AQID'],
  [{}, 1, EOS3_RP_ID, 'AQID'],
  [{}, 4, EOS3_RP_ID, 'AQID'],
  [{}, 5, 'other.example', 'AQID'],
  [{}, 5, EOS3_RP_ID, 'BAUG'],
])('rejects mismatched challenge, RP, credential, ceremony or verification flags', async (client, flags, rp, id) => {
  jest.mocked(getPasskey).mockResolvedValueOnce(assertion(client, flags, rp, id));
  await expect(signDigestWithPasskey(params)).rejects.toBeInstanceOf(PasskeySignatureMismatchError);
});
