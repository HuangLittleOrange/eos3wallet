jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
  TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value }, Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn(),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(), getStringAsync: jest.fn() }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/CenterDialog', () => 'CenterDialog');
jest.mock('../../components/useScreenCaptureGuard', () => ({ useScreenCaptureGuard: () => true }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../crypto/vault', () => ({
  biometricEnabled: jest.fn(async () => false), loadSecret: jest.fn(), loadSecretWithBiometric: jest.fn(), removeWallet: jest.fn(),
}));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import { Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useWalletSession } from '../../chain/WalletContext';
import { removeWallet } from '../../crypto/vault';
import WalletDetailScreen from '../WalletDetailScreen';

const { act, create } = require('react-test-renderer');
let renderer: any;
let session: any;
const reset = jest.fn();
const button = (label: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.props.children === label));
const confirm = () => jest.mocked(Alert.alert).mock.calls.at(-1)![2]!.find(item => item.style === 'destructive')!.onPress!();

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  session = { account: 'watchacct', currentWallet: undefined, setAccount: jest.fn(), reloadWallets: jest.fn() };
  jest.mocked(useWalletSession).mockImplementation(() => session);
  jest.mocked(useNavigation).mockReturnValue({ reset } as any);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });
async function mount() { await act(async () => { renderer = create(React.createElement(WalletDetailScreen)); }); }

test('details exposes removal for an imported watch account and requires confirmation', async () => {
  await mount();
  expect(button('walletDetail.removeWatchWallet')).toBeDefined();
  await act(async () => button('walletDetail.removeWatchWallet').props.onPress());
  expect(Alert.alert).toHaveBeenCalledWith('walletDetail.removeWatchWallet', 'walletDetail.removeWatchWalletBody', expect.any(Array));
  expect(session.setAccount).not.toHaveBeenCalled(); expect(removeWallet).not.toHaveBeenCalled();
  await act(async () => { await confirm(); });
  expect(session.setAccount).toHaveBeenCalledWith('');
  expect(removeWallet).not.toHaveBeenCalled(); expect(session.reloadWallets).not.toHaveBeenCalled();
  expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Tabs' }] });
});

test.each(['watch', 'privatekey'])('removing a saved %s wallet targets only its stored id', async source => {
  session.currentWallet = { id: 'target-wallet', source, account: session.account };
  await mount();
  await act(async () => button(source === 'watch' ? 'walletDetail.removeWatchWallet' : 'walletDetail.deleteWallet').props.onPress());
  await act(async () => { await confirm(); });
  expect(removeWallet).toHaveBeenCalledWith('target-wallet');
  expect(session.reloadWallets).toHaveBeenCalledTimes(1);
  expect(session.setAccount).not.toHaveBeenCalled();
});

test('an empty account has no removal action', async () => {
  session.account = '';
  await mount();
  expect(button('walletDetail.removeWatchWallet')).toBeUndefined();
  expect(button('walletDetail.deleteWallet')).toBeUndefined();
});
