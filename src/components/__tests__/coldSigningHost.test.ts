jest.mock('react-native-get-random-values', () => ({}));
jest.mock('react-native', () => ({ View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (v: any) => v },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove() {} })) }, Linking: { openSettings: jest.fn() },
  useWindowDimensions: () => ({ width: 390, height: 844 }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 44, bottom: 34 }) }));
jest.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: jest.fn() }));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(), setStringAsync: jest.fn() }));
jest.mock('react-native-qrcode-svg', () => 'QRCode');
jest.mock('../BottomSheet', () => ({ children, ...props }: any) => require('react').createElement('BottomSheet', props, children));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/importAccount', () => ({ readDirectSigningKeys: jest.fn() }));
jest.mock('../../dapp/linkSocket', () => ({ listenLinkChannel: jest.fn(() => ({ stop() {} })) }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({
  t: (key: string, params?: any) => key === 'coldSigning.remaining' ? `${key}:${params.seconds}` : key,
}) }));
import React from 'react';
import { AppState } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Action, PrivateKey, Serializer, Transaction } from '@wharfkit/antelope';
import { useWalletSession } from '../../chain/WalletContext';
import { readDirectSigningKeys } from '../../chain/importAccount';
import { cancelColdSigning, coldSigningSnapshot, requestColdSignature } from '../../chain/coldSigning';
import { CHAINS } from '../../chain/config';
import { coreActionAbi } from '../../chain/coreTokenAbi';
import { tokenPocketQrFrames } from '../../chain/tokenPocketQr';
import ColdSigningHost from '../ColdSigningHost';
const { create, act } = require('react-test-renderer');
const key = PrivateKey.generate('K1');
let renderer: any;
let session: any;
const requestCamera = jest.fn();
const text = () => renderer.root.findAllByType('Text').map((n: any) => n.props.children).flat().join(' ');
const button = (label: string) => renderer.root.findAllByType('TouchableOpacity').find((n: any) =>
  n.findAllByType('Text').some((t: any) => t.props.children === label));
const transaction = () => Transaction.from({ expiration: new Date(Date.now() + 120000).toISOString().slice(0, 19),
  ref_block_num: 0, ref_block_prefix: 0, actions: [Action.from({ account: 'core.vaulta', name: 'transfer',
    authorization: [{ actor: 'alice', permission: 'active' }], data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' } }, coreActionAbi('core.vaulta', 'transfer')!)] });
async function open() {
  const tx = transaction(); let signed!: ReturnType<typeof requestColdSignature>;
  await act(async () => { signed = requestColdSignature({ transaction: tx, chainId: CHAINS.vaulta.chainIdHash,
    chainSlug: 'vaulta', actor: 'alice', permission: 'active' }); });
  void signed.catch(() => {});
  return { tx, signed };
}
const rawResult = (tx: Transaction) => JSON.stringify({ ...Serializer.objectify(tx), signatures: [String(key.signDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash)))] });
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  AppState.currentState = 'active';
  session = { account: 'alice', chainId: 'vaulta', node: { url: 'https://rpc.invalid' } };
  jest.mocked(useWalletSession).mockImplementation(() => session);
  jest.mocked(readDirectSigningKeys).mockResolvedValue([String(key.toPublic())]);
  jest.mocked(useCameraPermissions).mockReturnValue([{ granted: false, canAskAgain: true } as any, requestCamera, jest.fn()]);
  requestCamera.mockResolvedValue({ granted: true });
  await act(async () => { renderer = create(React.createElement(ColdSigningHost)); });
});
afterEach(async () => { await act(async () => { cancelColdSigning(); renderer.unmount(); }); jest.useRealTimers(); });
test('camera is requested only on user action; a bad scan can be retried successfully', async () => {
  const { tx, signed } = await open();
  expect(requestCamera).not.toHaveBeenCalled();
  expect(renderer.root.findByType('QRCode').props.value).toContain('eosio:signTransaction-');
  await act(async () => { await button('coldSigning.scanResult').props.onPress(); });
  expect(requestCamera).toHaveBeenCalledTimes(1);
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: 'https://untrusted.invalid/' }); });
  expect(text()).toContain('coldSigning.invalidResponse');
  await act(async () => { await button('coldSigning.scanResult').props.onPress(); });
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: rawResult(tx) }); });
  expect((await signed).verifyDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
  expect(renderer.toJSON()).toBeNull();
});
test('denied camera permission keeps the request visible for retry and cancellation', async () => {
  const { signed } = await open(); const rejected = expect(signed).rejects.toThrow('cancelled');
  requestCamera.mockResolvedValueOnce({ granted: false });
  await act(async () => { await button('coldSigning.scanResult').props.onPress(); });
  expect(text()).toContain('scan.cameraPermDesc'); expect(coldSigningSnapshot()).not.toBeNull();
  await act(async () => { button('coldSigning.cancel').props.onPress(); }); await rejected;
});
test('dynamic signed results are assembled before verification and ignore duplicate frames', async () => {
  const { tx, signed } = await open();
  const frames = tokenPocketQrFrames(JSON.stringify({ ...JSON.parse(rawResult(tx)), padding: 'x'.repeat(1200) }));
  expect(frames.length).toBeGreaterThan(2);
  await act(async () => { await button('coldSigning.scanResult').props.onPress(); });
  const scan = async (data: string) => {
    await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data }); });
  };
  await scan(frames[frames.length - 1]);
  await scan(frames[frames.length - 1]);
  expect(readDirectSigningKeys).toHaveBeenCalledTimes(1);
  expect(text()).toContain('coldSigning.fragments');
  for (let i = frames.length - 2; i > 0; i--) await scan(frames[i]);
  expect(coldSigningSnapshot()).not.toBeNull();
  expect(readDirectSigningKeys).toHaveBeenCalledTimes(1);
  await scan(frames[0]);
  expect((await signed).verifyDigest(tx.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
  expect(readDirectSigningKeys).toHaveBeenCalledTimes(2);
  expect(renderer.toJSON()).toBeNull();
});
test('wallet context changes and backgrounding cancel pending signatures', async () => {
  const { signed } = await open(); const rejected = expect(signed).rejects.toThrow('cancelled');
  session = { ...session, account: 'bob' };
  await act(async () => { renderer.update(React.createElement(ColdSigningHost)); }); await rejected;
  session = { ...session, account: 'alice' };
  await act(async () => { renderer.update(React.createElement(ColdSigningHost)); });
  const next = await open(); const backgrounded = expect(next.signed).rejects.toThrow('cancelled');
  const callback = jest.mocked(AppState.addEventListener).mock.calls[0][1];
  await act(async () => { callback('background'); }); await backgrounded;
  expect(coldSigningSnapshot()).toBeNull();
});
test('first camera grant survives the Android permission activity and waits for foreground', async () => {
  const { tx, signed } = await open();
  let release!: (value: any) => void;
  const state = (value: 'background' | 'active') => {
    AppState.currentState = value;
    for (const [event, callback] of [...jest.mocked(AppState.addEventListener).mock.calls]) {
      if (event === 'change') callback(value);
    }
  };
  requestCamera.mockImplementationOnce(() => {
    state('background');
    return new Promise(resolve => { release = resolve; });
  });
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  expect(coldSigningSnapshot()).not.toBeNull();
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(0);
  await act(async () => { release({ granted: true }); });
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(0);
  await act(async () => { state('active'); });
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(1);
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: rawResult(tx) }); });
  await signed;
  expect(renderer.toJSON()).toBeNull();
});
test('a permission result for a cancelled request does not open the replacement camera', async () => {
  const first = await open(), rejected = expect(first.signed).rejects.toThrow('cancelled');
  let release!: (value: any) => void;
  requestCamera.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  await act(async () => { cancelColdSigning(); }); await rejected;
  await open();
  await act(async () => { release({ granted: true }); });
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(0);
});
test('a permission operation that times out in background cancels rather than opening the camera', async () => {
  jest.useFakeTimers();
  const { signed } = await open(), rejected = expect(signed).rejects.toThrow('cancelled');
  requestCamera.mockImplementationOnce(() => {
    AppState.currentState = 'background'; return new Promise(() => {});
  });
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(60001); }); await rejected;
  expect(renderer.toJSON()).toBeNull();
});
test('opening a request after idle resets the displayed countdown immediately', async () => {
  jest.useFakeTimers(); jest.setSystemTime(Date.now() + 60_000);
  await open();
  expect(text()).toContain('coldSigning.remaining:120');
});
test('a cancelled request finishing its authority read cannot close the replacement scanner', async () => {
  const first = await open(), rejected = expect(first.signed).rejects.toThrow('cancelled');
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  let release!: (keys: string[]) => void;
  jest.mocked(readDirectSigningKeys).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: rawResult(first.tx) }); });
  expect(coldSigningSnapshot()!.validating).toBe(true);
  await act(async () => { cancelColdSigning(); }); await rejected;
  const next = await open();
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  const id = coldSigningSnapshot()!.id;
  await act(async () => { release([String(key.toPublic())]); });
  expect(coldSigningSnapshot()!.id).toBe(id);
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(1);
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: rawResult(next.tx) }); });
  await next.signed;
});
test('a queued barcode event from the previous camera cannot consume the replacement request', async () => {
  const first = await open(), rejected = expect(first.signed).rejects.toThrow('cancelled');
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  const oldScan = renderer.root.findByType('CameraView').props.onBarcodeScanned;
  await act(async () => { cancelColdSigning(); }); await rejected;
  const next = await open();
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  await act(async () => { oldScan({ data: 'https://untrusted.invalid/' }); });
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(1);
  expect(text()).not.toContain('coldSigning.invalidResponse');
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: rawResult(next.tx) }); });
  await next.signed;
});
test('a late clipboard read for a cancelled request cannot block the new scanner', async () => {
  const first = await open(), rejected = expect(first.signed).rejects.toThrow('cancelled');
  let release!: (value: string) => void;
  jest.mocked(Clipboard.getStringAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { button('coldSigning.paste').props.onPress(); });
  await act(async () => { cancelColdSigning(); }); await rejected;
  const next = await open();
  await act(async () => { button('coldSigning.scanResult').props.onPress(); });
  await act(async () => { release(rawResult(first.tx)); });
  expect(renderer.root.findAllByType('CameraView')).toHaveLength(1);
  await act(async () => { renderer.root.findByType('CameraView').props.onBarcodeScanned({ data: rawResult(next.tx) }); });
  await next.signed;
});
