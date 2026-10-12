jest.mock('../../crypto/vault', () => ({
  importStoredPendingDeviceKey: jest.fn(async (_pending, wallet) => wallet),
  discardStoredPendingDeviceKey: jest.fn(), loadPendingDeviceKey: jest.fn(),
  newWalletId: jest.fn(() => 'device-id'), removeSecret: jest.fn(),
  savePendingDeviceKey: jest.fn(), saveSecret: jest.fn(), verifyMasterPassword: jest.fn(),
  WrongPasswordError: class WrongPasswordError extends Error {},
}));
jest.mock('../../crypto/keys', () => ({
  generateKey: jest.fn(() => ({ privateKey: 'secret', publicKey: 'public', legacyPublicKey: 'legacy' })),
  findAccountsByKey: jest.fn(),
}));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));

import {
  accountsWithActive, assertPendingDeviceChain, createPendingDeviceKey,
  DEVICE_KEY_AUTH_RETURN_URL, deviceKeyAuthorizeUrl, discardPendingDeviceKey,
  findAccountsForDeviceKey, importPendingDeviceKey,
} from '../deviceKey';
import {
  discardStoredPendingDeviceKey, importStoredPendingDeviceKey, loadPendingDeviceKey,
  newWalletId, removeSecret, savePendingDeviceKey, saveSecret, verifyMasterPassword, WrongPasswordError,
} from '../../crypto/vault';
import { findAccountsByKey, generateKey } from '../../crypto/keys';
import { fetchWithRetry } from '../../net/fetchRetry';
import { CHAINS } from '../config';

const PUB = 'PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5BoDq63';
const LEGACY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const pending = { id: 'device-id', publicKey: PUB, legacyPublicKey: LEGACY,
  label: 'Android', createdAt: 1, chainId: 'vaulta' as const };
const node = { url: 'https://node.test' };
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(newWalletId).mockReturnValue('device-id');
  jest.mocked(removeSecret).mockResolvedValue(undefined);
  jest.mocked(generateKey).mockReturnValue({
    privateKey: 'secret', publicKey: 'public', legacyPublicKey: 'legacy', path: '',
  });
  jest.mocked(verifyMasterPassword).mockResolvedValue(true);
  jest.mocked(loadPendingDeviceKey).mockResolvedValue(null);
  jest.mocked(importStoredPendingDeviceKey).mockImplementation(async (_pending, wallet) => wallet);
  jest.mocked(fetchWithRetry).mockImplementation(async (url) => response(
    String(url).endsWith('/get_info') ? { chain_id: String(url).includes('jungle')
      ? CHAINS.jungle4.chainIdHash : CHAINS.vaulta.chainIdHash } : { accounts: [] }));
});

it('authorization URL contains only public metadata and the accepted callback', () => {
  const url = new URL(deviceKeyAuthorizeUrl(pending, undefined, DEVICE_KEY_AUTH_RETURN_URL));
  expect(url.origin).toBe('https://eos3.app');
  expect(url.pathname).toBe('/account');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    deviceKey: PUB, deviceLabel: 'Android', returnTo: 'eos3wallet://device-key-authorized',
  });
});

it('encrypts the key before publishing a network-bound recovery record', async () => {
  const generated = await createPendingDeviceKey('password', 'vaulta');
  expect(generated.chainId).toBe('vaulta');
  expect(saveSecret).toHaveBeenCalledWith('device-id', 'secret', 'password');
  expect(savePendingDeviceKey).toHaveBeenCalledWith(generated);
  expect(jest.mocked(saveSecret).mock.invocationCallOrder[0])
    .toBeLessThan(jest.mocked(savePendingDeviceKey).mock.invocationCallOrder[0]);
});

it('wrong passwords and existing recovery records never replace a key', async () => {
  jest.mocked(verifyMasterPassword).mockResolvedValueOnce(false);
  await expect(createPendingDeviceKey('wrong', 'vaulta')).rejects.toBeInstanceOf(WrongPasswordError);
  jest.mocked(loadPendingDeviceKey).mockResolvedValueOnce(pending);
  await expect(createPendingDeviceKey('password', 'vaulta')).rejects.toThrow('vaultError.pendingKeyExists');
  expect(saveSecret).not.toHaveBeenCalled();
});

it('cleans up only the newly generated ciphertext when metadata publication fails', async () => {
  jest.mocked(savePendingDeviceKey).mockRejectedValueOnce(new Error('write failed'));
  await expect(createPendingDeviceKey('password', 'vaulta')).rejects.toThrow('write failed');
  expect(removeSecret).toHaveBeenCalledWith('device-id');
});

it('rejects a different selected network before any query or write', async () => {
  expect(() => assertPendingDeviceChain(pending, 'jungle4')).toThrow('deviceKey.chainMismatch');
  await expect(importPendingDeviceKey(pending, 'alice', 'jungle4', node))
    .rejects.toThrow('deviceKey.chainMismatch');
  expect(fetchWithRetry).not.toHaveBeenCalled();
});

it('verifies chain identity and equivalent legacy active keys before import', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(response({ chain_id: CHAINS.vaulta.chainIdHash }))
    .mockResolvedValueOnce(response({ account_name: 'alice', permissions: [
      { perm_name: 'active', required_auth: { threshold: 1, keys: [{ key: LEGACY, weight: 1 }] } },
    ] }));
  const wallet = await importPendingDeviceKey(pending, 'alice', 'vaulta', node);
  expect(wallet).toEqual(expect.objectContaining({
    account: 'alice', source: 'privatekey', authPermissions: ['active'], publicKey: PUB,
  }));
});

it.each([
  { account_name: 'bob', permissions: [] },
  { account_name: 'alice', permissions: [{ perm_name: 'owner', required_auth: { threshold: 1, keys: [{ key: PUB, weight: 1 }] } }] },
  { account_name: 'alice', permissions: [{ perm_name: 'active', required_auth: { threshold: 2, keys: [{ key: PUB, weight: 1 }] } }] },
  { account_name: 'alice', permissions: [{ perm_name: 'active', required_auth: { keys: [{ key: PUB }] } }] },
])('never consumes the pending record on missing or insufficient authority: %j', async (account) => {
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(response({ chain_id: CHAINS.vaulta.chainIdHash }))
    .mockResolvedValueOnce(response(account));
  await expect(importPendingDeviceKey(pending, 'alice', 'vaulta', node)).rejects.toThrow('deviceKeyImport.notYet');
  expect(importStoredPendingDeviceKey).not.toHaveBeenCalled();
});

it('wrong chain identity and network failures retain the key', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(response({ chain_id: CHAINS.jungle4.chainIdHash }));
  await expect(importPendingDeviceKey(pending, 'alice', 'vaulta', node)).rejects.toThrow('deviceKey.queryChainMismatch');
  jest.mocked(fetchWithRetry).mockRejectedValueOnce(new Error('offline'));
  await expect(importPendingDeviceKey(pending, 'alice', 'vaulta', node)).rejects.toThrow('offline');
  expect(importStoredPendingDeviceKey).not.toHaveBeenCalled();
});

it('only active or unknown-permission candidates are considered, with legacy lookup fallback', async () => {
  expect(accountsWithActive([{ account: 'a', permissions: ['owner'] },
    { account: 'b', permissions: ['active'] }, { account: 'c', permissions: [] }])).toEqual(['b', 'c']);
  jest.mocked(findAccountsByKey).mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ account: 'alice', permissions: ['active'] }]);
  await expect(findAccountsForDeviceKey(node, undefined, pending)).resolves.toEqual(['alice']);
  expect(findAccountsByKey).toHaveBeenLastCalledWith(node.url, LEGACY, undefined);
});

it('discard requires successful no-reference checks on every configured chain', async () => {
  await discardPendingDeviceKey(pending, node, 'vaulta');
  expect(fetchWithRetry).toHaveBeenCalledTimes(Object.keys(CHAINS).length * 3);
  expect(discardStoredPendingDeviceKey).toHaveBeenCalledWith(pending);
});

it('a referenced key, unreadable chain, or legacy unknown network cannot be discarded', async () => {
  jest.mocked(fetchWithRetry).mockImplementation(async (url) => response(
    String(url).endsWith('/get_info') ? { chain_id: String(url).includes('jungle')
      ? CHAINS.jungle4.chainIdHash : CHAINS.vaulta.chainIdHash } : { accounts: [{ account_name: 'alice' }] }));
  await expect(discardPendingDeviceKey(pending, node, 'vaulta')).rejects.toThrow('deviceKey.authorizedImportFirst');
  jest.mocked(fetchWithRetry).mockRejectedValueOnce(new Error('offline'));
  await expect(discardPendingDeviceKey(pending, node, 'vaulta')).rejects.toThrow('offline');
  await expect(discardPendingDeviceKey({ ...pending, chainId: undefined }, node, 'vaulta'))
    .rejects.toThrow('deviceKey.legacyPendingRecovery');
  expect(discardStoredPendingDeviceKey).not.toHaveBeenCalled();
});
