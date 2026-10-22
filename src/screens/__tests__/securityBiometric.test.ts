jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  View: 'View', Text: 'Text', Switch: 'Switch', TouchableOpacity: 'TouchableOpacity',
  Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (value: unknown) => value },
  Alert: { alert: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn(),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/CenterDialog', () => 'CenterDialog');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../crypto/vault', () => ({
  biometricAvailable: jest.fn(), biometricEnabled: jest.fn(), hasMasterPassword: jest.fn(),
  enableBiometric: jest.fn(), disableBiometric: jest.fn(),
  WrongPasswordError: class WrongPasswordError extends Error {},
}));
jest.mock('../../i18n', () => {
  const t = (key: string) => key;
  return { t, useI18n: () => ({ t }) };
});

import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { useWalletSession } from '../../chain/WalletContext';
import { biometricAvailable, biometricEnabled, hasMasterPassword, enableBiometric, disableBiometric } from '../../crypto/vault';
import SecurityScreen from '../SecurityScreen';

const { create, act } = require('react-test-renderer');
const navigate = jest.fn();
let renderer: any;
const mount = async () => { await act(async () => { renderer = create(React.createElement(SecurityScreen)); }); };
const hasText = (key: string) => renderer.root.findAllByType('Text')
  .some((node: any) => node.children.includes(key));
const button = (key: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.children.includes(key)));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  jest.mocked(useNavigation).mockReturnValue({ navigate } as any);
  jest.mocked(biometricAvailable).mockResolvedValue({ ok: true });
  jest.mocked(biometricEnabled).mockResolvedValue(false);
  jest.mocked(hasMasterPassword).mockResolvedValue(true);
  jest.mocked(useWalletSession).mockReturnValue({ account: '', wallets: [] } as any);
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  renderer = null;
});

it.each(['watch', 'passkey', undefined])('can manage the shared switch from %s accounts', async (source) => {
  jest.mocked(useWalletSession).mockReturnValue({
    currentWallet: source ? { id: 'wallet', source } : undefined, account: '', wallets: [],
  } as any);
  await mount();
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.disabled).toBe(false);
  expect(hasText('security.biometricShared')).toBe(true);
  expect(biometricEnabled).toHaveBeenCalledWith();
});

it('enabling verifies only the master password, never an account id', async () => {
  await mount();
  await act(async () => { await renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.onValueChange(true); });
  expect(renderer.root.findByType('TextInput').props).toEqual(expect.objectContaining({
    textContentType: 'oneTimeCode', autoComplete: 'off', importantForAutofill: 'no',
  }));
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('shared-password'); });
  await act(async () => { await button('security.enableAction').props.onPress(); });
  expect(enableBiometric).toHaveBeenCalledWith('shared-password');
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.value).toBe(true);
  expect(renderer.root.findByType('TextInput').props.value).toBe('');
});

it('switching accounts keeps the device-wide enabled state', async () => {
  jest.mocked(biometricEnabled).mockResolvedValue(true);
  await mount();
  jest.mocked(useWalletSession).mockReturnValue({
    currentWallet: { id: 'other-wallet', source: 'watch' }, account: 'bob', wallets: [],
  } as any);
  await act(async () => { renderer.update(React.createElement(SecurityScreen)); });
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.value).toBe(true);
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.disabled).toBe(false);
});

it('disabling works even when fingerprints are no longer enrolled', async () => {
  jest.mocked(biometricEnabled).mockResolvedValue(true);
  jest.mocked(biometricAvailable).mockResolvedValue({ ok: false, reason: 'not-enrolled' });
  await mount();
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.disabled).toBe(false);
  await act(async () => { await renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.onValueChange(false); });
  expect(disableBiometric).toHaveBeenCalledWith();
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.value).toBe(false);
});

it('no master password or no enrollment prevents enabling without tying it to an account', async () => {
  jest.mocked(hasMasterPassword).mockResolvedValue(false);
  await mount();
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.disabled).toBe(true);
  expect(hasText('security.masterPasswordRequired')).toBe(true);
});

it('storage read failures are retryable and never look like a read-only-account restriction', async () => {
  jest.mocked(hasMasterPassword).mockRejectedValueOnce(new Error('read failed'));
  await mount();
  expect(hasText('read failed')).toBe(true);
  await act(async () => { await button('onboarding.retry').props.onPress(); });
  expect(renderer.root.findByProps({testID:'biometric-unlock-toggle'}).props.disabled).toBe(false);
});

it('offers change password and keeps removed backup and analytics entries absent', async () => {
  await mount();
  expect(hasText('security.changePassword')).toBe(true);
  expect(hasText('security.walletPassword')).toBe(false);
  expect(hasText('security.mnemonicOrKeyBackup')).toBe(false);
  expect(hasText('analytics.title')).toBe(false);
  expect(renderer.root.findAllByProps({ testID: 'usage-analytics-toggle' })).toHaveLength(0);
  await act(async () => { button('security.changePassword').props.onPress(); });
  expect(navigate).toHaveBeenCalledWith('ChangePassword');
});
