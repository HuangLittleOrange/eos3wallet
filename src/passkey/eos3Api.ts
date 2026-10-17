// eos3.app 的登录和 Passkey 开户接口。
// 原生请求通过 credentials: 'include' 保留挑战 Cookie；Google 登录会话则由
// 系统浏览器通过回跳 URL 的 fragment 交给 App，随后显式使用 Bearer token。
import type {
  AuthenticationResponseJSON,
  CreationResponse,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from 'react-native-passkeys/build/ReactNativePasskeys.types';

import { EOS3_BASE_URL, EOS3_RP_ID } from './constants';
import { t } from '../i18n';
import { fetchWithRetry } from '../net/fetchRetry';

export class Eos3ApiError extends Error {}

// 同一个 EOS3_BASE_URL,chain/eos3Sign.ts 那边已经踩过 TLS 握手偶发失败的坑
// 并接了重试(见 net/fetchRetry.ts),这里是另一个独立的客户端(登录/开户),
// 之前漏掉了同一层重试。
async function request<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const { token, ...rest } = init ?? {};
  const res = await fetchWithRetry(`${EOS3_BASE_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Eos3ApiError(res.ok ? t('eos3Error.badResponseFormat') : t('eos3Error.requestFailed', { status: res.status }));
  }
  if (!res.ok) {
    throw new Eos3ApiError(body?.error ?? t('eos3Error.requestFailed', { status: res.status }));
  }
  return body as T;
}

/** go-webauthn 返回的浏览器风格包裹层:{ publicKey: {...} } */
type WrappedRequestOptions = { publicKey: PublicKeyCredentialRequestOptionsJSON };
type WrappedCreationOptions = { publicKey: PublicKeyCredentialCreationOptionsJSON };

// 与后端唯一允许的原生回跳地址及 app.json 已注册的 scheme 保持一致。
export const GOOGLE_OAUTH_RETURN_URL = 'eos3wallet://passkey-create';

/** 拼 Google OAuth 起始地址,交给 expo-web-browser 的 openAuthSessionAsync 打开 */
export function googleOAuthStartUrl(): string {
  const u = new URL(`${EOS3_BASE_URL}/api/auth/google/start`);
  u.searchParams.set('returnTo', GOOGLE_OAUTH_RETURN_URL);
  return u.toString();
}

/** 只接受约定的回跳及 fragment 令牌；取消返回 null，其他失败不继续注册。 */
export function googleOAuthTokenFromUrl(value: string): string | null {
  const fail = () => new Eos3ApiError(t('eos3Error.googleAuthFailed'));
  if (value.split(/[?#]/, 1)[0] !== GOOGLE_OAUTH_RETURN_URL) throw fail();
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    throw fail();
  }
  const authError = callback.searchParams.get('authError');
  if (authError === 'oauth_cancelled') return null;
  if (authError !== null) throw fail();
  const tokens = new URLSearchParams(callback.hash.slice(1)).getAll('token');
  if (tokens.length !== 1 || !tokens[0].trim()) throw fail();
  return tokens[0];
}

export type Eos3PublicUser = {
  id: string;
  email?: string;
  eosAccount?: string | null;
};

export type Eos3PasskeyChainWallet = {
  eosAccount: string | null;
  balance: string;
  hasWallet: boolean;
  status: string;
  credentialId: string;
  credentialIdHex: string;
  chainPublicKey: string;
  createdAt: string;
};

export type Eos3PlatformLoginResult = {
  user: Eos3PublicUser;
  wallet: Eos3PasskeyChainWallet;
  balance: string;
  hasWallet: boolean;
};

/** 第一步:向服务器要一次登录用的 WebAuthn assertion 选项(discoverable / 免用户名) */
export async function platformPasskeyAuthOptions(): Promise<WrappedRequestOptions> {
  const wrapped = await request<WrappedRequestOptions>('/api/platform/passkey/auth/options', { method: 'POST' });
  // 浏览器在省略 rpId 时会用当前页面的域名兜底,原生 App 没有"当前页面"这个概念,
  // 必须显式把 rpId 钉死成 eos3.app,否则系统认证器不知道该找哪个域名下的 passkey。
  return { publicKey: { ...wrapped.publicKey, rpId: EOS3_RP_ID } };
}

/** 第二步:把设备做出的 assertion 结果发回去校验,成功即建立登录会话 */
export function platformPasskeyAuthVerify(
  response: AuthenticationResponseJSON
): Promise<Eos3PlatformLoginResult> {
  return request<Eos3PlatformLoginResult>('/api/platform/passkey/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

// ---------- 注册 / 开户(需要先完成 Google 登录建立会话)----------

export type Eos3RegisterResult = {
  wallet: Eos3PasskeyChainWallet;
  balance: string;
  hasWallet: boolean;
};

/** 第一步:要一次注册用的 WebAuthn attestation 选项 —— 需要已经通过 Google 登录建立会话 */
export async function platformPasskeyRegisterOptions(token?: string): Promise<WrappedCreationOptions> {
  const wrapped = await request<WrappedCreationOptions>('/api/passkey-chain/register/options', {
    method: 'POST',
    token,
  });
  return { publicKey: { ...wrapped.publicKey, rp: { ...wrapped.publicKey.rp, id: EOS3_RP_ID } } };
}

/**
 * 第二步:把设备做出的 attestation 结果发回去校验,成功后建一条 passkey 凭据。
 * 如果链上账户尚未创建完成，wallet.eosAccount 可能为空，调用方应提示稍后重试。
 */
export function platformPasskeyRegisterVerify(response: CreationResponse, token?: string): Promise<Eos3RegisterResult> {
  return request<Eos3RegisterResult>('/api/passkey-chain/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
    token,
  });
}
