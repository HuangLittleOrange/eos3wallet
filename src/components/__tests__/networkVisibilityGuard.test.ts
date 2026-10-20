jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/networkVisibility', () => ({ useNetworkVisibility: jest.fn() }));
import React from 'react';
import { useWalletSession } from '../../chain/WalletContext';
import { useNetworkVisibility } from '../../chain/networkVisibility';
import NetworkVisibilityGuard from '../NetworkVisibilityGuard';
const { create, act } = require('react-test-renderer');
let renderer: any;
const setChain = jest.fn();
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); });
afterEach(async () => { await act(async () => renderer.unmount()); });

test('hidden active networks fall back only after both the session and settings are restored', async () => {
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'jungle4', walletsLoaded: false, setChain } as any);
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta'], ready: true, readError: false });
  await act(async () => { renderer = create(React.createElement(NetworkVisibilityGuard)); });
  expect(setChain).not.toHaveBeenCalled();
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'jungle4', walletsLoaded: true, setChain } as any);
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta'], ready: false, readError: false });
  await act(async () => renderer.update(React.createElement(NetworkVisibilityGuard)));
  expect(setChain).not.toHaveBeenCalled();
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta'], ready: true, readError: false });
  await act(async () => renderer.update(React.createElement(NetworkVisibilityGuard)));
  expect(setChain).toHaveBeenCalledWith('vaulta');
});

test('enabled test networks and failed preference reads do not change the session', async () => {
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'jungle4', walletsLoaded: true, setChain } as any);
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta', 'jungle4'], ready: true, readError: false });
  await act(async () => { renderer = create(React.createElement(NetworkVisibilityGuard)); });
  expect(setChain).not.toHaveBeenCalled();
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta'], ready: true, readError: true });
  await act(async () => renderer.update(React.createElement(NetworkVisibilityGuard)));
  expect(setChain).not.toHaveBeenCalled();
});
