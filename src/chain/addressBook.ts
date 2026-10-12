// 地址簿
//
// 存的是账户名和 Memo,不含任何密钥材料,所以用 AsyncStorage 即可,
// 不必占用 SecureStore 的加密槽位。
//
// Memo 一并保存是关键设计:向交易所充值漏填 Memo 是 EOS 资产丢失的
// 主要原因,把它和账户名绑在一起能从源头减少这类事故。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isValidAccountName } from './account';
import { t } from '../i18n';

const KEY = 'aurora.addressbook.v1';

export type Contact = {
  id: string;
  /** 备注名,如「币安充值」 */
  name: string;
  account: string;
  memo: string;
  /** 属于哪条链,避免主网与测试网地址混用 */
  chainId: string;
  createdAt: number;
};

export async function listContacts(chainId?: string): Promise<Contact[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const all: Contact[] = raw ? JSON.parse(raw) : [];
    const list = chainId ? all.filter((c) => c.chainId === chainId) : all;
    return list.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

async function writeAll(list: Contact[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(list));
}

export async function saveContact(c: Omit<Contact, 'id' | 'createdAt'> & { id?: string }): Promise<Contact> {
  const account = c.account.trim();
  if (!isValidAccountName(account)) throw new Error(t('send.invalidAccount'));
  const name = c.name.trim();
  if (!name) throw new Error(t('addressBookError.nameRequired'));
  if ((c.memo ?? '').length > 256) throw new Error(t('transactError.memoTooLong'));

  const raw = await AsyncStorage.getItem(KEY);
  const all: Contact[] = raw ? JSON.parse(raw) : [];

  if (c.id) {
    const idx = all.findIndex((x) => x.id === c.id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], name, account, memo: c.memo ?? '', chainId: c.chainId };
      await writeAll(all);
      return all[idx];
    }
  }

  // 同链同账户同 Memo 视为重复
  const dup = all.find(
    (x) => x.chainId === c.chainId && x.account === account && (x.memo ?? '') === (c.memo ?? '')
  );
  if (dup) throw new Error(t('addressBookError.duplicate'));

  const created: Contact = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    account,
    memo: c.memo ?? '',
    chainId: c.chainId,
    createdAt: Date.now(),
  };
  all.push(created);
  await writeAll(all);
  return created;
}

export async function removeContact(id: string): Promise<void> {
  const raw = await AsyncStorage.getItem(KEY);
  const all: Contact[] = raw ? JSON.parse(raw) : [];
  await writeAll(all.filter((x) => x.id !== id));
}
