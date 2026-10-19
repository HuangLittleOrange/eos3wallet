// SecureStore 用内存 Map 模拟——测的是 vault 的加密/索引逻辑,不是原生 Keystore
jest.mock('react-native', () => ({ Platform: { OS: 'android', constants: {} }, AppState: { currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  };
});
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: (...args: any[]) => require('../../net/fetchRetry').fetchWithRetry(...args) }));
jest.mock('../../i18n', () => ({
  t: (key: string) => key,
}));

// react-native-quick-crypto 的 pbkdf2 是 Nitro 原生模块,Jest 里没有真机/模拟器
// 跑不起来——转发给 Node 内置的 crypto.pbkdf2(同样是 OpenSSL 实现的
// PBKDF2-HMAC-SHA256)当替身,而不是随手拼一个假函数:这样单测既能跑,算出来
// 的 key 也和真实原生实现一样是标准正确的 PBKDF2 结果,不是"测试专用的假密钥"。
jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = require('crypto');
  return {
    pbkdf2: jest.fn(
      (
        password: string,
        salt: Uint8Array,
        iterations: number,
        keylen: number,
        digest: string,
        callback: (err: Error | null, key?: Uint8Array) => void
      ) => {
        nodeCrypto.pbkdf2(password, salt, iterations, keylen, digest, callback);
      }
    ),
  };
});

import { PrivateKey } from '@wharfkit/antelope';
import { rpcResponse } from '../../chain/__tests__/rpcResponse';
import type { StoredWallet, PendingDeviceKey } from '../vault';
let vault: typeof import('../vault');
let device: typeof import('../../chain/deviceKey');
let store: Map<string, string>;
let secure: typeof import('expo-secure-store');
let fetchRpc: jest.MockedFunction<typeof import('../../net/fetchRetry').fetchWithRetry>;
const password = 'survivor-test-password';
const rotatedPassword = 'survivor-rotated-password';
const key = PrivateKey.generate('K1');
const other = PrivateKey.generate('K1');
const original: StoredWallet = { id: 'old-copy', account: 'alice', chainId: 'vaulta',
  publicKey: String(key.toPublic()), source: 'privatekey', createdAt: 1, authPermissions: ['owner'] };
const newer: StoredWallet = { ...original, id: 'new-copy', createdAt: 2, authPermissions: ['active'] };
const pending: PendingDeviceKey = { id: newer.id, publicKey: newer.publicKey,
  legacyPublicKey: key.toPublic().toLegacyString(), createdAt: 2, label: 'Test phone', chainId: 'vaulta' };
const index = 'aurora.wallet.index';
const pendingSlot = 'aurora.deviceKey.pending';
const generation = 'aurora.vault.generation';
const slot = (id: string) => 'aurora.wallet.' + (store.has(generation) ? 'g' + store.get(generation) + '.' : '') + id;
const write = async (id: string, value: string) => { store.set(id, value); };
const read = async (id: string) => store.get(id) ?? null;
const response = rpcResponse;
jest.setTimeout(30_000);
beforeEach(() => {
  jest.resetModules();
  secure = require('expo-secure-store'); store = (secure as any).__store;
  vault = require('../vault'); device = require('../../chain/deviceKey');
  fetchRpc = require('../../net/fetchRetry').fetchWithRetry;
  const { CHAINS } = require('../../chain/config');
  const auth = { threshold: 1, keys: [{ key: original.publicKey, weight: 1 }], accounts: [], waits: [] };
  fetchRpc.mockImplementation(async url => response(String(url).endsWith('/get_info')
    ? { chain_id: CHAINS.vaulta.chainIdHash } : { account_name: 'alice', permissions: [
      { perm_name: 'owner', parent: '', required_auth: auth },
      { perm_name: 'active', parent: 'owner', required_auth: auth },
    ] }));
});
async function seed(state = 'missing', deviceImport = false, rotated = false) {
  await vault.setMasterPassword(rotated ? 'previous-survivor-password' : password);
  if (rotated) await vault.changeMasterPassword('previous-survivor-password', password);
  store.set(index, JSON.stringify(deviceImport ? [original] : [original, newer]));
  if (state === 'corrupt') store.set(slot(original.id), '{corrupt');
  if (state === 'valid' || state === 'wrong-key') await vault.saveSecret(original.id, String(state === 'valid' ? key : other), password);
  await vault.saveSecret(newer.id, String(key), password);
  if (deviceImport) await vault.savePendingDeviceKey(pending);
}
async function expectGood() {
  await expect(vault.loadSecret(newer.id, password)).resolves.toBe(String(key));
}

test.each([false, true])('ordinary list preserves the sole good ciphertext when oldest is missing, rotated=%s', async rotated => {
  await seed('missing', false, rotated); const before = new Map(store);
  const rows = await vault.listWallets();
  await expectGood(); expect(rows).toEqual([{ ...newer, authPermissions: ['owner', 'active'] }]);
  await vault.listWallets(); expect(store).toEqual(before);
  expect(secure.deleteItemAsync).not.toHaveBeenCalledWith(slot(newer.id));
});

test.each(['corrupt', 'wrong-key', 'valid'])('list retains both nonempty %s copies, without treating presence as key proof', async state => {
  await seed(state); const before = new Map(store);
  const rows = await vault.listWallets();
  expect(rows.map(w => w.id)).toEqual([original.id, newer.id]);
  expect(rows.every(w => w.authPermissions?.join() === 'owner,active')).toBe(true);
  await expectGood(); expect(store).toEqual(before);
  if (state === 'wrong-key') {
    const secret = await vault.loadSecret(original.id, password);
    expect(PrivateKey.from(secret).toPublic().equals(key.toPublic())).toBe(false);
  }
});

test('list never attempts index publication or removes biometric credentials, even if writes would fail', async () => {
  await seed(); store.set('aurora.bio.' + newer.id, 'legacy-gated-password');
  jest.mocked(secure.setItemAsync).mockClear().mockRejectedValue(new Error('writes forbidden'));
  jest.mocked(secure.deleteItemAsync).mockClear();
  await expect(vault.listWallets()).resolves.toHaveLength(1);
  expect(secure.setItemAsync).not.toHaveBeenCalled(); expect(secure.deleteItemAsync).not.toHaveBeenCalled();
  await expectGood();
});

test('unreadable duplicate slot fails the view closed without deleting another ciphertext', async () => {
  await seed('valid'); const before = new Map(store);
  jest.mocked(secure.getItemAsync).mockImplementation(async id => {
    if (id === slot(original.id)) throw new Error('read unavailable'); return read(id);
  });
  await expect(vault.listWallets()).rejects.toThrow('vaultError.readFailed');
  expect(store).toEqual(before); await expectGood();
});

test('an explicit authenticated reimport repairs a missing survivor after non-destructive startup', async () => {
  await seed(); await vault.listWallets(); await vault.addWallet(newer, password);
  expect(await vault.listWallets()).toEqual([{ ...original, source: newer.source, authPermissions: ['owner', 'active'] }]);
  await expect(vault.loadSecret(original.id, password)).resolves.toBe(String(key));
  expect(store.has(slot(newer.id))).toBe(false);
});

test('removing a displayed copy leaves hidden missing duplicate metadata and other chain keys intact', async () => {
  await seed(); const jungle = { ...newer, id: 'jungle-copy', chainId: 'jungle4' as const };
  await vault.saveSecret(jungle.id, String(key), password);
  store.set(index, JSON.stringify([original, newer, jungle]));
  await vault.listWallets(); await vault.removeWallet(newer.id);
  expect(JSON.parse(store.get(index)!)).toEqual([original, jungle]);
  await expect(vault.loadSecret(jungle.id, password)).resolves.toBe(String(key));
  expect(store.has(slot(newer.id))).toBe(false);
});

test.each(['corrupt', 'wrong-key', 'missing', 'valid'])('device duplicate preserves current verified ciphertext with %s older slot through actual authority quorum', async state => {
  await seed(state, true); const oldCipher = store.get(slot(original.id));
  const wallet = await device.importPendingDeviceKey(pending, 'alice', 'vaulta', { url: 'https://selected.test' });
  await expectGood(); expect(wallet.id).toBe(pending.id);
  expect(wallet.authPermissions).toEqual(['owner', 'active']);
  expect(JSON.parse(store.get(index)!)).toEqual([wallet, original]);
  expect(store.get(slot(original.id))).toBe(oldCipher);
  expect(await vault.loadPendingDeviceKey()).toBeNull();
  expect(fetchRpc.mock.calls.filter(([url]) => String(url).endsWith('/get_account')).length).toBeGreaterThanOrEqual(3);
  expect((await vault.listWallets())[0].id).toBe(pending.id);
});

test('both valid imported device copies survive password rotation in the current generation', async () => {
  await seed('valid', true, true);
  await device.importPendingDeviceKey(pending, 'alice', 'vaulta', { url: 'https://selected.test' });
  await vault.changeMasterPassword(password, rotatedPassword);
  await expect(vault.loadSecret(original.id, rotatedPassword)).resolves.toBe(String(key));
  await expect(vault.loadSecret(newer.id, rotatedPassword)).resolves.toBe(String(key));
});

test.each(['no-commit', 'commit-reject', 'unknown'] as const)('device index %s cannot cause premature pending key cleanup', async fault => {
  await seed('corrupt', true); let written = false;
  jest.mocked(secure.setItemAsync).mockImplementation(async (id, value) => {
    if (id === index) { written = true; if (fault !== 'no-commit') await write(id, value); throw new Error('index write failed'); }
    await write(id, value);
  });
  jest.mocked(secure.getItemAsync).mockImplementation(async id => {
    if (written && fault === 'unknown' && id === index) throw new Error('index unavailable'); return read(id);
  });
  const result = vault.importStoredPendingDeviceKey(pending, newer);
  if (fault === 'commit-reject') await expect(result).resolves.toMatchObject({ id: newer.id });
  else { await expect(result).rejects.toThrow('index write failed'); expect(await vault.loadPendingDeviceKey()).toEqual(pending); }
  await expectGood(); expect(store.get(slot(original.id))).toBe('{corrupt');
});

test('pending delete failure is retryable under the same new id, and commit-then-reject delete is recognized', async () => {
  await seed('valid', true);
  jest.mocked(secure.deleteItemAsync).mockImplementation(async id => { if (id === pendingSlot) throw new Error('delete failed'); store.delete(id); });
  await expect(vault.importStoredPendingDeviceKey(pending, newer)).rejects.toThrow('delete failed');
  await expectGood(); expect(await vault.loadPendingDeviceKey()).toEqual(pending);
  jest.mocked(secure.deleteItemAsync).mockImplementation(async id => { store.delete(id); if (id === pendingSlot) throw new Error('delete acknowledgment failed'); });
  await expect(vault.importStoredPendingDeviceKey(pending, newer)).resolves.toMatchObject({ id: newer.id });
  expect(JSON.parse(store.get(index)!).filter((w: StoredWallet) => w.id === newer.id)).toHaveLength(1);
  await expectGood(); expect(await vault.loadPendingDeviceKey()).toBeNull();
});

test('a selected-node-only authorization cannot consume the pending key', async () => {
  await seed('valid', true); const before = new Map(store);
  const impl = fetchRpc.getMockImplementation()!;
  fetchRpc.mockImplementation(async (...args) => {
    const r = await impl(...args); const data = await r.json();
    if (!String(args[0]).startsWith('https://selected.test/') && data.permissions)
      for (const p of data.permissions) p.required_auth.keys = [{ key: String(other.toPublic()), weight: 1 }];
    return response(data);
  });
  await expect(device.importPendingDeviceKey(pending, 'alice', 'vaulta', { url: 'https://selected.test' })).rejects.toThrow('importSecret.accountKeyMismatch');
  expect(store).toEqual(before); await expectGood();
});

async function seedCreation() {
  await vault.setMasterPassword(password);
  jest.spyOn(vault, 'newWalletId').mockReturnValue('publication-copy');
}

test('committed device publication preserves its actual decryptable ciphertext after native adapter rejects', async () => {
  await seedCreation(); let published: PendingDeviceKey | undefined;
  jest.mocked(secure.setItemAsync).mockImplementation(async (id, value) => {
    await write(id, value); if (id === pendingSlot) { published = JSON.parse(value); throw new Error('commit acknowledgment failed'); }
  });
  let result: PendingDeviceKey | undefined;
  try { result = await device.createPendingDeviceKey(password, 'vaulta'); } catch { /* Old-source negative control still checks the lost ciphertext. */ }
  expect(published).toBeDefined();
  const secret = await vault.loadSecret(published!.id, password);
  expect(String(PrivateKey.from(secret).toPublic())).toBe(published!.publicKey);
  expect(result).toEqual(published);
  expect(await vault.loadPendingDeviceKey()).toEqual(published);
  await expect(device.createPendingDeviceKey(password, 'vaulta')).rejects.toThrow('vaultError.pendingKeyExists');
});

test('definitely uncommitted publication cleans only its unreferenced new ciphertext', async () => {
  await seedCreation(); await vault.saveSecret('unrelated-copy', String(other), password);
  let proposed: PendingDeviceKey | undefined;
  jest.mocked(secure.setItemAsync).mockImplementation(async (id, value) => {
    if (id === pendingSlot) { proposed = JSON.parse(value); throw new Error('not committed'); } await write(id, value);
  });
  await expect(device.createPendingDeviceKey(password, 'vaulta')).rejects.toThrow('not committed');
  expect(proposed).toBeDefined(); expect(store.has(slot(proposed!.id))).toBe(false);
  expect(await vault.loadPendingDeviceKey()).toBeNull();
  await expect(vault.loadSecret('unrelated-copy', password)).resolves.toBe(String(other));
});

test.each([false, true])('unreadable publication state retains discoverable ciphertext with committed=%s', async committed => {
  await seedCreation(); let proposed: PendingDeviceKey | undefined;
  jest.mocked(secure.setItemAsync).mockImplementation(async (id, value) => {
    if (id === pendingSlot) { proposed = JSON.parse(value); if (committed) await write(id, value); throw new Error('uncertain publication'); } await write(id, value);
  });
  jest.mocked(secure.getItemAsync).mockImplementation(async id => {
    if (proposed && id === pendingSlot) throw new Error('pending unavailable'); return read(id);
  });
  await expect(device.createPendingDeviceKey(password, 'vaulta')).rejects.toThrow('uncertain publication');
  const secret = await vault.loadSecret(proposed!.id, password);
  expect(String(PrivateKey.from(secret).toPublic())).toBe(proposed!.publicKey);
  expect(await vault.listRecoverableDeviceKeys()).toEqual([proposed]);
  jest.mocked(secure.getItemAsync).mockImplementation(read); jest.mocked(secure.setItemAsync).mockImplementation(write);
  await expect(vault.restoreRecoverableDeviceKey(proposed!.id)).resolves.toEqual(proposed);
  expect(await vault.loadPendingDeviceKey()).toEqual(proposed);
});

test('unknown publication and unavailable recovery metadata still never erase the registered ciphertext', async () => {
  await seedCreation(); let proposed: PendingDeviceKey | undefined;
  jest.mocked(secure.setItemAsync).mockImplementation(async (id, value) => {
    if (id === pendingSlot) { proposed = JSON.parse(value); throw new Error('uncertain publication'); }
    if (id.startsWith('aurora.deviceKey.recovery')) throw new Error('recovery unavailable'); await write(id, value);
  });
  jest.mocked(secure.getItemAsync).mockImplementation(async id => {
    if (proposed && id === pendingSlot) throw new Error('pending unavailable'); return read(id);
  });
  await expect(device.createPendingDeviceKey(password, 'vaulta')).rejects.toThrow('uncertain publication');
  const secret = await vault.loadSecret(proposed!.id, password);
  expect(String(PrivateKey.from(secret).toPublic())).toBe(proposed!.publicKey);
  expect(JSON.parse(store.get('aurora.vault.secretIds')!)).toContain(proposed!.id);
});

test.each(['wallet', 'recovery', 'other-pending-same-id'] as const)('publication settlement cannot delete a ciphertext referenced by %s', async reference => {
  await seed('valid', true);
  store.delete(pendingSlot);
  if (reference === 'wallet') store.set(index, JSON.stringify([newer]));
  if (reference === 'recovery') {
    store.set('aurora.deviceKey.recoveryIds', JSON.stringify([pending.id]));
    store.set('aurora.deviceKey.recovery.' + pending.id, JSON.stringify(pending));
  }
  if (reference === 'other-pending-same-id') store.set(pendingSlot, JSON.stringify({ ...pending, publicKey: String(other.toPublic()) }));
  await expect(vault.settlePendingDevicePublication(pending)).resolves.toBe(false);
  await expectGood();
});

test('concurrent generation publishes one key and safely removes only the losing unpublished copy', async () => {
  await vault.setMasterPassword(password);
  let serial = 0; jest.spyOn(vault, 'newWalletId').mockImplementation(() => 'concurrent-' + ++serial);
  const results = await Promise.allSettled([device.createPendingDeviceKey(password, 'vaulta'), device.createPendingDeviceKey(password, 'vaulta')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const saved = await vault.loadPendingDeviceKey(); expect(saved).not.toBeNull();
  const secret = await vault.loadSecret(saved!.id, password);
  expect(String(PrivateKey.from(secret).toPublic())).toBe(saved!.publicKey);
  expect(['concurrent-1', 'concurrent-2'].filter(id => store.has(slot(id)))).toEqual([saved!.id]);
});
