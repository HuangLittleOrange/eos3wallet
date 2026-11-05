jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../dappGate', () => ({ getRiskAck: jest.fn(), setRiskAck: jest.fn(), addDappHistory: jest.fn() }));
import React from 'react';
import { useWalletSession } from '../../chain/WalletContext';
import { DappSessionProvider, useDappSession } from '../DappSessionContext';
import { useOpenDapp } from '../useOpenDapp';
import { getRiskAck, addDappHistory } from '../dappGate';
const { create, act } = require('react-test-renderer');
let renderer: any, session: ReturnType<typeof useDappSession>, opener: ReturnType<typeof useOpenDapp>;
let observed: (string | null)[];
function Harness() { session = useDappSession(); opener = useOpenDapp(); observed.push(session.session?.url ?? null); return null; }
const tree = () => React.createElement(DappSessionProvider, null, React.createElement(Harness));
async function network(chainId: 'vaulta' | 'jungle4') {
  jest.mocked(useWalletSession).mockReturnValue({ chainId } as any);
  await act(async () => renderer.update(tree()));
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); observed = [];
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'vaulta' } as any);
  jest.mocked(getRiskAck).mockResolvedValue(false);
  await act(async () => { renderer = create(tree()); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });

test('switching networks immediately removes the old browser, minimized state and pending ESR', async () => {
  await act(async () => { session.openDapp('https://main.example', 'vaulta'); session.openEsr('esr:main'); session.minimize(); });
  expect(session.session?.networkId).toBe('vaulta');
  expect(session.pendingEsr).toBe('esr:main');
  observed = [];
  await network('jungle4');
  expect(observed.every(value => value === null)).toBe(true);
  expect(session.minimized).toBe(false);
  expect(session.pendingEsr).toBeNull();
  await act(async () => session.openDapp('https://late-main.example', 'vaulta'));
  expect(session.session).toBeNull();
  await network('vaulta');
  expect(session.session).toBeNull();
});

test('a late risk lookup and old confirmation cannot open a previous network URL', async () => {
  let resolve!: (ack: boolean) => void;
  jest.mocked(getRiskAck).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  let pending!: Promise<void>;
  await act(async () => { pending = opener.open('https://main.example'); });
  await network('jungle4');
  await act(async () => { resolve(true); await pending; });
  expect(session.session).toBeNull();
  expect(addDappHistory).not.toHaveBeenCalled();
  await act(async () => { await opener.open('https://test.example'); });
  const oldConfirm = opener.confirm;
  await network('vaulta');
  await act(async () => oldConfirm(true));
  expect(session.session).toBeNull();
});

test('only the latest request can confirm, and confirming twice opens just once', async () => {
  await act(async () => { await opener.open('https://first.example'); });
  const firstConfirm = opener.confirm;
  let resolve!: (ack: boolean) => void;
  jest.mocked(getRiskAck).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  let pending!: Promise<void>;
  await act(async () => { pending = opener.open('https://second.example'); firstConfirm(false); });
  expect(session.session).toBeNull();
  await act(async () => { resolve(false); await pending; });
  expect(opener.pending).toBe('https://second.example');
  const confirm = opener.confirm;
  await act(async () => { confirm(false); confirm(false); });
  expect(session.session?.url).toBe('https://second.example');
  expect(addDappHistory).toHaveBeenCalledTimes(1);
  expect(addDappHistory).toHaveBeenCalledWith('https://second.example', undefined, 'vaulta');
});
