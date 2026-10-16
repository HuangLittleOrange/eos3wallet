import { Name, PublicKey } from '@wharfkit/antelope';
import { t } from '../i18n';

/**
 * EOS 账户名的合法字符集:a-z、1-5、点号,最长 12 位。
 * 这个规则来自账户名的 base-32 uint64 编码 —— 集合外的字符压根编不进去。
 */
const ACCOUNT_RE = /^[a-z1-5.]{1,12}$/;

/**
 * 随机生成一个 12 位合法账户名,供"合约创建账户"页的「随机账户」按钮用
 * (参考 TP 的 Random account)。只从 a-z1-5 里取字符、不含点号 —— 这个子集
 * 天然满足 ACCOUNT_RE,不需要再跑一遍 Name.from 往返校验。
 */
const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyz12345';

export function randomAccountName(len = 12): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += RANDOM_CHARS[Math.floor(Math.random() * RANDOM_CHARS.length)];
  }
  return s;
}

export function isValidAccountName(s: string): boolean {
  const v = (s ?? '').trim();
  if (!ACCOUNT_RE.test(v)) return false;
  // 双保险:Name.from 对非法输入不抛异常,而是「静默改写」。
  // 实测 account6 → account、user9 → user、ABCDEF → 空串。
  // 若不做往返校验,用户多打一个数字就会转账到完全不同的账户,且不可逆。
  try {
    return String(Name.from(v)) === v;
  } catch {
    return false;
  }
}

/** 校验失败时给出具体原因,供 UI 提示 */
export function accountNameError(s: string): string | null {
  const v = (s ?? '').trim();
  if (!v) return null;
  if (v.length > 12) return t('accountError.tooLong');
  const bad = Array.from(new Set(v.split('').filter((c) => !/[a-z1-5.]/.test(c))));
  if (bad.length) {
    const digits = bad.filter((c) => /[06-9]/.test(c));
    if (digits.length) return t('accountError.noDigits', { digits: digits.join('、') });
    if (bad.some((c) => /[A-Z]/.test(c))) return t('accountError.noUppercase');
    return t('accountError.badChars', { chars: bad.join('、') });
  }
  if (!isValidAccountName(v)) return t('accountError.invalidFormat');
  return null;
}

/** Permission badges describe last verified chain membership, never import-time metadata. */
export function resolveAuthPermissions(
  wallet: { account: string; publicKey?: string; authPermissions?: string[] } | null | undefined,
  currentAccount: string,
  resources: { account?: string; permissions: { name: string; keys: string[] }[] } | null | undefined
): string[] {
  if (!wallet?.publicKey || wallet.account !== currentAccount || !resources ||
    (resources.account !== undefined && resources.account !== wallet.account)) return [];
  const matchesKey = (key: string) => {
    if (key === wallet.publicKey) return true;
    try { return PublicKey.from(key).equals(PublicKey.from(wallet.publicKey!)); }
    catch { return false; }
  };
  return resources.permissions.filter(permission => permission.keys.some(matchesKey)).map(permission => permission.name);
}

/**
 * 断言账户名合法,不合法直接抛错。
 * 所有会把账户名写进交易的地方都必须先过这一关。
 */
export function assertAccountName(s: string, label?: string): string {
  const v = (s ?? '').trim();
  if (!isValidAccountName(v)) {
    throw new Error(t('accountError.invalidWithReason', { label: label ?? t('accountError.defaultLabel'), name: s, reason: accountNameError(v) ?? t('accountError.formatError') }));
  }
  return v;
}
