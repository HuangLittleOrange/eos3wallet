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
jest.mock('../../crypto/vault', () => ({ loadPendingDeviceKey: jest.fn(), hasMasterPassword: jest.fn(), updatePendingDeviceKeyLabel: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import { openAuthSessionAsync, WebBrowserResultType } from 'expo-web-browser';
import { useWalletSession } from '../../chain/WalletContext';
import { loadPendingDeviceKey, updatePendingDeviceKeyLabel } from '../../crypto/vault';
import { deviceKeyAuthorizeUrl, findAccountsForDeviceKey, importPendingDeviceKey } from '../../chain/deviceKey';
import DeviceKeyImportScreen from '../DeviceKeyImportScreen';

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
const mount = async () => { await act(async () => { renderer = create(React.createElement(DeviceKeyImportScreen)); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  jest.mocked(loadPendingDeviceKey).mockResolvedValue(pending);
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
});

it('recovers persisted authorization on entry, including cold-start callbacks', async () => {
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
  await mount();
  expect(importPendingDeviceKey).toHaveBeenCalledWith(pending, 'alice', 'vaulta', { url: 'https://node.test' });
  expect(reloadWallets).toHaveBeenCalled();
  expect(setAccount).toHaveBeenCalledWith('alice');
  expect(mockReset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Tabs' }] });
});

it('ignores forged callback accounts and only imports a fresh chain match', async () => {
  await mount();
  jest.mocked(openAuthSessionAsync).mockResolvedValue({
    type: 'success', url: 'eos3wallet://device-key-authorized?account=attacker',
  });
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
  await act(async () => { await button('deviceKey.openWeb').props.onPress(); });
  expect(openAuthSessionAsync).toHaveBeenCalledWith(
    'https://eos3.app/account?deviceKey=public', 'eos3wallet://device-key-authorized');
  expect(importPendingDeviceKey).toHaveBeenCalledWith(pending, 'alice', 'vaulta', expect.anything());
  expect(setAccount).toHaveBeenCalledWith('alice');
});

it('cancelled authorization never creates a wallet and keeps a retryable pending screen', async () => {
  await mount();
  jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: WebBrowserResultType.CANCEL });
  await act(async () => { await button('deviceKey.openWeb').props.onPress(); });
  expect(importPendingDeviceKey).not.toHaveBeenCalled();
  expect(setAccount).not.toHaveBeenCalled();
  expect(button('deviceKey.openWeb').props.disabled).toBe(false);
  expect(button('deviceKey.check')).toBeDefined();
});

it('verification failures do not switch accounts or navigate to a success state', async () => {
  await mount();
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
  jest.mocked(importPendingDeviceKey).mockRejectedValue(new Error('deviceKeyImport.notYet'));
  await act(async () => { await button('deviceKey.check').props.onPress(); });
  expect(hasText('deviceKeyImport.notYet')).toBe(true);
  expect(setAccount).not.toHaveBeenCalled();
  expect(mockReset).not.toHaveBeenCalled();
});

it('testnet never opens the fixed-mainnet authorization website', async () => {
  jest.mocked(loadPendingDeviceKey).mockResolvedValue({ ...pending, chainId: 'jungle4' });
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'jungle4' } as any);
  await mount();
  expect(button('deviceKey.openWeb').props.disabled).toBe(true);
  await act(async () => { await button('deviceKey.openWeb').props.onPress(); });
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
  expect(hasText('deviceKey.webMainnetOnly')).toBe(true);
});

it('unreadable recovery records offer retry, not a new key which could overwrite them', async () => {
  jest.mocked(loadPendingDeviceKey).mockRejectedValueOnce(new Error('storage failed'));
  await mount();
  expect(button('deviceKey.generate')).toBeUndefined();
  expect(hasText('storage failed')).toBe(true);
  await act(async () => { await button('onboarding.retry').props.onPress(); });
  expect(button('deviceKey.openWeb')).toBeDefined();
});

it('the pencil opens a prefilled name editor and blocks authorization until saved or canceled', async () => {
  await mount();
  await act(async () => { iconButton('deviceKey.editName').props.onPress(); });
  expect(renderer.root.findByType('TextInput').props.value).toBe('Phone');
  expect(renderer.root.findByType('TextInput').props.maxLength).toBe(40);
  expect(hasText('deviceKey.nameReuseWarning')).toBe(true);
  expect(button('deviceKey.openWeb').props.disabled).toBe(true);
  expect(button('deviceKey.check').props.disabled).toBe(true);
  await act(async () => { await button('deviceKey.openWeb').props.onPress(); });
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});

it('persists the custom name without changing the key and passes it to website authorization', async () => {
  await mount();
  await act(async () => { iconButton('deviceKey.editName').props.onPress(); });
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('  My iPhone  '); });
  await act(async () => { await iconButton('language.save').props.onPress(); });
  expect(updatePendingDeviceKeyLabel).toHaveBeenCalledWith(pending, '  My iPhone  ');
  expect(hasText('My iPhone')).toBe(true);
  expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
  jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: WebBrowserResultType.CANCEL });
  await act(async () => { await button('deviceKey.openWeb').props.onPress(); });
  expect(deviceKeyAuthorizeUrl).toHaveBeenCalledWith({ ...pending, label: 'My iPhone' }, undefined, 'eos3wallet://device-key-authorized');
});

it('canceling an edit preserves the saved name, and blank names cannot be submitted', async () => {
  await mount();
  await act(async () => { iconButton('deviceKey.editName').props.onPress(); });
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('   '); });
  expect(iconButton('language.save').props.disabled).toBe(true);
  await act(async () => { await iconButton('language.save').props.onPress(); iconButton('send.cancel').props.onPress(); });
  expect(updatePendingDeviceKeyLabel).not.toHaveBeenCalled();
  expect(hasText('Phone')).toBe(true);
  expect(button('deviceKey.openWeb').props.disabled).toBe(false);
});

it('failed persistence keeps the editable draft and does not publish it to the website', async () => {
  jest.mocked(updatePendingDeviceKeyLabel).mockRejectedValueOnce(new Error('storage failed'));
  await mount();
  await act(async () => { iconButton('deviceKey.editName').props.onPress(); });
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('New name'); });
  await act(async () => { await iconButton('language.save').props.onPress(); });
  expect(renderer.root.findByType('TextInput').props.value).toBe('New name');
  expect(hasText('storage failed')).toBe(true);
  expect(button('deviceKey.openWeb').props.disabled).toBe(true);
  await act(async () => { await iconButton('language.save').props.onPress(); });
  expect(hasText('New name')).toBe(true);
  expect(button('deviceKey.openWeb').props.disabled).toBe(false);
});

it('recovers a previously customized name on reopening', async () => {
  jest.mocked(loadPendingDeviceKey).mockResolvedValue({ ...pending, label: 'Custom phone' });
  await mount();
  expect(hasText('Custom phone')).toBe(true);
  await act(async () => { iconButton('deviceKey.editName').props.onPress(); });
  expect(renderer.root.findByType('TextInput').props.value).toBe('Custom phone');
});

it('prevents duplicate saves and editor dismissal while storage is pending', async () => {
  let resolve!: (value: typeof pending) => void;
  jest.mocked(updatePendingDeviceKeyLabel).mockReturnValue(new Promise((done) => { resolve = done; }));
  await mount();
  await act(async () => { iconButton('deviceKey.editName').props.onPress(); });
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('Saved phone'); });
  const press = iconButton('language.save').props.onPress;
  let task!: Promise<void>;
  await act(async () => { task = press(); await press(); iconButton('send.cancel').props.onPress(); });
  expect(updatePendingDeviceKeyLabel).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType('TextInput').props.editable).toBe(false);
  expect(button('deviceKey.openWeb').props.disabled).toBe(true);
  await act(async () => { resolve({ ...pending, label: 'Saved phone' }); await task; });
  expect(hasText('Saved phone')).toBe(true);
});

it('automatically retries indexer propagation after a successful web callback without another tap', async () => {
  jest.useFakeTimers();
  try {
    await mount();
    jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'success', url: 'eos3wallet://device-key-authorized' });
    jest.mocked(findAccountsForDeviceKey).mockResolvedValueOnce([]).mockResolvedValue(['alice']);
    let completion: Promise<void>;
    await act(async () => { completion = button('deviceKey.openWeb').props.onPress(); });
    expect(importPendingDeviceKey).not.toHaveBeenCalled();
    await act(async () => { await jest.advanceTimersByTimeAsync(1500); await completion!; });
    expect(importPendingDeviceKey).toHaveBeenCalledTimes(1);
    expect(setAccount).toHaveBeenCalledWith('alice');
  } finally { jest.useRealTimers(); }
});

it('retries a pending chain authority instead of trusting a successful callback or stale indexer', async () => {
  jest.useFakeTimers();
  try {
    await mount();
    jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'success', url: 'eos3wallet://device-key-authorized' });
    jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
    jest.mocked(importPendingDeviceKey).mockRejectedValueOnce(new Error('deviceKeyImport.notYet')).mockResolvedValue({} as any);
    let completion: Promise<void>;
    await act(async () => { completion = button('deviceKey.openWeb').props.onPress(); });
    expect(setAccount).not.toHaveBeenCalled();
    await act(async () => { await jest.advanceTimersByTimeAsync(1500); await completion!; });
    expect(importPendingDeviceKey).toHaveBeenCalledTimes(2);
    expect(setAccount).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

it('stops automatic checks if the authorization screen is closed', async () => {
  jest.useFakeTimers();
  try {
    await mount();
    jest.mocked(openAuthSessionAsync).mockResolvedValue({ type: 'success', url: 'eos3wallet://device-key-authorized' });
    jest.mocked(findAccountsForDeviceKey).mockResolvedValueOnce([]).mockResolvedValue(['alice']);
    let completion: Promise<void>;
    await act(async () => { completion = button('deviceKey.openWeb').props.onPress(); });
    await act(async () => renderer.unmount()); renderer = null;
    await act(async () => { await jest.advanceTimersByTimeAsync(1500); await completion!; });
    expect(importPendingDeviceKey).not.toHaveBeenCalled();
    expect(setAccount).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('does not import or switch accounts if the network changes while web authorization is open', async () => {
  await mount();
  let finish!: (result: any) => void;
  jest.mocked(openAuthSessionAsync).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  let completion: Promise<void>;
  await act(async () => { completion = button('deviceKey.openWeb').props.onPress(); });
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'jungle4', node: { url: 'https://testnet.test' }, reloadWallets, setAccount } as any);
  await act(async () => renderer.update(React.createElement(DeviceKeyImportScreen)));
  jest.mocked(findAccountsForDeviceKey).mockResolvedValue(['alice']);
  await act(async () => { finish({ type: 'success', url: 'eos3wallet://device-key-authorized' }); await completion!; });
  expect(importPendingDeviceKey).not.toHaveBeenCalled();
  expect(setAccount).not.toHaveBeenCalled();
});


import { connectAnchorWeb } from '../../chain/anchorWeb';
import { prepareAnchorDeviceImport, submitAnchorDeviceImport } from '../../chain/anchorDeviceImport';
import { AnchorImportNetworkError } from '../../chain/anchorImportError';
it('Anchor setup uses the import authorization and chain verification flow with creation copy', async () => {
  const session = { account: 'alice', permission: 'active' } as any;
  const review = { built: { eosAccount: 'alice' }, hex: 'reviewed' } as any;
  jest.mocked(connectAnchorWeb).mockResolvedValue(session);
  jest.mocked(prepareAnchorDeviceImport).mockResolvedValue(review);
  await act(async () => {
    renderer = create(React.createElement(DeviceKeyImportScreen, {
      route: { params: { provider: 'anchor', purpose: 'create' } },
    }));
  });
  expect(renderer.root.findByType('PageHeader').props.title).toBe('createWalletMethod.anchorOneTap');
  expect(hasText('anchorCreate.heroTitle')).toBe(true);
  expect(hasText('anchorCreate.heroDesc')).toBe(true);
  await act(async () => { await button('anchorImport.openWeb').props.onPress(); });
  expect(deviceKeyAuthorizeUrl).not.toHaveBeenCalled();
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
  expect(importPendingDeviceKey).not.toHaveBeenCalled();
  await act(async () => { await button('anchorImport.confirm').props.onPress(); });
  expect(connectAnchorWeb).toHaveBeenCalledTimes(1);
  expect(submitAnchorDeviceImport).toHaveBeenCalledWith(session, review, expect.any(AbortSignal));
  expect(importPendingDeviceKey).toHaveBeenCalledWith(pending, 'alice', 'vaulta', { url: 'https://node.test' }, expect.any(AbortSignal));
  expect(setAccount).toHaveBeenCalledWith('alice');
});

it('Anchor import connects directly, shows an account review, then imports only after chain verification', async () => {
  const session = {account:'alice',permission:'active'} as any;
  const review = {built:{eosAccount:'alice'},hex:'reviewed'} as any;
  jest.mocked(connectAnchorWeb).mockResolvedValue(session);
  jest.mocked(prepareAnchorDeviceImport).mockResolvedValue(review);
  await act(async () => { renderer=create(React.createElement(DeviceKeyImportScreen,{route:{params:{provider:'anchor'}}})); });
  await act(async () => { await button('anchorImport.openWeb').props.onPress(); });
  expect(connectAnchorWeb).toHaveBeenCalled();
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
  expect(deviceKeyAuthorizeUrl).not.toHaveBeenCalled();
  expect(importPendingDeviceKey).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('Text').some((node:any)=>node.children.includes('alice'))).toBe(true);
  await act(async () => { await button('anchorImport.confirm').props.onPress(); });
  expect(submitAnchorDeviceImport).toHaveBeenCalledWith(session,review,expect.any(AbortSignal));
  expect(importPendingDeviceKey).toHaveBeenCalledWith(pending,'alice','vaulta',{url:'https://node.test'},expect.any(AbortSignal));
});
it('Anchor signing errors retain the phone key and never import a wallet', async () => {
  jest.mocked(connectAnchorWeb).mockResolvedValue({account:'alice'} as any);
  jest.mocked(prepareAnchorDeviceImport).mockResolvedValue({hex:'review'} as any);
  jest.mocked(submitAnchorDeviceImport).mockRejectedValue(new Error('rejected'));
  await act(async () => { renderer=create(React.createElement(DeviceKeyImportScreen,{route:{params:{provider:'anchor'}}})); });
  await act(async () => { await button('anchorImport.openWeb').props.onPress(); });
  await act(async () => { await button('anchorImport.confirm').props.onPress(); });
  expect(importPendingDeviceKey).not.toHaveBeenCalled();expect(setAccount).not.toHaveBeenCalled();
  expect(button('anchorImport.openWeb')).toBeDefined();
});

it('keeps the Anchor login after an RPC failure and resumes without another browser login',async()=>{
 const session={account:'alice'} as any;const review={hex:'review'} as any;
 jest.mocked(connectAnchorWeb).mockResolvedValue(session);
 jest.mocked(prepareAnchorDeviceImport).mockRejectedValueOnce(new AnchorImportNetworkError()).mockResolvedValue(review);
 await act(async()=>{renderer=create(React.createElement(DeviceKeyImportScreen,{route:{params:{provider:'anchor'}}}));});
 await act(async()=>{await button('anchorImport.openWeb').props.onPress();});
 expect(hasText('anchorImport.networkFailed')).toBe(true);expect(hasText('alice')).toBe(true);
 expect(importPendingDeviceKey).not.toHaveBeenCalled();expect(setAccount).not.toHaveBeenCalled();
 await act(async()=>{await button('anchorImport.retry').props.onPress();});
 expect(connectAnchorWeb).toHaveBeenCalledTimes(1);expect(prepareAnchorDeviceImport).toHaveBeenCalledTimes(2);
 expect(button('anchorImport.confirm')).toBeDefined();
});

it('verifies the final phone key against the healthy replacement node',async()=>{
 const healthy={url:'https://healthy.test'};
 jest.mocked(connectAnchorWeb).mockResolvedValue({account:'alice'} as any);
 jest.mocked(prepareAnchorDeviceImport).mockImplementation(async(_session,_pending,_node,_chain,options)=>{
  options?.onNodeSwitch?.(healthy);return null;
 });
 await act(async()=>{renderer=create(React.createElement(DeviceKeyImportScreen,{route:{params:{provider:'anchor'}}}));});
 await act(async()=>{await button('anchorImport.openWeb').props.onPress();});
 expect(importPendingDeviceKey).toHaveBeenCalledWith(pending,'alice','vaulta',healthy,expect.any(AbortSignal));
});

it('a lost broadcast response requires a fresh review before signing again',async()=>{
 const review={hex:'review'} as any;
 jest.mocked(connectAnchorWeb).mockResolvedValue({account:'alice'} as any);
 jest.mocked(prepareAnchorDeviceImport).mockResolvedValue(review);
 jest.mocked(submitAnchorDeviceImport).mockRejectedValueOnce(new AnchorImportNetworkError());
 await act(async()=>{renderer=create(React.createElement(DeviceKeyImportScreen,{route:{params:{provider:'anchor'}}}));});
 await act(async()=>{await button('anchorImport.openWeb').props.onPress();});
 await act(async()=>{await button('anchorImport.confirm').props.onPress();});
 expect(submitAnchorDeviceImport).toHaveBeenCalledTimes(1);expect(importPendingDeviceKey).not.toHaveBeenCalled();
 await act(async()=>{await button('anchorImport.retry').props.onPress();});
 expect(prepareAnchorDeviceImport).toHaveBeenCalledTimes(2);expect(connectAnchorWeb).toHaveBeenCalledTimes(1);
 expect(submitAnchorDeviceImport).toHaveBeenCalledTimes(1);
});

it('closing the Anchor import screen aborts preparation and cannot import its late result',async()=>{
 let resolve!:(value:null)=>void;let signal:AbortSignal|undefined;
 jest.mocked(connectAnchorWeb).mockResolvedValue({account:'alice'} as any);
 jest.mocked(prepareAnchorDeviceImport).mockImplementation((_session,_pending,_node,_chain,options)=>{
  signal=options?.signal;return new Promise(done=>{resolve=done;});
 });
 await act(async()=>{renderer=create(React.createElement(DeviceKeyImportScreen,{route:{params:{provider:'anchor'}}}));});
 let completion!:Promise<void>;
 await act(async()=>{completion=button('anchorImport.openWeb').props.onPress();});
 await act(async()=>{renderer.unmount();});renderer=null;
 expect(signal?.aborted).toBe(true);
 await act(async()=>{resolve(null);await completion;});
 expect(importPendingDeviceKey).not.toHaveBeenCalled();expect(setAccount).not.toHaveBeenCalled();
});
