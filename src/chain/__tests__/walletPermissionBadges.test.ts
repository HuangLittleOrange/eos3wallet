jest.mock('react-native', () => ({ AppState: { currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import React from 'react';
import { AppState } from 'react-native';
import { useWalletPermissionBadges } from '../useWalletPermissionBadges';
const { act, create } = require('react-test-renderer');
const wallet = (id: string, publicKey = 'key-new', account = 'alice') => ({ id, account, publicKey, authPermissions: ['active'] });
const resources = (account = 'alice', key = 'key-new') => ({ account, permissions: [{ name: 'active', keys: [key] }] });
let result: Record<string, string[]>;
let renderer: any;
function Harness(props: { wallets: ReturnType<typeof wallet>[]; client: any; enabled?: boolean }) {
  result = useWalletPermissionBadges(props.wallets, props.client, props.enabled); return null;
}
const mount = async (props: any) => { await act(async () => { renderer = create(React.createElement(Harness, props)); }); };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); AppState.currentState = 'active'; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('deduplicates same-account keys and clears revoked badges, without changing saved metadata', async () => {
  const wallets = [wallet('new'), wallet('old1', 'key-old1'), wallet('old2', 'key-old2')];
  const getAccount = jest.fn(async () => resources());
  await mount({ wallets, client: { getAccount } });
  expect(getAccount).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ new: ['active'], old1: [], old2: [] });
  expect(wallets.map(w => w.authPermissions)).toEqual([['active'], ['active'], ['active']]);
});

test('refreshes each account on reopening and when the App returns from background', async () => {
  const getAccount = jest.fn(async (account: string) => resources(account));
  const props = { wallets: [wallet('a'), wallet('b', 'key-new', 'bob')], client: { getAccount } };
  await mount({ ...props, enabled: false });
  expect(getAccount).not.toHaveBeenCalled(); expect(result).toEqual({ a: [], b: [] });
  await act(async () => renderer.update(React.createElement(Harness, { ...props, enabled: true })));
  expect(result).toEqual({ a: ['active'], b: ['active'] });
  getAccount.mockImplementation(async account => resources(account, 'replacement'));
  const listener = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1];
  await act(async () => listener('background'));
  expect(result).toEqual({ a: [], b: [] });
  await act(async () => listener('active'));
  expect(result).toEqual({ a: [], b: [] });
  expect(getAccount).toHaveBeenCalledTimes(4);
});

test('network errors show empty permissions, not cached active or owner', async () => {
  await mount({ wallets: [wallet('a')], client: { getAccount: jest.fn(async () => { throw new Error('offline'); }) } });
  expect(result).toEqual({ a: [] });
});

test('late reads from a previous node or chain cannot overwrite the new result', async () => {
  let finish!: (value: any) => void;
  const old = { getAccount: jest.fn(() => new Promise(resolve => { finish = resolve; })) };
  const wallets = [wallet('a')];
  await mount({ wallets, client: old });
  await act(async () => renderer.update(React.createElement(Harness, { wallets, client: { getAccount: async () => resources('alice', 'other') } })));
  expect(result).toEqual({ a: [] });
  await act(async () => finish(resources()));
  expect(result).toEqual({ a: [] });
});

test('does not share permissions across accounts or start new reads after closing', async () => {
  let finish!: (value: any) => void;
  const getAccount = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const props = { wallets: [wallet('a'), wallet('b', 'key-new', 'bob')], client: { getAccount } };
  await mount(props);
  await act(async () => renderer.update(React.createElement(Harness, { ...props, enabled: false })));
  await act(async () => finish(resources('alice')));
  expect(result).toEqual({ a: [], b: [] });
});
