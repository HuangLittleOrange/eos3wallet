jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('react-native', () => ({ AppState: { currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../../crypto/vault', () => ({
  listWallets: jest.fn(),
  signingPermission: jest.fn(() => 'active'),
  WalletReadError: class WalletReadError extends Error {},
}));
jest.mock('../customNodes', () => ({ listCustomNodes: jest.fn(async () => []) }));
jest.mock('../resourceRepairQuote', () => ({ refreshResourceRepairFee: jest.fn(async () => {}) }));
jest.mock('../eos3Sign', () => ({ eos3Get: jest.fn() }));
jest.mock('../walletCache', () => ({
  loadTokenSnapshot: jest.fn(async () => null),
  peekTokenSnapshot: jest.fn(() => null),
  saveTokenSnapshot: jest.fn(async () => {}),
}));
jest.mock('../prices', () => ({
  DEFAULT_PRICE_SOURCE: 'coingecko',
  fetchPrices: jest.fn(async () => null),
  loadPriceSnapshot: jest.fn(async () => null),
  peekPrices: jest.fn(() => null),
}));
jest.mock('../client', () => ({
  ChainClient: jest.fn().mockImplementation((chainId, node, historyNode) => ({
    chainId, node, historyNode,
    config: { systemToken: 'core.vaulta', symbol: 'A', precision: 4 },
    getInfo: jest.fn(async () => ({ headBlock: 1, latencyMs: 1 })),
    getAccount: jest.fn(async (account) => ({ account, permissions: [] })),
    getTokens: jest.fn(async () => []),
    getBalance: jest.fn(async () => []),
    getActions: jest.fn(async () => ({ actions: [] })),
    getRamPrice: jest.fn(async () => ({ pricePerKb: 0 })),
  })),
  probeNode: jest.fn(async () => null),
}));

import React from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { listWallets, StoredWallet } from '../../crypto/vault';
import { ChainClient } from '../client';
import { WalletProvider, useWallet } from '../WalletContext';
import { loadSession, saveSession } from '../session';
import { loadTokenSnapshot } from '../walletCache';
import { fetchPrices } from '../prices';
import { notifyWalletDataChanged } from '../walletDataEvents';
import { tokenDirectoryCache, tokenDirectoryKey } from '../tokenDirectory';
import { authorizedAppsCache, authorizedAppsKey } from '../authorizedAppsCache';
import { eos3Get } from '../eos3Sign';

const { act, create } = require('react-test-renderer');
let state: ReturnType<typeof useWallet>;
let root: ReturnType<typeof create>;
let renders: ReturnType<typeof useWallet>[] = [];

function Observer() {
  state = useWallet();
  renders.push(state);
  return null;
}

async function mount() {
  await act(async () => {
    root = create(React.createElement(WalletProvider, null, React.createElement(Observer)));
  });
}

const savedWallet: StoredWallet = {
  id: 'saved', account: 'myaccount', publicKey: 'EOS_PUB',
  source: 'privatekey', createdAt: 1, chainId: 'vaulta',
};

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.clearAllMocks();
  renders = [];
  AppState.currentState = 'active';
  jest.mocked(loadTokenSnapshot).mockResolvedValue(null);
  await AsyncStorage.clear();
  jest.mocked(listWallets).mockResolvedValue([]);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('首次无账户启动不查询默认账户', async () => {
  await mount();
  expect(state.walletsLoaded).toBe(true);
  expect(state.account).toBe('');
  expect(state.hasAccount).toBe(false);
  for (const client of jest.mocked(ChainClient).mock.results) {
    expect(client.value.getAccount).not.toHaveBeenCalled();
  }
});

it('旧占位会话恢复后仍无账户,重启也不会再出现', async () => {
  await saveSession({
    chainId: 'vaulta', account: 'bitfinexdep1', hasAccount: false,
    perChain: { vaulta: { account: 'bitfinexdep1', hasAccount: false } },
  });
  await mount();
  expect(state.hasAccount).toBe(false);
  expect((await loadSession())?.account).toBe('');
  await act(async () => root.unmount());
  await mount();
  expect(state.account).toBe('');
});

it('主动添加观察账户立即退出无账户状态,重启仍保留', async () => {
  await mount();
  await act(async () => state.setAccount('bitfinexdep1'));
  expect(state.hasAccount).toBe(true);
  expect((await loadSession())?.hasAccount).toBe(true);
  await act(async () => root.unmount());
  await mount();
  expect(state.account).toBe('bitfinexdep1');
  expect(state.hasAccount).toBe(true);
});

it('删除最后一个钱包后清空账户、余额和持久会话', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]);
  await mount();
  expect(state.account).toBe('myaccount');
  jest.mocked(listWallets).mockResolvedValue([]);
  await act(async () => state.reloadWallets());
  expect(state.account).toBe('');
  expect(state.hasAccount).toBe(false);
  expect(state.tokens).toEqual([]);
  expect(state.resources).toBeNull();
  expect((await loadSession())?.account).toBe('');
});

it('切换到没有账户的链进入空状态,切回恢复已有钱包', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]);
  await mount();
  await act(async () => state.setChain('jungle4'));
  expect(state.hasAccount).toBe(false);
  expect(state.account).toBe('');
  await act(async () => state.setChain('vaulta'));
  expect(state.account).toBe('myaccount');
  expect(state.currentWallet?.id).toBe('saved');
});

const token = (amount: number) => ({ contract: 'core.vaulta', symbol: 'A', precision: 4, amount, raw: `${amount}.0000 A` });

it('代币请求完成即可显示，不等待账户资源请求', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  let finish!: (value: any) => void;
  jest.mocked(state.client.getAccount).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  jest.mocked(state.client.getTokens).mockResolvedValueOnce([token(9)]);
  let request!: Promise<void>;
  await act(async () => { request = state.refresh(); });
  expect(state.status).toBe('loading');
  expect(state.tokens).toEqual([token(9)]);
  await act(async () => { finish({ account: 'myaccount', permissions: [] }); await request; });
  expect(state.status).toBe('ready');
});

it('切换账户不会显示前一账户的实时余额和资源，旧请求也不能覆盖新账户', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  const finishes = new Map<string, (value: any) => void>();
  jest.mocked(state.client.getTokens).mockImplementation(account => new Promise(resolve => { finishes.set(account, resolve); }));
  let oldRequest!: Promise<void>;
  await act(async () => { oldRequest = state.refresh(); });
  jest.mocked(loadTokenSnapshot).mockResolvedValueOnce({ tokens: [token(12)], updatedAt: Date.now() });
  await act(async () => state.setAccount('bob'));
  expect(state.account).toBe('bob'); expect(state.tokens).toEqual([]);
  expect(state.resources?.account).toBe('bob');
  expect(state.cachedTokens).toEqual([token(12)]);
  await act(async () => { finishes.get('myaccount')!([token(999)]); await oldRequest; });
  expect(state.tokens).toEqual([]); expect(state.cachedTokens).toEqual([token(12)]);
  expect(state.resources?.account).toBe('bob');
  await act(async () => finishes.get('bob')!([token(3)]));
  expect(state.tokens).toEqual([token(3)]);
});

it('余额每分钟独立刷新；短暂切后台不重查，超过资源周期回前台才重查资源', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  const getTokens = jest.mocked(state.client.getTokens);
  const calls = getTokens.mock.calls.length;
  const accountCalls = jest.mocked(state.client.getAccount).mock.calls.length;
  const listeners = jest.mocked(AppState.addEventListener).mock.calls.map(call => call[1]);
  await act(async () => { listeners.forEach(listener => listener('active')); });
  expect(getTokens).toHaveBeenCalledTimes(calls);
  await act(async () => jest.advanceTimersByTimeAsync(60 * 1000));
  expect(getTokens).toHaveBeenCalledTimes(calls + 1);
  expect(state.client.getAccount).toHaveBeenCalledTimes(accountCalls);
  AppState.currentState = 'background';
  await act(async () => jest.advanceTimersByTime(5 * 60 * 1000));
  expect(getTokens).toHaveBeenCalledTimes(calls + 1);
  AppState.currentState = 'active';
  await act(async () => { listeners.forEach(listener => listener('active')); });
  expect(getTokens).toHaveBeenCalledTimes(calls + 2);
  expect(state.client.getAccount).toHaveBeenCalledTimes(accountCalls + 1);
});

it('切换行情源只刷新行情，不带着余额和账户权限重查', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  const balances = jest.mocked(state.client.getTokens).mock.calls.length;
  const accounts = jest.mocked(state.client.getAccount).mock.calls.length;
  jest.mocked(fetchPrices).mockClear();
  await act(async () => state.setPriceSource('binance'));
  expect(fetchPrices).toHaveBeenCalledWith('binance');
  expect(state.client.getTokens).toHaveBeenCalledTimes(balances);
  expect(state.client.getAccount).toHaveBeenCalledTimes(accounts);
});

it('余额持续刷新不延长目录24小时缓存；新代币会立即补入目录', async () => {
  tokenDirectoryCache.invalidate(tokenDirectoryKey('vaulta', 'myaccount'));
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  const at = state.tokenDirectoryAt;
  jest.mocked(state.client.getTokens).mockResolvedValue([{ ...token(3), precision: 6 }]);
  await act(async () => jest.advanceTimersByTimeAsync(60000));
  expect(state.tokens[0].precision).toBe(6);
  expect(state.tokenDirectory[0].precision).toBe(4);
  expect(state.tokenDirectoryAt).toBe(at);
  jest.mocked(state.client.getTokens).mockResolvedValue([token(3), { contract: 'tethertether', symbol: 'USDT', precision: 6, amount: 2, raw: '2.000000 USDT' }]);
  await act(async () => jest.advanceTimersByTimeAsync(60000));
  expect(state.tokenDirectory.map(token => token.symbol)).toContain('USDT');
  expect(state.tokenDirectoryAt).toBe(at);
});

it('操作成功的通知立即更新余额、目录与已加载授权列表，无需等待提示框关闭', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  const key = authorizedAppsKey('vaulta', 'myaccount');
  authorizedAppsCache.remember(key, { eosAccount: 'myaccount', permissions: [], assetCatalog: [] });
  const app = { permission: 'demo', parent: 'active', active: true, managedByPayLimit: true,
    assets: [], threshold: 1, keys: 1, accounts: 0, linkedActions: 0 };
  jest.mocked(eos3Get).mockResolvedValue({ eosAccount: 'myaccount', permissions: [app], assetCatalog: [] });
  jest.mocked(state.client.getBalance).mockResolvedValue([token(2)]);
  const calls = jest.mocked(state.client.getTokens).mock.calls.length;
  await act(async () => notifyWalletDataChanged({ chainId: 'vaulta', accounts: ['myaccount'], permissions: true }));
  expect(state.client.getTokens).toHaveBeenCalledTimes(calls + 1);
  expect(state.tokens[0].amount).toBe(2);
  expect(authorizedAppsCache.get(key).data?.permissions).toEqual([app]);
  expect(state.tokenDirectoryAt).toBeGreaterThan(0);
});
it('操作后等待余额更新期间保留展示快照，但不能用变更前的余额放行下一笔转账', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  jest.mocked(state.client.getTokens).mockResolvedValue([token(8)]);
  await act(async () => state.refresh());
  let finish!: (value: any) => void;
  jest.mocked(state.client.getBalance).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => notifyWalletDataChanged({ chainId: 'vaulta', accounts: ['myaccount'] }));
  expect(state.tokens).toEqual([]); expect(state.cachedTokens?.[0].amount).toBe(8);
  await act(async () => finish([token(1)]));
  expect(state.tokens[0].amount).toBe(1);
});

const historyPage = (id: string) => ({ actions: [{ id, seq: 1, time: '2026-10-16T00:00:00Z',
  contract: 'core.vaulta', action: 'transfer', from: 'bob', to: 'myaccount', direction: 'in' as const }], hasMore: false });
it('交易历史独立更新，失败后保留已有记录与错误提示', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  jest.mocked(state.client.getActions).mockResolvedValueOnce(historyPage('success'));
  await act(async () => state.refresh()); expect(state.actions[0]?.id).toBe('success');
  const previous = state.actions;
  jest.mocked(state.client.getActions).mockRejectedValueOnce(new Error('offline'));
  await act(async () => state.refresh());
  expect(state.actions).toBe(previous); expect(state.actionsFailed).toBe(true);
  jest.mocked(state.client.getActions).mockResolvedValueOnce(historyPage('success'));
  await act(async () => state.refresh());
  expect(state.actions).toBe(previous); expect(state.actionsFailed).toBe(false);
});

it('旧账户的历史响应不能混进新账户或消息列表', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  let finish!: (value: any) => void;
  jest.mocked(state.client.getActions).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => state.refresh());
  await act(async () => state.setAccount('otheruser'));
  await act(async () => finish(historyPage('old-account')));
  expect(state.account).toBe('otheruser'); expect(state.actions).toEqual([]);
});


it('切换账户的每一帧都隔离旧余额、资源和加载状态，不等待 effect 才清空', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  jest.mocked(state.client.getTokens).mockResolvedValueOnce([token(42)]);
  await act(async () => state.refresh());
  expect(state.tokens).toEqual([token(42)]);
  jest.mocked(state.client.getTokens).mockImplementation(() => new Promise(() => {}));
  jest.mocked(state.client.getAccount).mockImplementation(() => new Promise(() => {}));
  renders = [];
  await act(async () => state.setAccount('newaccount'));
  const switched = renders.filter(frame => frame.account === 'newaccount');
  expect(switched.length).toBeGreaterThan(0);
  for (const frame of switched) {
    expect(frame.tokens).toEqual([]);
    expect(frame.resources).toBeNull();
    expect(frame.cachedTokens).toBeNull();
    expect(frame.status).toBe('loading');
    expect(frame.error).toBeNull();
    expect(frame.headBlock).toBe(0);
  }
});

it('自动切换分别保存 RPC 和历史节点，旧 client 不能覆盖手动选择', async () => {
  jest.mocked(listWallets).mockResolvedValue([savedWallet]); await mount();
  const old = jest.mocked(ChainClient).mock.calls.at(-1)![3]!;
  const previousHistory = state.historyNode;
  const rpc = { id: 'auto-rpc', name: 'Auto RPC', url: 'https://auto-rpc.example' };
  await act(async () => old.onSwitch!('rpc', rpc));
  expect(state.node).toEqual(rpc);
  expect(state.historyNode).toEqual(previousHistory);
  expect((await loadSession())?.nodeId).toBe('auto-rpc');
  const active = jest.mocked(ChainClient).mock.calls.at(-1)![3]!;
  const history = { id: 'auto-history', name: 'Auto History', url: 'https://auto-history.example' };
  await act(async () => active.onSwitch!('history', history));
  expect(state.node).toEqual(rpc); expect(state.historyNode).toEqual(history);
  expect((await loadSession())?.historyNodeId).toBe('auto-history');
  const stale = jest.mocked(ChainClient).mock.calls.at(-1)![3]!;
  const manual = { id: 'manual', name: 'Manual', url: 'https://manual.example' };
  await act(async () => {
    state.setNode(manual);
    stale.onSwitch!('rpc', rpc);
    old.onSwitch!('history', previousHistory);
  });
  expect(state.node).toEqual(manual); expect(state.historyNode).toEqual(history);
  expect((await loadSession())?.nodeId).toBe('manual');
});
