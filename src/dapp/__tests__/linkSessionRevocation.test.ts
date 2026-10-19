jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('../linkIdentity', () => ({ getLinkIdentity: jest.fn() }));
jest.mock('../linkSocket', () => ({ listenLinkChannel: jest.fn() }));
jest.mock('../linkCrypto', () => ({ sealedMessageFromWire: jest.fn(), unsealMessage: jest.fn() }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/signers', () => ({ passwordSigner: jest.fn(), biometricSigner: jest.fn(), passkeySigner: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ signingPermission: () => 'active' }));
jest.mock('../../crypto/systemAuthentication', () => ({ shouldInvalidateBackground: () => true }));
jest.mock('../../components/ResourceRepairSheet', () => ({
  useResourceRepair: () => ({ prepare: jest.fn(), offer: () => false, element: null }),
}));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../esr', () => ({ parseEsr: jest.fn(), signAndCallback: jest.fn(),
  assertIdentityNotExpired: jest.fn(), identityExpirationMs: () => null }));
jest.mock('../esr-flow-overlay', () => ({ __esModule: true,
  default: ({ flow }: any) => { mockFlow = flow; return null; } }));

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useWalletSession } from '../../chain/WalletContext';
import { passwordSigner } from '../../chain/signers';
import { DappSessionProvider, useDappSession } from '../DappSessionContext';
import EsrRequestHost from '../EsrRequestHost';
import LinkSessionProvider from '../LinkSessionProvider';
import { getLinkIdentity } from '../linkIdentity';
import { listenLinkChannel } from '../linkSocket';
import { sealedMessageFromWire, unsealMessage } from '../linkCrypto';
import { parseEsr, signAndCallback } from '../esr';
import { authorizeLinkSession, recordLinkSession, revokeLinkSession } from '../linkSessions';
import type { useEsrFlow } from '../useEsrFlow';

const { create, act } = require('react-test-renderer');
let mockFlow: ReturnType<typeof useEsrFlow>;
let context: ReturnType<typeof useDappSession>;
let renderer: any;
let deliver: (raw: Uint8Array) => void;
let unlock: jest.Mock;
const raw = new Uint8Array([1]);
const identity = { channelUrl: 'https://channel.invalid/', privateKey: 'synthetic' } as any;
const parsed = { req: { uri: 'esr:synthetic', isIdentity: true, actions: [], chainId: 'chain' }, resolved: {} } as any;
const deferred = <T,>() => { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const session = (requestKey = 'sender') => ({ requestKey, name: requestKey, account: 'alice', chainId: 'vaulta' as const, createdAt: 1 });
function Capture() { context = useDappSession(); return null; }
async function mount() {
  await act(async () => { renderer = create(React.createElement(DappSessionProvider, null,
    React.createElement(LinkSessionProvider), React.createElement(EsrRequestHost), React.createElement(Capture))); });
}
const push = async () => { await act(async () => { deliver(raw); }); };
const revoke = async (key = 'sender') => { await act(async () => { await revokeLinkSession(key); }); };
const changeState = async (state: 'active' | 'background' | 'inactive') => {
  await act(async () => {
    (AppState as any).currentState = state;
    for (const [, callback] of jest.mocked(AppState.addEventListener).mock.calls) callback(state);
  });
};

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.restoreAllMocks(); jest.clearAllMocks();
  for (const mock of [getLinkIdentity, listenLinkChannel, sealedMessageFromWire, unsealMessage,
    useWalletSession, passwordSigner, parseEsr, signAndCallback]) jest.mocked(mock).mockReset();
  await AsyncStorage.clear(); (AppState as any).currentState = 'active';
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  jest.mocked(getLinkIdentity).mockResolvedValue(identity);
  jest.mocked(listenLinkChannel).mockImplementation((_url, callback) => { deliver = callback; return { stop: jest.fn() }; });
  jest.mocked(sealedMessageFromWire).mockReturnValue({ from: 'sender', nonce: 'nonce' } as any);
  jest.mocked(unsealMessage).mockReturnValue('esr:synthetic');
  jest.mocked(useWalletSession).mockReturnValue({ currentWallet: { id: 'wallet' }, account: 'alice',
    chainId: 'vaulta', node: { url: 'https://node.invalid' }, client: { config: {} } } as any);
  jest.mocked(parseEsr).mockResolvedValue(parsed);
  unlock = jest.fn().mockResolvedValue({ kind: 'privatekey', privateKey: 'synthetic' });
  jest.mocked(passwordSigner).mockReturnValue(unlock);
  jest.mocked(signAndCallback).mockResolvedValue({ kind: 'none', signature: 'synthetic' });
  await recordLinkSession(session());
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); }); renderer = null;
  await revokeLinkSession('sender'); await revokeLinkSession('other');
});

it('a known sender can still open and confirm a normal push', async () => {
  await mount(); await push(); expect(mockFlow.esr).toBe(parsed);
  await act(async () => { await mockFlow.submitPassword('synthetic'); });
  expect(signAndCallback).toHaveBeenCalledTimes(1);
});

it('revocation while the receiver identity is loading drops the in-flight push', async () => {
  await mount(); const gate = deferred<any>();
  jest.mocked(getLinkIdentity).mockReturnValueOnce(gate.promise);
  await push(); await revoke();
  await act(async () => { gate.resolve(identity); });
  expect(parseEsr).not.toHaveBeenCalled(); expect(mockFlow.esr).toBeNull();
});

it('revocation during ESR parsing cannot open a late confirmation', async () => {
  const gate = deferred<any>(); jest.mocked(parseEsr).mockReturnValueOnce(gate.promise);
  await mount(); await push(); expect(mockFlow.parsing).toBe(true);
  await revoke(); await act(async () => { gate.resolve(parsed); });
  expect(mockFlow.esr).toBeNull(); expect(mockFlow.parsing).toBe(false);
});

it('revocation closes an already open push confirmation and blocks signing', async () => {
  await mount(); await push(); expect(mockFlow.esr).toBe(parsed);
  await revoke(); expect(mockFlow.esr).toBeNull();
  await act(async () => { await mockFlow.submitPassword('synthetic'); });
  expect(unlock).not.toHaveBeenCalled(); expect(signAndCallback).not.toHaveBeenCalled();
});

it('revocation while unlocking prevents dispatch to the signing path', async () => {
  const gate = deferred<any>(); jest.mocked(passwordSigner).mockReturnValueOnce(() => gate.promise);
  await mount(); await push(); let submitting!: Promise<void>;
  await act(async () => { submitting = mockFlow.submitPassword('synthetic'); });
  await revoke();
  await act(async () => { gate.resolve({ kind: 'privatekey', privateKey: 'synthetic' }); await submitting; });
  expect(signAndCallback).not.toHaveBeenCalled(); expect(mockFlow.esr).toBeNull();
});

it('revocation invalidates the delivery guard of an already running signature', async () => {
  const gate = deferred<any>(); jest.mocked(signAndCallback).mockReturnValueOnce(gate.promise);
  await mount(); await push(); let submitting!: Promise<void>;
  await act(async () => { submitting = mockFlow.submitPassword('synthetic'); });
  const guard = jest.mocked(signAndCallback).mock.calls[0][0].isCurrent!;
  expect(guard()).toBe(true); await revoke(); expect(guard()).toBe(false);
  await act(async () => { gate.resolve({ kind: 'redirect', callbackUrl: 'https://dapp.invalid/', signature: 'synthetic' }); await submitting; });
  expect(context.session).toBeNull();
});

it('relogin does not revive an old in-flight push but accepts a fresh one', async () => {
  await mount(); const gate = deferred<any>(); jest.mocked(getLinkIdentity).mockReturnValueOnce(gate.promise);
  await push(); await revoke(); await recordLinkSession(session());
  await act(async () => { gate.resolve(identity); });
  expect(parseEsr).not.toHaveBeenCalled();
  await push(); expect(mockFlow.esr).toBe(parsed);
});

it('unrelated sender revocation leaves a valid confirmation intact', async () => {
  await recordLinkSession(session('other')); await mount(); await push(); await revoke('other');
  expect(mockFlow.esr).toBe(parsed);
});

it('a background-to-foreground cycle cannot revive a push from the old listener', async () => {
  await mount(); const gate = deferred<any>(); jest.mocked(getLinkIdentity).mockReturnValueOnce(gate.promise);
  await push(); await changeState('background'); await changeState('active');
  await act(async () => { gate.resolve(identity); });
  expect(parseEsr).not.toHaveBeenCalled();
});

it('unmounting while decrypt identity is loading suppresses the old push', async () => {
  await mount(); const gate = deferred<any>(); jest.mocked(getLinkIdentity).mockReturnValueOnce(gate.promise);
  await push(); await act(async () => { renderer.unmount(); }); renderer = null;
  await act(async () => { gate.resolve(identity); });
  expect(parseEsr).not.toHaveBeenCalled(); expect(unsealMessage).not.toHaveBeenCalled();
});

it('revoking a Link sender does not cancel an independently scanned ESR', async () => {
  await mount(); await act(async () => { context.openEsr('esr:scanned'); });
  await revoke(); expect(mockFlow.esr).toBe(parsed);
});

it('revocation before the pending slot is consumed never starts parsing', async () => {
  await mount(); const signal = (await authorizeLinkSession('sender'))!;
  await act(async () => { context.openEsr('esr:queued', signal); await revokeLinkSession('sender'); });
  expect(parseEsr).not.toHaveBeenCalled(); expect(mockFlow.esr).toBeNull();
});

it('an old confirm callback cannot sign after revoke and a fresh login', async () => {
  await mount(); await push(); const oldConfirm = mockFlow.submitPassword;
  await revoke(); await recordLinkSession(session());
  jest.mocked(sealedMessageFromWire).mockReturnValue({ from: 'sender', nonce: 'fresh' } as any);
  await push(); expect(mockFlow.esr).toBe(parsed);
  await act(async () => { await oldConfirm('synthetic'); });
  expect(unlock).not.toHaveBeenCalled(); expect(signAndCallback).not.toHaveBeenCalled();
  await act(async () => { await mockFlow.submitPassword('synthetic'); });
  expect(signAndCallback).toHaveBeenCalledTimes(1);
});

it('unknown senders are dropped before retrieving a decrypting identity', async () => {
  await revokeLinkSession('sender'); await mount(); jest.mocked(getLinkIdentity).mockClear();
  await push(); expect(getLinkIdentity).not.toHaveBeenCalled(); expect(parseEsr).not.toHaveBeenCalled();
});

it('a foreground during the initial identity read starts only a fresh listener', async () => {
  const gate = deferred<any>(); jest.mocked(getLinkIdentity).mockReturnValueOnce(gate.promise);
  await mount(); await changeState('background'); await changeState('active');
  expect(listenLinkChannel).not.toHaveBeenCalled();
  await act(async () => { gate.resolve(identity); });
  expect(listenLinkChannel).toHaveBeenCalledTimes(1);
  expect(getLinkIdentity).toHaveBeenCalledTimes(2);
});
