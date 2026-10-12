jest.mock('../WalletContext', () => ({ useWallet: jest.fn() }));
jest.mock('../../i18n', () => ({ useI18n: () => ({ locale: 'zh', t: (key: string) => key }) }));
jest.mock('../../content/AppContentContext', () => ({ useAppContent: () => ({ content: { announcements: [] } }) }));
jest.mock('../messages', () => ({ buildMessages: jest.fn(), getLastReadAt: jest.fn(), setLastReadAt: jest.fn() }));

import React from 'react';
import { MessagesProvider, useMessages } from '../MessagesContext';
import { useWallet } from '../WalletContext';
import { buildMessages, getLastReadAt, setLastReadAt } from '../messages';

const { create, act } = require('react-test-renderer');
let renderer: { update: (element: React.ReactElement) => void; unmount: () => void };
let messages: ReturnType<typeof useMessages>;

function Consumer() { messages = useMessages(); return null; }
const tree = () => React.createElement(MessagesProvider, null, React.createElement(Consumer));
const setWallet = (account: string) => jest.mocked(useWallet).mockReturnValue({ account, chainId: 'vaulta', actions: [] } as unknown as ReturnType<typeof useWallet>);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  setWallet('alice');
  jest.mocked(buildMessages).mockReturnValue([{ id: 'tx', kind: 'transfer', title: 'Transfer', body: '', time: 100 }]);
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); });

it('标为已读后，迟到的本地读取不能把消息重新变成未读', async () => {
  let resolve!: (at: number) => void;
  jest.mocked(getLastReadAt).mockImplementation(() => new Promise((done) => { resolve = done; }));
  await act(async () => { renderer = create(tree()); });
  await act(async () => { messages.markAllRead(); });
  expect(messages.unreadCount).toBe(0);
  await act(async () => { resolve(0); });
  expect(messages.unreadCount).toBe(0);
  expect(setLastReadAt).toHaveBeenCalledWith('vaulta', 'alice', expect.any(Number));
});

it('切账户后不使用前一个账户的已读时间隐藏新账户消息', async () => {
  jest.mocked(getLastReadAt).mockResolvedValueOnce(200).mockImplementationOnce(() => new Promise(() => {}));
  await act(async () => { renderer = create(tree()); });
  expect(messages.unreadCount).toBe(0);
  setWallet('bob');
  await act(async () => { renderer.update(tree()); });
  expect(messages.unreadCount).toBe(1);
});


it('后台明确下架全部公告时，provider把空数组传给消息构建器', async () => {
  jest.mocked(getLastReadAt).mockResolvedValue(0);
  await act(async () => { renderer = create(tree()); });
  expect(buildMessages).toHaveBeenCalledWith([], [], 'zh', undefined, expect.any(Function));
});
