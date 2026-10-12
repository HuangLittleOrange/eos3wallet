// EOS/Antelope 密钥生成与派生
// 全部为纯 JS 实现,不依赖原生模块。
import 'react-native-get-random-values';

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { Bytes, PrivateKey, PublicKey, KeyType } from '@wharfkit/antelope';
import { t } from '../i18n';
import { fetchWithRetry } from '../net/fetchRetry';

/**
 * EOS 的 BIP44 币种编号是 194。
 * 注意:EOS 并不像以太坊那样统一采用 BIP44 —— 很多账户是直接用裸私钥创建的,
 * 没有助记词。所以钱包必须同时支持「助记词导入」和「私钥导入」两条路径。
 */
export const EOS_DERIVATION_PATH = "m/44'/194'/0'/0/0";

export type DerivedKey = {
  privateKey: string; // PVT_K1_... 格式
  publicKey: string; // PUB_K1_... 格式
  /** 兼容旧版 EOS... 格式的公钥,查账户接口有些只认这个 */
  legacyPublicKey: string;
  path: string;
};

/** 生成 12 或 24 词助记词 */
export function newMnemonic(words: 12 | 24 = 12): string {
  // 128 位熵 → 12 词;256 位 → 24 词
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

export function isValidMnemonic(m: string): boolean {
  try {
    return validateMnemonic(m.trim().toLowerCase().replace(/\s+/g, ' '), wordlist);
  } catch {
    return false;
  }
}

/** 助记词 → EOS 密钥对 */
export function deriveFromMnemonic(
  mnemonic: string,
  path: string = EOS_DERIVATION_PATH,
  passphrase = ''
): DerivedKey {
  const clean = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(clean, wordlist)) throw new Error(t('keysError.mnemonicInvalid'));

  const seed = mnemonicToSeedSync(clean, passphrase);
  let root: HDKey | undefined;
  let node: HDKey | undefined;
  try {
    root = HDKey.fromMasterSeed(seed);
    node = root.derive(path);
    if (!node.privateKey) throw new Error(t('keysError.derivationFailed'));
    const priv = new PrivateKey(KeyType.K1, Bytes.from(node.privateKey));
    return keyInfo(priv, path);
  } finally {
    seed.fill(0);
    node?.wipePrivateData();
    root?.wipePrivateData();
  }
}

/**
 * 生成一把全新的随机密钥对,不经过助记词。
 *
 * 用于"合约创建账户"这类不想强制用户先走一遍抄写+校验仪式才能继续的场景——
 * 生成后立即由调用方加密存入 vault(见 CreateAccountPayScreen 的 unlock 步骤),
 * 事后仍能在钱包详情页导出这把私钥自行备份,只是不在创建的这一刻拦着不让走。
 *
 * 不用 antelope 自带的 PrivateKey.generate()——它底层走 elliptic/brorand 的
 * curve.genKeyPair() 取随机数,brorand 在这套 RN/Hermes 环境里探测不到
 * self.crypto.getRandomValues,会掉进"老古董浏览器"分支直接
 * throw('Not implemented yet')。改成自己用已经 polyfill 好的
 * crypto.getRandomValues(见文件顶部 react-native-get-random-values)取 32 字节
 * 随机数,再和 deriveFromMnemonic 一样直接拼私钥对象——toPublic() 只是确定性的
 * 标量乘法,不会碰到 brorand。32 字节随机数落在 secp256k1 合法标量范围外的概率
 * 低到可以忽略,这里仍然重试几次以防万一(呼应 antelope 自己 generate() 里的
 * all-zero 重试逻辑)。
 */
export function generateKey(): DerivedKey {
  for (let i = 0; i < 8; i++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    if (bytes.every((b) => b === 0)) continue;
    try {
      const priv = new PrivateKey(KeyType.K1, Bytes.from(bytes));
      return keyInfo(priv, '(随机生成)');
    } catch {
      // 极小概率不是合法的 secp256k1 标量,重新取一次
    } finally {
      bytes.fill(0);
    }
  }
  throw new Error(t('keysError.derivationFailed'));
}

/** 私钥字符串 → 密钥对。同时接受 PVT_K1_... 与旧版 5... 格式 */
export function fromPrivateKey(input: string): DerivedKey {
  try {
    const priv = PrivateKey.from(input.trim());
    return keyInfo(priv, '(直接导入)');
  } catch {
    // Parser errors can include the supplied key; never expose them to UI/logging.
    throw new Error(t('importSecret.keyParseFailed'));
  }
}

function keyInfo(priv: PrivateKey, path: string): DerivedKey {
  const pub: PublicKey = priv.toPublic();
  return {
    privateKey: String(priv),
    publicKey: String(pub),
    legacyPublicKey: pub.toLegacyString(),
    path,
  };
}

/** 私钥格式是否合法 —— 用于输入框即时校验,不抛异常 */
export function isValidPrivateKey(s: string): boolean {
  try {
    PrivateKey.from(s.trim());
    return true;
  } catch {
    return false;
  }
}

/** 一次反查命中——某个账户上,这把公钥出现在了哪个权限的 required_auth 里 */
export type KeyAccountMatch = {
  account: string;
  /** 这把钥匙在该账户上控制的权限名,如 ['active']、['owner']、或两者都有。
   *  走 Hyperion 兜底查到的账户拿不到权限名,留空数组表示「未知,需要用户自己确认」。 */
  permissions: string[];
};

/**
 * 用公钥反查它控制了哪些账户,以及在每个账户上具体控制哪个/哪些权限。
 * EOS 的账户名与密钥是分离的:一个密钥可以控制多个账户,同一个密钥也可能
 * 同时出现在同一账户的 owner 和 active 里(不推荐但很常见),所以导入密钥后
 * 必须扫链才知道有哪些账户可用、以及该按哪个权限收。
 *
 * 主路径用 Chain API 的 get_accounts_by_authorizers —— 标准节点都提供,
 * 不依赖 Hyperion,而且响应里每一条自带 permission_name,能借此区分
 * active/owner。之前只走 Hyperion 会在没有历史 API 的节点上查不到账户
 * (实测 Greymass 的 Jungle4 就返回 404),表现为「该密钥未控制任何账户」的假阴性,
 * 且 Hyperion 的 get_key_accounts 本来就不返回权限名,只能兜底出账户名。
 */
export async function findAccountsByKey(
  chainUrl: string,
  publicKey: string,
  hyperionUrl?: string
): Promise<KeyAccountMatch[]> {
  // 1. Chain API(首选)—— 能拿到 permission_name
  // 这里失败会直接静默落到 Hyperion 兜底(见下),TLS 握手偶发失败不重试的话
  // 一次抖动就会被当成"这个节点没有这个 API",表现为假阴性(见下面 catch 的
  // 注释),所以比其他只读查询更需要重试。
  try {
    const r = await fetchWithRetry(`${chainUrl}/v1/chain/get_accounts_by_authorizers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [publicKey] }),
    });
    if (r.ok) {
      const j = await r.json();
      const byAccount = new Map<string, Set<string>>();
      for (const a of j.accounts ?? []) {
        const account = String(a.account_name);
        const permission = String(a.permission_name ?? '');
        if (!account) continue;
        if (!byAccount.has(account)) byAccount.set(account, new Set());
        if (permission) byAccount.get(account)!.add(permission);
      }
      if (byAccount.size) {
        return Array.from(byAccount.entries()).map(([account, perms]) => ({
          account,
          permissions: Array.from(perms),
        }));
      }
    }
  } catch {
    // 落到 Hyperion
  }

  // 2. Hyperion 兜底 —— 只有账户名,没有权限名
  if (hyperionUrl) {
    const r = await fetchWithRetry(
      `${hyperionUrl}/v2/state/get_key_accounts?public_key=${encodeURIComponent(publicKey)}`
    );
    if (r.ok) {
      const j = await r.json();
      return ((j.account_names ?? []) as string[]).map((account) => ({ account, permissions: [] }));
    }
  }

  return [];
}
