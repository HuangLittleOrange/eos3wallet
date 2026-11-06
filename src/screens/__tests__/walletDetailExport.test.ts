jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
  TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value }, Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({}),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(), getStringAsync: jest.fn() }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/CenterDialog', () => 'CenterDialog');
jest.mock('../../components/useScreenCaptureGuard', () => ({ useScreenCaptureGuard: jest.fn(() => true) }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../crypto/vault', () => ({
  biometricEnabled: jest.fn(async () => false), loadSecret: jest.fn(), loadSecretWithBiometric: jest.fn(), removeWallet: jest.fn(),
}));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import { Alert, AppState } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useWalletSession } from '../../chain/WalletContext';
import { loadSecret } from '../../crypto/vault';
import { useScreenCaptureGuard } from '../../components/useScreenCaptureGuard';
import WalletDetailScreen from '../WalletDetailScreen';

const { act, create } = require('react-test-renderer');
const exportedSecret = 'synthetic-export-secret';
let renderer: any;
let session: any;
let clipboardText: string;
const button = (label: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.props.children === label));
const revealDialog = () => renderer.root.findAllByType('CenterDialog')[1];
const copyConfirmation = () => jest.mocked(Alert.alert).mock.calls.at(-1)![2]![1].onPress!;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.clearAllMocks();
  clipboardText = '';
  AppState.currentState = 'active';
  session = { account: 'alice', currentWallet: { id: 'export-wallet', source: 'privatekey' } };
  jest.mocked(useWalletSession).mockImplementation(() => session);
  jest.mocked(loadSecret).mockResolvedValue(exportedSecret);
  jest.mocked(Clipboard.setStringAsync).mockImplementation(async value => { clipboardText = value; return true; });
  jest.mocked(Clipboard.getStringAsync).mockImplementation(async () => clipboardText);
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); renderer = null; });
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function reveal() {
  await act(async () => { renderer = create(React.createElement(WalletDetailScreen)); });
  await act(async () => { button('walletDetail.exportKey').props.onPress(); });
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('synthetic-password'); });
  await act(async () => { await button('walletDetail.verify').props.onPress(); });
  expect(revealDialog().props.visible).toBe(true);
  expect(useScreenCaptureGuard).toHaveBeenLastCalledWith(true, 'wallet-export');
}

test.each(['watch', 'passkey'])('%s wallets do not expose an unsupported private-key export entry', async source => {
  session.currentWallet = { ...session.currentWallet, source };
  await act(async () => { renderer = create(React.createElement(WalletDetailScreen)); });
  expect(button('walletDetail.exportKey')).toBeUndefined();
  expect(loadSecret).not.toHaveBeenCalled();
});
async function requestCopy() {
  await act(async () => { button('walletDetail.copySecret').props.onPress(); });
  expect(Alert.alert).toHaveBeenLastCalledWith('walletDetail.copySecret', 'walletDetail.clipboardWarning', expect.any(Array));
}
async function changeAppState(state: 'background' | 'active') {
  await act(async () => {
    AppState.currentState = state;
    for (const [, listener] of jest.mocked(AppState.addEventListener).mock.calls) listener(state);
  });
}

test.each(['background', 'close', 'unmount', 'wallet change'])('a completed export survives %s for pasting into another app', async reason => {
  await reveal();
  await requestCopy();
  await act(async () => { await copyConfirmation()(); });
  expect(clipboardText).toBe(exportedSecret);
  if (reason === 'background') await changeAppState('background');
  else if (reason === 'close') await act(async () => { button('walletDetail.copiedAndClose').props.onPress(); });
  else if (reason === 'wallet change') await act(async () => {
    session = { ...session, currentWallet: { id: 'other-wallet', source: 'privatekey' } };
    renderer.update(React.createElement(WalletDetailScreen));
  });
  else await act(async () => { renderer.unmount(); renderer = null; });
  expect(clipboardText).toBe(exportedSecret);
  expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
  expect(Clipboard.getStringAsync).not.toHaveBeenCalled();
  if (renderer) {
    const revealed = reason === 'background';
    expect(revealDialog().props.visible).toBe(revealed);
    expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === exportedSecret)).toBe(revealed);
  }
  if (reason === 'background') {
    await changeAppState('active');
    expect(revealDialog().props.visible).toBe(true);
    expect(useScreenCaptureGuard).toHaveBeenLastCalledWith(true, 'wallet-export');
    expect(clipboardText).toBe(exportedSecret);
  }
});

test('an already revealed key survives repeated app switches without copying and closes on request', async () => {
  await reveal();
  for (let cycle = 0; cycle < 2; cycle++) {
    await changeAppState('background');
    await changeAppState('active');
    expect(revealDialog().props.visible).toBe(true);
    expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === exportedSecret)).toBe(true);
    expect(useScreenCaptureGuard).toHaveBeenLastCalledWith(true, 'wallet-export');
  }
  expect(loadSecret).toHaveBeenCalledTimes(1);
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  await act(async () => { button('walletDetail.copiedAndClose').props.onPress(); });
  expect(revealDialog().props.visible).toBe(false);
  expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === exportedSecret)).toBe(false);
});

test('a copy confirmation cannot write while the app is in the background', async () => {
  await reveal();
  await requestCopy();
  const confirm = copyConfirmation();
  await changeAppState('background');
  await act(async () => { await confirm(); });
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
});

test('switching apps while the native write is unfinished cancels and cleans the late write', async () => {
  await reveal();
  await requestCopy();
  let finish!: () => void;
  jest.mocked(Clipboard.setStringAsync).mockImplementationOnce(value => new Promise(resolve => {
    finish = () => { clipboardText = value; resolve(true); };
  }));
  let pending!: Promise<void>;
  await act(async () => { pending = copyConfirmation()() as unknown as Promise<void>; });
  await changeAppState('background');
  await act(async () => { finish(); await pending; });
  expect(clipboardText).toBe('');
  expect(revealDialog().props.visible).toBe(true);
  await changeAppState('active');
  await requestCopy();
  await act(async () => { await copyConfirmation()(); });
  expect(clipboardText).toBe(exportedSecret);
  expect(revealDialog().props.visible).toBe(true);
});
