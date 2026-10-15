jest.mock('../../i18n', () => ({ t: (key: string, vars?: unknown) => vars ? `${key}:${JSON.stringify(vars)}` : key }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithTimeout: jest.fn() }));
import { PrivateKey } from '@wharfkit/antelope';
import { fetchWithTimeout } from '../../net/fetchRetry';
import { AuthorizationFailureError, chainErrorText, diagnoseAuthorization, explainAuthorizationFailure, isAuthorizationFailure } from '../authorizationError';
const context = { actor: 'alice', permission: 'active' };
const pub = 'PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5BoDq63';
const legacy = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const other = PrivateKey.generate('K1').toPublic().toString();
const permission = (name: string, keys: { key: string; weight: number }[], threshold = 1, extra = {}) => ({
  perm_name: name, parent: name === 'owner' ? '' : 'owner',
  required_auth: { threshold, keys, accounts: [], waits: [], ...extra }
});
const account = (active = permission('active', [{ key: other, weight: 1 }]), owner = permission('owner', [{ key: other, weight: 1 }])) => ({ account_name: 'alice', permissions: [active, owner] });

beforeEach(() => { jest.resetAllMocks(); });

test.each([
  { message: 'Internal Service Error', response: { json: { error: { code: 3090003, name: 'unsatisfied_authorization' } } } },
  { error: { code: 3090002, what: 'Irrelevant signature included' } },
  { error: { code: 3090004, what: 'Missing required authority' } },
  { cause: { body: JSON.stringify({ error: { code: 3090007 } }) } },
  new Error("transaction declares authority 'alice@active', but does not have signatures for it."),
  new Error('irrelevant keys provided'),
])('recognizes permission errors across direct, nested, and proxy responses', error => {
  expect(isAuthorizationFailure(error)).toBe(true);
});

test.each([new Error('Network request failed'), { error: { code: 3080002, name: 'tx_net_usage_exceeded' } }, new Error('invalid project credentials (HTTP 401)'), new Error('password incorrect')])('never labels network, resource, project credentials or password errors as revoked keys', error => {
  expect(isAuthorizationFailure(error)).toBe(false);
});

test('cyclic wrapper objects are bounded', () => { const e: any = { message: 'offline' }; e.cause = e; expect(chainErrorText(e)).toContain('offline'); });

test('a removed active key gets a precise explanation, not a cached import permission', () => {
  expect(diagnoseAuthorization(account(), context, pub)).toBe('unavailable-key');
  expect(new AuthorizationFailureError(context, 'unavailable-key').message).toContain('chainError.keyNotAuthorized');
});
test('a listed key with insufficient direct weight is distinguished from a removed key', () => {
  expect(diagnoseAuthorization(account(permission('active', [{ key: pub, weight: 1 }, { key: other, weight: 1 }], 2)), context, pub)).toBe('insufficient-weight');
});
test('legacy public key encoding is accepted and a sufficient authority is not called revoked', () => {
  expect(diagnoseAuthorization(account(permission('active', [{ key: legacy, weight: 1 }])), context, pub)).toBe('unknown');
});
test('an owner key is not misreported as revoked merely because it is absent from active', () => {
  expect(diagnoseAuthorization(account(undefined, permission('owner', [{ key: pub, weight: 1 }])), context, pub)).toBe('unknown');
});
test('delegated permissions, delayed authorities and malformed or wrong account responses stay conservative', () => {
  expect(diagnoseAuthorization(account(permission('active', [], 1, { accounts: [{ permission: { actor: 'bob', permission: 'active' }, weight: 1 }] })), context, pub)).toBe('unknown');
  expect(diagnoseAuthorization(account(permission('active', [], 1, { waits: [{ wait_sec: 30, weight: 1 }] })), context, pub)).toBe('unknown');
  expect(diagnoseAuthorization({ ...account(), account_name: 'bob' }, context, pub)).toBe('unknown');
  expect(diagnoseAuthorization({ account_name: 'alice', permissions: [{ perm_name: 'active' }] }, context, pub)).toBe('unknown');
});
test('deleted custom permissions identify the actual required permission', () => {
  const custom = { actor: 'alice', permission: 'paytransfer' };
  expect(diagnoseAuthorization(account(), custom, pub)).toBe('unavailable-key');
  expect(new AuthorizationFailureError(custom).message).toContain('"permission":"paytransfer"');
});

test('post-failure diagnostics read only get_info and get_account, and never request or broadcast transactions', async () => {
  jest.mocked(fetchWithTimeout).mockImplementation(async input => ({ ok: true, json: async () => String(input).endsWith('get_info') ? { chain_id: 'mainnet' } : account() } as Response));
  const error = await explainAuthorizationFailure(new AuthorizationFailureError(context), { nodeUrl: 'https://node.test', chainId: 'mainnet', publicKey: pub });
  expect(error.diagnosis).toBe('unavailable-key');
  expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  expect(jest.mocked(fetchWithTimeout).mock.calls.map(call => String(call[0]))).toEqual(['https://node.test/v1/chain/get_info', 'https://node.test/v1/chain/get_account']);
});
test('failed queries and a different chain keep the honest generic permission failure', async () => {
  const original = new AuthorizationFailureError(context);
  jest.mocked(fetchWithTimeout).mockRejectedValue(new Error('offline'));
  expect(await explainAuthorizationFailure(original, { nodeUrl: 'https://node.test', chainId: 'mainnet', publicKey: pub })).toBe(original);
  jest.mocked(fetchWithTimeout).mockResolvedValue({ ok: true, json: async () => ({ chain_id: 'testnet' }) } as Response);
  expect(await explainAuthorizationFailure(original, { nodeUrl: 'https://node.test', chainId: 'mainnet', publicKey: pub })).toBe(original);
});
test('stale signing contexts do not start diagnostic network reads', async () => {
  const original = new AuthorizationFailureError(context);
  expect(await explainAuthorizationFailure(original, { nodeUrl: 'https://node.test', chainId: 'mainnet', publicKey: pub, isCurrent: () => false })).toBe(original);
  expect(fetchWithTimeout).not.toHaveBeenCalled();
});
