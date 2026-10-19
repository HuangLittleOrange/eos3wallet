// SecureStore 用内存 Map 模拟——测的是 vault 的加密/索引逻辑,不是原生 Keystore
jest.mock('react-native', () => ({ AppState: { currentState: 'active',
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
import type { StoredWallet } from '../vault';
type Vault = typeof import('../vault');
let vault: Vault;
let store: Map<string, string>;
let secureStore: typeof import('expo-secure-store');
const password = 'reimport-test-password';
const nextPassword = 'rotated-test-password';
const key = PrivateKey.generate('K1');
const otherKey = PrivateKey.generate('K1');
const original: StoredWallet = { id: 'original-wallet', account: 'alice', chainId: 'vaulta',
  publicKey: String(key.toPublic()), source: 'privatekey', createdAt: 1, authPermissions: ['active'] };
const incoming: StoredWallet = { ...original, id: 'fresh-import', createdAt: 2, authPermissions: ['owner'] };
const indexKey = 'aurora.wallet.index';
const generationKey = 'aurora.vault.generation';
const slot = (id: string) => 'aurora.wallet.' + (store.has(generationKey) ? 'g' + store.get(generationKey) + '.' : '') + id;
const write = async (id: string, value: string) => { store.set(id, value); };

beforeEach(() => {
  jest.resetModules();
  secureStore = require('expo-secure-store'); store = (secureStore as any).__store;
  vault = require('../vault');
});
jest.setTimeout(30_000);

async function seed(state = 'missing', rotated = false) {
  await vault.setMasterPassword(rotated ? 'previous-test-password' : password);
  if (rotated) await vault.changeMasterPassword('previous-test-password', password);
  store.set(indexKey, JSON.stringify([original]));
  if (state === 'corrupt') store.set(slot(original.id), '{corrupt');
  else if (state === 'wrong-key' || state === 'valid') {
    await vault.saveSecret(original.id, String(state === 'valid' ? key : otherKey), password);
  }
  await vault.saveSecret(incoming.id, String(key), password);
}
async function expectRepaired() {
  const rows = await vault.listWallets();
  expect(rows).toEqual([{ ...incoming, id: original.id, createdAt: original.createdAt, authPermissions: ['active', 'owner'] }]);
  await expect(vault.loadSecret(rows[0].id, password)).resolves.toBe(String(key));
}

test.each([false, true])('re-import repairs missing old ciphertext with rotated=%s before deleting the verified new copy', async rotated => {
  await seed('missing', rotated);
  await vault.addWallet(incoming, password);
  await expectRepaired();
  expect(store.has(slot(incoming.id))).toBe(false);
  await vault.changeMasterPassword(password, nextPassword);
  await expect(vault.loadSecret(original.id, nextPassword)).resolves.toBe(String(key));
});

test.each(['corrupt', 'wrong-key'].flatMap(state => [false, true].map(rotated => ({ state, rotated }))))(
  're-import retains abnormal $state old ciphertext with rotated=$rotated and refuses false success', async ({ state, rotated }) => {
    await seed(state, rotated); const before = new Map(store);
    await expect(vault.addWallet(incoming, password)).rejects.toThrow('vaultError.saveVerifyFailed');
    expect(store).toEqual(before);
    await expect(vault.loadSecret(incoming.id, password)).resolves.toBe(String(key));
  }
);

test('valid duplicate ciphertext and mnemonic-derived imports still retain the original id and merge permissions', async () => {
  await seed('valid');
  const oldCiphertext = store.get(slot(original.id));
  await vault.addWallet({ ...incoming, source: 'mnemonic', path: 'synthetic-derivation-path' }, password);
  const rows = await vault.listWallets();
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: original.id, source: 'mnemonic', path: 'synthetic-derivation-path' });
  await expect(vault.loadSecret(rows[0].id, password)).resolves.toBe(String(key));
  expect(store.get(slot(original.id))).toBe(oldCiphertext);
  expect(store.has(slot(incoming.id))).toBe(false);
});

test('metadata-only duplicate calls cannot erase a newly saved secret without a password proof', async () => {
  await seed(); const before = new Map(store);
  await expect(vault.addWallet(incoming)).rejects.toThrow('vaultError.saveVerifyFailed');
  expect(store).toEqual(before);
});

test('a newly encrypted key for a different public key is rejected without changing the original index or ciphertext', async () => {
  await seed('valid'); await vault.saveSecret(incoming.id, String(otherKey), password);
  const before = new Map(store);
  await expect(vault.addWallet(incoming, password)).rejects.toThrow('vaultError.saveVerifyFailed');
  expect(store).toEqual(before);
});

test('an old password after a generation change cannot authorize cleanup; the current password can retry', async () => {
  await seed('valid'); await vault.changeMasterPassword(password, nextPassword);
  const before = new Map(store);
  await expect(vault.addWallet(incoming, password)).rejects.toThrow('vaultError.wrongPassword');
  expect(store).toEqual(before);
  await vault.addWallet(incoming, nextPassword);
  await expect(vault.loadSecret(original.id, nextPassword)).resolves.toBe(String(key));
});

test.each(['target', 'index'] as const)('a failed %s write retains the verified incoming ciphertext and permits retry', async stage => {
  await seed(); const beforeIndex = store.get(indexKey);
  const failAt = stage === 'target' ? slot(original.id) : indexKey;
  jest.mocked(secureStore.setItemAsync).mockImplementation(async (id, value) => {
    if (id === failAt) throw new Error('write failed'); await write(id, value);
  });
  await expect(vault.addWallet(incoming, password)).rejects.toThrow('write failed');
  expect(store.get(indexKey)).toBe(beforeIndex);
  await expect(vault.loadSecret(incoming.id, password)).resolves.toBe(String(key));
  jest.mocked(secureStore.setItemAsync).mockImplementation(write);
  await vault.addWallet(incoming, password); await expectRepaired();
});

test.each(['target', 'index'] as const)('commit-then-reject at %s is checked by readback before cleanup', async stage => {
  await seed(); const failAt = stage === 'target' ? slot(original.id) : indexKey;
  jest.mocked(secureStore.setItemAsync).mockImplementation(async (id, value) => {
    await write(id, value); if (id === failAt) throw new Error('native response lost');
  });
  await vault.addWallet(incoming, password); await expectRepaired();
  expect(store.has(slot(incoming.id))).toBe(false);
});

test('uncertain index commit retains both ciphertext copies rather than cleaning an unconfirmed import', async () => {
  await seed(); let committed = false;
  jest.mocked(secureStore.setItemAsync).mockImplementation(async (id, value) => {
    await write(id, value);
    if (id === indexKey) { committed = true; throw new Error('native response lost'); }
  });
  jest.mocked(secureStore.getItemAsync).mockImplementation(async id => {
    if (id === indexKey && committed) throw new Error('read unavailable');
    return store.get(id) ?? null;
  });
  await expect(vault.addWallet(incoming, password)).rejects.toThrow('native response lost');
  await expect(vault.loadSecret(incoming.id, password)).resolves.toBe(String(key));
  await expect(vault.loadSecret(original.id, password)).resolves.toBe(String(key));
  jest.mocked(secureStore.getItemAsync).mockImplementation(async id => store.get(id) ?? null);
  await expectRepaired();
});

test('cleanup failure leaves a usable indexed key and preserves the remaining encrypted copy', async () => {
  await seed();
  jest.mocked(secureStore.deleteItemAsync).mockRejectedValueOnce(new Error('delete failed'));
  await vault.addWallet(incoming, password); await expectRepaired();
  await expect(vault.loadSecret(incoming.id, password)).resolves.toBe(String(key));
});

test('password rotation waits for repair and then migrates the published survivor', async () => {
  await seed(); let release!: () => void; let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const target = slot(original.id);
  jest.mocked(secureStore.setItemAsync).mockImplementation(async (id, value) => {
    if (id === target) { reached(); await gate; }
    await write(id, value);
  });
  const repairing = vault.addWallet(incoming, password); await waiting;
  const rotating = vault.changeMasterPassword(password, nextPassword);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.has(generationKey)).toBe(false);
  release(); await repairing; await rotating;
  await expect(vault.loadSecret(original.id, nextPassword)).resolves.toBe(String(key));
  expect(store.has(slot(incoming.id))).toBe(false);
});

test('unrelated wallet records on another chain remain separate', async () => {
  await seed();
  const another = { ...original, id: 'other-chain', chainId: 'jungle4' };
  store.set(indexKey, JSON.stringify([original, another]));
  await vault.addWallet(incoming, password);
  const rows = await vault.listWallets();
  expect(rows).toHaveLength(2); expect(rows).toContainEqual(another);
  await expect(vault.loadSecret(original.id, password)).resolves.toBe(String(key));
});


test('a fresh encrypted import publishes the verified incoming id and remains usable after password rotation', async () => {
  await vault.setMasterPassword(password);
  await vault.saveSecret(incoming.id, String(key), password);
  await vault.addWallet(incoming, password);
  await expect(vault.listWallets()).resolves.toEqual([incoming]);
  await expect(vault.loadSecret(incoming.id, password)).resolves.toBe(String(key));
  await vault.changeMasterPassword(password, nextPassword);
  await expect(vault.loadSecret(incoming.id, nextPassword)).resolves.toBe(String(key));
});

test('a missing survivor can be repaired alongside a verified historical duplicate without losing permissions', async () => {
  await seed();
  const duplicate = { ...original, id: 'old-duplicate', createdAt: 2, authPermissions: ['custom'] };
  await vault.saveSecret(duplicate.id, String(key), password);
  store.set(indexKey, JSON.stringify([original, duplicate]));
  await vault.addWallet(incoming, password);
  await expect(vault.listWallets()).resolves.toEqual([{ ...incoming, id: original.id,
    createdAt: original.createdAt, authPermissions: ['active', 'custom', 'owner'] }]);
  await expect(vault.loadSecret(original.id, password)).resolves.toBe(String(key));
  expect(store.has(slot(duplicate.id))).toBe(false);
  expect(store.has(slot(incoming.id))).toBe(false);
});

test('an abnormal historical duplicate blocks cleanup even when the intended survivor is usable', async () => {
  await seed('valid');
  const duplicate = { ...original, id: 'old-duplicate', createdAt: 2 };
  await vault.saveSecret(duplicate.id, String(otherKey), password);
  store.set(indexKey, JSON.stringify([original, duplicate]));
  const before = new Map(store);
  await expect(vault.addWallet(incoming, password)).rejects.toThrow('vaultError.saveVerifyFailed');
  expect(store).toEqual(before);
});
