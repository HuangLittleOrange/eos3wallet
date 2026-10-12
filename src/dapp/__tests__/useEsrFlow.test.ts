jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  Alert: { alert: jest.fn() },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/signers', () => ({ passwordSigner: jest.fn(), biometricSigner: jest.fn(), passkeySigner: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ signingPermission: () => 'active' }));
jest.mock('../../components/ResourceRepairSheet', () => ({
  useResourceRepair: () => ({ prepare: jest.fn(), offer: () => false, element: null }),
}));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: mockTranslate }) }));
jest.mock('../esr', () => ({
  parseEsr: jest.fn(), signAndCallback: jest.fn(), assertIdentityNotExpired: jest.fn(), identityExpirationMs: jest.fn(),
}));

import React from 'react';
import { Alert, AppState } from 'react-native';
import { useWalletSession } from '../../chain/WalletContext';
import { passwordSigner } from '../../chain/signers';
import { assertIdentityNotExpired, identityExpirationMs, parseEsr, signAndCallback } from '../esr';
import { useEsrFlow } from '../useEsrFlow';

const { create, act } = require('react-test-renderer');
const mockTranslate = (key: string) => key;
const getSigner = jest.fn();
const refresh = jest.fn();
let flow: ReturnType<typeof useEsrFlow>;
let renderer: any;
const harness = () => { flow = useEsrFlow({ onRedirect: redirect }); return null; };
const redirect = jest.fn();
const parsed = (uri = 'esr:first', expiresAt: number | null = Date.now() + 300_000) => ({
  req: { uri, isIdentity: true, actions: [], chainId: 'chain' },
  resolved: { expiresAt },
}) as any;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const mount = async () => { await act(async () => { renderer = create(React.createElement(harness)); }); };
const open = async () => { await act(async () => { await flow.open('esr:first'); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers().setSystemTime(new Date('2026-10-09T01:00:00Z'));
  jest.resetAllMocks();
  jest.mocked(AppState.addEventListener).mockReturnValue({ remove: jest.fn() });
  jest.mocked(useWalletSession).mockReturnValue({ currentWallet: { id: 'wallet' }, account: 'alice',
    chainId: 'vaulta', node: { url: 'https://node.invalid' }, client: { config: {} }, refresh } as any);
  jest.mocked(parseEsr).mockImplementation(async (uri) => parsed(uri));
  jest.mocked(identityExpirationMs).mockImplementation((resolved: any) => resolved.expiresAt);
  jest.mocked(assertIdentityNotExpired).mockImplementation((resolved: any) => {
    if (resolved.expiresAt !== null && Date.now() >= resolved.expiresAt) throw new Error('esrError.identityExpired');
  });
  getSigner.mockResolvedValue({ kind: 'privatekey', privateKey: 'test' });
  jest.mocked(passwordSigner).mockReturnValue(getSigner);
  jest.mocked(signAndCallback).mockResolvedValue({ kind: 'posted', signature: 'sig', callbackUrl: 'https://dapp.invalid/cb' });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  renderer = null;
  jest.useRealTimers();
});

it('reserves a request before parsing, so duplicate and competing requests cannot overwrite it', async () => {
  const pending = deferred<any>();
  jest.mocked(parseEsr).mockReturnValueOnce(pending.promise);
  await mount();
  let opening!: Promise<void>;
  await act(async () => { opening = flow.open('esr:first'); await flow.open('esr:first'); await flow.open('esr:second'); });
  expect(parseEsr).toHaveBeenCalledTimes(1);
  expect(flow.parsing).toBe(true);
  await act(async () => { pending.resolve(parsed()); await opening; });
  await act(async () => { await flow.open('esr:second'); });
  expect(parseEsr).toHaveBeenCalledTimes(1);
  expect(flow.esr!.req.uri).toBe('esr:first');
});

it('cancelled parse results cannot reopen a sheet or replace a newer request', async () => {
  const pending = deferred<any>();
  jest.mocked(parseEsr).mockReturnValueOnce(pending.promise);
  await mount();
  let opening!: Promise<void>;
  await act(async () => { opening = flow.open('esr:first'); });
  await act(async () => { flow.close(); await flow.open('esr:second'); });
  await act(async () => { pending.resolve(parsed()); await opening; });
  expect(flow.esr!.req.uri).toBe('esr:second');
  expect(flow.parsing).toBe(false);
});

it('cancelled parsing errors do not interrupt a newer request', async () => {
  const pending = deferred<any>();
  jest.mocked(parseEsr).mockReturnValueOnce(pending.promise);
  await mount();
  let opening!: Promise<void>;
  await act(async () => { opening = flow.open('esr:first'); });
  await act(async () => { flow.close(); await flow.open('esr:second'); });
  await act(async () => { pending.reject(new Error('old failure')); await opening; });
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(flow.esr!.req.uri).toBe('esr:second');
});

it('unmounting while parsing suppresses stale results and alerts', async () => {
  const pending = deferred<any>();
  jest.mocked(parseEsr).mockReturnValueOnce(pending.promise);
  await mount();
  let opening!: Promise<void>;
  await act(async () => { opening = flow.open('esr:first'); });
  await act(async () => { renderer.unmount(); });
  renderer = null;
  await act(async () => { pending.reject(new Error('late failure')); await opening; });
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('synchronously blocks double submission, close, and replacement during authentication', async () => {
  const pending = deferred<any>();
  getSigner.mockReturnValueOnce(pending.promise);
  await mount();
  await open();
  let submitting!: Promise<void>;
  await act(async () => {
    submitting = flow.submitPassword('password');
    await flow.submitPassword('password');
    flow.close();
    await flow.open('esr:second');
  });
  expect(flow.esr!.req.uri).toBe('esr:first');
  expect(getSigner).toHaveBeenCalledTimes(1);
  expect(parseEsr).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ kind: 'privatekey', privateKey: 'test' }); await submitting; });
  expect(signAndCallback).toHaveBeenCalledTimes(1);
  expect(flow.busy).toBe(false);
  expect(flow.esr).toBeNull();
});

it('shows timeout at five minutes and stops before unlocking or sending authorization', async () => {
  await mount();
  await open();
  await act(async () => { jest.advanceTimersByTime(299_999); });
  expect(flow.err).toBeNull();
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(flow.err).toBe('esrError.identityExpired');
  await act(async () => { await flow.submitPassword('password'); });
  expect(getSigner).not.toHaveBeenCalled();
  expect(signAndCallback).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(flow.busy).toBe(false);
  await act(async () => { flow.close(); await flow.open('esr:second'); });
  expect(flow.err).toBeNull();
  expect(flow.esr!.req.uri).toBe('esr:second');
});

it('backgrounding during authentication invalidates the request before sending a signature', async () => {
  const pending = deferred<any>();
  getSigner.mockReturnValueOnce(pending.promise);
  await mount();
  await open();
  let submitting!: Promise<void>;
  await act(async () => { submitting = flow.submitPassword('password'); });
  const listener = jest.mocked(AppState.addEventListener).mock.calls.find(([event]) => event === 'change')![1];
  await act(async () => { listener('background'); });
  await act(async () => { pending.resolve({ kind: 'privatekey', privateKey: 'test' }); await submitting; });
  expect(signAndCallback).not.toHaveBeenCalled();
  expect(flow.esr).toBeNull();
  expect(flow.busy).toBe(false);
});

it('reports delivery rather than login success, and accepts a new request afterwards', async () => {
  await mount();
  await open();
  await act(async () => { await flow.submitPassword('password'); });
  expect(Alert.alert).toHaveBeenCalledWith('dappBrowser.authorizationSentTitle', 'dappBrowser.authorizationSentBody', expect.any(Array));
  await act(async () => { await flow.open('esr:second'); });
  expect(parseEsr).toHaveBeenCalledTimes(2);
});

it('missing callbacks are sign-only, not reported as sent or signed in', async () => {
  jest.mocked(signAndCallback).mockResolvedValueOnce({ kind: 'none', signature: 'sig' });
  await mount();
  await open();
  await act(async () => { await flow.submitPassword('password'); });
  expect(Alert.alert).toHaveBeenCalledWith('dappBrowser.signedTitle', 'dappBrowser.identitySignedBody', expect.any(Array));
});

it('foreground callbacks still navigate to the callback URL without a success alert', async () => {
  jest.mocked(signAndCallback).mockResolvedValueOnce({ kind: 'redirect', signature: 'sig', callbackUrl: 'https://dapp.invalid/login' });
  await mount();
  await open();
  await act(async () => { await flow.submitPassword('password'); });
  expect(redirect).toHaveBeenCalledWith('https://dapp.invalid/login');
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('callback failures keep the confirmed request retryable without success feedback', async () => {
  jest.mocked(signAndCallback).mockRejectedValueOnce(new Error('callback failed'));
  await mount();
  await open();
  await act(async () => { await flow.submitPassword('password'); });
  expect(flow.err).toBe('callback failed');
  expect(flow.esr!.req.uri).toBe('esr:first');
  expect(Alert.alert).not.toHaveBeenCalled();
  await act(async () => { await flow.submitPassword('password'); });
  expect(signAndCallback).toHaveBeenCalledTimes(2);
  expect(flow.esr).toBeNull();
});

it('legacy requests without expiration do not get a spurious timeout', async () => {
  jest.mocked(parseEsr).mockResolvedValueOnce(parsed('esr:first', null));
  await mount();
  await open();
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(flow.err).toBeNull();
});
