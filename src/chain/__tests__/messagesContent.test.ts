jest.mock('../../i18n', () => ({ t: (key: string) => key }));

import { buildMessages } from '../messages';
import type { ChainAction } from '../client';
import type { ContentAnnouncement } from '../../content/types';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const incoming: ChainAction = {
  id: 'transfer-1', seq: 1, contract: 'core.vaulta', action: 'transfer',
  time: '2026-10-03T11:00:00Z', direction: 'in', from: 'alice', to: 'bob', quantity: '1.0000 A',
};
const announcement = (id: string, overrides: Partial<ContentAnnouncement> = {}): ContentAnnouncement => ({
  id, enabled: true, sortOrder: 0, title: { en: 'Announcement', zh: '公告' },
  body: { en: 'Notice body', zh: '公告内容' }, publishedAt: '2026-10-03T10:00:00Z', ...overrides,
});

it('旧单参数调用仍有内置欢迎消息', () => {
  expect(buildMessages([])).toEqual([expect.objectContaining({ id: 'sys-welcome', kind: 'system' })]);
});

it('后台空公告列表权威下架系统消息，同时保留真实转入', () => {
  const outgoing = { ...incoming, id: 'outgoing', direction: 'out' as const };
  expect(buildMessages([incoming, outgoing], [], 'zh', NOW)).toEqual([
    expect.objectContaining({ id: 'tx-transfer-1', kind: 'transfer' }),
  ]);
});

it('不展示停用、未来或无效发布时间的公告', () => {
  const notices = [
    announcement('published'),
    announcement('disabled', { enabled: false }),
    announcement('future', { publishedAt: '2026-10-03T12:00:01Z' }),
    announcement('invalid', { publishedAt: 'invalid' }),
  ];
  expect(buildMessages([], notices, 'zh', NOW).map((item) => item.id)).toEqual(['sys-published']);
  expect(buildMessages([], notices, 'zh', NOW + 1000).map((item) => item.id)).toEqual(['sys-future', 'sys-published']);
});

it('公告按当前语言与真实转入时间合并排序', () => {
  const messages = buildMessages([incoming], [announcement('first', { url: 'https://eos3.app/news' })], 'zh', NOW);
  expect(messages.map((item) => item.id)).toEqual(['tx-transfer-1', 'sys-first']);
  expect(messages[1]).toEqual(expect.objectContaining({ title: '公告', body: '公告内容', url: 'https://eos3.app/news' }));
  expect(buildMessages([], [announcement('first')], 'ko', NOW)[0].title).toBe('Announcement');
});


it('上下文翻译器立即用于转入文案，避免语言切换时读到旧全局语言', () => {
  const translate: Parameters<typeof buildMessages>[4] = (key) => `当前语言:${key}`;
  const messages = buildMessages([incoming], [announcement('published')], 'zh', NOW, translate);
  expect(messages[0].title).toBe('当前语言:messages.receivedTransferTitle');
  expect(messages[0].body).toBe('当前语言:messages.receivedTransferBody');
  expect(messages[1].title).toBe('公告');
});
