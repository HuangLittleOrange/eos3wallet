import { Name } from '@wharfkit/antelope';
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

/**
 * 这把钥匙实际控制着哪些权限(active / owner / …),给权限徽标用。
 *
 * 优先用导入(或建号)时记录下来的 authPermissions;这份记录是后来才加的字段,
 * 早先存进去的钱包没有 —— 那就退而用当前已经拉到手的链上权限结构按公钥反查一次,
 * 免得非要用户删掉重新导入才看得出这张卡是哪个权限。
 *
 * 反查只在"正在看的就是这个账户"时才有意义(resources 只覆盖当前账户);
 * 对不上就返回空数组,宁可不显示也不瞎猜。
 */
export function resolveAuthPermissions(
  wallet: { account: string; publicKey?: string; authPermissions?: string[] } | null | undefined,
  currentAccount: string,
  resources: { permissions: { name: string; keys: string[] }[] } | null | undefined
): string[] {
  if (!wallet) return [];
  if (wallet.authPermissions?.length) return wallet.authPermissions;
  if (wallet.account !== currentAccount || !wallet.publicKey) return [];
  const pub = wallet.publicKey;
  return (resources?.permissions ?? []).filter((p) => p.keys.includes(pub)).map((p) => p.name);
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
