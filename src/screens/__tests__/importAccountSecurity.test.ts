jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value }, Alert: { alert: jest.fn() }, Share: {},
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({}), useRoute: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Feather: 'Feather' }));
jest.mock('react-native-qrcode-svg', () => 'QRCode');
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('expo-clipboard', () => ({}));
jest.mock('expo-sharing', () => ({}));
jest.mock('react-native-view-shot', () => ({}));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/PasswordDialog', () => 'PasswordDialog');
jest.mock('../../components/BottomSheet', () => 'BottomSheet');
jest.mock('../../components/CenterDialog', () => 'CenterDialog');
jest.mock('../../components/useScreenCaptureGuard', () => ({ useScreenCaptureGuard: () => true }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn(), useWallet: jest.fn() }));
jest.mock('../../chain/prices', () => ({ priceIn: () => 0 }));
jest.mock('../receiveSave', () => ({}));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../crypto/vault', () => ({
  verifyMasterPassword: jest.fn(), saveSecret: jest.fn(), addWallet: jest.fn(), removeSecret: jest.fn(), newWalletId: () => 'synthetic-import',
}));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: (...args: any[]) => require('../../net/fetchRetry').fetchWithRetry(...args) }));

import React from 'react';
import { Alert, AppState } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { PrivateKey } from '@wharfkit/antelope';
import { useWallet, useWalletSession } from '../../chain/WalletContext';
import { CHAINS } from '../../chain/config';
import { deriveFromMnemonic } from '../../crypto/keys';
import { addWallet, saveSecret, removeSecret, verifyMasterPassword } from '../../crypto/vault';
import { fetchWithRetry } from '../../net/fetchRetry';
import { rpcResponse } from '../../chain/__tests__/rpcResponse';
import ImportSecretScreen from '../ImportSecretScreen';
import ReceiveScreen from '../ReceiveScreen';

const { create, act } = require('react-test-renderer');
let renderer: any;
let wallet: any;
let candidate: string;
let authorizedKey: string;
let readGate: Promise<void> | undefined;
let offline: boolean;
const key = PrivateKey.generate('K1');
const attackerKey = PrivateKey.generate('K1');
const network = jest.mocked(fetchWithRetry);
const button = (label: string) => renderer.root.findAllByType('TouchableOpacity').find((b: any) =>
  b.findAllByType('Text').some((text: any) => text.props.children === label));
const dialog = () => renderer.root.findByType('PasswordDialog');
async function preview(input = String(key)) {
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText(input); });
  await act(async () => { await button('importSecret.parseAndSearch').props.onPress(); });
  await act(async () => { button('importSecret.importByPerms').props.onPress(); });
}
const save = async () => { await act(async () => { await dialog().props.onSubmit('synthetic-test-password'); }); };

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  candidate = 'alice'; authorizedKey = String(key.toPublic()); offline = false; readGate = undefined;
  (AppState as any).currentState = 'active';
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  jest.mocked(useRoute).mockReturnValue({ params: { mode: 'privatekey' } } as any);
  wallet = { chainId: 'vaulta', account: '', node: { url: 'https://selected-malicious.invalid' },
    historyNode: { url: 'https://history.invalid' }, client: { config: CHAINS.vaulta }, prices: {},
    reloadWallets: jest.fn(async () => {}), setAccount: jest.fn((account: string) => { wallet.account = account; }) };
  jest.mocked(useWalletSession).mockImplementation(() => wallet);
  jest.mocked(useWallet).mockImplementation(() => wallet);
  jest.mocked(verifyMasterPassword).mockResolvedValue(true);
  network.mockImplementation(async url => {
    const endpoint = String(url);
    if (endpoint.endsWith('/get_accounts_by_authorizers')) return { ok: true, json: async () => ({
      accounts: [{ account_name: candidate, permission_name: 'active' }],
    }) } as any;
    if (readGate) await readGate;
    if (offline) throw new Error('offline');
    const auth = { threshold: 1, keys: [{ key: authorizedKey, weight: 1 }], accounts: [], waits: [] };
    const result = endpoint.endsWith('/get_info') ? { chain_id: CHAINS[wallet.chainId as 'vaulta'].chainIdHash }
      : { account_name: candidate, permissions: [
        { perm_name: 'owner', parent: '', required_auth: auth },
        { perm_name: 'active', parent: 'owner', required_auth: auth },
      ] };
    return rpcResponse(result);
  });
  await act(async () => { renderer = create(React.createElement(ImportSecretScreen)); });
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); });

test('the original malicious discovery proof cannot save a wallet or poison the receive address', async () => {
  candidate = 'attacker'; authorizedKey = String(attackerKey.toPublic());
  await preview(); await save();
  expect(dialog().props.error).toBe('importSecret.accountKeyMismatch');
  expect(saveSecret).not.toHaveBeenCalled(); expect(addWallet).not.toHaveBeenCalled();
  expect(wallet.setAccount).not.toHaveBeenCalled(); expect(Alert.alert).not.toHaveBeenCalled();
  expect(network.mock.calls.some(([url]) => String(url).includes('selected-malicious.invalid') && String(url).endsWith('/get_account'))).toBe(false);
});
test.each(['privatekey', 'mnemonic'])('valid %s import still saves the reviewed identity and generates its receive QR', async mode => {
  jest.mocked(useRoute).mockReturnValue({ params: { mode } } as any);
  await act(async () => { renderer.update(React.createElement(ImportSecretScreen)); });
  const input = mode === 'privatekey' ? String(key) : 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  if (mode === 'mnemonic') authorizedKey = deriveFromMnemonic(input).publicKey;
  await preview(input); await save();
  expect(addWallet).toHaveBeenCalledWith(expect.objectContaining({ account: 'alice', publicKey: authorizedKey, chainId: 'vaulta', authPermissions: ['active'] }), 'synthetic-test-password');
  expect(wallet.setAccount).toHaveBeenCalledWith('alice');
  expect(Alert.alert).toHaveBeenCalledWith('importSecret.importSuccessTitle', expect.anything(), expect.anything());
  await act(async () => { renderer.unmount(); renderer = create(React.createElement(ReceiveScreen)); });
  const codes = renderer.root.findAllByType('QRCode');
  expect(codes.length).toBeGreaterThan(0);
  expect(codes.every((qr: any) => qr.props.value === 'alice')).toBe(true);
});
test('a failed independent read retains the input and dialog for a successful retry', async () => {
  await preview(); offline = true; await save();
  expect(dialog().props.error).toBe('importSecret.accountVerificationFailed');
  expect(renderer.root.findByType('TextInput').props.value).toBe(String(key));
  expect(saveSecret).not.toHaveBeenCalled();
  offline = false; await save(); expect(addWallet).toHaveBeenCalledTimes(1);
});
test('legacy-key and Hyperion discovery fallback still works with independently verified permissions', async () => {
  const normal = network.getMockImplementation()!;
  network.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/get_accounts_by_authorizers')) return { ok: true, json: async () => ({ accounts: [] }) } as any;
    if (String(args[0]).includes('/v2/state/get_key_accounts')) return { ok: true, json: async () => ({ account_names: ['alice'] }) } as any;
    return normal(...args);
  });
  await preview(); await save();
  expect(addWallet).toHaveBeenCalledWith(expect.objectContaining({ account: 'alice', authPermissions: ['active'] }), 'synthetic-test-password');
});
test.each(['background', 'network', 'unmount'])('an import invalidated by %s while verification is pending never persists or switches accounts', async reason => {
  await preview(); let resume!: () => void;
  readGate = new Promise(resolve => { resume = resolve; });
  let pending!: Promise<void>;
  await act(async () => { pending = dialog().props.onSubmit('synthetic-test-password'); });
  if (reason === 'background') await act(async () => {
    (AppState as any).currentState = 'background';
    for (const [, listener] of jest.mocked(AppState.addEventListener).mock.calls) (listener as any)('background');
  });
  else if (reason === 'network') await act(async () => {
    wallet = { ...wallet, node: { url: 'https://changed.invalid' } };
    renderer.update(React.createElement(ImportSecretScreen));
  });
  else await act(async () => { renderer.unmount(); });
  await act(async () => { resume(); await pending; });
  expect(saveSecret).not.toHaveBeenCalled(); expect(addWallet).not.toHaveBeenCalled();
  expect(wallet.setAccount).not.toHaveBeenCalled();
});
test('a context cancelled during encryption removes its newly created orphan secret', async () => {
  await preview();
  jest.mocked(saveSecret).mockImplementationOnce(async () => {
    (AppState as any).currentState = 'background';
  });
  await save();
  expect(removeSecret).toHaveBeenCalledWith('synthetic-import');
  expect(addWallet).not.toHaveBeenCalled();
});


test('a rejected re-import keeps the input and never reports success', async () => {
  await preview();
  jest.mocked(addWallet).mockRejectedValueOnce(new Error('repair failed'));
  await save();
  expect(dialog().props.error).toBe('repair failed');
  expect(renderer.root.findByType('TextInput').props.value).toBe(String(key));
  expect(wallet.setAccount).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(removeSecret).not.toHaveBeenCalled();
});
