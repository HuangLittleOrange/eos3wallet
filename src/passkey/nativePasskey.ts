// 对 react-native-passkeys 的薄封装。
//
// eos3.app 后端(go-webauthn)返回的 options 是浏览器 `navigator.credentials.get({publicKey})`
// 那种带 `publicKey` 包裹层的形状;react-native-passkeys 的 get()/create() 直接吃里层的
// PublicKeyCredentialRequest/CreationOptionsJSON,所以这里负责拆包裹 + 把结果原样透传
// (react-native-passkeys 已经用的是标准 WebAuthn JSON(base64url)形状,和后端字段一致,
// 不需要再做字段映射)。
import * as Passkeys from 'react-native-passkeys';
// react-native-passkeys 的 build/index.d.ts 只导出了 create()/get() 函数,没有把这些 JSON
// 类型从主入口再导出一遍,所以只能从它的类型子模块直接引入。
import type {
  AuthenticationResponseJSON,
  CreationResponse,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from 'react-native-passkeys/build/ReactNativePasskeys.types';
import { t } from '../i18n';
import { withSystemAuthentication } from '../crypto/systemAuthentication';

export class PasskeyUnavailableError extends Error {
  constructor() {
    super(t('passkeyError.unavailable'));
    this.name = 'PasskeyUnavailableError';
  }
}

/** 系统没有启用可存取 Passkey 的凭据提供方（例如 Google 密码管理器） */
export class PasskeyProviderNotConfiguredError extends Error {
  constructor() {
    super(t('passkeyError.providerNotConfigured'));
    this.name = 'PasskeyProviderNotConfiguredError';
  }
}

export class PasskeyCancelledError extends Error {
  constructor() {
    super(t('passkeyError.cancelled'));
    this.name = 'PasskeyCancelledError';
  }
}

// 实测在部分设备/系统状态下(例如系统凭据面板被整体 Dismiss,而不是用户在面板内选了
// "取消"),react-native-passkeys 的 get()/create() 返回的 Promise 会一直不 resolve 也不
// reject——大概率是 Android CredentialManager 那边的回调没有被触发。没有超时兜底的话,
// 调用方的 loading 状态会永久卡住,用户除了强杀 App 没有别的办法退出。
export class PasskeyTimeoutError extends Error {
  constructor() {
    super(t('passkeyError.timeout'));
    this.name = 'PasskeyTimeoutError';
  }
}

const PASSKEY_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PasskeyTimeoutError()), PASSKEY_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * 开跑之前挡一道明显不可能成功的情况。
 *
 * 注意 Passkeys.isSupported() **只是**一次系统版本判断——库里的原生实现,Android 侧
 * 是 `Build.VERSION.SDK_INT >= 28`、iOS 侧是 `#available(iOS 15.0)`,仅此而已。
 * 设备有没有设锁屏/生物识别、有没有可用的凭据提供方(Google Play 服务的
 * Credential Manager、iCloud 钥匙串)、用户有没有登录账号,它一概不看。
 *
 * 所以它只配当这里的一道前置断言,不足以拿去在界面上提前隐藏入口:版本够了照样
 * 可能失败,而版本不够就藏掉,用户连"为什么不能用"都看不到。真正的可用性由
 * create()/get() 跑起来说了算,失败路径靠下面这几个错误类型区分。
 */
function ensureSupported() {
  let supported: boolean;
  try {
    supported = Passkeys.isSupported();
  } catch {
    // 原生模块没装上/没链接好 —— 当作不可用,给出和版本不够一样的提示
    supported = false;
  }
  if (!supported) throw new PasskeyUnavailableError();
}

// 实测:用户把系统凭据面板整体划掉/Dismiss 掉(而不是在面板里点"取消")时,
// react-native-passkeys 在 Android 上不是像"没选中任何凭据"那样 resolve 一个 falsy 值,
// 而是直接 reject 一个 name/message 为 "UserCancelled" 的原生异常。这条路径本质上也是
// 用户主动放弃,应该和 PasskeyCancelledError 一样静默处理,而不是把这串原始英文异常名
// 当成"登录失败"的错误文案展示给用户。
const CANCEL_PATTERN = /cancel/i;
const PROVIDER_NOT_CONFIGURED_PATTERN = /not\s*configured/i;

function isNativeCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CANCEL_PATTERN.test(error.name) || CANCEL_PATTERN.test(error.message);
}

function isNativeProviderNotConfigured(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return PROVIDER_NOT_CONFIGURED_PATTERN.test(error.name) || PROVIDER_NOT_CONFIGURED_PATTERN.test(error.message);
}

async function runCeremony<T>(promise: Promise<T | null | undefined>): Promise<T> {
  let result: T | null | undefined;
  try {
    result = await withTimeout(promise);
  } catch (error) {
    if (isNativeCancellation(error)) throw new PasskeyCancelledError();
    if (isNativeProviderNotConfigured(error)) throw new PasskeyProviderNotConfiguredError();
    throw error;
  }
  if (!result) throw new PasskeyCancelledError();
  return result;
}

/** 包裹层:go-webauthn 返回 `{ publicKey: {...} }`,与浏览器 CredentialRequestOptions 一致 */
type WrappedRequestOptions = { publicKey: PublicKeyCredentialRequestOptionsJSON };
type WrappedCreationOptions = { publicKey: PublicKeyCredentialCreationOptionsJSON };

/** 发起一次认证(登录)ceremony,对应 navigator.credentials.get() */
export async function getPasskey(wrapped: WrappedRequestOptions): Promise<AuthenticationResponseJSON> {
  ensureSupported();
  return withSystemAuthentication(() => runCeremony(Passkeys.get(wrapped.publicKey)));
}

/** 发起一次注册 ceremony,对应 navigator.credentials.create()(创建流程会用到,登录阶段暂不涉及) */
export async function createPasskey(wrapped: WrappedCreationOptions): Promise<CreationResponse> {
  ensureSupported();
  return withSystemAuthentication(() => runCeremony(Passkeys.create(wrapped.publicKey)));
}
