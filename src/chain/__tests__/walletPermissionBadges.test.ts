jest.mock('react-native', () => ({ AppState: { currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useWalletPermissionBadges } from '../useWalletPermissionBadges';
import { invalidatePermissionDisplay, PERMISSION_DISPLAY_TTL, rememberPermissionDisplay } from '../permissionDisplayCache';
const { act, create } = require('react-test-renderer');
const wallet = (id: string, publicKey = 'key-new', account = 'alice') => ({ id, account, publicKey, authPermissions: ['active'] });
const resources = (account = 'alice', key = 'key-new') => ({ account, permissions: [{ name: 'active', keys: [key] }] });
let scope = 0;
const client = (getAccount: jest.Mock = jest.fn(async (account: string) => resources(account)), chainId = 'vaulta') =>
  ({ chainId, node: { url: `https://node-${++scope}.example` }, getAccount }) as any;
let result: Record<string, string[]>;
let renderer: any;
function Harness(props: { wallets: ReturnType<typeof wallet>[]; client: any; enabled?: boolean }) {
  result = useWalletPermissionBadges(props.wallets, props.client, props.enabled); return null;
}
const mount = async (props: any) => { await act(async () => { renderer = create(React.createElement(Harness, props)); }); };
const update = async (props: any) => { await act(async () => renderer.update(React.createElement(Harness, props))); };
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers(); jest.clearAllMocks(); AppState.currentState = 'active'; await AsyncStorage.clear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null; jest.clearAllTimers(); jest.useRealTimers();
});

test('deduplicates same-account keys and clears revoked badges without changing saved metadata', async () => {
  const wallets = [wallet('new'), wallet('old1', 'key-old1'), wallet('old2', 'key-old2')];
  const rpc = client();
  await mount({ wallets, client: rpc });
  expect(rpc.getAccount).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ new: ['active'], old1: [], old2: [] });
  expect(wallets.map(w => w.authPermissions)).toEqual([['active'], ['active'], ['active']]);
});

test('reopening and short background trips preserve badges and do not repeat fresh requests', async () => {
  const rpc = client(); const props = { wallets: [wallet('a'), wallet('b', 'key-new', 'bob')], client: rpc };
  await mount(props);
  await act(async () => jest.advanceTimersByTime(60000));
  await update({ ...props, enabled: false });
  expect(result).toEqual({ a: ['active'], b: ['active'] });
  await update({ ...props, enabled: true });
  const listener = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1];
  await act(async () => { listener('background'); listener('active'); });
  expect(result).toEqual({ a: ['active'], b: ['active'] });
  expect(rpc.getAccount).toHaveBeenCalledTimes(2);
  await act(async () => renderer.unmount());
  await mount(props);
  expect(result).toEqual({ a: ['active'], b: ['active'] });
  expect(rpc.getAccount).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(PERMISSION_DISPLAY_TTL - 60000));
  expect(rpc.getAccount).toHaveBeenCalledTimes(4);
});

test('expired badges stay visible during refresh and offline failures; a later refresh removes revoked keys', async () => {
  const rpc = client(); await mount({ wallets: [wallet('a')], client: rpc });
  let reject!: (e: Error) => void;
  rpc.getAccount.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  await act(async () => jest.advanceTimersByTime(PERMISSION_DISPLAY_TTL));
  expect(result).toEqual({ a: ['active'] });
  await act(async () => reject(new Error('offline')));
  expect(result).toEqual({ a: ['active'] });
  rpc.getAccount.mockImplementation(async () => resources('alice', 'replacement'));
  await act(async () => jest.advanceTimersByTime(60000));
  expect(result).toEqual({ a: [] });
  expect(rpc.getAccount).toHaveBeenCalledTimes(3);
});

test('cold persisted badges render before a slow RPC and concurrent readers share one refresh', async () => {
  let finish!: (value: any) => void;
  const rpc = client(jest.fn(() => new Promise(resolve => { finish = resolve; })) as any);
  await AsyncStorage.setItem('aurora.permissionDisplay.v1.' + JSON.stringify([rpc.chainId, rpc.node.url, 'alice']),
    JSON.stringify({ ...resources(), updatedAt: Date.now() - PERMISSION_DISPLAY_TTL }));
  const props = { wallets: [wallet('a')], client: rpc };
  await mount(props);
  expect(result).toEqual({ a: ['active'] });
  await update({ ...props, enabled: false }); await update(props);
  expect(rpc.getAccount).toHaveBeenCalledTimes(1);
  await act(async () => finish(resources('alice', 'replacement')));
  expect(result).toEqual({ a: [] });
});

test('network errors without verified cache never trust imported active or owner flags', async () => {
  const rpc = client(jest.fn(async () => { throw new Error('offline'); }));
  await mount({ wallets: [wallet('a')], client: rpc });
  expect(result).toEqual({ a: [] });
});

test('late reads from a previous node or chain cannot overwrite the new result', async () => {
  let finish!: (value: any) => void;
  const old = client(jest.fn(() => new Promise(resolve => { finish = resolve; })) as any);
  const wallets = [wallet('a')]; await mount({ wallets, client: old });
  await update({ wallets, client: client(jest.fn(async () => resources('alice', 'other')), 'jungle4') });
  expect(result).toEqual({ a: [] });
  await act(async () => finish(resources()));
  expect(result).toEqual({ a: [] });
});

test('closing stops queued requests; completed results remain scoped to their account', async () => {
  const finish: ((value: any) => void)[] = [];
  const rpc = client(jest.fn(() => new Promise(resolve => { finish.push(resolve); })) as any);
  const props = { wallets: ['alice', 'bob', 'carol', 'dan'].map(name => wallet(name, 'key-new', name)), client: rpc };
  await mount(props); expect(rpc.getAccount).toHaveBeenCalledTimes(3);
  await update({ ...props, enabled: false });
  await act(async () => { finish.forEach((done, i) => done(resources(['alice', 'bob', 'carol'][i]))); });
  expect(result).toEqual({ alice: ['active'], bob: ['active'], carol: ['active'], dan: [] });
  expect(rpc.getAccount).toHaveBeenCalledTimes(3);
});

test('fresh resources update badges without another RPC', async () => {
  const rpc = client(); rememberPermissionDisplay(rpc, resources() as any);
  await mount({ wallets: [wallet('a')], client: rpc });
  expect(result).toEqual({ a: ['active'] });
  await act(async () => rememberPermissionDisplay(rpc, resources('alice', 'replacement') as any));
  expect(result).toEqual({ a: [] });
  expect(rpc.getAccount).not.toHaveBeenCalled();
});
test('one-hour freshness does not delay a known permission change or allow a pre-change read to restore it', async () => {
  expect(PERMISSION_DISPLAY_TTL).toBe(60 * 60 * 1000);
  let finish!: (value: any) => void;
  const rpc = client(jest.fn(() => new Promise(resolve => { finish = resolve; })));
  await mount({ wallets: [wallet('a')], client: rpc });
  rpc.getAccount.mockImplementation(async () => resources('alice', 'replacement'));
  await act(async () => invalidatePermissionDisplay('vaulta', 'alice'));
  expect(rpc.getAccount).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ a: [] });
  await act(async () => finish(resources()));
  expect(result).toEqual({ a: [] });
});

test('opening publishes all account badges together even when RPC replies arrive one by one', async () => {
  const finish = new Map<string, (value: any) => void>();
  const rpc = client(jest.fn((account: string) => new Promise(resolve => { finish.set(account, resolve); })));
  await mount({ wallets: ['alice', 'bob', 'carol'].map(name => wallet(name, 'key-new', name)), client: rpc });
  expect(result).toEqual({ alice: [], bob: [], carol: [] });
  await act(async () => finish.get('bob')!(resources('bob')));
  expect(result).toEqual({ alice: [], bob: [], carol: [] });
  await act(async () => finish.get('alice')!(resources('alice')));
  expect(result).toEqual({ alice: [], bob: [], carol: [] });
  await act(async () => finish.get('carol')!(resources('carol')));
  expect(result).toEqual({ alice: ['active'], bob: ['active'], carol: ['active'] });
});
