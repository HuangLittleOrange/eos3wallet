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

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';
import {
  addWallet,
  hasMasterPassword,
  listWallets,
  loadSecret,
  newWalletId,
  removeWallet,
  saveSecret,
  setMasterPassword,
  signingPermission,
  StoredWallet,
  verifyMasterPassword,
  changeMasterPassword,
  WrongPasswordError,
  savePendingDeviceKey,
  loadPendingDeviceKey,
  updatePendingDeviceKeyLabel,
  importStoredPendingDeviceKey,
  discardStoredPendingDeviceKey,
  listRecoverableDeviceKeys,
  restoreRecoverableDeviceKey,
  PendingDeviceKey,
  biometricEnabled,
  enableBiometric,
  disableBiometric,
  loadSecretWithBiometric,
} from '../vault';
import { discardPendingDeviceKey } from '../../chain/deviceKey';
import { fetchWithRetry } from '../../net/fetchRetry';
import { CHAINS } from '../../chain/config';
import { PrivateKey } from '@wharfkit/antelope';

// PBKDF2 20 万次迭代走(mock 出来的)原生实现本身很快,放宽超时只是给较慢的
// CI 机器留余量,不是像纯 JS 实现那样必须依赖大额超时才能跑完。
jest.setTimeout(20_000);

const memStore: Map<string, string> = (SecureStore as any).__store;

beforeEach(() => {
  memStore.clear();
  jest.clearAllMocks();
});

const wallet = (over: Partial<StoredWallet>): StoredWallet => ({
  id: newWalletId(),
  account: 'alice',
  publicKey: 'PUB_K1_x',
  createdAt: 1000,
  source: 'privatekey',
  chainId: 'vaulta',
  ...over,
});

describe('saveSecret / loadSecret', () => {
  it('clears the native derived key buffer after encryption', async () => {
    const quickCrypto = require('react-native-quick-crypto');
    const nodeCrypto = require('crypto');
    let nativeKey: Uint8Array | undefined;
    quickCrypto.pbkdf2.mockImplementationOnce((password: string, salt: Uint8Array, iterations: number,
      keylen: number, digest: string, callback: Function) => {
      nodeCrypto.pbkdf2(password, salt, iterations, keylen, digest, (err: Error | null, key: Uint8Array) => {
        nativeKey = key; callback(err, key);
      });
    });
    await saveSecret('wipe-test', 'synthetic secret', 'password-123');
    expect(Array.from(nativeKey!)).toEqual(Array(32).fill(0));
  });

  it('clears a native key delivered after timeout without writing a wallet record', async () => {
    jest.useFakeTimers();
    try {
      let deliver!: Function;
      require('react-native-quick-crypto').pbkdf2.mockImplementationOnce((...args: any[]) => { deliver = args[5]; });
      const result = saveSecret('timeout-test', 'synthetic secret', 'password-123').catch((error) => error);
      await jest.advanceTimersByTimeAsync(20_000);
      expect((await result).message).toBe('vaultError.timeout');
      const lateKey = new Uint8Array(32).fill(9);
      deliver(null, lateKey);
      await Promise.resolve();
      expect(lateKey).toEqual(new Uint8Array(32));
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('加密后能用同一密码解回原文', async () => {
    await saveSecret('id1', '5KsecretKey', 'password-123');
    await expect(loadSecret('id1', 'password-123')).resolves.toBe('5KsecretKey');
  });

  it('密码错误抛 WrongPasswordError(GCM 认证失败)', async () => {
    await saveSecret('id2', '5KsecretKey', 'password-123');
    await expect(loadSecret('id2', 'wrong-password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('react-native-quick-crypto 的 pbkdf2 wiring 参数顺序/摘要名传对了(用 Node crypto 当基准核对)', async () => {
    // password='password' salt='salt' c=1 dkLen=32、sha256,用 Node 内置 crypto.pbkdf2
    // (标准 OpenSSL 实现)独立算出来的值钉死在这里当回归基线——这里验的是我们的调用
    // 姿势(参数顺序、digest 名字大小写、keylen)传对了,而不是重新证明 PBKDF2 本身正确;
    // 后面 iterations 兼容性测试的可信度建立在这份基线之上。
    const quickCrypto = require('react-native-quick-crypto');
    // 运行时其实是 Node 的真 Buffer(有 toString('hex')),但项目没装 @types/node、
    // 顶层 tsconfig 也没把 "node" 加进 types——用 any 接住,和 require() 本身
    // 未类型化的现实保持一致,不为了这一个测试引入新的类型依赖。
    const derived: any = await new Promise((resolve, reject) => {
      quickCrypto.pbkdf2('password', 'salt', 1, 32, 'sha256', (err: Error | null, key?: any) => {
        if (err || !key) reject(err);
        else resolve(key);
      });
    });
    expect(derived.toString('hex')).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'
    );
  });

  it('loadSecret 按 envelope 里记录的 iterations 派生密钥,不是当前的全局常量', async () => {
    // 手工拼一条"历史记录":用一个明显不同于当前 PBKDF2_ITERATIONS(200_000)的
    // 旧迭代次数加密,模拟"以后调高了迭代次数,但这条记录是升级前写的"的场景。
    // vault.ts 的 loadSecret 如果还是悄悄用当前全局常量重新派生(修复前的行为),
    // 派生出的 key 就和加密时用的对不上,GCM 认证会失败——这个用例修复前必挂。
    const quickCrypto = require('react-native-quick-crypto');
    const salt = new Uint8Array(16).fill(7);
    const nonce = new Uint8Array(12).fill(9);
    const oldIterations = 1_000;

    const key: Uint8Array = await new Promise((resolve, reject) => {
      quickCrypto.pbkdf2(
        'password-123',
        salt,
        oldIterations,
        32,
        'sha256',
        (err: Error | null, derived?: Uint8Array) => {
          if (err || !derived) reject(err);
          else resolve(new Uint8Array(derived));
        }
      );
    });
    const cipher = gcm(key, nonce).encrypt(utf8ToBytes('5KoldSecretKey'));

    memStore.set(
      'aurora.wallet.old-record',
      JSON.stringify({
        v: 1,
        salt: bytesToHex(salt),
        nonce: bytesToHex(nonce),
        cipher: bytesToHex(cipher),
        iterations: oldIterations,
      })
    );

    await expect(loadSecret('old-record', 'password-123')).resolves.toBe('5KoldSecretKey');
  });

  it('不存在的 id 报"找不到"', async () => {
    await expect(loadSecret('nope', 'x')).rejects.toThrow('vaultError.keyNotFound');
  });
});

describe('主密码', () => {
  it('设置后能验证,错的验证不过', async () => {
    expect(await hasMasterPassword()).toBe(false);
    await setMasterPassword('master-pass-1');
    expect(await hasMasterPassword()).toBe(true);
    expect(await verifyMasterPassword('master-pass-1')).toBe(true);
    expect(await verifyMasterPassword('nope')).toBe(false);
  });
});

describe('change master password', () => {
  const write = jest.mocked(SecureStore.setItemAsync).getMockImplementation()!;
  afterEach(() => { jest.mocked(SecureStore.setItemAsync).mockImplementation(write); });
  const seed = async () => {
    await setMasterPassword('old-password');
    await saveSecret('alice-key', 'synthetic-private-key', 'old-password');
    await addWallet(wallet({ id: 'alice-key' }));
  };

  it('rotates all local keys across networks, preserves watch/passkey records and disables old biometrics', async () => {
    await seed();
    await saveSecret('bob-key', 'synthetic-mnemonic-key', 'old-password');
    await addWallet(wallet({ id: 'bob-key', account: 'bob', chainId: 'jungle4', source: 'mnemonic' }));
    await addWallet(wallet({ id: 'watch', account: 'observer', source: 'watch' }));
    await addWallet(wallet({ id: 'passkey', account: 'passkey', source: 'passkey' }));
    // Existing releases have no secret-id registry. The wallet index must suffice.
    memStore.delete('aurora.vault.secretIds');
    await enableBiometric('old-password');
    const index = memStore.get('aurora.wallet.index');
    await changeMasterPassword('old-password', 'new-password');
    expect(await verifyMasterPassword('new-password')).toBe(true);
    expect(await verifyMasterPassword('old-password')).toBe(false);
    await expect(loadSecret('alice-key', 'new-password')).resolves.toBe('synthetic-private-key');
    await expect(loadSecret('bob-key', 'new-password')).resolves.toBe('synthetic-mnemonic-key');
    await expect(loadSecret('alice-key', 'old-password')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(memStore.get('aurora.wallet.index')).toBe(index);
    expect(await biometricEnabled()).toBe(false);
    expect(memStore.has('aurora.bio.master')).toBe(false);
    expect(memStore.has('aurora.wallet.alice-key')).toBe(false);
    await enableBiometric('new-password');
    await expect(loadSecretWithBiometric('alice-key')).resolves.toBe('synthetic-private-key');
  });

  it('retains the old vault on a staged write failure and removes incomplete staging', async () => {
    await seed();
    const original = memStore.get('aurora.wallet.alice-key');
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value, options) => {
      if (/\.g[a-f0-9]{16}\.alice-key$/.test(key)) throw new Error('storage full');
      return write(key, value, options);
    });
    await expect(changeMasterPassword('old-password', 'new-password')).rejects.toThrow('storage full');
    expect(memStore.has('aurora.vault.generation')).toBe(false);
    expect(memStore.get('aurora.wallet.alice-key')).toBe(original);
    expect([...memStore.keys()].some(key => /\.g[a-f0-9]{16}\./.test(key))).toBe(false);
    await expect(loadSecret('alice-key', 'old-password')).resolves.toBe('synthetic-private-key');
  });

  it('a failed generation commit preserves old credentials, while a committed-but-rejected write preserves new ones', async () => {
    await seed();
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value, options) => {
      if (key === 'aurora.vault.generation') throw new Error('commit failed');
      return write(key, value, options);
    });
    await expect(changeMasterPassword('old-password', 'new-password')).rejects.toThrow('commit failed');
    expect(await verifyMasterPassword('old-password')).toBe(true);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value, options) => {
      await write(key, value, options);
      if (key === 'aurora.vault.generation') throw new Error('native response lost');
    });
    await expect(changeMasterPassword('old-password', 'new-password')).resolves.toBeUndefined();
    await expect(loadSecret('alice-key', 'new-password')).resolves.toBe('synthetic-private-key');
  });

  it('rejects wrong current passwords and invalid new passwords without writing', async () => {
    await seed(); jest.mocked(SecureStore.setItemAsync).mockClear();
    await expect(changeMasterPassword('incorrect', 'new-password')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(changeMasterPassword('old-password', 'short')).rejects.toThrow('changePwd.invalidNew');
    await expect(changeMasterPassword('old-password', 'old-password')).rejects.toThrow('changePwd.invalidNew');
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('includes unindexed pending keys, supports repeated changes and rejects stale-password imports', async () => {
    await seed();
    await saveSecret('pending-key', 'pending-secret', 'old-password');
    await changeMasterPassword('old-password', 'new-password');
    await changeMasterPassword('new-password', 'third-password');
    await expect(loadSecret('pending-key', 'third-password')).resolves.toBe('pending-secret');
    await expect(saveSecret('stale-import', 'stale-secret', 'old-password')).rejects.toBeInstanceOf(WrongPasswordError);
    await saveSecret('new-import', 'new-secret', 'third-password');
    await expect(loadSecret('new-import', 'third-password')).resolves.toBe('new-secret');
    await removeWallet('alice-key');
    await expect(loadSecret('alice-key', 'third-password')).rejects.toThrow('vaultError.keyNotFound');
  });

  it('rotates a legacy pending device key even before it enters the wallet index', async () => {
    await seed();
    const pending: PendingDeviceKey = { id: 'pending-device', publicKey: 'pending-public', legacyPublicKey: 'legacy-public',
      label: 'Phone', createdAt: 1, chainId: 'vaulta' };
    await saveSecret(pending.id, 'pending-device-secret', 'old-password');
    await savePendingDeviceKey(pending);
    memStore.delete('aurora.vault.secretIds');
    await changeMasterPassword('old-password', 'new-password');
    await expect(loadSecret(pending.id, 'new-password')).resolves.toBe('pending-device-secret');
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
    await expect(importStoredPendingDeviceKey(pending, wallet({ id: pending.id, publicKey: pending.publicKey }))).resolves.toEqual(
      expect.objectContaining({ id: pending.id }));
  });

  it('a missing local key aborts before selecting a new password, preserving the remaining keys', async () => {
    await seed();
    await addWallet(wallet({ id: 'missing-key', account: 'missing' }));
    await expect(changeMasterPassword('old-password', 'new-password')).rejects.toThrow('vaultError.keyNotFound');
    expect(await verifyMasterPassword('old-password')).toBe(true);
    await expect(loadSecret('alice-key', 'old-password')).resolves.toBe('synthetic-private-key');
    expect(memStore.has('aurora.vault.generation')).toBe(false);
  });
});

describe('钱包索引', () => {
  it('addWallet + listWallets + removeWallet 基本闭环', async () => {
    const a = wallet({ account: 'alice' });
    const b = wallet({ account: 'bob', publicKey: 'PUB_K1_y' });
    await addWallet(a);
    await addWallet(b);
    let list = await listWallets();
    expect(list.map((x) => x.account).sort()).toEqual(['alice', 'bob']);

    await removeWallet(a.id);
    list = await listWallets();
    expect(list.map((x) => x.account)).toEqual(['bob']);
  });

  it('同链+同账户+同公钥重复导入 → 合并而不是叠卡片,权限取并集,保留最早的 id/createdAt', async () => {
    const first = wallet({ createdAt: 1000, authPermissions: ['active'] });
    await addWallet(first);
    const again = wallet({ publicKey: first.publicKey, createdAt: 2000, authPermissions: ['owner'] });
    await addWallet(again);

    const list = await listWallets();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(first.id);
    expect(list[0].createdAt).toBe(1000);
    expect([...(list[0].authPermissions ?? [])].sort()).toEqual(['active', 'owner']);
  });

  it('公钥不同就是不同的钥匙,各留一条', async () => {
    await addWallet(wallet({ publicKey: 'PUB_K1_active' }));
    await addWallet(wallet({ publicKey: 'PUB_K1_owner' }));
    expect(await listWallets()).toHaveLength(2);
  });

  it('listWallets merges metadata in its view without rewriting the source index', async () => {
    const dup1 = wallet({ id: 'aaaa', createdAt: 1000, authPermissions: ['active'] });
    const dup2 = { ...dup1, id: 'bbbb', createdAt: 2000, authPermissions: ['owner'] };
    memStore.set('aurora.wallet.index', JSON.stringify([dup1, dup2]));

    const list = await listWallets();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('aaaa');
    expect([...(list[0].authPermissions ?? [])].sort()).toEqual(['active', 'owner']);
    expect(JSON.parse(memStore.get('aurora.wallet.index')!)).toEqual([dup1, dup2]);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});

describe('device-wide biometric unlock', () => {
  const password = 'shared-master-password';
  const globalKey = 'aurora.bio.master';
  const globalFlag = globalKey + '.flag';
  const seedMaster = () => setMasterPassword(password);
  const seedWallet = async (id: string) => {
    await saveSecret(id, 'private-key-' + id, password);
    await addWallet(wallet({ id, account: id, publicKey: 'PUB_K1_' + id }));
  };

  it('can be enabled with the master password before any account is imported', async () => {
    await seedMaster();
    await enableBiometric(password);
    await expect(biometricEnabled()).resolves.toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(globalKey, password,
      expect.objectContaining({ requireAuthentication: true, keychainAccessible: 'whenUnlockedThisDeviceOnly' }));
    expect(memStore.get(globalFlag)).toBe('1');
  });

  it('wrong master password never publishes a shared credential', async () => {
    await seedMaster();
    await expect(enableBiometric('wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(memStore.has(globalKey)).toBe(false);
    await expect(biometricEnabled()).resolves.toBe(false);
  });

  it('existing and newly imported accounts use the same authentication-gated slot', async () => {
    await seedMaster();
    await seedWallet('alice');
    await enableBiometric(password);
    await seedWallet('bob');
    jest.mocked(SecureStore.getItemAsync).mockClear();
    await expect(loadSecretWithBiometric('alice')).resolves.toBe('private-key-alice');
    await expect(loadSecretWithBiometric('bob')).resolves.toBe('private-key-bob');
    const authenticatedReads = jest.mocked(SecureStore.getItemAsync).mock.calls
      .filter(([, options]) => options?.requireAuthentication);
    expect(authenticatedReads).toHaveLength(2);
    expect(authenticatedReads.every(([key]) => key === globalKey)).toBe(true);
  });

  it('reading the global state never authenticates or loads the password', async () => {
    memStore.set(globalFlag, '1');
    await expect(biometricEnabled()).resolves.toBe(true);
    expect(SecureStore.getItemAsync).not.toHaveBeenCalledWith(globalKey, expect.anything());
  });

  it('deleting one account does not disable shared unlocking for the others', async () => {
    await seedMaster();
    await seedWallet('alice');
    await seedWallet('bob');
    await enableBiometric(password);
    await removeWallet('alice');
    await expect(biometricEnabled()).resolves.toBe(true);
    await expect(loadSecretWithBiometric('bob')).resolves.toBe('private-key-bob');
  });

  it('closing the global switch preserves wallet ciphertext and password fallback', async () => {
    await seedMaster();
    await seedWallet('alice');
    await enableBiometric(password);
    const ciphertext = memStore.get('aurora.wallet.alice');
    await disableBiometric();
    await expect(biometricEnabled()).resolves.toBe(false);
    await expect(loadSecretWithBiometric('alice')).rejects.toThrow('vaultError.credentialNotFound');
    expect(memStore.get('aurora.wallet.alice')).toBe(ciphertext);
    await expect(loadSecret('alice', password)).resolves.toBe('private-key-alice');
  });

  it('migrates an old account credential only after successful system authentication', async () => {
    await seedMaster();
    await seedWallet('alice');
    await seedWallet('bob');
    memStore.set('aurora.bio.alice', password);
    memStore.set('aurora.bio.alice.flag', '1');
    await expect(biometricEnabled()).resolves.toBe(true);
    expect(memStore.has(globalKey)).toBe(false);
    await expect(loadSecretWithBiometric('bob')).resolves.toBe('private-key-bob');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('aurora.bio.alice',
      expect.objectContaining({ requireAuthentication: true }));
    expect(memStore.get(globalFlag)).toBe('1');
    expect(memStore.has('aurora.bio.alice')).toBe(false);
  });

  it('a cancelled legacy authentication leaves the credential unchanged', async () => {
    await seedMaster();
    await seedWallet('alice');
    memStore.set('aurora.bio.alice', password);
    memStore.set('aurora.bio.alice.flag', '1');
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key, options) => {
      if (key === 'aurora.bio.alice' && options?.requireAuthentication) throw new Error('User cancelled');
      return memStore.get(key) ?? null;
    });
    await expect(loadSecretWithBiometric('alice')).rejects.toThrow('vaultError.cancelled');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('aurora.bio.alice',
      expect.objectContaining({ requireAuthentication: true }));
    expect(memStore.has(globalKey)).toBe(false);
    expect(memStore.get('aurora.bio.alice')).toBe(password);
  });

  it('missing or invalidated shared credentials never fall back to an obsolete per-account slot', async () => {
    memStore.set(globalFlag, '1');
    memStore.set('aurora.bio.alice', password);
    await expect(loadSecretWithBiometric('alice')).rejects.toThrow('vaultError.credentialNotFound');
    expect(SecureStore.getItemAsync).not.toHaveBeenCalledWith('aurora.bio.alice', expect.anything());
  });

  it('an off marker blocks legacy reactivation even if credential deletion fails', async () => {
    memStore.set(globalFlag, '1');
    memStore.set(globalKey, password);
    jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('delete failed'));
    await expect(disableBiometric()).rejects.toThrow('delete failed');
    await expect(biometricEnabled()).resolves.toBe(false);
    await expect(loadSecretWithBiometric('alice')).rejects.toThrow('vaultError.credentialNotFound');
  });

  it('a failed credential write does not publish an enabled flag', async () => {
    await seedMaster();
    jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('credential write failed'));
    await expect(enableBiometric(password)).rejects.toThrow('credential write failed');
    expect(memStore.has(globalFlag)).toBe(false);
  });

  it('a late authenticated legacy read cannot reverse a global disable', async () => {
    await seedMaster();
    await seedWallet('alice');
    memStore.set('aurora.bio.alice', password);
    memStore.set('aurora.bio.alice.flag', '1');
    let release!: (value: string) => void;
    let started!: () => void;
    const authentication = new Promise<string>((resolve) => { release = resolve; });
    const reachedAuthentication = new Promise<void>((resolve) => { started = resolve; });
    jest.mocked(SecureStore.getItemAsync)
      .mockImplementationOnce(async (key) => memStore.get(key) ?? null)
      .mockImplementationOnce(async (key) => memStore.get(key) ?? null)
      .mockImplementationOnce(async (key) => memStore.get(key) ?? null)
      .mockImplementationOnce(() => { started(); return authentication; });
    const unlocking = loadSecretWithBiometric('alice');
    await reachedAuthentication;
    await disableBiometric();
    release(password);
    await expect(unlocking).rejects.toThrow('vaultError.credentialNotFound');
    expect(memStore.get(globalFlag)).toBe('0');
    expect(memStore.has(globalKey)).toBe(false);
  });

  it('wallet list loading never clears legacy or shared biometric credentials', async () => {
    memStore.set(globalKey, password);
    memStore.set(globalFlag, '1');
    memStore.set('aurora.wallet.index', JSON.stringify([
      wallet({ id: 'original', createdAt: 1 }), wallet({ id: 'duplicate', createdAt: 2 }),
    ]));
    await expect(listWallets()).resolves.toHaveLength(1);
    await expect(biometricEnabled()).resolves.toBe(true);
    expect(memStore.get(globalKey)).toBe(password);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });
});

describe('pending device authorization storage', () => {
  const pending: PendingDeviceKey = {
    id: 'pending-id', publicKey: 'PUB_K1_pending', legacyPublicKey: 'EOS_pending',
    label: 'Android', createdAt: 1, chainId: 'vaulta',
  };
  const imported = () => wallet({ id: pending.id, publicKey: pending.publicKey });
  const seed = async () => {
    memStore.set('aurora.wallet.' + pending.id, 'encrypted-secret');
    await savePendingDeviceKey(pending);
  };

  it('absent is empty, but corrupt recovery metadata is a read error', async () => {
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
    memStore.set('aurora.deviceKey.pending', '{broken');
    await expect(loadPendingDeviceKey()).rejects.toThrow('vaultError.readFailed');
    memStore.set('aurora.deviceKey.pending', JSON.stringify({ ...pending, chainId: 'unknown' }));
    await expect(loadPendingDeviceKey()).rejects.toThrow('vaultError.readFailed');
  });

  it('serializes competing pending writes without overwriting the first key', async () => {
    const outcomes = await Promise.allSettled([
      savePendingDeviceKey(pending), savePendingDeviceKey({ ...pending, id: 'other' }),
    ]);
    expect(outcomes.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
  });

  it('renames only the saved metadata and preserves encrypted key material', async () => {
    await seed();
    const updated = await updatePendingDeviceKeyLabel(pending, '  Custom phone  ');
    expect(updated).toEqual({ ...pending, label: 'Custom phone' });
    await expect(loadPendingDeviceKey()).resolves.toEqual(updated);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
    expect(await listWallets()).toEqual([]);
  });

  it.each(['', '   ', 'x'.repeat(41), 'two\nlines', 'control\u0000character'])('rejects invalid device names: %j', async (label) => {
    await seed();
    await expect(updatePendingDeviceKeyLabel(pending, label)).rejects.toThrow('deviceKey.nameInvalid');
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
  });

  it('keeps the old name and ciphertext when a name write fails', async () => {
    await seed();
    jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('write failed'));
    await expect(updatePendingDeviceKeyLabel(pending, 'New phone')).rejects.toThrow('write failed');
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
  });

  it('rejects stale, missing, and different-chain recovery records without resurrecting a key', async () => {
    await expect(updatePendingDeviceKeyLabel(pending, 'New phone')).rejects.toThrow('signupError.pendingChanged');
    await seed();
    await expect(updatePendingDeviceKeyLabel({ ...pending, id: 'old' }, 'New phone')).rejects.toThrow('signupError.pendingChanged');
    await expect(updatePendingDeviceKeyLabel({ ...pending, chainId: 'jungle4' }, 'New phone')).rejects.toThrow('signupError.pendingChanged');
    await updatePendingDeviceKeyLabel(pending, 'New phone');
    await expect(updatePendingDeviceKeyLabel(pending, 'Stale phone')).rejects.toThrow('signupError.pendingChanged');
    await importStoredPendingDeviceKey(pending, imported());
    await expect(updatePendingDeviceKeyLabel(pending, 'Late phone')).rejects.toThrow('signupError.pendingChanged');
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
  });

  it('serializes rename with import or discard without bringing consumed metadata back', async () => {
    await seed();
    const outcomes = await Promise.allSettled([
      importStoredPendingDeviceKey(pending, imported()), updatePendingDeviceKeyLabel(pending, 'Late phone'),
    ]);
    expect(outcomes.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
  });

  it('publishes the wallet before removing pending and keeps its ciphertext', async () => {
    await seed();
    await importStoredPendingDeviceKey(pending, imported());
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
    expect(await listWallets()).toEqual([imported()]);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
  });

  it('index write failure leaves recovery metadata and secret untouched', async () => {
    await seed();
    jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('index failed'));
    await expect(importStoredPendingDeviceKey(pending, imported())).rejects.toThrow('index failed');
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
    await expect(listWallets()).resolves.toEqual([]);
  });

  it('cleanup failure leaves a usable wallet and can be retried', async () => {
    await seed();
    jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(importStoredPendingDeviceKey(pending, imported())).rejects.toThrow('cleanup failed');
    expect((await listWallets())[0].id).toBe(pending.id);
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
    await importStoredPendingDeviceKey(pending, imported());
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
  });

  it('stale pending, wrong network, or missing secret cannot be imported', async () => {
    await seed();
    await expect(importStoredPendingDeviceKey({ ...pending, id: 'old' }, imported()))
      .rejects.toThrow('signupError.pendingChanged');
    await expect(importStoredPendingDeviceKey(pending, { ...imported(), chainId: 'jungle4' }))
      .rejects.toThrow('signupError.pendingChanged');
    memStore.delete('aurora.wallet.' + pending.id);
    await expect(importStoredPendingDeviceKey(pending, imported())).rejects.toThrow('vaultError.keyNotFound');
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
  });

  it('a late discard cannot erase a successfully imported wallet', async () => {
    await seed();
    const outcomes = await Promise.allSettled([
      importStoredPendingDeviceKey(pending, imported()), discardStoredPendingDeviceKey(pending),
    ]);
    expect(outcomes.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
  });

  it('a failure to clear pending leaves its ciphertext and recovery record intact', async () => {
    await seed();
    jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('pending removal failed'));
    await expect(discardStoredPendingDeviceKey(pending)).rejects.toThrow('pending removal failed');
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
    await expect(listRecoverableDeviceKeys()).resolves.toEqual([pending]);
    await discardStoredPendingDeviceKey(pending);
    await expect(restoreRecoverableDeviceKey(pending.id)).resolves.toEqual(pending);
  });

  it('does not erase an authorized key when the selected RPC lies about empty references', async () => {
    const key = PrivateKey.generate('K1');
    const current = { ...pending, publicKey: String(key.toPublic()), legacyPublicKey: key.toPublic().toLegacyString() };
    await saveSecret(current.id, String(key), 'test-password');
    await savePendingDeviceKey(current);
    // The selected source hides the real authorization; the other chain has none.
    // Correct chain IDs and syntactically valid empty indexes are not proof of non-use.
    jest.mocked(fetchWithRetry).mockImplementation(async url => ({ ok: true, json: async () =>
      String(url).endsWith('/get_info') ? { chain_id: String(url).includes('jungle') ? CHAINS.jungle4.chainIdHash : CHAINS.vaulta.chainIdHash }
        : { accounts: [] },
    }) as Response);
    await discardPendingDeviceKey(current, { url: 'https://malicious.invalid' }, 'vaulta');
    await expect(loadSecret(current.id, 'test-password')).resolves.toBe(String(key));
    await expect(listRecoverableDeviceKeys()).resolves.toEqual([current]);
    await restoreRecoverableDeviceKey(current.id);
    await expect(loadPendingDeviceKey()).resolves.toEqual(current);
    await importStoredPendingDeviceKey(current, wallet({ id: current.id, publicKey: current.publicKey }));
    await expect(loadSecret(current.id, 'test-password')).resolves.toBe(String(key));
  });

  it('does not erase a key even when all indexes are empty or lag behind a new authorization', async () => {
    await seed(); await discardStoredPendingDeviceKey(pending);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
    await expect(listRecoverableDeviceKeys()).resolves.toEqual([pending]);
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
  });

  it.each(['aurora.deviceKey.recovery.pending-id', 'aurora.deviceKey.recoveryIds'])(
    'a failed archive write at %s keeps the active recovery record and ciphertext', async slot => {
      await seed();
      jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
        if (key === slot) throw new Error('archive failed');
        memStore.set(key, value);
      });
      if (slot.endsWith('recoveryIds')) jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('archive failed'));
      await expect(discardStoredPendingDeviceKey(pending)).rejects.toThrow('archive failed');
      await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
      expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
    });

  it('commit-then-reject on pending removal still leaves a discoverable key', async () => {
    await seed();
    jest.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async key => {
      memStore.delete(key); throw new Error('native reply lost');
    });
    await expect(discardStoredPendingDeviceKey(pending)).rejects.toThrow('native reply lost');
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
    await expect(listRecoverableDeviceKeys()).resolves.toEqual([pending]);
    await restoreRecoverableDeviceKey(pending.id);
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
  });

  it('multiple archived keys remain distinguishable and restoring cannot replace an active key', async () => {
    await seed(); await discardStoredPendingDeviceKey(pending);
    const next = { ...pending, id: 'next-key', publicKey: 'next-public' };
    memStore.set('aurora.wallet.' + next.id, 'next-encrypted');
    await savePendingDeviceKey(next);
    await expect(restoreRecoverableDeviceKey(pending.id)).rejects.toThrow('vaultError.pendingKeyExists');
    await discardStoredPendingDeviceKey(next);
    expect((await listRecoverableDeviceKeys()).map(key => key.id)).toEqual([pending.id, next.id]);
    await restoreRecoverableDeviceKey(pending.id);
    await expect(listRecoverableDeviceKeys()).resolves.toEqual([next]);
    await expect(loadPendingDeviceKey()).resolves.toEqual(pending);
  });

  it('a failed restore publication leaves the archive recoverable', async () => {
    await seed(); await discardStoredPendingDeviceKey(pending);
    jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('restore failed'));
    await expect(restoreRecoverableDeviceKey(pending.id)).rejects.toThrow('restore failed');
    await expect(listRecoverableDeviceKeys()).resolves.toEqual([pending]);
    await expect(loadPendingDeviceKey()).resolves.toBeNull();
    expect(memStore.get('aurora.wallet.' + pending.id)).toBe('encrypted-secret');
  });

  it('rotates archived ciphertext with the master password before it is restored or imported', async () => {
    await setMasterPassword('old-password');
    await saveSecret(pending.id, 'synthetic-device-secret', 'old-password');
    await savePendingDeviceKey(pending); await discardStoredPendingDeviceKey(pending);
    await changeMasterPassword('old-password', 'new-password');
    await expect(loadSecret(pending.id, 'new-password')).resolves.toBe('synthetic-device-secret');
    await expect(loadSecret(pending.id, 'old-password')).rejects.toBeInstanceOf(WrongPasswordError);
    await restoreRecoverableDeviceKey(pending.id); await importStoredPendingDeviceKey(pending, imported());
    await expect(loadSecret(pending.id, 'new-password')).resolves.toBe('synthetic-device-secret');
  });
});

describe('signingPermission', () => {
  it('无记录/旧数据默认 active', () => {
    expect(signingPermission(undefined)).toBe('active');
    expect(signingPermission(wallet({ authPermissions: undefined }))).toBe('active');
    expect(signingPermission(wallet({ authPermissions: [] }))).toBe('active');
  });
  it('active+owner 都有时按更安全的 active 走', () => {
    expect(signingPermission(wallet({ authPermissions: ['owner', 'active'] }))).toBe('active');
  });
  it('只标了 owner 的钥匙照实用 owner', () => {
    expect(signingPermission(wallet({ authPermissions: ['owner'] }))).toBe('owner');
  });
});

// Generated in-process fixtures: never funded or assigned to real accounts.
describe('pending signup keys', () => {
  const { PrivateKey } = require('@wharfkit/antelope');
  const { savePendingKey, loadPendingKey, clearPendingKey } = require('../vault');
  it('keeps independent orders separate and verifies private/public key correspondence', async () => {
    const first = PrivateKey.generate('K1');
    const second = PrivateKey.generate('K1');
    const firstPub = String(first.toPublic());
    const secondPub = String(second.toPublic());
    await savePendingKey(String(first), firstPub);
    await savePendingKey(String(second), secondPub);
    await expect(loadPendingKey(firstPub)).resolves.toBe(String(first));
    await expect(loadPendingKey(secondPub)).resolves.toBe(String(second));
    await expect(savePendingKey(String(first), secondPub)).rejects.toThrow('Pending key mismatch');
    await clearPendingKey(firstPub);
    await expect(loadPendingKey(secondPub)).resolves.toBe(String(second));
  });
  it('migrates the matching legacy key while preserving unmatched recovery material', async () => {
    const first = PrivateKey.generate('K1');
    const second = PrivateKey.generate('K1');
    memStore.set('aurora.signup.pendingKey', String(first));
    await expect(loadPendingKey(String(second.toPublic()))).resolves.toBeNull();
    expect(memStore.get('aurora.signup.pendingKey')).toBe(String(first));
    await expect(loadPendingKey(String(first.toPublic()))).resolves.toBe(String(first));
    expect(memStore.has('aurora.signup.pendingKey')).toBe(false);
  });
});
