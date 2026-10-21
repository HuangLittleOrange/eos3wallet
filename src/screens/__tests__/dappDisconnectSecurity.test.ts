jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', Image: 'Image', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value }, Alert: { alert: jest.fn() }, Share: {}, Linking: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Platform: { OS: 'android', Version: 36 }, Keyboard: { addListener: () => ({ remove() {} }) },
}));
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('expo-clipboard', () => ({}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'synthetic-token' }));
jest.mock('react-native-view-shot', () => ({}));
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../components/DappMoreSheet', () => 'DappMoreSheet');
jest.mock('../../components/WalletListSheet', () => 'WalletListSheet');
jest.mock('../../components/ResourceRepairSheet', () => ({ useResourceRepair: () => ({ element: null, prepare() {}, offer: () => false }) }));
jest.mock('../../components/ModalHost', () => ({ addBackHandler: () => ({ remove() {} }) }));
jest.mock('../../chain/WalletContext', () => ({ useWallet: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ signingPermission: () => 'active' }));
jest.mock('../../chain/signers', () => ({ passwordSigner: jest.fn(), biometricSigner: jest.fn(), passkeySigner: jest.fn() }));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../../chain/sponsor', () => ({}));
jest.mock('../../chain/sponsorFeeCache', () => ({}));
jest.mock('../../chain/walletDataEvents', () => ({}));
jest.mock('../../chain/signingAbi', () => ({ getSigningAbi: jest.fn() }));
jest.mock('../../chain/coldSigning', () => ({ requestColdSignature: jest.fn() }));
jest.mock('../../chain/transact', () => {
  const actual = jest.requireActual('../../chain/transact');
  return { ...actual, signDigest: jest.fn(actual.signDigest), transact: jest.fn() };
});
jest.mock('../../net/fetchRetry', () => ({ fetchWithTimeout: jest.fn() }));
jest.mock('../../dapp/injected', () => ({ buildInjectedScript: () => '' }));
jest.mock('../../dapp/esr-flow-overlay', () => 'EsrFlowOverlay');
jest.mock('../../dapp/use-browser-esr', () => ({ useBrowserEsr: () => ({ flow: {}, handleBridgeRequest: () => false, interceptUrl: () => false, invalidate() {} }) }));
jest.mock('../../dapp/use-token-pocket-browser', () => ({ useTokenPocketBrowser: () => ({ handleRequest: () => false, cancelScan: jest.fn() }) }));
jest.mock('../../dapp/dappGate', () => ({ addDappHistory: async () => {}, listDappHistory: async () => [], isDappFavorite: async () => false }));
jest.mock('../../dapp/DappSessionContext', () => ({ useDappSession: () => ({ session: { url: 'https://dapp.invalid/' }, close: async () => {}, minimize: async () => {} }) }));
jest.mock('../../crypto/systemAuthentication', () => ({ shouldInvalidateBackground: () => true }));
jest.mock('../../navigation/navigationRef', () => ({ navigationRef: { isReady: () => false } }));
jest.mock('../../update/appUpdate', () => ({ currentAppVersion: () => '1.0.9' }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key, locale: 'en' }), BCP47: { en: 'en-US' } }));

import React from 'react';
import { Alert } from 'react-native';
import { ABI, Action, Transaction, Serializer, PrivateKey, Signature, Checksum256 } from '@wharfkit/antelope';
import { CHAINS } from '../../chain/config';
import { coreActionAbi } from '../../chain/coreTokenAbi';
import { useWallet } from '../../chain/WalletContext';
import { getSigningAbi } from '../../chain/signingAbi';
import { requestColdSignature } from '../../chain/coldSigning';
import { signDigest, transact } from '../../chain/transact';
import { passwordSigner, biometricSigner, passkeySigner } from '../../chain/signers';
import { fetchWithTimeout } from '../../net/fetchRetry';
import DappBrowserScreen from '../DappBrowserScreen';

const { create, act } = require('react-test-renderer');
const key = PrivateKey.generate('K1');
const text = 'Approve login session for security regression';
let renderer: any;
let injected: string[];
let wallet: any;
let unlockGate: Promise<void> | undefined;
let preflightGate: Promise<void> | undefined;
let preflightStarted: boolean;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; };
const sheet = () => renderer.root.findByType('ConfirmTxSheet');
async function send(id: string, method: string, params?: any) {
  await act(async () => { renderer.root.findByType('WebView').props.onMessage({ nativeEvent: {
    url: 'https://dapp.invalid/', data: JSON.stringify({ id: 'doc:' + id, documentId: 'doc', bridgeToken: 'synthetic-token', method, params }),
  } }); });
}
const response = (id: string, ok = true) => injected.filter(js => js.startsWith(`window.__auroraResolve("doc:${id}", ${ok}, `));
const payload = (js: string) => JSON.parse(js.slice(js.indexOf(', true, ') + 8, js.lastIndexOf('); true;')));
const connectionButtons = () => jest.mocked(Alert.alert).mock.calls.filter(([title]) => title === 'dappBrowser.connectTitle').at(-1)![2]!;
async function connect(id = 'connect') {
  await send(id, 'getIdentity');
  await act(async () => { connectionButtons().find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
}
const makeTransaction = () => Transaction.from({ expiration: new Date(Date.now() + 120000).toISOString().split('.')[0],
  ref_block_num: 1, ref_block_prefix: 2, actions: [Action.from({ account: 'core.vaulta', name: 'transfer',
    authorization: [{ actor: 'alice', permission: 'active' }], data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' } }, coreActionAbi('core.vaulta', 'transfer')!)] });
const sendTransaction = (id: string, tx: Transaction) => send(id, 'signTransaction', {
  chainId: CHAINS.vaulta.chainIdHash, serializedTransaction: Serializer.encode({ object: tx }).hexString,
});
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  injected = []; unlockGate = preflightGate = undefined; preflightStarted = false;
  wallet = { chainId: 'vaulta', account: 'alice', hasAccount: true, node: { url: 'https://rpc.invalid' },
    currentWallet: { id: 'synthetic', account: 'alice', publicKey: String(key.toPublic()), source: 'privatekey' }, client: { config: CHAINS.vaulta } };
  jest.mocked(useWallet).mockImplementation(() => wallet);
  for (const getter of [passwordSigner, biometricSigner, passkeySigner]) jest.mocked(getter).mockReturnValue(async () => {
    if (unlockGate) await unlockGate;
    return { kind: 'privatekey', privateKey: String(key) };
  });
  jest.mocked(getSigningAbi).mockImplementation(async () => coreActionAbi('core.vaulta', 'transfer')!);
  jest.mocked(fetchWithTimeout).mockImplementation(async () => ({ ok: true, json: async () => {
    preflightStarted = true; if (preflightGate) await preflightGate; return {};
  } }) as any);
  await act(async () => { renderer = create(React.createElement(DappBrowserScreen), { createNodeMock: (element: any) => element.type === 'WebView'
    ? { reload() {}, injectJavaScript: (js: string) => injected.push(js) } : null }); });
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); });

test('normal approved messages and serialized transfers still return valid signatures', async () => {
  await connect(); await send('message', 'arbitrarySignature', { data: text });
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(Signature.from(payload(response('message')[0]).signature).verifyDigest(Checksum256.hash(new TextEncoder().encode(text)), key.toPublic())).toBe(true);
  const tx = makeTransaction(); await sendTransaction('transaction', tx);
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(Signature.from(payload(response('transaction')[0]).signatures[0]).verifyDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
});
test('an observation account reviews a transaction before requesting a keyless external signature', async () => {
  wallet.currentWallet = undefined;
  await act(async () => { renderer.update(React.createElement(DappBrowserScreen)); });
  jest.mocked(passwordSigner).mockReturnValue(async () => ({ kind: 'external', chainSlug: 'vaulta', account: 'alice' }));
  jest.mocked(requestColdSignature).mockImplementation(async opts => key.signDigest(opts.transaction.signingDigest(opts.chainId)));
  await connect(); const tx = makeTransaction(); await sendTransaction('external', tx);
  expect(sheet().props.external).toBe(true);
  expect(requestColdSignature).not.toHaveBeenCalled();
  await act(async () => { await sheet().props.onConfirm(''); });
  expect(requestColdSignature).toHaveBeenCalledWith(expect.objectContaining({ actor: 'alice', permission: 'active', chainId: CHAINS.vaulta.chainIdHash }));
  expect(Signature.from(payload(response('external')[0]).signatures[0]).verifyDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
  expect(transact).not.toHaveBeenCalled();
});
test('a late external signature cannot complete after a DApp disconnect', async () => {
  wallet.currentWallet = undefined;
  await act(async () => { renderer.update(React.createElement(DappBrowserScreen)); });
  jest.mocked(passwordSigner).mockReturnValue(async () => ({ kind: 'external', chainSlug: 'vaulta', account: 'alice' }));
  const gate = deferred(); const tx = makeTransaction();
  jest.mocked(requestColdSignature).mockImplementation(async () => { await gate.promise; return key.signDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash)); });
  await connect(); await sendTransaction('external', tx); let signing!: Promise<void>;
  await act(async () => { signing = sheet().props.onConfirm(''); });
  await send('logout', 'forgetIdentity'); await connect('again');
  await act(async () => { gate.resolve(); await signing; });
  expect(response('external')).toHaveLength(0);
  expect(transact).not.toHaveBeenCalled();
});
test('a zero-reference noop challenge requires confirmation and returns a valid signature without broadcasting', async () => {
  await connect();
  const noopAbi = ABI.from({ version: 'eosio::abi/1.2',
    structs: [{ name: 'noop', base: '', fields: [] }],
    actions: [{ name: 'noop', type: 'noop', ricardian_contract: '' }] });
  jest.mocked(getSigningAbi).mockResolvedValueOnce(noopAbi);
  const tx = Transaction.from({ expiration: new Date(Date.now() + 120000).toISOString().slice(0, 19),
    ref_block_num: 0, ref_block_prefix: 0, actions: [Action.from({ account: 'eoseyespower', name: 'noop',
      authorization: [{ actor: 'alice', permission: 'active' }], data: {} }, noopAbi)] });
  await sendTransaction('challenge', tx);
  expect(sheet().props.visible).toBe(true);
  expect(sheet().props.actions[0]).toMatchObject({ account: 'eoseyespower', name: 'noop', data: {} });
  expect(signDigest).not.toHaveBeenCalled();
  expect(response('challenge')).toHaveLength(0);
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(Signature.from(payload(response('challenge')[0]).signatures[0])
    .verifyDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
  expect(transact).not.toHaveBeenCalled();
  expect(jest.mocked(fetchWithTimeout).mock.calls.every(([url]) => String(url).endsWith('/v1/chain/get_account'))).toBe(true);
});

test.each(['onConfirm', 'onConfirmBiometric', 'onConfirmPasskey'])('disconnect/reconnect cannot revive an old %s authentication', async confirm => {
  await connect(); await send('old', 'arbitrarySignature', { data: text });
  const unlock = deferred(); unlockGate = unlock.promise; let submitting!: Promise<void>;
  await act(async () => { submitting = sheet().props[confirm]('synthetic-password'); });
  await send('logout', 'forgetIdentity');
  expect(response('logout')).toHaveLength(1); expect(sheet().props.visible).toBe(false);
  await connect('reconnect'); await act(async () => { unlock.resolve(); await submitting; });
  expect(signDigest).not.toHaveBeenCalled(); expect(response('old')).toHaveLength(0);
  // Reusing the old ID creates a new request which needs a fresh confirmation.
  await send('old', 'arbitrarySignature', { data: 'Fresh approval' });
  expect(sheet().props.visible).toBe(true); expect(signDigest).not.toHaveBeenCalled();
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(response('old')).toHaveLength(1);
  expect(Signature.from(payload(response('old')[0]).signature).verifyDigest(Checksum256.hash(new TextEncoder().encode('Fresh approval')), key.toPublic())).toBe(true);
});
test('disconnect/reconnect during real resource preflight cannot return the old transaction signature', async () => {
  await connect(); const tx = makeTransaction(); await sendTransaction('old', tx);
  const preflight = deferred(); preflightGate = preflight.promise; let submitting!: Promise<void>;
  await act(async () => { submitting = sheet().props.onConfirm('synthetic-password'); });
  expect(preflightStarted).toBe(true);
  await send('logout', 'forgetIdentity'); await connect('reconnect');
  await act(async () => { preflight.resolve(); await submitting; });
  expect(signDigest).not.toHaveBeenCalled(); expect(response('old')).toHaveLength(0); expect(sheet().props.visible).toBe(false);
  await sendTransaction('fresh', tx); await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(response('fresh')).toHaveLength(1);
});
test('decoding a revoked request cannot restore its confirmation or overwrite a reused ID', async () => {
  await connect(); const abi = deferred();
  jest.mocked(getSigningAbi).mockImplementationOnce(async () => { await abi.promise; return coreActionAbi('core.vaulta', 'transfer')!; });
  await sendTransaction('old', makeTransaction()); await send('logout', 'forgetIdentity'); await connect('reconnect');
  await send('old', 'arbitrarySignature', { data: 'Fresh message' });
  await act(async () => { abi.resolve(); });
  expect(sheet().props.message).toBe('Fresh message'); expect(sheet().props.actions).toEqual([]);
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(response('old')).toHaveLength(1);
  expect(payload(response('old')[0]).signature).toBeDefined(); expect(payload(response('old')[0]).signatures).toBeUndefined();
});
test('old native connection buttons cannot grant or reject a reused new connection request', async () => {
  await send('connect', 'getIdentity'); const old = connectionButtons();
  await send('logout', 'forgetIdentity'); await send('connect', 'getIdentity');
  expect(jest.mocked(Alert.alert).mock.calls.filter(([title]) => title === 'dappBrowser.connectTitle')).toHaveLength(2);
  await act(async () => { old.find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); old.find(b => b.style === 'cancel')!.onPress!(); });
  expect(response('connect')).toHaveLength(0); expect(response('connect', false)).toHaveLength(0);
  await act(async () => { connectionButtons().find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(response('connect')).toHaveLength(1);
});
test('old asynchronous public queries cannot reply to a reused request ID after disconnect', async () => {
  await connect(); const read = deferred();
  wallet.client.getAccount = jest.fn().mockImplementationOnce(async () => { await read.promise; return { account_name: 'old' }; })
    .mockResolvedValue({ account_name: 'fresh' });
  await send('query', 'getAccount', { account: 'old' }); await send('logout', 'forgetIdentity'); await connect('reconnect');
  await send('query', 'getAccount', { account: 'fresh' }); await act(async () => { read.resolve(); });
  expect(response('query')).toHaveLength(1); expect(payload(response('query')[0]).account_name).toBe('fresh');
});


test('a restored DApp signing request reconnects with consent and continues the same request', async () => {
  await send('restored', 'arbitrarySignature', { data: text });
  expect(sheet().props.visible).toBe(false);
  expect(signDigest).not.toHaveBeenCalled();
  expect(response('restored', false)).toHaveLength(0);
  await act(async () => { connectionButtons().find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(injected.some(js => js.startsWith('window.__auroraSetAccount("alice", '))).toBe(true);
  expect(sheet().props.visible).toBe(true);
  expect(sheet().props.message).toBe(text);
  expect(signDigest).not.toHaveBeenCalled();
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(response('restored')).toHaveLength(1);
  expect(Signature.from(payload(response('restored')[0]).signature).verifyDigest(Checksum256.hash(new TextEncoder().encode(text)), key.toPublic())).toBe(true);
  expect(transact).not.toHaveBeenCalled();
});

test('reconnection continues a serialized transaction without changing bytes or broadcasting', async () => {
  const tx = makeTransaction();
  await sendTransaction('restored-tx', tx);
  expect(getSigningAbi).not.toHaveBeenCalled();
  await act(async () => { connectionButtons().find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(sheet().props.visible).toBe(true);
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(Signature.from(payload(response('restored-tx')[0]).signatures[0]).verifyDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
  expect(transact).not.toHaveBeenCalled();
});

test('rejecting reconnection returns rejection and a later attempt can reconnect', async () => {
  await send('restored', 'arbitrarySignature', { data: text });
  await act(async () => { connectionButtons().find(b => b.style === 'cancel')!.onPress!(); });
  expect(response('restored', false)).toHaveLength(1);
  expect(sheet().props.visible).toBe(false);
  expect(signDigest).not.toHaveBeenCalled();
  await send('retry', 'arbitrarySignature', { data: text });
  await act(async () => { connectionButtons().find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(sheet().props.visible).toBe(true);
});

test('concurrent restored requests cannot stack connection prompts or resume a revoked request', async () => {
  await send('restored', 'arbitrarySignature', { data: text });
  const old = connectionButtons();
  await send('other', 'arbitrarySignature', { data: 'Other request' });
  expect(response('other', false)).toHaveLength(1);
  expect(jest.mocked(Alert.alert).mock.calls.filter(([title]) => title === 'dappBrowser.connectTitle')).toHaveLength(1);
  await send('logout', 'forgetIdentity');
  await act(async () => { old.find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(sheet().props.visible).toBe(false);
  expect(response('restored')).toHaveLength(0);
  expect(signDigest).not.toHaveBeenCalled();
});

test('switching accounts while a reconnection prompt is open cannot approve the old request', async () => {
  await send('restored', 'arbitrarySignature', { data: text });
  const old = connectionButtons();
  wallet = { ...wallet, account: 'bob', currentWallet: { ...wallet.currentWallet, account: 'bob' } };
  await act(async () => { renderer.update(React.createElement(DappBrowserScreen)); });
  await act(async () => { old.find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(sheet().props.visible).toBe(false);
  expect(response('restored')).toHaveLength(0);
  expect(signDigest).not.toHaveBeenCalled();
});

test('restored action requests broadcast once after both connection and transaction approval', async () => {
  const actions = [{ account: 'core.vaulta', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }],
    data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' } }];
  jest.mocked(transact).mockResolvedValueOnce({ txId: 'restored-id', explorerUrl: 'https://explorer.invalid/tx' } as any);
  await send('restored-actions', 'requestSignature', { actions, chainId: CHAINS.vaulta.chainIdHash });
  expect(transact).not.toHaveBeenCalled();
  const buttons = connectionButtons();
  await act(async () => { buttons.find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(sheet().props.visible).toBe(true);
  expect(transact).not.toHaveBeenCalled();
  // Native button callbacks cannot accidentally consume or resume a request twice.
  await act(async () => { buttons.find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(response('restored-actions', false)).toHaveLength(0);
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(transact).toHaveBeenCalledTimes(1);
  expect(transact).toHaveBeenCalledWith(expect.objectContaining({ actor: 'alice', actions }));
  expect(payload(response('restored-actions')[0]).transaction_id).toBe('restored-id');
});

test('page navigation invalidates a reconnection prompt before it can resume signing', async () => {
  await send('restored', 'arbitrarySignature', { data: text });
  const old = connectionButtons();
  await act(async () => { renderer.root.findByType('WebView').props.onLoadStart({ nativeEvent: { url: 'https://other.invalid/' } }); });
  await act(async () => { old.find(b => b.text === 'dappBrowser.connectAllow')!.onPress!(); });
  expect(sheet().props.visible).toBe(false);
  expect(response('restored')).toHaveLength(0);
  expect(signDigest).not.toHaveBeenCalled();
});

const sessionNoticeButtons = () => jest.mocked(Alert.alert).mock.calls.filter(([title]) => title === 'dappBrowser.sessionInvalidTitle').at(-1)![2]!;
test('explicit DApp login failure offers a reconnect guide without disconnecting until selected', async () => {
  await connect();
  await send('failure', 'dappSessionFailure', { status: 401, code: 'SESSION_EXPIRED' });
  const buttons = sessionNoticeButtons();
  await send('permission-before', 'getIdentityFromPermissions');
  expect(payload(response('permission-before')[0]).account).toBe('alice');
  await act(async () => { buttons.find(b => b.text === 'dappBrowser.sessionLoginAgain')!.onPress!(); });
  expect(injected).toContain('window.scatter && window.scatter.forgetIdentity(); true;');
  await send('permission-after', 'getIdentityFromPermissions');
  expect(payload(response('permission-after')[0])).toBeNull();
  expect(transact).not.toHaveBeenCalled(); expect(signDigest).not.toHaveBeenCalled();
});
test.each([
  { status: 401 }, { status: 403, code: 'insufficient_scope' }, { status: 0, code: 'SESSION_EXPIRED' },
  { status: 500, code: 'SESSION_EXPIRED' }, { status: 401, code: 'expired_tx_exception' }, { status: 401, code: 'INVALID_TOKEN' }, { status: 401, code: 'TOKEN_EXPIRED' },
])('ordinary failure does not disconnect or offer reconnection: %j', async params => {
  await connect();
  await send('failure', 'dappSessionFailure', params);
  expect(jest.mocked(Alert.alert).mock.calls.some(([title]) => title === 'dappBrowser.sessionInvalidTitle')).toBe(false);
  await send('permission', 'getIdentityFromPermissions');
  expect(payload(response('permission')[0]).account).toBe('alice');
});
test('repeated DApp failures coalesce and a dismissed notice leaves the wallet connected', async () => {
  await connect();
  await send('failure', 'dappSessionFailure', { status: 401, code: 'SESSION_EXPIRED' });
  await act(async () => { sessionNoticeButtons().find(b => b.style === 'cancel')!.onPress?.(); });
  await send('other-failure', 'dappSessionFailure', { status: 401, code: 'SESSION_INVALID' });
  expect(jest.mocked(Alert.alert).mock.calls.filter(([title]) => title === 'dappBrowser.sessionInvalidTitle')).toHaveLength(1);
  await send('permission', 'getIdentityFromPermissions');
  expect(payload(response('permission')[0]).account).toBe('alice');
});
test('a notice from before a newer connection cannot disconnect it', async () => {
  await connect();
  await send('failure', 'dappSessionFailure', { status: 401, code: 'SESSION_EXPIRED' });
  const old = sessionNoticeButtons();
  await send('login-again', 'getIdentity');
  await act(async () => { old.find(b => b.text === 'dappBrowser.sessionLoginAgain')!.onPress!(); });
  await send('permission', 'getIdentityFromPermissions');
  expect(payload(response('permission')[0]).account).toBe('alice');
});
test('login-failure notices cannot interrupt a pending signature', async () => {
  await connect(); await send('sign', 'arbitrarySignature', { data: text });
  await send('failure', 'dappSessionFailure', { status: 401, code: 'SESSION_EXPIRED' });
  expect(jest.mocked(Alert.alert).mock.calls.some(([title]) => title === 'dappBrowser.sessionInvalidTitle')).toBe(false);
  expect(sheet().props.visible).toBe(true);
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(response('sign')).toHaveLength(1);
});
test('native node permission and network failures remain ordinary signing errors without reconnect prompts', async () => {
  await connect();
  const actions = [{ account: 'core.vaulta', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }],
    data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' } }];
  jest.mocked(transact).mockRejectedValueOnce(new TypeError('Network request failed'));
  await send('tx', 'requestSignature', { actions });
  await act(async () => { await sheet().props.onConfirm('synthetic-password'); });
  expect(sheet().props.error).toBe('Network request failed');
  expect(jest.mocked(Alert.alert).mock.calls.some(([title]) => title === 'dappBrowser.sessionInvalidTitle')).toBe(false);
  await send('permission', 'getIdentityFromPermissions');
  expect(payload(response('permission')[0]).account).toBe('alice');
});
