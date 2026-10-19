jest.mock('../../passkey/nativePasskey', () => ({ createPasskey: jest.fn(), getPasskey: jest.fn() }));
jest.mock('../../passkey/eos3Api', () => ({ platformPasskeyRegisterOptions: jest.fn(), platformPasskeyAuthOptions: jest.fn() }));
jest.mock('../../chain/anchorWeb', () => ({ connectAnchorWeb: jest.fn(), AnchorWebCancelled: class AnchorWebCancelled extends Error {} }));
jest.mock('../../chain/anchorDeviceImport', () => ({ prepareAnchorDeviceImport: jest.fn(), submitAnchorDeviceImport: jest.fn() }));
jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (value: unknown) => value },
  Alert: { alert: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ reset: mockReset }), useFocusEffect: () => {},
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), WebBrowserResultType: { CANCEL: 'cancel' } }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/PasswordDialog', () => 'PasswordDialog');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/deviceKey', () => ({
  assertPendingDeviceChain: (pending: any, chainId: string) => {
    if (pending.chainId && pending.chainId !== chainId) throw new Error('deviceKey.chainMismatch');
  },
  DEVICE_KEY_AUTH_RETURN_URL: 'eos3wallet://device-key-authorized',
  deviceKeyAuthorizeUrl: jest.fn(),
  createPendingDeviceKey: jest.fn(), discardPendingDeviceKey: jest.fn(),
  findAccountsForDeviceKey: jest.fn(), importPendingDeviceKey: jest.fn(),
}));
jest.mock('../../crypto/vault', () => ({ loadPendingDeviceKey: jest.fn(), listRecoverableDeviceKeys: jest.fn(async () => []), restoreRecoverableDeviceKey: jest.fn(), hasMasterPassword: jest.fn(), updatePendingDeviceKeyLabel: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import { openAuthSessionAsync, WebBrowserResultType } from 'expo-web-browser';
import { useWalletSession } from '../../chain/WalletContext';
import { loadPendingDeviceKey, listRecoverableDeviceKeys, updatePendingDeviceKeyLabel } from '../../crypto/vault';
import { deviceKeyAuthorizeUrl, findAccountsForDeviceKey, importPendingDeviceKey } from '../../chain/deviceKey';
import PasskeyCreateScreen from '../PasskeyCreateScreen';
import { createPendingDeviceKey } from '../../chain/deviceKey';
import { createPasskey, getPasskey } from '../../passkey/nativePasskey';
import { platformPasskeyRegisterOptions, platformPasskeyAuthOptions } from '../../passkey/eos3Api';

const { create, act } = require('react-test-renderer');
const mockReset = jest.fn();
const reloadWallets = jest.fn();
const setAccount = jest.fn();
const pending = { id: 'pending', publicKey: 'public', legacyPublicKey: 'legacy',
  label: 'Phone', createdAt: 1, chainId: 'vaulta' as const };
let renderer: any;
const button = (key: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.children.includes(key)));
const hasText = (key: string) => renderer.root.findAllByType('Text')
  .some((node: any) => node.children.includes(key));
const iconButton = (label: string) => renderer.root.findAllByType('TouchableOpacity')
  .find((node: any) => node.props.accessibilityLabel === label);
const mount = async () => { await act(async () => { renderer = create(React.createElement(PasskeyCreateScreen)); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  jest.mocked(loadPendingDeviceKey).mockResolvedValue(pending);
  jest.mocked(listRecoverableDeviceKeys).mockResolvedValue([]);
  jest.mocked(createPendingDeviceKey).mockResolvedValue(pending);
  jest.mocked(deviceKeyAuthorizeUrl).mockReturnValue('https://eos3.app/account?deviceKey=public');
  jest.mocked(updatePendingDeviceKeyLabel).mockImplementation(async (value, name) => ({ ...value, label: name.trim() }));
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue([]);
  jest.mocked(useWalletSession).mockReturnValue({
    chainId: 'vaulta', node: { url: 'https://node.test' }, reloadWallets, setAccount,
  } as any);
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  renderer = null;
  expect(createPasskey).not.toHaveBeenCalled();
  expect(getPasskey).not.toHaveBeenCalled();
  expect(platformPasskeyRegisterOptions).not.toHaveBeenCalled();
  expect(platformPasskeyAuthOptions).not.toHaveBeenCalled();
});


it('new users generate an encrypted pending device key before opening website setup', async () => {
  jest.mocked(loadPendingDeviceKey).mockResolvedValue(null);
  await mount();
  expect(hasText('passkeyCreate.heroTitle')).toBe(true);
  expect(hasText('passkeyCreate.heroDesc')).toBe(true);
  expect(hasText('passkeyCreate.noteText')).toBe(true);
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
  await act(async () => { button('deviceKey.generate').props.onPress(); });
  await act(async () => { await renderer.root.findByType('PasswordDialog').props.onSubmit('wallet-password'); });
  expect(createPendingDeviceKey).toHaveBeenCalledWith('wallet-password', 'vaulta');
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
  jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'cancel' } as any);
  await act(async () => { await button('passkeyCreate.submit').props.onPress(); });
  expect(deviceKeyAuthorizeUrl).toHaveBeenCalledWith(pending, undefined, 'eos3wallet://device-key-authorized');
  expect(openAuthSessionAsync).toHaveBeenCalledWith('https://eos3.app/account?deviceKey=public', 'eos3wallet://device-key-authorized');
});

it('existing accounts return through device authorization and require a chain match', async () => {
  await mount();
  jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'success', url: 'eos3wallet://device-key-authorized?account=forged' });
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
  await act(async () => { await button('passkeyCreate.submit').props.onPress(); });
  expect(importPendingDeviceKey).toHaveBeenCalledWith(pending, 'alice', 'vaulta', expect.anything());
  expect(setAccount).toHaveBeenCalledWith('alice');
  expect(mockReset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Tabs' }] });
});

it('canceling the website keeps the same key available for retry without importing', async () => {
  await mount();
  jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'cancel' } as any);
  await act(async () => { await button('passkeyCreate.submit').props.onPress(); });
  expect(importPendingDeviceKey).not.toHaveBeenCalled();
  expect(button('passkeyCreate.submit').props.disabled).toBe(false);
  expect(createPendingDeviceKey).not.toHaveBeenCalled();
});

it('never imports on failed chain authorization verification', async () => {
  await mount();
  jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'success', url: 'eos3wallet://device-key-authorized' });
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
  jest.mocked(importPendingDeviceKey).mockRejectedValue(new Error('verification failed'));
  await act(async () => { await button('passkeyCreate.submit').props.onPress(); });
  expect(setAccount).not.toHaveBeenCalled();
  expect(mockReset).not.toHaveBeenCalled();
  expect(hasText('verification failed')).toBe(true);
});

it('does not send testnet device keys to the mainnet website', async () => {
  jest.mocked(loadPendingDeviceKey).mockResolvedValue({ ...pending, chainId: 'jungle4' });
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'jungle4' } as any);
  await mount();
  expect(button('passkeyCreate.submit').props.disabled).toBe(true);
  await act(async () => { await button('passkeyCreate.submit').props.onPress(); });
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});
