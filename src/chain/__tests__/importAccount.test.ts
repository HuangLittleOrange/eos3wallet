jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: (...args: any[]) => require('../../net/fetchRetry').fetchWithRetry(...args) }));
import { PrivateKey } from '@wharfkit/antelope';
import { CHAINS } from '../config';
import { fetchWithRetry } from '../../net/fetchRetry';
import { readDirectSigningKeys, verifyImportedAccount, verifyCreatedAccount } from '../importAccount';
import { rpcResponse, stalledRpcResponse } from './rpcResponse';

const key = PrivateKey.generate('K1').toPublic();
const other = PrivateKey.generate('K1').toPublic();
const auth = (publicKey = String(key), threshold = 1) => ({ threshold,
  keys: [{ key: publicKey, weight: 1 }], accounts: [], waits: [] });
const permission = (name: string, parent: string, required_auth = auth()) => ({ perm_name: name, parent, required_auth });
const state = () => ({ account_name: 'alice', permissions: [permission('owner', ''), permission('active', 'owner')] });
const options = { chainId: 'vaulta' as const, account: 'alice', publicKey: String(key), permissions: ['active'] };
const network = jest.mocked(fetchWithRetry);
function serve(choose = (_url: string) => state(), chainId: string = CHAINS.vaulta.chainIdHash) {
  network.mockImplementation(async url => rpcResponse(String(url).endsWith('/get_info') ? { chain_id: chainId } : choose(String(url))));
}
beforeEach(() => { jest.resetAllMocks(); serve(); });
afterEach(() => { jest.useRealTimers(); });

test('external signing keys require direct sufficient weight for the exact permission and corroborated authority', async () => {
  await expect(readDirectSigningKeys({ chainId: 'vaulta', account: 'alice', permission: 'active' })).resolves.toEqual([String(key)]);
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', ''),
    permission('active', 'owner', auth(String(key), 2)), permission('custom', 'active', auth(String(other)))] }));
  await expect(readDirectSigningKeys({ chainId: 'vaulta', account: 'alice', permission: 'active' })).resolves.toEqual([]);
  await expect(readDirectSigningKeys({ chainId: 'vaulta', account: 'alice', permission: 'custom' })).resolves.toEqual([String(other)]);
  await expect(readDirectSigningKeys({ chainId: 'vaulta', account: 'alice', permission: 'missing' })).resolves.toEqual([]);
});

test('requires independent built-in hosts and sends only the candidate account, never a key or password', async () => {
  await verifyImportedAccount(options);
  const calls = network.mock.calls;
  expect(new Set(calls.map(([url]) => new URL(String(url)).hostname)).size).toBeGreaterThanOrEqual(2);
  for (const [url, init] of calls) {
    expect(CHAINS.vaulta.nodes.some(n => String(url).startsWith(n.url + '/'))).toBe(true);
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual(String(url).endsWith('/get_info') ? {} : { account_name: 'alice' });
  }
});
test('a false key membership from one built-in source is outvoted; a discovery claim cannot authorize import', async () => {
  serve(url => url.startsWith(CHAINS.vaulta.nodes[0].url + '/') ? state() : {
    account_name: 'alice', permissions: [permission('owner', '', auth(String(other))), permission('active', 'owner', auth(String(other)))],
  });
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountKeyMismatch');
});
test('semantically identical legacy/new public keys and reordered permissions agree', async () => {
  serve(url => ({ ...state(), permissions: url.startsWith(CHAINS.vaulta.nodes[0].url + '/')
    ? [permission('active', 'owner', auth(key.toLegacyString())), permission('owner', '', auth(key.toLegacyString()))]
    : state().permissions }));
  await expect(verifyImportedAccount(options)).resolves.toBeUndefined();
});
test('owner keys may authorize active/custom children, but active keys cannot claim owner', async () => {
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', ''),
    permission('active', 'owner', auth(String(other))), permission('custom', 'active', auth(String(other)))] }));
  await expect(verifyImportedAccount({ ...options, permissions: ['active', 'owner', 'custom'] })).resolves.toBeUndefined();
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', '', auth(String(other))), permission('active', 'owner')] }));
  await expect(verifyImportedAccount({ ...options, permissions: ['owner'] })).rejects.toThrow('accountKeyMismatch');
  await expect(verifyImportedAccount({ ...options, permissions: ['missing'] })).rejects.toThrow('accountKeyMismatch');
});
test('legitimate partial multisig members remain importable without treating their weight as full control', async () => {
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', '', auth(String(other))), permission('active', 'owner', auth(String(key), 2))] }));
  await expect(verifyImportedAccount(options)).resolves.toBeUndefined();
});
test('a key directly assigned to a custom permission remains importable without active/owner membership', async () => {
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', '', auth(String(other))),
    permission('active', 'owner', auth(String(other))), permission('custom', 'active')] }));
  await expect(verifyImportedAccount({ ...options, permissions: ['custom'] })).resolves.toBeUndefined();
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountKeyMismatch');
});
test('device enrollment still requires a direct active key meeting its threshold', async () => {
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', ''),
    permission('active', 'owner', auth(String(key), 2))] }));
  await expect(verifyImportedAccount({ ...options, requireDirectThreshold: true })).rejects.toThrow('accountKeyMismatch');
  serve();
  await expect(verifyImportedAccount({ ...options, requireDirectThreshold: true })).resolves.toBeUndefined();
});
test('signup returns only independently verified permissions that its new key can satisfy', async () => {
  await expect(verifyCreatedAccount(options)).resolves.toEqual(['active', 'owner']);
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', '', auth(String(other))),
    permission('active', 'owner'), permission('custom', 'active', auth(String(key), 2))] }));
  await expect(verifyCreatedAccount(options)).resolves.toEqual(['active']);
});
test('signup also permits an owner key, without claiming direct control of other permissions', async () => {
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', ''), permission('active', 'owner', auth(String(other))), permission('aaa', 'active')] }));
  await expect(verifyCreatedAccount(options)).resolves.toEqual(['owner', 'aaa']);
});
test.each(['unrelated', 'partial', 'custom'])('signup rejects a new key with only %s authority; manual import keeps multisig support', async kind => {
  serve(() => ({ account_name: 'alice', permissions: [permission('owner', '', auth(String(other))),
    permission('active', 'owner', auth(kind === 'partial' ? String(key) : String(other), kind === 'partial' ? 2 : 1)),
    permission('custom', 'active')] }));
  await expect(verifyCreatedAccount(options)).rejects.toThrow('accountKeyMismatch');
  if (kind === 'partial') await expect(verifyImportedAccount(options)).resolves.toBeUndefined();
});
test('wrong chain, wrong account, malformed authority and conflicting snapshots fail closed', async () => {
  serve(() => state(), CHAINS.jungle4.chainIdHash);
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountVerificationFailed');
  serve(() => ({ ...state(), account_name: 'attacker' }));
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountVerificationFailed');
  serve(() => ({ ...state(), permissions: [permission('owner', ''), permission('active', 'owner', auth(String(key), 0))] }));
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountVerificationFailed');
  serve(url => ({ ...state(), permissions: [permission('owner', ''),
    permission('active', 'owner', auth(String(key), CHAINS.vaulta.nodes.findIndex(n => url.startsWith(n.url + '/')) + 1))] }));
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountVerificationFailed');
});
test('every save rechecks authority and a failed read can be retried', async () => {
  await verifyImportedAccount(options);
  const count = network.mock.calls.length;
  network.mockRejectedValue(new Error('offline'));
  await expect(verifyImportedAccount(options)).rejects.toThrow('accountVerificationFailed');
  serve(); await verifyImportedAccount(options);
  expect(network.mock.calls.length).toBeGreaterThan(count);
});
test('cancellation and stalled response bodies have bounded completion', async () => {
  jest.useFakeTimers();
  network.mockImplementation(async () => stalledRpcResponse());
  const controller = new AbortController();
  const cancelled = expect(verifyImportedAccount({ ...options, signal: controller.signal })).rejects.toThrow('accountVerificationFailed');
  controller.abort(); await cancelled;
  const timeout = expect(verifyImportedAccount(options)).rejects.toThrow('accountVerificationFailed');
  await jest.advanceTimersByTimeAsync(12_001); await timeout;
});
test('Jungle imports use the Jungle authorities and invalid selections do not issue requests', async () => {
  serve(() => state(), CHAINS.jungle4.chainIdHash);
  await verifyImportedAccount({ ...options, chainId: 'jungle4' });
  expect(network.mock.calls.every(([url]) => CHAINS.jungle4.nodes.some(n => String(url).startsWith(n.url + '/')))).toBe(true);
  network.mockClear();
  await expect(verifyImportedAccount({ ...options, account: 'account6' })).rejects.toThrow();
  await expect(verifyImportedAccount({ ...options, permissions: [] })).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
