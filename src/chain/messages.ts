import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChainId } from './config';
import { ChainAction } from './client';
import { BRAND_NAME } from '../theme';
import { t, type LocaleId } from '../i18n';
import { localizedText, visibleItems, type ContentAnnouncement } from '../content/types';

export type MessageItem = {
  id: string;
  kind: 'system' | 'transfer';
  title: string;
  body: string;
  time: number;
  url?: string;
};

function systemMessages(translate: typeof t): MessageItem[] {
  return [
    {
      id: 'sys-welcome',
      kind: 'system',
      title: translate('messages.welcomeTitle', { brand: BRAND_NAME }),
      body: translate('messages.welcomeBody'),
      time: Date.parse('2026-08-01T00:00:00+08:00'),
    },
  ];
}

export function buildMessages(
  actions: ChainAction[],
  announcements?: ContentAnnouncement[],
  locale: LocaleId = 'en',
  now = Date.now(),
  translate: typeof t = t,
): MessageItem[] {
  // undefined 保留默认公告；显式 [] 移除全部系统公告。
  const system: MessageItem[] = announcements === undefined ? systemMessages(translate) : visibleItems(announcements)
    .map((announcement) => ({
      id: `sys-${announcement.id}`,
      kind: 'system' as const,
      title: localizedText(announcement.title, locale),
      body: localizedText(announcement.body, locale),
      time: Date.parse(announcement.publishedAt),
      url: announcement.url,
    }))
    .filter((announcement) => Number.isFinite(announcement.time) && announcement.time <= now);
  const transferMsgs: MessageItem[] = actions
    .filter((a) => a.direction === 'in' && a.quantity)
    .map((a) => ({
      id: `tx-${a.id}`,
      kind: 'transfer' as const,
      title: translate('messages.receivedTransferTitle'),
      body: translate('messages.receivedTransferBody', {
        from: a.from ?? translate('messages.unknownAccount'),
        quantity: a.quantity ?? '',
        memoSuffix: a.memo ? ` · ${a.memo}` : '',
      }),
      time: Date.parse(a.time) || 0,
    }));
  return [...system, ...transferMsgs].sort((a, b) => b.time - a.time);
}

const keyOf = (chainId: ChainId, account: string) => `aurora.messages.lastRead.${chainId}.${account}`;

/** 已读时间按链和账户隔离。 */
export async function getLastReadAt(chainId: ChainId, account: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(keyOf(chainId, account));
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

export async function setLastReadAt(chainId: ChainId, account: string, at: number): Promise<void> {
  await AsyncStorage.setItem(keyOf(chainId, account), String(at)).catch(() => {});
}
