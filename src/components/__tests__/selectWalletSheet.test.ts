jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../BottomSheet', () => 'BottomSheet');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/recentRecipients', () => ({ listRecentRecipients: jest.fn(async () => ['recent.acct']) }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import SelectWalletSheet from '../SelectWalletSheet';
import { useWalletSession } from '../../chain/WalletContext';
import { listRecentRecipients } from '../../chain/recentRecipients';
import type { StoredWallet } from '../../crypto/vault';

const { create, act } = require('react-test-renderer');
let renderer: any;
const onClose = jest.fn();
const onPick = jest.fn();
const switchWallet = jest.fn();
const setAccount = jest.fn();
const wallet = (id: string, account: string, extra: Partial<StoredWallet> = {}): StoredWallet => ({
  id, account, publicKey: `PUB_${id}`, source: 'privatekey', createdAt: 1, ...extra,
});
const current = wallet('alice-active', 'alice');
const saved = [
  current,
  wallet('bob', 'bob', { createdAt: 3 }),
  wallet('watch', 'watch.acct', { source: 'watch', publicKey: '', createdAt: 2 }),
  wallet('alice-owner', 'alice', { authPermissions: ['owner'] }),
  wallet('testnet', 'jungle.acct', { chainId: 'jungle4' }),
];
const state = (extra = {}) => ({
  chainId: 'vaulta', account: 'alice', wallets: saved, currentWallet: current,
  switchWallet, setAccount, ...extra,
}) as unknown as ReturnType<typeof useWalletSession>;
const props = { visible: true, onClose, onPick };
const render = async () => {
  await act(async () => { renderer = create(React.createElement(SelectWalletSheet, props)); });
};
const texts = () => renderer.root.findAllByType('Text').flatMap((node: any) => node.children);
const rows = () => renderer.root.findAllByType('TouchableOpacity').filter((node: any) =>
  node.findAllByType('Text').some((text: any) => saved.some((item) => text.children.includes(item.account)))
);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  jest.mocked(useWalletSession).mockReturnValue(state());
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  renderer = null;
});

test('shows every saved wallet on the transfer network with its own key, including watch and legacy records', async () => {
  await render();
  expect(rows().map((node: any) => node.findAllByType('Text')[1].children[0])).toEqual(['bob', 'watch.acct', 'alice', 'alice']);
  expect(texts()).toEqual(expect.arrayContaining(['PUB_bob', 'PUB_alice-active', 'PUB_alice-owner', 'selectWallet.watchOnlyWallet']));
  expect(texts()).not.toContain('jungle.acct');
  expect(texts().filter((value: string) => value === 'selectWallet.current')).toHaveLength(1);
  expect(saved[0]).toBe(current);
});

test('picking another saved wallet fills the recipient and closes without changing the sender', async () => {
  await render();
  await act(async () => { rows()[0].props.onPress(); });
  expect(onPick).toHaveBeenCalledWith('bob');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(switchWallet).not.toHaveBeenCalled();
  expect(setAccount).not.toHaveBeenCalled();
});

test('saved wallet additions and removals update the displayed list', async () => {
  await render();
  jest.mocked(useWalletSession).mockReturnValue(state({ wallets: [current, wallet('new', 'new.acct')] }));
  await act(async () => { renderer.update(React.createElement(SelectWalletSheet, props)); });
  expect(texts()).toContain('new.acct');
  expect(texts()).not.toContain('bob');
  expect(texts()).not.toContain('watch.acct');
});

test('keeps an unsaved current account and recent recipients available', async () => {
  jest.mocked(useWalletSession).mockReturnValue(state({ account: 'unsaved', currentWallet: undefined }));
  await render();
  expect(texts()).toContain('unsaved');
  expect(texts()).toContain('bob');
  const recentTab = renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
    node.findAllByType('Text').some((text: any) => text.children.includes('selectWallet.recent'))
  );
  await act(async () => { recentTab.props.onPress(); });
  expect(listRecentRecipients).toHaveBeenCalledWith('vaulta');
  expect(texts()).toContain('recent.acct');
  expect(texts()).not.toContain('bob');
});
