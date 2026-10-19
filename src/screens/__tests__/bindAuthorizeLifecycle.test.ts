jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: (s: unknown) => s }, Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: { bindId: 'synthetic-bind' } }),
  useNavigation: () => ({ navigate: jest.fn() }) }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../components/AssetEditSheet', () => 'AssetEditSheet');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/bindAuthorize', () => ({ buildBindAuthorization: jest.fn(), prepareBindAuthorization: jest.fn(), signAndCompleteBindAuthorization: jest.fn() }));
jest.mock('../../chain/signers', () => ({ passwordSigner: jest.fn(), biometricSigner: jest.fn(), passkeySigner: jest.fn() }));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (k: string) => k, useI18n: () => ({ t: (k: string) => k }) }));
import React from 'react';
import { AppState } from 'react-native';
import { useWalletSession } from '../../chain/WalletContext';
import { buildBindAuthorization, prepareBindAuthorization, signAndCompleteBindAuthorization } from '../../chain/bindAuthorize';
import { passwordSigner } from '../../chain/signers';
import { withSystemAuthentication } from '../../crypto/systemAuthentication';
import BindAuthorizeScreen from '../BindAuthorizeScreen';
const { act, create } = require('react-test-renderer');
let renderer: any; let wallet: any; let resume: () => void;
let delivered: jest.Mock; let unlock: jest.Mock;
const asset = { tokenContract: 'core.vaulta', symbol: 'A', precision: 4, perTxLimit: '1.0000 A', dailyLimit: '1.0000 A', totalBudget: '5.0000 A' };
const plan = { intent: { assetLimits: [asset] }, build: { projectName: 'Synthetic app' } };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.resetAllMocks();
  (AppState as any).currentState = 'active';
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  wallet = { account: 'alice', chainId: 'vaulta', node: { url: 'https://rpc.invalid' },
    client: { config: { name: 'Vaulta' } }, currentWallet: { id: 'test-wallet', publicKey: 'test-public' } };
  jest.mocked(useWalletSession).mockImplementation(() => wallet);
  jest.mocked(buildBindAuthorization).mockResolvedValue({ assetLimits: [asset], projectName: 'Synthetic app' } as any);
  jest.mocked(prepareBindAuthorization).mockResolvedValue(plan as any);
  delivered = jest.fn();
  unlock = jest.fn(() => new Promise(resolve => { resume = () => resolve({ kind: 'privatekey', privateKey: 'synthetic-never-signed' }); }));
  jest.mocked(passwordSigner).mockReturnValue(unlock as any);
  // Keep the real domain function's post-unlock and pre-delivery context checks.
  // No wallet, network, cryptographic signing or broadcast is accessed here.
  jest.mocked(signAndCompleteBindAuthorization).mockImplementation(async (opts: any) => {
    if (!opts.isCurrent()) throw new Error('cancelled');
    await opts.getSigner();
    if (!opts.isCurrent()) throw new Error('cancelled');
    delivered(); return { txId: 'synthetic' };
  });
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });
const sheet = () => renderer.root.findByType('ConfirmTxSheet');
async function mountConfirm() {
  await act(async () => { renderer = create(React.createElement(BindAuthorizeScreen)); });
  const button = renderer.root.findAllByType('TouchableOpacity').find((n: any) =>
    n.findAllByType('Text').some((v: any) => v.children.includes('bindAuthorize.confirmButton')));
  await act(async () => { await button.props.onPress(); });
  expect(sheet().props.visible).toBe(true);
}
async function state(value: string) {
  await act(async () => {
    (AppState as any).currentState = value;
    for (const [, cb] of jest.mocked(AppState.addEventListener).mock.calls) (cb as any)(value);
  });
}
test('ordinary background invalidates an already confirmed binding before delayed unlock returns', async () => {
  await mountConfirm(); let task!: Promise<void>;
  await act(async () => { task = sheet().props.onConfirm('synthetic-password'); });
  expect(unlock).toHaveBeenCalledTimes(1);
  await state('background'); await state('active');
  await act(async () => { resume(); await task; });
  expect(delivered).not.toHaveBeenCalled();
});
test('background discards the old confirmation instead of allowing it after foreground', async () => {
  await mountConfirm(); await state('background'); await state('active');
  expect(sheet().props.visible).toBe(false);
});
test('wallet A to B to A never revives the original unlock attempt', async () => {
  await mountConfirm(); let task!: Promise<void>;
  await act(async () => { task = sheet().props.onConfirm('synthetic-password'); });
  await act(async () => { wallet = { ...wallet, account: 'bob' }; renderer.update(React.createElement(BindAuthorizeScreen)); });
  await act(async () => { wallet = { ...wallet, account: 'alice' }; renderer.update(React.createElement(BindAuthorizeScreen)); });
  await act(async () => { resume(); await task; });
  expect(delivered).not.toHaveBeenCalled();
});
test('normal foreground unlock delivers the reviewed binding', async () => {
  await mountConfirm(); let task!: Promise<void>;
  await act(async () => { task = sheet().props.onConfirm('synthetic-password'); });
  await act(async () => { resume(); await task; });
  expect(delivered).toHaveBeenCalledTimes(1);
});
test('system authentication background is not mistaken for ordinary cancellation', async () => {
  await mountConfirm(); let task!: Promise<void>;
  await act(async () => { task = sheet().props.onConfirm('synthetic-password'); });
  await withSystemAuthentication(async () => { await state('background'); await state('active'); });
  await act(async () => { resume(); await task; });
  expect(delivered).toHaveBeenCalledTimes(1);
});

test('an old confirmation callback cannot sign a newly prepared binding after returning from background', async () => {
  await mountConfirm(); const oldConfirm = sheet().props.onConfirm;
  await state('background'); await state('active');
  const button = renderer.root.findAllByType('TouchableOpacity').find((n: any) =>
    n.findAllByType('Text').some((v: any) => v.children.includes('bindAuthorize.confirmButton')));
  await act(async () => { await button.props.onPress(); });
  expect(sheet().props.visible).toBe(true);
  await act(async () => { await oldConfirm('synthetic-password'); });
  expect(unlock).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
});

test.each(['background', 'context'])('late preparation cannot open a confirmation after %s invalidation', async kind => {
  let prepared!: (value: any) => void;
  jest.mocked(prepareBindAuthorization).mockReturnValueOnce(new Promise(done => { prepared = done; }));
  await act(async () => { renderer = create(React.createElement(BindAuthorizeScreen)); });
  const button = renderer.root.findAllByType('TouchableOpacity').find((n: any) =>
    n.findAllByType('Text').some((v: any) => v.children.includes('bindAuthorize.confirmButton')));
  let task!: Promise<void>;
  await act(async () => { task = button.props.onPress(); });
  if (kind === 'background') { await state('background'); await state('active'); }
  else {
    await act(async () => { wallet = { ...wallet, account: 'bob' }; renderer.update(React.createElement(BindAuthorizeScreen)); });
    await act(async () => { wallet = { ...wallet, account: 'alice' }; renderer.update(React.createElement(BindAuthorizeScreen)); });
  }
  await act(async () => { prepared(plan); await task; });
  expect(sheet().props.visible).toBe(false); expect(delivered).not.toHaveBeenCalled();
});

test('a cancelled confirmation cannot unlock through a queued old button callback', async () => {
  await mountConfirm(); const old = sheet().props;
  await act(async () => { old.onClose(); await old.onConfirm('synthetic-password'); });
  expect(unlock).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
});
