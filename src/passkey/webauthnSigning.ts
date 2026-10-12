// 用 passkey 给一笔已构建好的 EOS/Antelope 交易摘要签名。
//
// 移植自 eospasskey 项目网页端的 apps/web/src/lib/eosWebAuthn.ts —— 核心思路是
// Antelope 链原生支持一种 `WA`(WebAuthn)签名类型:直接拿 WebAuthn assertion 的
// DER 签名 + authenticatorData + clientDataJSON 拼起来,链上节点自己会验证,不需要
// 任何后端代签或转发。算法是纯字节运算,和 Web/RN 无关,这里只是把
// `navigator.credentials.get()` 换成 react-native-passkeys 的 get()。
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Bytes, KeyType, PublicKey, Signature } from '@wharfkit/antelope';

import { getPasskey } from './nativePasskey';
import { base64urlToBytes, bytesToBase64url } from './base64url';
import { EOS3_RP_ID } from './constants';
import { t } from '../i18n';

export class PasskeySignatureMismatchError extends Error {
  constructor() {
    super(t('passkeyError.signatureMismatch'));
    this.name = 'PasskeySignatureMismatchError';
  }
}

/**
 * 用指定 credential 对一个交易摘要发起一次 WebAuthn assertion,并拼装成
 * Antelope 原生支持的 `WA` 类型 Signature(SIG_WA_...)。
 */
export async function signDigestWithPasskey(params: {
  digest: Uint8Array;
  chainPublicKey: string;
  credentialIdHex: string;
}): Promise<Signature> {
  const expectedDigest = Uint8Array.from(params.digest);
  const credentialId = hexToBytes(params.credentialIdHex);
  const assertion = await getPasskey({
    publicKey: {
      rpId: EOS3_RP_ID,
      timeout: 60000,
      allowCredentials: [{ id: bytesToBase64url(credentialId), type: 'public-key' }],
      challenge: bytesToBase64url(expectedDigest),
      userVerification: 'required',
    },
  });

  const authenticatorData = base64urlToBytes(assertion.response.authenticatorData);
  const clientDataJSON = base64urlToBytes(assertion.response.clientDataJSON);
  const derSignature = base64urlToBytes(assertion.response.signature);
  try {
    const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));
    if (clientData.type !== 'webauthn.get' || clientData.challenge !== bytesToBase64url(expectedDigest) ||
        clientData.crossOrigin === true || authenticatorData.length < 37 ||
        !bytesEqual(authenticatorData.slice(0, 32), sha256(new TextEncoder().encode(EOS3_RP_ID))) ||
        (authenticatorData[32] & 5) !== 5 ||
        !bytesEqual(base64urlToBytes(assertion.id), credentialId)) throw new Error();
  } catch {
    throw new PasskeySignatureMismatchError();
  }

  const { r, s } = parseDERSignature(derSignature);
  const signedByAuthenticator = concatBytes(authenticatorData, sha256(clientDataJSON));
  const authenticatorDigest = sha256(signedByAuthenticator);

  const recid = recoveryIdForSignature(
    authenticatorDigest,
    concatBytes(r, s),
    PublicKey.from(params.chainPublicKey).getCompressedKeyBytes()
  );

  const signatureData = concatBytes(
    new Uint8Array([recid + 27 + 4]),
    r,
    s,
    varuint32(authenticatorData.length),
    authenticatorData,
    varuint32(clientDataJSON.length),
    clientDataJSON
  );

  return new Signature(KeyType.WA, Bytes.from(signatureData));
}

function recoveryIdForSignature(
  digest: Uint8Array,
  compactSignature: Uint8Array,
  expectedCompressedPublicKey: Uint8Array
): number {
  for (let recid = 0; recid < 4; recid += 1) {
    try {
      const recovered = p256.recoverPublicKey(concatBytes(new Uint8Array([recid]), compactSignature), digest, {
        prehash: false,
      });
      if (bytesEqual(recovered, expectedCompressedPublicKey)) return recid;
    } catch {
      // 有些 recovery id 对给定签名无效,尝试下一个
    }
  }
  throw new PasskeySignatureMismatchError();
}

function parseDERSignature(signature: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  let offset = 0;
  if (signature[offset++] !== 0x30) throw new Error(t('passkeySignError.missingDerPrefix'));
  if (signature[offset++] !== signature.length - 2) throw new Error(t('passkeySignError.badLength'));
  if (signature[offset++] !== 0x02) throw new Error(t('passkeySignError.badRMarker'));
  const r = fixedInteger(signature.slice(offset + 1, offset + 1 + signature[offset]));
  offset += 1 + signature[offset];
  if (signature[offset++] !== 0x02) throw new Error(t('passkeySignError.badSMarker'));
  const length = signature[offset];
  if (!length || offset + 1 + length !== signature.length) throw new Error(t('passkeySignError.badLength'));
  return { r, s: fixedInteger(signature.slice(offset + 1, offset + 1 + length)) };
}

function fixedInteger(bytes: Uint8Array): Uint8Array {
  const value = Array.from(bytes);
  while (value.length < 32) value.unshift(0);
  while (value.length > 32) {
    if (value.shift() !== 0) throw new Error(t('passkeySignError.rsTooLong'));
  }
  return new Uint8Array(value);
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim();
  if (!normalized || normalized.length % 2 !== 0) throw new Error(t('passkeySignError.badHexLength'));
  if (!/^[0-9a-f]+$/i.test(normalized)) throw new Error(t('passkeySignError.badHexFormat'));
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(t('passkeySignError.badHexFormat'));
    bytes[i] = byte;
  }
  return bytes;
}

function varuint32(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return new Uint8Array(bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
