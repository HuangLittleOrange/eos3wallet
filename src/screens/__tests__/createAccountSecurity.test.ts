jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', Image: 'Image',
  TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value }, Alert: { alert: jest.fn() }, Share: {}, Linking: {},
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ reset: jest.fn() }), useFocusEffect: () => {} }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Feather: 'Feather' }));
jest.mock('expo-clipboard', () => ({}));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('expo-sharing', () => ({}));
jest.mock('react-native-view-shot', () => ({}));
jest.mock('react-native-qrcode-svg', () => 'QRCode');
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/PasswordDialog', () => 'PasswordDialog');
jest.mock('../../components/AccountNameBoxes', () => 'AccountNameBoxes');
jest.mock('../../components/TokenBadge', () => 'TokenBadge');
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../components/BottomSheet', () => 'BottomSheet');
jest.mock('../../components/CenterDialog', () => 'CenterDialog');
jest.mock('../../components/ResourceRepairSheet', () => ({ useResourceRepair: () => ({ element: null, offer: () => false }) }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn(), useWallet: jest.fn() }));
jest.mock('../../chain/prices', () => ({ priceIn: () => 0 }));
jest.mock('../receiveSave', () => ({}));
jest.mock('../../chain/transact', () => ({ buildTransfer: jest.fn(), transact: jest.fn() }));
jest.mock('../../chain/signers', () => ({ passwordSigner: () => async () => ({ kind: 'privatekey', privateKey: 'synthetic' }) }));
jest.mock('../../chain/signup', () => ({ SIGNUP_AMOUNT: 2, SIGNUP_CONTRACT: 'signupwallet', isSignupTokenSupported: jest.fn() }));
jest.mock('../../chain/pendingSignup', () => ({ loadPendingSignup: jest.fn(), savePendingSignup: jest.fn(), clearPendingSignup: jest.fn() }));
jest.mock('../../crypto/keys', () => ({ generateKey: jest.fn() }));
jest.mock('../../crypto/systemAuthentication', () => ({ shouldInvalidateBackground: () => true }));
jest.mock('../../crypto/vault', () => ({
  verifyMasterPassword: jest.fn(), saveSecret: jest.fn(), addWallet: jest.fn(), removeSecret: jest.fn(), newWalletId: () => 'synthetic-created',
  hasMasterPassword: jest.fn(), savePendingKey: jest.fn(), loadPendingKey: jest.fn(), clearPendingKey: jest.fn(),
}));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: (...args: any[]) => require('../../net/fetchRetry').fetchWithRetry(...args) }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import { Alert, AppState } from 'react-native';
import { APIError, PrivateKey } from '@wharfkit/antelope';
import { useWalletSession, useWallet } from '../../chain/WalletContext';
import { CHAINS } from '../../chain/config';
import { generateKey } from '../../crypto/keys';
import { loadPendingSignup, savePendingSignup, clearPendingSignup, type PendingSignupOrder } from '../../chain/pendingSignup';
import { isSignupTokenSupported } from '../../chain/signup';
import { buildTransfer, transact } from '../../chain/transact';
import { addWallet, saveSecret, removeSecret, verifyMasterPassword, loadPendingKey, clearPendingKey } from '../../crypto/vault';
import { fetchWithRetry } from '../../net/fetchRetry';
import { rpcResponse } from '../../chain/__tests__/rpcResponse';
import CreateAccountPayScreen from '../CreateAccountPayScreen';
import ReceiveScreen from '../ReceiveScreen';

const { create, act } = require('react-test-renderer');
const key = PrivateKey.generate('K1');
const attacker = PrivateKey.generate('K1');
const network = jest.mocked(fetchWithRetry);
let renderer: any;
let wallet: any;
let pending: PendingSignupOrder | null;
let authorityKey: string;
let ownerKey: string;
let weight: number;
let networkGate: Promise<void> | undefined;
const button = (label: string) => renderer.root.findAllByType('TouchableOpacity').find((b: any) =>
  b.findAllByType('Text').some((node: any) => node.children.includes(label)));
const dialog = () => renderer.root.findByType('PasswordDialog');
const hasText = (label: string) => renderer.root.findAllByType('Text').some((node: any) => node.children.includes(label));
const unknownAccount = () => new APIError('/v1/chain/get_account', { status: 500, json: { error: {
  name: 'unknown_key_exception', code: 0, what: 'unspecified', details: [{ file: 'http_plugin.cpp', message: 'unknown key', line_number: 1, method: 'get_account' }],
} } } as any);
async function mount(resume = true) {
  if (!resume) pending = null;
  await act(async () => { renderer = create(React.createElement(CreateAccountPayScreen)); });
  if (resume) await act(async () => {
    jest.mocked(Alert.alert).mock.calls.find(([title]) => title === 'createAccountPay.resumeTitle')![2]!
      .find(b => b.text === 'createAccountPay.resumeConfirm')!.onPress!();
  });
}
async function activate() { await act(async () => { button('createAccountPay.activeAccount').props.onPress(); }); }
async function previewSave() {
  await activate();
  await act(async () => { button('createAccountPay.saveWallet').props.onPress(); });
}
const save = async () => { await act(async () => { await dialog().props.onSubmit('synthetic-password'); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  (AppState as any).currentState = 'active';
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  pending = { id: 'order-1', chainId: 'vaulta', accountName: 'alice', publicKey: String(key.toPublic()),
    legacyPublicKey: key.toPublic().toLegacyString(), memo: 'alice-' + key.toPublic().toLegacyString(),
    amount: 2, symbol: 'A', precision: 4, contract: 'signupwallet', status: 'submitted', createdAt: 1, updatedAt: 1 };
  authorityKey = ownerKey = String(key.toPublic()); weight = 1; networkGate = undefined;
  wallet = { chainId: 'vaulta', account: '', node: { url: 'https://selected-malicious.invalid' }, prices: {},
    client: { config: CHAINS.vaulta, getAccount: jest.fn(async () => ({ permissions: [{ name: 'active', keys: [String(key.toPublic())] }] })) },
    reloadWallets: jest.fn(async () => {}), setAccount: jest.fn((account: string) => { wallet.account = account; }) };
  jest.mocked(useWalletSession).mockImplementation(() => wallet); jest.mocked(useWallet).mockImplementation(() => wallet);
  jest.mocked(generateKey).mockReturnValue({ privateKey: String(key), publicKey: String(key.toPublic()), legacyPublicKey: key.toPublic().toLegacyString(), path: 'random' });
  jest.mocked(loadPendingSignup).mockImplementation(async () => pending);
  jest.mocked(savePendingSignup).mockImplementation(async value => { pending = value; });
  jest.mocked(clearPendingSignup).mockImplementation(async () => { pending = null; });
  jest.mocked(verifyMasterPassword).mockResolvedValue(true); jest.mocked(loadPendingKey).mockResolvedValue(String(key));
  jest.mocked(clearPendingKey).mockResolvedValue(undefined); jest.mocked(removeSecret).mockResolvedValue(undefined);
  jest.mocked(isSignupTokenSupported).mockResolvedValue(true);
  network.mockImplementation(async url => {
    if (networkGate) await networkGate;
    const auth = (publicKey: string) => ({ threshold: 1, keys: [{ key: publicKey, weight }], accounts: [], waits: [] });
    const result = String(url).endsWith('/get_info') ? { chain_id: CHAINS.vaulta.chainIdHash } : {
      account_name: pending?.accountName ?? 'alice', permissions: [
        { perm_name: 'owner', parent: '', required_auth: auth(ownerKey) },
        { perm_name: 'active', parent: 'owner', required_auth: auth(authorityKey) },
      ],
    };
    return rpcResponse(result);
  });
});
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); renderer = null; jest.useRealTimers(); });

test('the original poisoned signup cannot show success, persist, clear recovery keys or switch receive identity', async () => {
  authorityKey = ownerKey = String(attacker.toPublic());
  await mount(); await activate();
  expect(button('createAccountPay.saveWallet')).toBeUndefined();
  expect(hasText('importSecret.accountKeyMismatch')).toBe(true);
  expect(addWallet).not.toHaveBeenCalled(); expect(saveSecret).not.toHaveBeenCalled();
  expect(clearPendingKey).not.toHaveBeenCalled(); expect(clearPendingSignup).not.toHaveBeenCalled();
  expect(wallet.setAccount).not.toHaveBeenCalled(); expect(pending).not.toBeNull();
});
test('valid activation and save independently recheck authority, retain owner/active and produce the correct QR', async () => {
  await mount(); await previewSave(); const before = network.mock.calls.length; await save();
  expect(network.mock.calls.length).toBeGreaterThan(before);
  expect(addWallet).toHaveBeenCalledWith(expect.objectContaining({ account: 'alice', authPermissions: ['active', 'owner'], publicKey: String(key.toPublic()) }), 'synthetic-password');
  expect(clearPendingKey).toHaveBeenCalledWith(String(key.toPublic())); expect(clearPendingSignup).toHaveBeenCalledWith('vaulta');
  expect(wallet.setAccount).toHaveBeenCalledWith('alice');
  await act(async () => { renderer.unmount(); renderer = create(React.createElement(ReceiveScreen)); });
  expect(renderer.root.findAllByType('QRCode').every((qr: any) => qr.props.value === 'alice')).toBe(true);
});
test('final save rejects authority changed after activation, retains recovery data, and allows retry', async () => {
  await mount(); await previewSave(); authorityKey = ownerKey = String(attacker.toPublic()); await save();
  expect(dialog().props.error).toBe('importSecret.accountKeyMismatch');
  expect(saveSecret).not.toHaveBeenCalled(); expect(clearPendingKey).not.toHaveBeenCalled(); expect(pending).not.toBeNull();
  authorityKey = ownerKey = String(key.toPublic()); await save(); expect(addWallet).toHaveBeenCalledTimes(1);
});
test('a failed quorum keeps the save draft and succeeds when retried', async () => {
  await mount(); await previewSave(); const normal = network.getMockImplementation()!;
  network.mockRejectedValue(new Error('offline')); await save();
  expect(dialog().props.error).toBe('importSecret.accountVerificationFailed');
  expect(clearPendingSignup).not.toHaveBeenCalled(); expect(loadPendingKey).not.toHaveBeenCalled();
  network.mockImplementation(normal); await save(); expect(wallet.setAccount).toHaveBeenCalledWith('alice');
});
test('activation keeps polling until the chain and independent authorities are ready', async () => {
  jest.useFakeTimers(); await mount();
  wallet.client.getAccount.mockRejectedValueOnce(unknownAccount()); await activate();
  expect(button('createAccountPay.saveWallet')).toBeUndefined();
  network.mockRejectedValueOnce(new Error('offline'));
  // One failed source is tolerated; the other independent hosts can agree.
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(button('createAccountPay.saveWallet')).toBeDefined();
  expect(addWallet).not.toHaveBeenCalled(); expect(clearPendingKey).not.toHaveBeenCalled();
});
test('wallet-list refresh selecting the first new wallet does not suppress successful completion', async () => {
  await mount(); await previewSave();
  wallet.reloadWallets.mockImplementation(async () => {
    wallet = { ...wallet, account: 'alice', currentWallet: { id: 'synthetic-created', publicKey: String(key.toPublic()) } };
    renderer.update(React.createElement(CreateAccountPayScreen));
    // Allow this legitimate context update to render before reload resolves.
    await Promise.resolve();
  });
  await save(); expect(wallet.setAccount).toHaveBeenCalledWith('alice');
  expect(Alert.alert).toHaveBeenCalledWith('createAccountPay.accountCreatedTitle', expect.anything(), expect.anything());
});
test('active-only signup records only the verified active permission', async () => {
  ownerKey = String(attacker.toPublic()); await mount(); await previewSave(); await save();
  expect(addWallet).toHaveBeenCalledWith(expect.objectContaining({ authPermissions: ['active'] }), 'synthetic-password');
});
test.each(['background', 'network', 'unmount'])('activation cancelled by %s does not show an old success', async reason => {
  await mount(); let resume!: () => void; networkGate = new Promise(resolve => { resume = resolve; });
  await activate(); await invalidate(reason); await act(async () => { resume(); });
  if (reason !== 'unmount') expect(button('createAccountPay.saveWallet')).toBeUndefined();
  expect(addWallet).not.toHaveBeenCalled(); expect(clearPendingKey).not.toHaveBeenCalled();
});
async function invalidate(reason: string) {
  await act(async () => {
    if (reason === 'background') {
      (AppState as any).currentState = 'background';
      for (const [, listener] of jest.mocked(AppState.addEventListener).mock.calls) (listener as any)('background');
    } else if (reason === 'network') {
      wallet = { ...wallet, node: { url: 'https://new.invalid' } }; renderer.update(React.createElement(CreateAccountPayScreen));
    } else { renderer.unmount(); renderer = null; }
  });
}
test.each(['background', 'network', 'unmount'])('save cancelled by %s never persists or clears its pending key', async reason => {
  await mount(); await previewSave(); let resume!: () => void; networkGate = new Promise(resolve => { resume = resolve; });
  let pendingSave!: Promise<void>;
  await act(async () => { pendingSave = dialog().props.onSubmit('synthetic-password'); });
  await invalidate(reason); await act(async () => { resume(); await pendingSave; });
  expect(saveSecret).not.toHaveBeenCalled(); expect(addWallet).not.toHaveBeenCalled();
  expect(clearPendingKey).not.toHaveBeenCalled(); expect(clearPendingSignup).not.toHaveBeenCalled(); expect(wallet.setAccount).not.toHaveBeenCalled();
});
test('cancellation during encryption removes only the new orphan slot and keeps the pending recovery key', async () => {
  await mount(); await previewSave();
  jest.mocked(saveSecret).mockImplementationOnce(async () => { (AppState as any).currentState = 'background'; });
  await save(); expect(removeSecret).toHaveBeenCalledWith('synthetic-created');
  expect(addWallet).not.toHaveBeenCalled(); expect(clearPendingKey).not.toHaveBeenCalled();
});
test('failed wallet persistence retains both pending recovery and the possibly committed encrypted slot', async () => {
  await mount(); await previewSave(); jest.mocked(addWallet).mockRejectedValueOnce(new Error('write failed')); await save();
  expect(dialog().props.error).toBe('write failed'); expect(clearPendingKey).not.toHaveBeenCalled();
  expect(clearPendingSignup).not.toHaveBeenCalled(); expect(removeSecret).not.toHaveBeenCalled();
});
test('wrong password and missing pending key cannot save or clear the order', async () => {
  await mount(); await previewSave(); jest.mocked(verifyMasterPassword).mockResolvedValueOnce(false); await save();
  expect(dialog().props.error).toBe('importSecret.masterPasswordWrong');
  jest.mocked(loadPendingKey).mockResolvedValueOnce(null); await save();
  expect(dialog().props.error).toBe('createAccountPay.pendingKeyMissing');
  expect(saveSecret).not.toHaveBeenCalled(); expect(clearPendingSignup).not.toHaveBeenCalled();
});
test('double submission produces one wallet', async () => {
  await mount(); await previewSave();
  await act(async () => { await Promise.all([dialog().props.onSubmit('synthetic-password'), dialog().props.onSubmit('synthetic-password')]); });
  expect(addWallet).toHaveBeenCalledTimes(1);
});
test('network errors never mark names available; real unknown-account errors and fresh input remain usable', async () => {
  await mount(false);
  await act(async () => { renderer.root.findByType('AccountNameBoxes').props.onChangeText('alice'); });
  wallet.client.getAccount.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await renderer.root.findByType('AccountNameBoxes').props.onBlur(); });
  expect(hasText('createAccountPay.nameCheckFailed')).toBe(true);
  await act(async () => { button('createAccountPay.agreePrefix').props.onPress(); });
  expect(button('createAccountPay.nextStep').props.disabled).toBe(true);
  wallet.client.getAccount.mockRejectedValueOnce(unknownAccount());
  await act(async () => { await renderer.root.findByType('AccountNameBoxes').props.onBlur(); });
  expect(button('createAccountPay.nextStep').props.disabled).toBe(false);
  await act(async () => { renderer.root.findByType('AccountNameBoxes').props.onChangeText('bob'); });
  expect(button('createAccountPay.nextStep').props.disabled).toBe(true);
  wallet.client.getAccount.mockRejectedValueOnce(unknownAccount());
  await act(async () => { await renderer.root.findByType('AccountNameBoxes').props.onBlur(); });
  await act(async () => { await button('createAccountPay.nextStep').props.onPress(); });
  expect(savePendingSignup).toHaveBeenCalledWith(expect.objectContaining({ accountName: 'bob', publicKey: String(key.toPublic()) }));
});
test('internal wallet payment keeps the reviewed creation fee and then activates the verified account', async () => {
  pending!.status = 'draft'; wallet.account = 'payer'; wallet.currentWallet = { id: 'payer-wallet', publicKey: String(key.toPublic()), source: 'privatekey' };
  jest.mocked(buildTransfer).mockReturnValue({ account: 'core.vaulta', name: 'transfer', data: { from: 'payer', to: 'signupwallet', quantity: '2.0000 A', memo: pending!.memo } });
  jest.mocked(transact).mockResolvedValue({ txId: 'test-tx', explorerUrl: 'https://explorer.invalid/test-tx' });
  await mount(); await act(async () => { button('createAccountPay.payAndCreate').props.onPress(); });
  expect(buildTransfer).toHaveBeenCalledWith(expect.objectContaining({ from: 'payer', to: 'signupwallet', amount: 2, memo: pending!.memo }));
  await act(async () => { await renderer.root.findByType('ConfirmTxSheet').props.onConfirm('synthetic-password'); });
  expect(transact).toHaveBeenCalledTimes(1); expect(pending).toMatchObject({ status: 'submitted', txid: 'test-tx' });
  expect(button('createAccountPay.saveWallet')).toBeDefined();
});
