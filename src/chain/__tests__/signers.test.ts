jest.mock('../../crypto/vault', () => ({ loadSecret: jest.fn(), loadSecretWithBiometric: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { PrivateKey } from '@wharfkit/antelope';
import { loadSecret, loadSecretWithBiometric, type StoredWallet } from '../../crypto/vault';
import { passwordSigner, biometricSigner } from '../signers';
import { transactionWallet } from '../transactionWallet';
const key = PrivateKey.generate('K1');
const wallet = { id: 'test', publicKey: String(key.toPublic()) } as StoredWallet;
test('matching password and biometric keys retain local signing', async () => {
  jest.mocked(loadSecret).mockResolvedValue(String(key));
  jest.mocked(loadSecretWithBiometric).mockResolvedValue(String(key));
  expect((await passwordSigner(wallet, 'test-password')()).kind).toBe('privatekey');
  expect((await biometricSigner(wallet)()).kind).toBe('privatekey');
});
test('a swapped vault record cannot sign using a different wallet key', async () => {
  jest.mocked(loadSecret).mockResolvedValue(String(PrivateKey.generate('K1')));
  await expect(passwordSigner(wallet, 'test-password')()).rejects.toThrow('walletDetail.unlockFailed');
});
test('malformed key-parser errors do not disclose input to callers', async () => {
  jest.mocked(loadSecretWithBiometric).mockResolvedValue('invalid-secret-material');
  const error = await biometricSigner(wallet)().catch((e) => e);
  expect(error.message).toBe('walletDetail.unlockFailed');
  expect(error.message).not.toContain('invalid-secret-material');
});

test('an observation account gets an external signer without decrypting or storing any local secret', async () => {
  jest.mocked(loadSecret).mockClear();
  const watch = transactionWallet({ account: 'alice', chainId: 'vaulta', hasAccount: true })!;
  expect(watch.source).toBe('watch');
  expect(await passwordSigner(watch, '')()).toEqual({ kind: 'external', account: 'alice', chainSlug: 'vaulta' });
  expect(loadSecret).not.toHaveBeenCalled();
  expect(transactionWallet({ account: '', chainId: 'vaulta', hasAccount: false })).toBeUndefined();
  expect(transactionWallet({ currentWallet: wallet, account: 'alice', chainId: 'vaulta', hasAccount: true })).toBe(wallet);
});
