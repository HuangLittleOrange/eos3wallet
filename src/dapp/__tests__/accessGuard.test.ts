import { DappAccessGuard, secureDappOrigin } from '../accessGuard';

const source = 'https://app.example/path';
const context = 'wallet-a:chain-a:node-a';
test('reusing a cancelled or completed id cannot revive an old authentication result', () => {
  const guard = new DappAccessGuard(); guard.navigate(source, context);
  guard.accept('doc:1', 'doc', source, context);
  const cancelled = guard.capture('doc:1', context);
  guard.cancelPending(); guard.accept('doc:1', 'doc', source, context);
  expect(cancelled()).toBe(false);
  const completed = guard.capture('doc:1', context);
  guard.finish('doc:1', context); guard.accept('doc:1', 'doc', source, context);
  expect(completed()).toBe(false);
  expect(guard.capture('doc:1', context)()).toBe(true);
});
function connectedGuard() {
  const guard = new DappAccessGuard();
  guard.navigate(source, context);
  expect(guard.accept('doc:1', 'doc', source, context)).toBe(true);
  expect(guard.connect('doc:1', context)).toBe(true);
  return guard;
}

test('no permission before consent; explicit logout revokes it', () => {
  const guard = new DappAccessGuard();
  guard.navigate(source, context);
  expect(guard.connected()).toBe(false);
  expect(guard.connect('unknown', context)).toBe(false);
  expect(guard.accept('doc:1', 'doc', source, context)).toBe(true);
  expect(guard.connected()).toBe(false);
  guard.connect('doc:1', context);
  expect(guard.connected()).toBe(true);
  guard.disconnect();
  expect(guard.connected()).toBe(false);
});

test('origins are isolated by scheme, host and port; HTTP cannot connect', () => {
  const guard = connectedGuard();
  for (const url of ['https://other.example', 'https://app.example:444', 'http://app.example']) {
    guard.navigate(url, context);
    expect(guard.connected()).toBe(false);
  }
  for (const url of ['file:///a', 'javascript:alert(1)', 'https://user:password@app.example', 'bad']) expect(secureDappOrigin(url)).toBeNull();
});

test('wallet, chain, node and navigation changes invalidate outstanding requests', () => {
  const guard = connectedGuard();
  expect(guard.current('doc:1', context)).toBe(true);
  expect(guard.current('doc:1', 'other-wallet')).toBe(false);
  guard.navigate(source + '/next', context);
  expect(guard.current('doc:1', context)).toBe(false);
  expect(guard.connect('doc:1', context)).toBe(false);
  // Refresh can reconnect silently only in the same browser session and context.
  expect(guard.connected()).toBe(true);
  guard.navigate(source, 'other-wallet');
  expect(guard.connected()).toBe(false);
});

test('rejects cross-origin messages, duplicate IDs and replies from another document', () => {
  const guard = connectedGuard();
  expect(guard.accept('doc:2', 'doc', 'https://evil.example', context)).toBe(false);
  expect(guard.accept('doc:1', 'doc', source, context)).toBe(false);
  expect(guard.accept('different:1', 'different', source, context)).toBe(false);
  expect(guard.finish('doc:1', context)).toBe(true);
  expect(guard.finish('doc:1', context)).toBe(false);
});
