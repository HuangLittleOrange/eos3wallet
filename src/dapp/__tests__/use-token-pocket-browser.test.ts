jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, Share: { share: jest.fn() } }));
jest.mock('../../components/DappScanModal', () => 'DappScanModal');
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../dappDeviceId', () => ({ dappDeviceId: jest.fn() }));
jest.mock('../dappGate', () => ({ isDappFavorite: jest.fn(), toggleDappFavorite: jest.fn() }));
jest.mock('../saveRemoteImage', () => ({
  SaveImageError: class SaveImageError extends Error {}, saveRemoteImage: jest.fn(),
}));

import React from 'react';
import { Alert, Share } from 'react-native';
import { dappDeviceId } from '../dappDeviceId';
import { isDappFavorite, toggleDappFavorite } from '../dappGate';
import { SaveImageError, saveRemoteImage } from '../saveRemoteImage';
import { useTokenPocketBrowser } from '../use-token-pocket-browser';

const { create, act } = require('react-test-renderer');
let browser: ReturnType<typeof useTokenPocketBrowser>;
let renderer: any;
let options: Parameters<typeof useTokenPocketBrowser>[0];
function Harness() { browser = useTokenPocketBrowser(options); return null; }
const send = async (method: string, params?: any) => {
  let handled = false;
  await act(async () => { handled = browser.handleRequest({ id: 'doc:1', method, params }); });
  return handled;
};
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  options = { client: { getActions: jest.fn() }, account: 'alice', isConnected: () => true,
    url: 'https://alcor.exchange/', pageUrl: 'https://alcor.exchange/market', reply: jest.fn(),
    goBack: jest.fn(), close: jest.fn(), importWallet: jest.fn(async () => {}), onFavorited: jest.fn() };
  jest.mocked(dappDeviceId).mockResolvedValue('site-id');
  jest.mocked(Share.share).mockResolvedValue({ action: 'sharedAction' });
  jest.mocked(saveRemoteImage).mockResolvedValue(undefined);
  jest.mocked(isDappFavorite).mockResolvedValue(false);
  jest.mocked(toggleDappFavorite).mockResolvedValue(true);
  await act(async () => { renderer = create(React.createElement(Harness)); });
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); });

test('full screen, menubar and navigation gestures preserve their state and acknowledgements', async () => {
  await send('fullScreen', { on: true }); await send('setMenubar', { visible: true });
  await send('setNavGestures', { enabled: true });
  expect(browser).toMatchObject({ fullScreen: true, menubarInFullScreen: true, navGestures: true });
  await send('fullScreen', { on: false });
  expect(browser).toMatchObject({ fullScreen: false, menubarInFullScreen: false, navGestures: true });
  expect(options.reply).toHaveBeenCalledTimes(4);
  expect(options.reply).toHaveBeenLastCalledWith('doc:1', true, true);
});

test('scanner returns the text to its request and document navigation clears pending scanning', async () => {
  await send('scanQR');
  expect(browser.scanElement.props.visible).toBe(true);
  await act(async () => { browser.scanElement.props.onResult('scanned-text'); });
  expect(options.reply).toHaveBeenCalledWith('doc:1', true, 'scanned-text');
  expect(browser.scanElement.props.visible).toBe(false);
  await send('scanQR');
  await act(async () => { browser.scanElement.props.onCancel(); });
  expect(options.reply).toHaveBeenLastCalledWith('doc:1', false, 'dappBrowser.userRejected');
  await send('scanQR');
  await act(async () => { browser.cancelScan(); });
  expect(browser.scanElement.props.visible).toBe(false);
  expect(options.reply).toHaveBeenCalledTimes(2);
});

test('history requests retain paging bounds, contract/token filtering and ascending order', async () => {
  const newer = { contract: 'core.vaulta', quantity: '2.0000 A' };
  const older = { contract: 'core.vaulta', quantity: '1.0000 A' };
  jest.mocked(options.client.getActions).mockResolvedValue({ actions: [newer,
    { contract: 'other', quantity: '3.0000 A' }, { contract: 'core.vaulta', quantity: '1.0000 EOS' }, older] } as any);
  await send('getActions', { count: 1000, start: -10, contract: 'core.vaulta', token: 'A', sort: 'asc' });
  expect(options.client.getActions).toHaveBeenCalledWith('alice', { limit: 100, skip: 0 });
  expect(options.reply).toHaveBeenCalledWith('doc:1', true, [older, newer]);
});

test('history failures reply with an error and later requests use the latest wallet context', async () => {
  jest.mocked(options.client.getActions).mockRejectedValueOnce(new Error('node unavailable'));
  await send('getActions');
  expect(options.reply).toHaveBeenCalledWith('doc:1', false, 'node unavailable');
  options = { ...options, account: 'bob' };
  await act(async () => { renderer.update(React.createElement(Harness)); });
  jest.mocked(options.client.getActions).mockResolvedValue({ actions: [] } as any);
  await send('getActions');
  expect(options.client.getActions).toHaveBeenLastCalledWith('bob', { limit: 10, skip: 0 });
});

test('device IDs remain scoped to the page host', async () => {
  await send('getDeviceId');
  expect(dappDeviceId).toHaveBeenCalledWith('alcor.exchange');
  expect(options.reply).toHaveBeenCalledWith('doc:1', true, 'site-id');
});

test('share, back, close and import delegate to native operations and acknowledge', async () => {
  await send('share', { title: 'Market', description: 'Trade', url: options.url });
  expect(Share.share).toHaveBeenCalledWith({ title: 'Market', message: 'Market\nTrade\nhttps://alcor.exchange/', url: options.url });
  await send('goBack'); await send('closeBrowser'); await send('importWallet');
  expect(options.goBack).toHaveBeenCalledTimes(1);
  expect(options.close).toHaveBeenCalledTimes(1);
  expect(options.importWallet).toHaveBeenCalledTimes(1);
  expect(options.reply).toHaveBeenCalledTimes(4);
});

test('save-image permission failures report failure; retries report success after saving', async () => {
  jest.mocked(saveRemoteImage).mockRejectedValueOnce(new SaveImageError('permission-denied'));
  await send('saveImage', { url: 'https://alcor.exchange/image.png' });
  expect(options.reply).toHaveBeenCalledWith('doc:1', false, 'permission-denied');
  expect(Alert.alert).toHaveBeenCalledWith('dappBrowser.imagePermissionDenied');
  await send('saveImage', { url: 'https://alcor.exchange/image.png' });
  expect(options.reply).toHaveBeenLastCalledWith('doc:1', true, true);
  expect(Alert.alert).toHaveBeenLastCalledWith('dappBrowser.imageSaved');
});

test('favorites are not toggled off when already saved', async () => {
  await send('addFavorite');
  expect(toggleDappFavorite).toHaveBeenCalledWith(options.url, 'alcor.exchange', 'vaulta');
  expect(options.onFavorited).toHaveBeenCalledTimes(1);
  jest.mocked(isDappFavorite).mockResolvedValueOnce(true);
  await send('addFavorite');
  expect(toggleDappFavorite).toHaveBeenCalledTimes(1);
  expect(options.reply).toHaveBeenLastCalledWith('doc:1', true, true);
});

test('browser favorites use the current network for lookup and storage', async () => {
  options = { ...options, networkId: 'jungle4' };
  await act(async () => renderer.update(React.createElement(Harness)));
  await send('addFavorite');
  expect(isDappFavorite).toHaveBeenCalledWith(options.url, 'jungle4');
  expect(toggleDappFavorite).toHaveBeenCalledWith(options.url, 'alcor.exchange', 'jungle4');
});

test.each(['getIdentity', 'requestSignature', 'signTransaction', 'arbitrarySignature', 'unknown'])
  ('wallet/signing methods stay in the shared bridge: %s', async (method) => {
    expect(await send(method)).toBe(false);
    expect(options.reply).not.toHaveBeenCalled();
  });


test('unconnected pages cannot infer the current account through omitted/null history accounts', async () => {
  options = { ...options, isConnected: () => false };
  await act(async () => renderer.update(React.createElement(Harness)));
  await send('getActions', {});
  await send('getActions', { account: null });
  expect(options.client.getActions).not.toHaveBeenCalled();
  expect(options.reply).toHaveBeenLastCalledWith('doc:1', false, 'dappBrowser.connectionRequired');
  jest.mocked(options.client.getActions).mockResolvedValue({ actions: [] } as any);
  await send('getActions', { account: 'publicacct' });
  expect(options.client.getActions).toHaveBeenCalledWith('publicacct', { limit: 10, skip: 0 });
  options = { ...options, isConnected: () => true };
  await act(async () => renderer.update(React.createElement(Harness)));
  await send('getActions');
  expect(options.client.getActions).toHaveBeenLastCalledWith('alice', { limit: 10, skip: 0 });
});

test('cancelled asynchronous TP replies cannot be delivered to a reused bridge request', async () => {
  let resolve!: (value: string) => void;
  jest.mocked(dappDeviceId).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  let current = true;
  await act(async () => { browser.handleRequest({ id: 'doc:1', method: 'getDeviceId', isCurrent: () => current }); });
  current = false;
  await act(async () => { resolve('old-device-id'); });
  expect(options.reply).not.toHaveBeenCalled();
});
test('cancelled scanning cannot return results after its original request is revoked', async () => {
  let current = true;
  await act(async () => { browser.handleRequest({ id: 'doc:1', method: 'scanQR', isCurrent: () => current }); });
  current = false;
  await act(async () => { browser.scanElement.props.onResult('stale-result'); });
  expect(options.reply).not.toHaveBeenCalled(); expect(browser.scanElement.props.visible).toBe(false);
});
