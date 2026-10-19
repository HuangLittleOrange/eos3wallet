import { DappAccessGuard, dappPageOrigin, secureDappOrigin } from '../accessGuard';

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

test('disconnect invalidates old signatures and connection prompts even after reconnect and id reuse', () => {
  const guard = connectedGuard();
  guard.accept('doc:sign', 'doc', source, context);
  guard.accept('doc:connect', 'doc', source, context);
  const oldSign = guard.capture('doc:sign', context);
  const oldConnect = guard.capture('doc:connect', context);
  guard.disconnect();
  expect(oldSign()).toBe(false); expect(oldConnect()).toBe(false);
  expect(guard.connect('doc:connect', context)).toBe(false);
  expect(guard.accept('doc:connect', 'doc', source, context)).toBe(true);
  expect(guard.connect('doc:connect', context)).toBe(true);
  expect(guard.accept('doc:sign', 'doc', source, context)).toBe(true);
  expect(oldSign()).toBe(false); expect(oldConnect()).toBe(false);
  expect(guard.capture('doc:sign', context)()).toBe(true);
});

test('origins are isolated by scheme, host and port; HTTP cannot connect', () => {
  const guard = connectedGuard();
  for (const url of ['https://other.example', 'https://app.example:444', 'http://app.example']) {
    guard.navigate(url, context);
    expect(guard.connected()).toBe(false);
  }
  for (const url of ['file:///a', 'javascript:alert(1)', 'https://user:password@app.example', 'bad']) expect(secureDappOrigin(url)).toBeNull();
});

test('HTTP accepts ESR confirmation requests without allowing wallet APIs or connection grants', () => {
  const page = 'http://192.168.31.51:8787/';
  const guard = new DappAccessGuard();
  guard.navigate(page, context);
  expect(dappPageOrigin(page)).toBe('http://192.168.31.51:8787');
  expect(secureDappOrigin(page)).toBeNull();
  expect(guard.accept('doc:1', 'doc', page, context, 'esrRequest')).toBe(true);
  expect(guard.connect('doc:1', context)).toBe(false);
  expect(guard.connected()).toBe(false);
  for (const method of ['getIdentity', 'getIdentityFromPermissions', 'getAccount', 'signTransaction', 'requestSignature', 'arbitrarySignature', undefined]) {
    expect(guard.accept('doc:2', 'doc', page, context, method)).toBe(false);
  }
});

test('HTTP ESR requests retain origin, document, wallet context and navigation isolation', () => {
  const page = 'http://192.168.31.51:8787/';
  const guard = new DappAccessGuard();
  guard.navigate(page, context);
  for (const url of ['http://192.168.31.52:8787/', 'http://192.168.31.51:8788/', 'https://192.168.31.51:8787/', 'http://user:password@192.168.31.51:8787/']) {
    expect(guard.accept('doc:1', 'doc', url, context, 'esrRequest')).toBe(false);
  }
  expect(guard.accept('doc:1', 'doc', page, 'other-wallet', 'esrRequest')).toBe(false);
  expect(guard.accept('doc:1', 'doc', page, context, 'esrRequest')).toBe(true);
  expect(guard.accept('other:1', 'other', page, context, 'esrRequest')).toBe(false);
  const current = guard.capture('doc:1', context);
  guard.navigate('http://192.168.31.52:8787/', context);
  expect(current()).toBe(false);
  expect(guard.accept('doc:2', 'doc', page, context, 'esrRequest')).toBe(false);
  for (const url of ['file:///a', 'javascript:alert(1)', 'data:text/html,a', 'about:blank']) {
    guard.navigate(url, context);
    expect(guard.accept('doc:1', 'doc', url, context, 'esrRequest')).toBe(false);
  }
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
