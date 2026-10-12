// eos3.app(eospasskey 项目)后端接口的客户端。
//
// 登录部分(/api/platform/passkey/auth/*)只用它已有的"纯 passkey 登录"接口,
// 不涉及 Google 登录 / 开户,后端零改动。
//
// 注册/开户部分(/api/auth/google/*、/api/passkey-chain/register/*)是这次新加的 ——
// 后端建号逻辑还在补,这边先按约定好的接口形状对接,细节见项目内的实现计划。
//
// 会话是 Cookie 形式(eos_platform_passkey_auth_challenge 挑战码 + 最终的登录态 Cookie)。
// RN 的 fetch 走系统原生网络栈(iOS NSURLSession / Android OkHttp),同源请求默认会保留
// 并携带 Set-Cookie 下发的 Cookie,这里显式带上 `credentials: 'include'` 和网页端保持一致;
// 真机联调时需要确认这个假设成立,如果不行再补 @react-native-cookies/cookies 显式接管。
//
// Google 登录这段更麻烦:OAuth 要先跳系统浏览器(expo-web-browser 的 auth session)
// 再跳回 App,系统浏览器建立的会话 Cookie 能不能被 App 自己的 fetch() 读到,两边是不是
// 共享同一个 Cookie 存储,真机测试前不确定。留了一个可选的 bearer token 兜底路径:
// 如果不行,后端可以在 returnTo 跳转的 URL 上带一个一次性 token,这边存下来后续
// 显式当 Authorization 头带上,不依赖 Cookie 能不能共享。
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

/** 拼 Google OAuth 起始地址,交给 expo-web-browser 的 openAuthSessionAsync 打开 */
export function googleOAuthStartUrl(returnTo: string): string {
  const u = new URL(`${EOS3_BASE_URL}/api/auth/google/start`);
  u.searchParams.set('returnTo', returnTo);
  return u.toString();
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
 * `wallet.eosAccount` 是否有值取决于后端有没有把"建链上账户"接到这个接口上 ——
 * 现状(见项目计划里的调研记录)是不接的,拿到 null 要提示用户稍后重试,
 * 不能假设这里一定会返回一个可用账户。
 */
export function platformPasskeyRegisterVerify(response: CreationResponse, token?: string): Promise<Eos3RegisterResult> {
  return request<Eos3RegisterResult>('/api/passkey-chain/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
    token,
  });
}
