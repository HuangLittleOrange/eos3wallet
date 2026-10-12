jest.mock('react-native', () => ({ AppState: { currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
import React from 'react';
import { AppState } from 'react-native';
import { useSigningGuard } from '../useSigningGuard';
import { withSystemAuthentication } from '../../crypto/systemAuthentication';
const { act, create } = require('react-test-renderer');
let guard: ReturnType<typeof useSigningGuard>;
let renderer: any;
const changed = jest.fn();
function Harness({ context, confirmation }: { context: string; confirmation: unknown }) {
  guard = useSigningGuard(context, confirmation, changed); return null;
}
const confirmation = [{}];
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); });
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = null; });
const mount = async () => { await act(async () => { renderer = create(React.createElement(Harness, { context: 'wallet-a/mainnet', confirmation })); }); };
test('prevents repeated clicks from creating concurrent signing attempts', async () => {
  await mount(); const first = guard.begin()!;
  expect(first.isCurrent()).toBe(true); expect(guard.begin()).toBeNull();
  first.finish(); expect(guard.begin()).not.toBeNull();
});
test('wallet/node/network changes invalidate a pending signer and its old confirmation', async () => {
  await mount(); const first = guard.begin()!;
  await act(async () => renderer.update(React.createElement(Harness, { context: 'wallet-b/testnet', confirmation })));
  expect(first.isCurrent()).toBe(false); first.finish();
  expect(guard.begin()).toBeNull(); expect(changed).toHaveBeenCalledTimes(1);
});
test('cancelling or replacing the confirmation invalidates the attempt', async () => {
  await mount(); const first = guard.begin()!;
  await act(async () => renderer.update(React.createElement(Harness, { context: 'wallet-a/mainnet', confirmation: null })));
  expect(first.isCurrent()).toBe(false); first.finish(); expect(guard.begin()).toBeNull();
});
test('background cancels work; a biometric inactive transition does not', async () => {
  await mount(); const first = guard.begin()!;
  const listener = jest.mocked(AppState.addEventListener).mock.calls[0][1];
  listener('inactive'); expect(first.isCurrent()).toBe(true);
  listener('background'); expect(first.isCurrent()).toBe(false);
});
test('system credential picker temporarily pauses an attempt until foreground without invalidating it', async () => {
  await mount(); const first = guard.begin()!;
  const listener = jest.mocked(AppState.addEventListener).mock.calls[0][1];
  await withSystemAuthentication(async () => {
    AppState.currentState = 'background'; listener('background');
    expect(first.isCurrent()).toBe(false);
    AppState.currentState = 'active'; listener('active');
  });
  expect(first.isCurrent()).toBe(true); first.finish();
});
test('unmount cancels outstanding authentication', async () => {
  await mount(); const first = guard.begin()!;
  await act(async () => renderer.unmount()); renderer = null;
  expect(first.isCurrent()).toBe(false);
});
