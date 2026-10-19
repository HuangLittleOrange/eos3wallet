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

import type { PendingDeviceKey, StoredWallet } from '../vault';

type Vault = typeof import('../vault');
let vault: Vault;
let store: Map<string, string>;
let secureStore: typeof import('expo-secure-store');
const oldPassword = 'queue-old-password';
const newPassword = 'queue-new-password';
const pending: PendingDeviceKey = {
  id: 'queue-pending', publicKey: 'synthetic-device-public', legacyPublicKey: 'synthetic-device-legacy',
  label: 'No funds fixture', chainId: 'vaulta', createdAt: 3,
};
const duplicates: StoredWallet[] = [1, 2].map(createdAt => ({
  id: `queue-wallet-${createdAt}`, account: 'alice', publicKey: 'synthetic-duplicate-public',
  chainId: 'vaulta', source: 'privatekey', createdAt,
  authPermissions: [createdAt === 1 ? 'active' : 'owner'],
}));
const indexKey = 'aurora.wallet.index';
const pendingSlot = 'aurora.deviceKey.pending';
const recoveryIds = 'aurora.deviceKey.recoveryIds';
const recoverySlot = 'aurora.deviceKey.recovery.' + pending.id;

// Each test gets fresh queues, including the old-source negative controls that
// intentionally leave an unresolved cycle. No real native storage or wallet.
beforeEach(() => {
  jest.resetModules();
  secureStore = require('expo-secure-store');
  store = (secureStore as any).__store;
  vault = require('../vault');
});
jest.setTimeout(30_000);

async function bounded<T>(task: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: queue did not complete`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function seed(mode: 'archive' | 'restore') {
  await vault.setMasterPassword(oldPassword);
  // Real password-derived AES-GCM envelopes; only SecureStore and the native
  // PBKDF2 adapter are replaced with an in-memory store and Node crypto.
  await vault.saveSecret(duplicates[0].id, 'synthetic-wallet-secret', oldPassword);
  await vault.saveSecret(duplicates[1].id, 'synthetic-wallet-secret', oldPassword);
  await vault.saveSecret(pending.id, 'synthetic-device-secret', oldPassword);
  store.set(indexKey, JSON.stringify(duplicates));
  if (mode === 'archive') await vault.savePendingDeviceKey(pending);
  else {
    store.set(recoveryIds, JSON.stringify([pending.id]));
    store.set(recoverySlot, JSON.stringify(pending));
  }
}

function operate(mode: 'archive' | 'restore'): Promise<void | PendingDeviceKey> {
  return mode === 'archive' ? vault.discardStoredPendingDeviceKey(pending)
    : vault.restoreRecoverableDeviceKey(pending.id);
}

test.each(['archive', 'restore'] as const)(
  '%s completes with historical duplicates and releases subsequent secret writes and password rotation', async mode => {
    await seed(mode);
    const originalIndex = store.get(indexKey);
    const ciphertext = new Map(duplicates.concat({ id: pending.id } as StoredWallet)
      .map(wallet => ['aurora.wallet.' + wallet.id, store.get('aurora.wallet.' + wallet.id)]));
    let reachedIndex!: () => void;
    const atIndex = new Promise<void>(resolve => { reachedIndex = resolve; });
    jest.mocked(secureStore.getItemAsync).mockImplementation(async key => {
      if (key === indexKey) reachedIndex();
      return store.get(key) ?? null;
    });
    const action = operate(mode);
    // Queue a write after the operation has reached its index read while owning
    // the secret queue. On the old source both operations wait forever.
    await bounded(atIndex, 'reach index');
    const nextWrite = vault.saveSecret('queue-after', 'synthetic-later-secret', oldPassword);
    await bounded(action, mode);
    await bounded(nextWrite, 'subsequent save', 10_000);
    jest.mocked(secureStore.getItemAsync).mockImplementation(async key => store.get(key) ?? null);
    // Guards must not silently remove any indexed record or encrypted material.
    expect(store.get(indexKey)).toBe(originalIndex);
    for (const [key, value] of ciphertext) expect(store.get(key)).toBe(value);
    expect(await vault.loadPendingDeviceKey()).toEqual(mode === 'archive' ? null : pending);
    expect(await vault.listRecoverableDeviceKeys()).toEqual(mode === 'archive' ? [pending] : []);
    await bounded(vault.changeMasterPassword(oldPassword, newPassword), 'password rotation', 15_000);
    for (const wallet of duplicates) {
      await expect(vault.loadSecret(wallet.id, newPassword)).resolves.toBe('synthetic-wallet-secret');
    }
    await expect(vault.loadSecret(pending.id, newPassword)).resolves.toBe('synthetic-device-secret');
    await expect(vault.loadSecret('queue-after', newPassword)).resolves.toBe('synthetic-later-secret');
    // Normal list loading preserves both local envelopes and their source rows.
    // Only an authenticated import may consolidate verified ciphertext copies.
    await expect(bounded(vault.listWallets(), 'normal dedupe')).resolves.toEqual([
      { ...duplicates[0], authPermissions: ['active', 'owner'] },
      { ...duplicates[1], authPermissions: ['active', 'owner'] },
    ]);
    expect(store.has('aurora.wallet.g' + store.get('aurora.vault.generation') + '.' + duplicates[1].id)).toBe(true);
    expect(store.get(indexKey)).toBe(originalIndex);
    await expect(vault.loadSecret(duplicates[0].id, newPassword)).resolves.toBe('synthetic-wallet-secret');
    await expect(vault.loadSecret(pending.id, newPassword)).resolves.toBe('synthetic-device-secret');
  }
);

test.each(['archive', 'restore'] as const)(
  '%s rejects a pending id already in a duplicate index without deleting its ciphertext', async mode => {
    await seed(mode);
    store.set(indexKey, JSON.stringify([duplicates[0], { ...duplicates[1], id: pending.id }]));
    const before = new Map(store);
    await expect(bounded(operate(mode), mode)).rejects.toThrow('signupError.pendingChanged');
    expect(store).toEqual(before);
    await bounded(vault.saveSecret('after-rejection', 'synthetic-secret', oldPassword), 'write after rejection');
  }
);

test.each(['archive', 'restore'] as const)(
  '%s fails closed on a malformed index and releases the secret queue', async mode => {
    await seed(mode); store.set(indexKey, '{}');
    const before = new Map(store);
    await expect(bounded(operate(mode), mode)).rejects.toThrow('vaultError.readFailed');
    expect(store).toEqual(before);
    await bounded(vault.saveSecret('after-read-error', 'synthetic-secret', oldPassword), 'write after read error');
  }
);
