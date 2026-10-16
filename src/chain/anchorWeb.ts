import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { ABI, PrivateKey, PublicKey, Serializer, Signature, Transaction } from '@wharfkit/antelope';
import { SigningRequest, type CallbackPayload } from '@wharfkit/signing-request';
import { deflateRaw, inflateRaw } from 'pako';
import { generateKey } from '../crypto/keys';
import { sealMessage } from '../dapp/linkCrypto';
import { listenLinkChannel } from '../dapp/linkSocket';
import { CHAINS } from './config';
import { t } from '../i18n';

export const ANCHOR_WEB_ORIGIN = 'https://vaulta.anchorwallet.io';
const RETURN_URL = 'eos3wallet://device-key-authorized?provider=anchor';
const APP_NAME = 'eos3wallet';
const CHAIN = CHAINS.vaulta.chainIdHash;
const esrOptions = { zlib: { deflateRaw: (b: Uint8Array) => deflateRaw(b), inflateRaw: (b: Uint8Array) => inflateRaw(b) } };
const linkAbi = ABI.from({ structs: [
  { name: 'link_create', base: '', fields: [{ name: 'session_name', type: 'name' }, { name: 'request_key', type: 'public_key' }, { name: 'user_agent', type: 'string$' }] },
  { name: 'link_info', base: '', fields: [{ name: 'expiration', type: 'time_point_sec' }] },
] });

// This is an ephemeral request-channel key, never an account or device private key.
export type AnchorWebSession = { account: string; permission: 'active' | 'owner'; requestKey: PrivateKey; messageKey: PublicKey };
export class AnchorWebCancelled extends Error {}
function channelUrl(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'https://cb.anchor.link/' + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}

/** Official Anchor web transport uses unescaped ESR/sealed query values. */
export function anchorWebUrl(params: Record<string, string>): string {
  return `${ANCHOR_WEB_ORIGIN}/sign?` + Object.entries(params).map(([key, value]) => {
    if (/[&?#\s]/.test(value)) throw new Error(t('anchorImport.invalidResponse'));
    return `${key}=${value}`;
  }).join('&');
}

/** The relay only transports a response; account access is decided by the final chain signature. */
export async function openAnchorWebRequest(url: string, callback: string, signal?: AbortSignal): Promise<CallbackPayload> {
  if (new URL(url).origin !== ANCHOR_WEB_ORIGIN || signal?.aborted) throw new AnchorWebCancelled();
  return new Promise((resolve, reject) => {
    let done = false;
    let listener: ReturnType<typeof listenLinkChannel> | undefined;
    let browserStarted = false;
    const closeBrowser = (resume: boolean) => {
      if (!browserStarted) return;
      if (Platform.OS === 'ios') {
        try { WebBrowser.dismissAuthSession(); } catch {}
      }
      else if (resume && Platform.OS === 'android') void Linking.openURL(RETURN_URL).catch(() => undefined);
    };
    const finish = (error?: unknown, payload?: CallbackPayload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      listener?.stop();
      closeBrowser(Boolean(payload));
      if (error) reject(error); else resolve(payload!);
    };
    const abort = () => finish(new AnchorWebCancelled());
    const timer = setTimeout(() => finish(new Error(t('anchorImport.timeout'))), 300_000);
    signal?.addEventListener('abort', abort, { once: true });
    listener = listenLinkChannel(callback, raw => {
      try {
        if (raw.length > 131072) throw new Error();
        const payload = JSON.parse(new TextDecoder().decode(raw));
        if (payload.rejected) finish(new AnchorWebCancelled());
        else finish(undefined, payload);
      } catch { finish(new Error(t('anchorImport.invalidResponse'))); }
    });
    browserStarted = true;
    void WebBrowser.openAuthSessionAsync(url, RETURN_URL).then(result => {
      // The native session handles user cancellation; only the relay carries signatures.
      if (result.type === 'cancel' || result.type === 'dismiss') finish(new AnchorWebCancelled());
    }, error => finish(error));
  });
}

export async function connectAnchorWeb(signal?: AbortSignal): Promise<AnchorWebSession> {
  const requestKey = PrivateKey.from(generateKey().privateKey);
  const callback = channelUrl();
  const request = SigningRequest.identity({ chainId: CHAIN, scope: APP_NAME, callback: { url: callback, background: true } }, esrOptions);
  request.setRawInfoKey('link', Serializer.encode({ object: { session_name: APP_NAME, request_key: requestKey.toPublic(), user_agent: 'EOS3 Wallet mobile' }, type: 'link_create', abi: linkAbi }));
  const encoded = request.encode();
  const payload = await openAnchorWebRequest(anchorWebUrl({ esr: encoded, chain: CHAIN, requestKey: String(requestKey.toPublic()) }), callback, signal);
  if (payload.cid !== CHAIN || !/^[a-z1-5.]{1,12}$/.test(payload.sa) || !['active', 'owner'].includes(payload.sp) ||
      !payload.sig || !payload.link_key || SigningRequest.from(payload.req, esrOptions).encode() !== encoded) throw new Error(t('anchorImport.invalidResponse'));
  Signature.from(payload.sig);
  return { account: payload.sa, permission: payload.sp as 'active' | 'owner', requestKey, messageKey: PublicKey.from(payload.link_key) };
}

export async function signWithAnchorWeb(session: AnchorWebSession, hex: string, signal?: AbortSignal): Promise<string[]> {
  const transaction = Serializer.decode({ data: hex, type: Transaction });
  if (transaction.expiration.toMilliseconds() <= Date.now() + 5000) throw new Error(t('anchorImport.expired'));
  const request = await SigningRequest.create({ chainId: CHAIN, transaction, broadcast: false }, esrOptions);
  request.setRawInfoKey('link', Serializer.encode({ object: { expiration: transaction.expiration }, type: 'link_info', abi: linkAbi }));
  const callback = channelUrl();
  request.setCallback(callback, true);
  const sealed = sealMessage(request.encode(), session.requestKey, session.messageKey);
  const payload = await openAnchorWebRequest(anchorWebUrl({ sealed: sealed.ciphertext.hexString, nonce: String(sealed.nonce), chain: CHAIN,
    accountName: session.account, permissionName: session.permission, appName: APP_NAME, requestKey: String(session.requestKey.toPublic()) }), callback, signal);
  // Never trust the response's account, request or TAPOS in place of reviewed bytes.
  if (payload.cid !== CHAIN || payload.sa !== session.account || payload.sp !== session.permission ||
      SigningRequest.from(payload.req, esrOptions).encode() !== request.encode() || payload.tx !== String(transaction.id)) throw new Error(t('anchorImport.invalidResponse'));
  const fields = Object.keys(payload).filter(k => k === 'sig' || /^sig\d+$/.test(k)).sort((a,b) => a === 'sig' ? -1 : b === 'sig' ? 1 : Number(a.slice(3))-Number(b.slice(3)));
  const signatures = [...new Set(fields.map(k => String((payload as any)[k])).filter(Boolean))];
  if (!signatures.length) throw new Error(t('anchorImport.invalidResponse'));
  signatures.forEach(sig => Signature.from(sig));
  if (transaction.expiration.toMilliseconds() <= Date.now()) throw new Error(t('anchorImport.expired'));
  return signatures;
}
