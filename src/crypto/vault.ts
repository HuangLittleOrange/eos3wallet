// 密钥保管:密码派生 → 加密 → 存入系统 Keystore/Keychain
//
// 双层保护:
//   1. 私钥用用户密码派生的密钥做 AES-GCM 加密(密码不落盘)
//   2. 密文再存进 expo-secure-store(Android Keystore / iOS Keychain)
// 这两层减少离线存储泄漏,不阻止已控制应用运行时的代码读取解锁后的明文。
import 'react-native-get-random-values';

import { PrivateKey, PublicKey } from '@wharfkit/antelope';
import * as SecureStore from 'expo-secure-store';
import { pbkdf2 as nativePbkdf2 } from 'react-native-quick-crypto';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { CHAINS, DEFAULT_CHAIN, type ChainId } from '../chain/config';
import { t } from '../i18n';
import { withSystemAuthentication } from './systemAuthentication';

const bytesToUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

const KEY_PREFIX = 'aurora.wallet.';
const INDEX_KEY = 'aurora.wallet.index';

/**
 * PBKDF2 迭代次数。越高越慢也越安全;走 react-native-quick-crypto 的原生实现
 * (JSI 调 OpenSSL),60 万次在移动端约一秒上下 —— 纯 JS 实现(@noble/hashes)
 * 在 Hermes 上没有硬件加速,同样的迭代次数会慢上一个数量级,体感是"卡好几秒"。
 * 60 万是 OWASP 对 PBKDF2-HMAC-SHA256 的当前建议值。以前用 20 万写入的旧记录
 * 不受影响——每条 Envelope 落盘时存了自己的 iterations,解密按它来(见下)。
 */
const PBKDF2_ITERATIONS = 600_000;

export type StoredWallet = {
  id: string;
  /** 账户名,导入时由公钥反查得到 */
  account: string;
  publicKey: string;
  /** 派生路径,私钥直接导入时为空 */
  path?: string;
  createdAt: number;
  /** 来源:助记词 / 私钥 / 只读观察 / eos3.app 的 passkey 账户 */
  source: 'mnemonic' | 'privatekey' | 'watch' | 'passkey';
  /**
   * 添加这个钱包时选的链 —— 账户名是链内资源,同名账户在不同链上可能是完全
   * 不同的人,不能因为公私钥一样就默认这个账户在别的链上也能用。这个字段
   * 上线前存的钱包没有,读到 undefined 时按主网处理(见 WalletListSheet)。
   */
  chainId?: ChainId;
  /**
   * 仅 source === 'passkey' 时存在:该 passkey credential 的十六进制 ID。
   * 本机从不保存这类钱包的任何密钥材料 —— credential ID 本身不是密钥,
   * 每次签名都要现场发起一次系统级 passkey 认证。
   */
  credentialIdHex?: string;
  /**
   * 这把钥匙在链上实际控制的权限名(如 ['active']、['owner']、或两者都有,
   * 同一把私钥同时出现在 owner 和 active 里并不罕见)。导入时由
   * get_accounts_by_authorizers 检测得到,用户可在确认导入前调整。
   * 上线前导入的钱包没有这个字段,读到 undefined 按「未知」处理,
   * 不代表它只控制 active——只是没有这份记录。
   */
  authPermissions?: string[];
  /** Encrypted device private key uses this wallet's id, just like a private-key import. */
  deviceKey?: DeviceKeyMeta;
};

export type DeviceKeyMeta = {
  publicKey: string;
  label: string;
  createdAt: number;
  authorizedAt?: number;
};

type Envelope = {
  v: 1;
  salt: string;
  nonce: string;
  cipher: string;
  iterations: number;
};

/**
 * 部分设备/系统状态下,原生模块的回调可能永远不触发(既不 resolve 也不
 * reject)——同样的坑之前在 passkey 的系统凭据面板上踩过一次(见
 * nativePasskey.ts 的 PasskeyTimeoutError 注释),这里是同一类风险:
 * PBKDF2 走的是 Nitro 原生线程池,生物识别读密码走的是系统 BiometricPrompt,
 * 两者都是"回调可能不来"的黑盒。没有超时兜底,调用方(导出私钥、签名前
 * 解锁)的 busy 状态会永久卡死——弹窗的取消按钮也跟 busy 绑在一起,用户
 * 除了强杀 App 没有别的办法退出。
 */
export class VaultTimeoutError extends Error {
  constructor() {
    super(t('vaultError.timeout'));
    this.name = 'VaultTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VaultTimeoutError()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * 密码 → AES-256 密钥,PBKDF2-HMAC-SHA256。
 *
 * iterations 必须显式传入、不能悄悄取全局常量:每条加密记录(Envelope)在
 * 写入时把当时用的迭代次数存进了 iterations 字段,以后调高 PBKDF2_ITERATIONS
 * 时,旧记录仍要按它写入那一刻的值重新派生才能解密——用新常量硬算,老密文
 * 全部按"密码错误"处理,等于把所有旧钱包锁死。
 */
async function deriveAesKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  let timedOut = false;
  const raw = new Promise<Uint8Array>((resolve, reject) => {
    nativePbkdf2(password, salt, iterations, 32, 'sha256', (err, key) => {
      if (err || !key) reject(err ?? new Error('pbkdf2 failed'));
      else resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength));
    });
  });
  // 原生实现单次正常耗时约 1 秒(见 PBKDF2_ITERATIONS 注释),20 秒足够覆盖
  // 慢设备的正常抖动,不会误伤真实还在算的情况。
  // A native callback can arrive after the timeout, when no caller owns its buffer.
  void raw.then((key) => { if (timedOut) key.fill(0); }, () => {});
  try {
    return await withTimeout(raw, 20_000);
  } catch (error) {
    timedOut = true;
    throw error;
  }
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * SecureStore 的读取偶尔会因为原生模块/Keystore 还没完全就绪而短暂失败,
 * 属于一过性抖动 —— 重试几次再认输,不要一次读不到就判死刑。
 * 只用在"读"上;写失败、密码错误(GCM 认证失败)这类确定性结果不重试。
 */
async function getItemWithRetry(key: string, opts?: SecureStore.SecureStoreOptions, attempts = 3): Promise<string | null> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await SecureStore.getItemAsync(key, opts);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 加密并保存私钥。
 *
 * 写完立刻用同一份密码读回来解密校验一遍再返回 —— 宁可创建/导入这几十毫秒
 * 多花一点时间,也不要用户以为保存成功了,真要签名的时候才发现读不出来。
 * 校验失败会把这条写坏的记录删掉,不留半成品。
 */
export async function saveSecret(id: string, secret: string, password: string): Promise<void> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const plain = utf8ToBytes(secret);
  let cipher: Uint8Array;
  try {
    cipher = gcm(key, nonce).encrypt(plain);
  } finally {
    key.fill(0);
    plain.fill(0);
  }

  const env: Envelope = {
    v: 1,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    cipher: bytesToHex(cipher),
    iterations: PBKDF2_ITERATIONS,
  };
  await SecureStore.setItemAsync(KEY_PREFIX + id, JSON.stringify(env), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

  const check = await loadSecret(id, password).catch(() => null);
  if (check !== secret) {
    await SecureStore.deleteItemAsync(KEY_PREFIX + id).catch(() => {});
    throw new Error(t('vaultError.saveVerifyFailed'));
  }
}

/** 密码错误(GCM 认证失败)—— 单独开一个类,而不是拿 Error.message 的文本去比对,
 *  这样调用方（如 SecurityScreen）用 instanceof 判断就不会因为切换语言、
 *  message 文案变了而失效。 */
export class WrongPasswordError extends Error {
  constructor() {
    super(t('vaultError.wrongPassword'));
    this.name = 'WrongPasswordError';
  }
}

/** 读取并解密私钥。密码错误会抛异常(GCM 认证失败) */
export async function loadSecret(id: string, password: string): Promise<string> {
  const raw = await getItemWithRetry(KEY_PREFIX + id);
  if (!raw) throw new Error(t('vaultError.keyNotFound'));

  const env: Envelope = JSON.parse(raw);
  // 按这条记录写入时实际用的迭代次数验证,而不是当前的全局常量——
  // 否则以后调高 PBKDF2_ITERATIONS,所有旧记录都会因为派生结果对不上
  // 而被误判成密码错误(见 deriveAesKey 的注释)。
  const key = await deriveAesKey(password, hexToBytes(env.salt), env.iterations ?? PBKDF2_ITERATIONS);
  let plain: Uint8Array | undefined;
  try {
    plain = gcm(key, hexToBytes(env.nonce)).decrypt(hexToBytes(env.cipher));
    return bytesToUtf8(plain);
  } catch {
    throw new WrongPasswordError();
  } finally {
    key.fill(0);
    plain?.fill(0);
  }
}

export async function removeSecret(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_PREFIX + id);
}

// ---------- 待激活账户的临时密钥 ----------
//
// "转账给合约建号"的订单存在一个尴尬窗口:钱已经转出去了,但账户还没上链,
// 这把新密钥此时既不能进钱包索引(账户还不存在),又绝对不能丢(丢了 = 这笔
// 开户费和这个账户一起打水漂)。
//
// 这里的取舍:临时密钥只进 SecureStore(Android Keystore / iOS Keychain),
// 不套密码派生的那层 AES —— 因为整个建号流程里没有再向用户要密码的时机,
// 而"少一层保护地存几分钟"明显优于"应用被杀掉就永久丢失一个已付费账户"。
// 账户上链后会立刻要求主密码、转存成正常的双层加密条目并删掉这个临时槽位
// (见 CreateAccountPayScreen 的 save 步骤),订单被删除时同样清掉。
const PENDING_KEY = 'aurora.signup.pendingKey';

function pendingKeySlot(publicKey: string): string {
  return PENDING_KEY + '.' + String(PublicKey.from(publicKey));
}

/** Each order has its own key; creating an order on another chain cannot overwrite it. */
export async function savePendingKey(privateKey: string, publicKey: string): Promise<void> {
  if (!PrivateKey.from(privateKey).toPublic().equals(PublicKey.from(publicKey))) throw new Error('Pending key mismatch');
  await SecureStore.setItemAsync(pendingKeySlot(publicKey), privateKey, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadPendingKey(publicKey: string): Promise<string | null> {
  const slot = pendingKeySlot(publicKey);
  let secret = await getItemWithRetry(slot);
  if (!secret) {
    // Migrate an older global slot only when it matches this order. Keep mismatched
    // legacy material recoverable instead of deleting a potentially paid account key.
    secret = await getItemWithRetry(PENDING_KEY);
    if (!secret || !PrivateKey.from(secret).toPublic().equals(PublicKey.from(publicKey))) return null;
    await savePendingKey(secret, publicKey);
    await SecureStore.deleteItemAsync(PENDING_KEY);
  }
  if (!PrivateKey.from(secret).toPublic().equals(PublicKey.from(publicKey))) throw new Error('Pending key mismatch');
  return secret;
}

export async function clearPendingKey(publicKey: string): Promise<void> {
  await SecureStore.deleteItemAsync(pendingKeySlot(publicKey));
  const legacy = await getItemWithRetry(PENDING_KEY);
  if (legacy && PrivateKey.from(legacy).toPublic().equals(PublicKey.from(publicKey))) await SecureStore.deleteItemAsync(PENDING_KEY);
}

const PENDING_DEVICE_KEY = 'aurora.deviceKey.pending';

export type PendingDeviceKey = DeviceKeyMeta & {
  id: string;
  legacyPublicKey: string;
  /** Undefined only for recoverable records from older builds. */
  chainId?: ChainId;
};

let deviceImportQueue: Promise<void> = Promise.resolve();
function withDeviceImportStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = deviceImportQueue.then(operation);
  deviceImportQueue = result.then(() => {}, () => {});
  return result;
}

export async function loadPendingDeviceKey(): Promise<PendingDeviceKey | null> {
  const raw = await getItemWithRetry(PENDING_DEVICE_KEY);
  if (raw === null) return null;
  try {
    const pending = JSON.parse(raw) as PendingDeviceKey;
    if (!pending || typeof pending.id !== 'string' || !pending.id ||
      typeof pending.publicKey !== 'string' || !pending.publicKey ||
      typeof pending.legacyPublicKey !== 'string' || !pending.legacyPublicKey ||
      typeof pending.label !== 'string' || !Number.isFinite(pending.createdAt) ||
      (pending.chainId !== undefined && !Object.prototype.hasOwnProperty.call(CHAINS, pending.chainId))) {
      throw new Error();
    }
    return pending;
  } catch {
    throw new WalletReadError();
  }
}

export function savePendingDeviceKey(pending: PendingDeviceKey): Promise<void> {
  return withDeviceImportStorage(async () => {
    const current = await loadPendingDeviceKey();
    if (current && !samePendingDeviceKey(current, pending)) throw new Error(t('vaultError.pendingKeyExists'));
    await SecureStore.setItemAsync(PENDING_DEVICE_KEY, JSON.stringify(pending), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
}

function samePendingDeviceKey(a: PendingDeviceKey, b: PendingDeviceKey): boolean {
  return a.id === b.id && a.publicKey === b.publicKey && a.chainId === b.chainId;
}

/** Rename only a live recovery record; never recreate a consumed key. */
export function updatePendingDeviceKeyLabel(pending: PendingDeviceKey, label: string): Promise<PendingDeviceKey> {
  return withDeviceImportStorage(async () => {
    const name = label.trim();
    if (!name || name.length > 40 || /[\x00-\x1F\x7F]/.test(name)) {
      throw new Error(t('deviceKey.nameInvalid'));
    }
    const current = await loadPendingDeviceKey();
    if (!current || !samePendingDeviceKey(current, pending) || current.label !== pending.label) {
      throw new Error(t('signupError.pendingChanged'));
    }
    const updated = { ...current, label: name };
    await SecureStore.setItemAsync(PENDING_DEVICE_KEY, JSON.stringify(updated), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return updated;
  });
}

export function importStoredPendingDeviceKey(pending: PendingDeviceKey, wallet: StoredWallet): Promise<StoredWallet> {
  return withDeviceImportStorage(async () => {
    const current = await loadPendingDeviceKey();
    if (!current || !samePendingDeviceKey(current, pending) || wallet.id !== current.id ||
      wallet.publicKey !== current.publicKey || wallet.source !== 'privatekey' ||
      (current.chainId !== undefined && current.chainId !== wallet.chainId)) {
      throw new Error(t('signupError.pendingChanged'));
    }
    if (!await getItemWithRetry(KEY_PREFIX + current.id)) throw new Error(t('vaultError.keyNotFound'));
    const all = await listWallets();
    const duplicate = all.find((entry) => entry.id !== wallet.id && entry.account === wallet.account &&
      entry.publicKey === wallet.publicKey &&
      (entry.chainId ?? DEFAULT_CHAIN) === (wallet.chainId ?? DEFAULT_CHAIN));
    const stored = duplicate
      ? { ...wallet, id: duplicate.id, createdAt: duplicate.createdAt,
          authPermissions: mergePermissions(duplicate.authPermissions, wallet.authPermissions) }
      : wallet;
    if (duplicate && !await getItemWithRetry(KEY_PREFIX + duplicate.id)) throw new Error(t('vaultError.keyNotFound'));
    // Publish the wallet before removing the recovery record or redundant ciphertext.
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...all.filter((entry) => entry.id !== stored.id), stored]));
    await SecureStore.deleteItemAsync(PENDING_DEVICE_KEY);
    if (stored.id !== pending.id) await removeSecret(pending.id).catch(() => {});
    return stored;
  });
}

export function discardStoredPendingDeviceKey(pending: PendingDeviceKey): Promise<void> {
  return withDeviceImportStorage(async () => {
    const current = await loadPendingDeviceKey();
    const all = await listWallets();
    if (!current || !samePendingDeviceKey(current, pending) || all.some((entry) => entry.id === pending.id)) {
      throw new Error(t('signupError.pendingChanged'));
    }
    await SecureStore.deleteItemAsync(PENDING_DEVICE_KEY);
    try {
      await removeSecret(pending.id);
    } catch (error) {
      await SecureStore.setItemAsync(PENDING_DEVICE_KEY, JSON.stringify(current), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      throw error;
    }
  });
}

// ---------- 钱包索引(不含任何密钥材料) ----------

/**
 * 索引存在但读不出来 —— 和"本来就没有钱包"是两回事,不能直接当空列表处理。
 * 常见原因是 Android Keystore 里对应的系统密钥没了(比如设备被还原到了
 * 某个旧快照、系统备份/迁移把加密文件搬过去了密钥却没带过去),密文还在
 * 但再也解不开,和硬盘上的加密卷丢了钥匙是一回事。
 */
export class WalletReadError extends Error {
  constructor() {
    super(t('vaultError.readFailed'));
    this.name = 'WalletReadError';
  }
}

export async function listWallets(): Promise<StoredWallet[]> {
  let raw: string | null;
  try {
    raw = await getItemWithRetry(INDEX_KEY);
  } catch {
    throw new WalletReadError();
  }
  if (!raw) return [];
  let list: StoredWallet[];
  try {
    list = JSON.parse(raw) as StoredWallet[];
  } catch {
    throw new WalletReadError();
  }
  return dedupeStoredWallets(list);
}

/**
 * 清掉索引里已经存在的重复记录(同链 + 同账户 + 同公钥出现了不止一条)。
 *
 * addWallet() 只能防住"以后"再导入同一把钥匙时不会新增重复行,但这个字段
 * 上线前、或者这个去重逻辑本身上线前就已经存进索引里的重复数据,不会因为
 * 以后不再产生新重复就自己消失——每次 listWallets() 都得看一眼、顺手清一次,
 * 不然界面上永远是那两张一模一样的卡片,哪怕它们其实是同一把钥匙。
 */
async function dedupeStoredWallets(list: StoredWallet[]): Promise<StoredWallet[]> {
  const groups = new Map<string, StoredWallet[]>();
  for (const w of list) {
    const key = `${w.chainId ?? DEFAULT_CHAIN}\x00${w.account}\x00${w.publicKey}`;
    const arr = groups.get(key);
    if (arr) arr.push(w);
    else groups.set(key, [w]);
  }

  let changed = false;
  const merged: StoredWallet[] = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      merged.push(arr[0]);
      continue;
    }
    changed = true;
    // 留最早的一条(最初那次导入),权限标记取并集——几条重复记录里
    // 只要有一条标过权限,合并后就不该把这份信息丢掉
    const survivor = arr.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    const authPermissions = Array.from(new Set(arr.flatMap((x) => x.authPermissions ?? [])));
    merged.push({ ...survivor, authPermissions: authPermissions.length ? authPermissions : undefined });
    // 被合并掉的那几条,密文和生物识别槽位都是废弃 id 下的孤儿数据,一并清掉
    for (const dup of arr) {
      if (dup.id === survivor.id) continue;
      await removeSecret(dup.id).catch(() => {});
      await clearLegacyBiometric(dup.id).catch(() => {});
    }
  }

  if (changed) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(merged)).catch(() => {});
  return merged;
}

/**
 * 写入一条钱包记录。
 *
 * 去重不能只看 id(每次导入都会生成新的随机 id)——同一把私钥/助记词对同一条链
 * 上同一个账户重复导入时(比如先只勾了 active,后来回来把 owner 也勾上),
 * 应该合并权限而不是叠出一张一模一样的卡片。判断"同一把钥匙"用
 * (chainId, account, publicKey) 这三者,公钥不同就是确实不同的钥匙
 * (比如 active/owner 分开用了两把私钥),各自保留一条记录。
 */
export async function addWallet(w: StoredWallet): Promise<void> {
  const all = await listWallets();
  const sameChain = (x: StoredWallet) => (x.chainId ?? DEFAULT_CHAIN) === (w.chainId ?? DEFAULT_CHAIN);
  const dup = all.find(
    (x) => x.id !== w.id && sameChain(x) && x.account === w.account && x.publicKey === w.publicKey
  );
  const merged: StoredWallet = dup
    ? { ...w, id: dup.id, createdAt: dup.createdAt, authPermissions: mergePermissions(dup.authPermissions, w.authPermissions) }
    : w;
  const next = [...all.filter((x) => x.id !== merged.id), merged];
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(next));
  // 旧记录换了 id 才需要清掉密文;merged.id === dup.id 时是同一份密钥,原密文还留着即可
  if (dup && dup.id !== w.id) await removeSecret(w.id).catch(() => {});
}

function mergePermissions(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined;
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

export async function removeWallet(id: string): Promise<void> {
  const all = await listWallets();
  await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(all.filter((x) => x.id !== id)));
  await removeSecret(id).catch(() => {});
  await clearLegacyBiometric(id).catch(() => {});
}

export function newWalletId(): string {
  return bytesToHex(randomBytes(8));
}

/**
 * 这条钱包记录签名时应该报的权限名。
 *
 * 一把钥匙可能同时标了 active 和 owner(同一份密钥两个权限都用它,这种情况
 * 下默认按更常用、也更安全的 active 走,owner 不该被日常操作顺手带出来);
 * 只标了 owner 的钥匙(专门分开导入的 owner 密钥)就照实用 owner——这正是
 * 用户在钱包列表里特意选中那张"owner"卡片时想要的效果。没有标记的旧数据
 * (这个字段上线前导入的)按 active 处理,和一直以来的默认行为一致。
 */
export function signingPermission(w: StoredWallet | undefined): string {
  const perms = w?.authPermissions;
  if (!perms || perms.length === 0) return 'active';
  return perms.includes('active') ? 'active' : perms[0];
}

// ---------- 主密码 ----------
//
// 全机共用一个密码,加密逻辑仍是 saveSecret/loadSecret 那一套,
// 没有引入新的加密格式 —— 只是把"主密码"存成一份保留 id 下的验证器,
// 靠它能不能解密来判断用户输的密码对不对。这个 id 是固定字符串,
// newWalletId() 只会产出 16 位十六进制,永远不会撞上它。
//
// "设置"和"用来保存某个具体钱包"是两个独立动作(分别在
// SetMasterPasswordScreen 和 ImportSecretScreen/CreateAccountPayScreen 里),
// 不是一个事务里前后脚发生的——设置成功了就是成功了,后面某次导入失败
// 不需要、也不应该把已经设好的主密码撤回去。
//
// 密码本身依然不缓存:这里只负责"设置一次"和"每次现验一次",
// 不在内存里留存,和签名/导出私钥的现有原则一致。

const MASTER_ID = '__master_verifier__';

/** 本机是否已经设置过主密码。走 getItemWithRetry —— 和 listWallets() 读索引一致,
 *  避免 Keystore 抖动导致的假阴性把"验证已有主密码"误判成"设置新主密码"。 */
export async function hasMasterPassword(): Promise<boolean> {
  return (await getItemWithRetry(KEY_PREFIX + MASTER_ID)) !== null;
}

/** 首次设置主密码。验证器内容本身没有意义,只用来事后验证密码对不对。 */
export async function setMasterPassword(password: string): Promise<void> {
  await saveSecret(MASTER_ID, bytesToHex(randomBytes(16)), password);
}

/** 校验主密码是否正确。 */
export async function verifyMasterPassword(password: string): Promise<boolean> {
  try {
    await loadSecret(MASTER_ID, password);
    return true;
  } catch {
    return false;
  }
}

// ---------- 生物识别解锁 ----------
//
// 设计:生物识别**不直接解密私钥**,而是门控密码。
// 私钥始终由密码派生的密钥加密;开启生物识别只是把密码存进一个
// 需要系统认证才能读取的槽位。这样做的好处:
//   - 生物识别被移除或失效时,密码仍能解锁,不会永久锁死资产
//   - 私钥的加密强度不依赖设备生物识别的实现质量

const BIO_PREFIX = 'aurora.bio.';
const BIO_MASTER_KEY = BIO_PREFIX + 'master';
const BIO_MASTER_FLAG = BIO_MASTER_KEY + '.flag';

let biometricQueue: Promise<void> = Promise.resolve();
function withBiometricStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = biometricQueue.then(operation);
  biometricQueue = result.then(() => {}, () => {});
  return result;
}

async function clearLegacyBiometric(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(BIO_PREFIX + id + '.flag');
  await SecureStore.deleteItemAsync(BIO_PREFIX + id);
}

async function clearLegacyBiometrics(): Promise<void> {
  const wallets = await listWallets();
  for (const wallet of wallets) await clearLegacyBiometric(wallet.id);
}

async function biometricCredentialSlot(): Promise<string | null> {
  const mode = await getItemWithRetry(BIO_MASTER_FLAG);
  if (mode !== null) return mode === '1' ? BIO_MASTER_KEY : null;
  // Old credentials remain authentication-gated until their first successful use.
  const wallets = await listWallets();
  for (const wallet of wallets) {
    if (wallet.source !== 'privatekey' && wallet.source !== 'mnemonic') continue;
    if (await getItemWithRetry(BIO_PREFIX + wallet.id + '.flag') === '1') return BIO_PREFIX + wallet.id;
  }
  return null;
}

/** 系统是否可用生物识别(有硬件且已录入) */
export async function biometricAvailable(): Promise<{
  ok: boolean;
  reason?: 'no-hardware' | 'not-enrolled';
}> {
  const LocalAuth = await import('expo-local-authentication');
  const hasHardware = await LocalAuth.hasHardwareAsync();
  if (!hasHardware) return { ok: false, reason: 'no-hardware' };
  const enrolled = await LocalAuth.isEnrolledAsync();
  if (!enrolled) return { ok: false, reason: 'not-enrolled' };
  return { ok: true };
}

/** Device-wide setting; reading it never opens an authentication prompt. */
export async function biometricEnabled(): Promise<boolean> {
  try {
    return (await biometricCredentialSlot()) !== null;
  } catch {
    return false;
  }
}

async function saveBiometricMasterPassword(password: string): Promise<void> {
  await SecureStore.setItemAsync(BIO_MASTER_KEY, password, {
    requireAuthentication: true,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    authenticationPrompt: t('vaultError.unlockPrompt'),
  });
  await SecureStore.setItemAsync(BIO_MASTER_FLAG, '1');
}

/** Verify the shared master password, not the currently selected wallet. */
export function enableBiometric(password: string): Promise<void> {
  return withBiometricStorage(async () => {
    await loadSecret(MASTER_ID, password);
    await saveBiometricMasterPassword(password);
    await clearLegacyBiometrics().catch(() => {});
  });
}

export function disableBiometric(): Promise<void> {
  return withBiometricStorage(async () => {
    // An explicit off marker prevents surviving legacy records from re-enabling it.
    await SecureStore.setItemAsync(BIO_MASTER_FLAG, '0');
    await SecureStore.deleteItemAsync(BIO_MASTER_KEY);
    await clearLegacyBiometrics().catch(() => {});
  });
}

/**
 * 用生物识别取回私钥。用户取消或识别失败会抛错。
 *
 * 正常解锁只读取一次受认证保护的全机凭据——`SecureStore.getItemAsync(..., { requireAuthentication: true })`
 * 本身就会弹原生的生物识别/设备凭据提示,这是真正把 Keystore 里那份密码解锁出来
 * 所必需的那一次。以前这里在它前面还多调了一次 expo-local-authentication 的
 * `authenticateAsync()`——那只是一次独立的"验证一下是不是你"，跟 SecureStore
 * 这个 key 本身的解锁没有绑定关系，不产生任何额外的安全效果，纯粹让用户多按一次
 * 指纹。cancel 场景改成捕获 SecureStore 认证失败时抛出的异常来识别。
 */
export async function loadSecretWithBiometric(id: string): Promise<string> {
  const slot = await biometricCredentialSlot();
  if (!slot) throw new Error(t('vaultError.credentialNotFound'));
  let password: string | null;
  try {
    // 45 秒对齐 passkey 那边的系统凭据面板超时——生物识别面板要留时间给
    // 用户真的去按指纹/看脸,比纯计算类的 20 秒宽松得多。
    password = await withSystemAuthentication(() => withTimeout(
      SecureStore.getItemAsync(slot, {
        requireAuthentication: true,
        authenticationPrompt: t('vaultError.unlockPrompt'),
      }),
      45_000
    ));
  } catch (e: any) {
    // 超时是它自己的错误类型,原样往外抛——不该被下面的"生物识别失败"
    // 文案盖掉,那会让用户以为是指纹/面容没认出来,再试还是白等 45 秒。
    if (e instanceof VaultTimeoutError) throw e;
    // 系统认证失败/被取消时,expo-secure-store 是 reject 而不是返回 null——
    // 取消属于"用户主动放弃,还能用密码代替"的场景,不该和真的失败混为一谈。
    const cancelled = /cancel/i.test(String(e?.message ?? ''));
    throw new Error(cancelled ? t('vaultError.cancelled') : t('vaultError.biometricFailed'));
  }
  if (!password) throw new Error(t('vaultError.credentialNotFound'));

  if (slot !== BIO_MASTER_KEY) {
    await loadSecret(MASTER_ID, password);
    await withBiometricStorage(async () => {
      const mode = await getItemWithRetry(BIO_MASTER_FLAG);
      if (mode === '0') throw new Error(t('vaultError.credentialNotFound'));
      if (mode === null) {
        await saveBiometricMasterPassword(password!);
        await clearLegacyBiometrics().catch(() => {});
      }
    });
  }
  if (await getItemWithRetry(BIO_MASTER_FLAG) !== '1') throw new Error(t('vaultError.credentialNotFound'));
  return loadSecret(id, password);
}
