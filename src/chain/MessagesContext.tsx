import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useWallet } from './WalletContext';
import { buildMessages, getLastReadAt, MessageItem, setLastReadAt } from './messages';
import { useI18n } from '../i18n';
import { useAppContent } from '../content/AppContentContext';

type MessagesState = {
  messages: MessageItem[];
  unreadCount: number;
  markAllRead: () => void;
};

const Ctx = createContext<MessagesState | null>(null);

export function MessagesProvider({ children }: { children: React.ReactNode }) {
  const w = useWallet();
  const { locale, t: translate } = useI18n();
  const { content } = useAppContent();
  const [announcementClock, setAnnouncementClock] = useState(Date.now);
  const identity = `${w.chainId}:${w.account}`;
  const [readState, setReadState] = useState({ identity, at: 0 });
  const readVersion = useRef(0);
  const lastReadAt = readState.identity === identity ? readState.at : 0;

  useEffect(() => {
    let cancelled = false;
    const version = ++readVersion.current;
    getLastReadAt(w.chainId, w.account).then((t) => {
      if (!cancelled && version === readVersion.current) setReadState({ identity, at: t });
    });
    return () => {
      cancelled = true;
    };
  }, [w.chainId, w.account, identity]);

  // Refresh when the next scheduled notice becomes publishable.
  useEffect(() => {
    const now = Date.now();
    const next = content.announcements
      .filter((announcement) => announcement.enabled)
      .map((announcement) => Date.parse(announcement.publishedAt))
      .filter((time) => Number.isFinite(time) && time > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = setTimeout(() => setAnnouncementClock(Date.now()), Math.min(next - now + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [content.announcements, announcementClock]);

  const messages = useMemo(
    () => buildMessages(w.actions, content.announcements, locale, undefined, translate),
    [w.actions, content.announcements, locale, translate, announcementClock]
  );
  const unreadCount = messages.filter((m) => m.time > lastReadAt).length;

  const markAllRead = useCallback(() => {
    const now = Date.now();
    readVersion.current += 1;
    setReadState({ identity, at: now });
    setLastReadAt(w.chainId, w.account, now);
  }, [w.chainId, w.account, identity]);

  const value = useMemo(() => ({ messages, unreadCount, markAllRead }), [messages, unreadCount, markAllRead]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMessages(): MessagesState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMessages 必须在 MessagesProvider 内使用');
  return v;
}
