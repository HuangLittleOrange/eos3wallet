jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../crypto/vault', () => ({
  listWallets: jest.fn(),
  signingPermission: jest.fn(() => 'active'),
  WalletReadError: class WalletReadError extends Error {},
}));
jest.mock('../customNodes', () => ({ listCustomNodes: jest.fn(async () => []) }));
jest.mock('../resourceRepairQuote', () => ({ refreshResourceRepairFee: jest.fn(async () => {}) }));
jest.mock('../walletCache', () => ({
  loadTokenSnapshot: jest.fn(async () => null),
  saveTokenSnapshot: jest.fn(async () => {}),
}));
jest.mock('../prices', () => ({
  DEFAULT_PRICE_SOURCE: 'coingecko',
  fetchPrices: jest.fn(async () => null),
}));
jest.mock('../client', () => ({
  ChainClient: jest.fn().mockImplementation(() => ({
    config: { systemToken: 'core.vaulta', symbol: 'A', precision: 4 },
    getInfo: jest.fn(async () => ({ headBlock: 1, latencyMs: 1 })),
    getAccount: jest.fn(async () => ({ permissions: [] })),
    getTokens: jest.fn(async () => []),
    getBalance: jest.fn(async () => []),
    getActions: jest.fn(async () => ({ actions: [] })),
    getRamPrice: jest.fn(async () => ({ pricePerKb: 0 })),
  })),
  probeNode: jest.fn(async () => null),
}));

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { listWallets, StoredWallet } from '../../crypto/vault';
import { ChainClient } from '../client';
import { WalletProvider, useWallet } from '../WalletContext';
import { loadSession, saveSession } from '../session';

const { act, create } = require('react-test-renderer');
let state: ReturnType<typeof useWallet>;
let root: ReturnType<typeof create>;

function Observer() {
  state = useWallet();
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
  jest.useFakeTimers();
  jest.clearAllMocks();
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
