jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../importAccount', () => ({ readDirectSigningKeys: jest.fn() }));
jest.mock('../../dapp/linkSocket', () => ({ listenLinkChannel: jest.fn() }));
import { Action, PrivateKey, Serializer, Transaction } from '@wharfkit/antelope';
import { CHAINS } from '../config';
import { coreActionAbi } from '../coreTokenAbi';
import { readDirectSigningKeys } from '../importAccount';
import { listenLinkChannel } from '../../dapp/linkSocket';
import { acceptColdSignature, cancelColdSigning, coldSigningSnapshot, requestColdSignature } from '../coldSigning';

const key = PrivateKey.generate('K1'), publicKey = String(key.toPublic());
function options(isCurrent = () => true) {
  const transaction = Transaction.from({ expiration: new Date(Date.now() + 120000).toISOString().slice(0, 19),
    ref_block_num: 0, ref_block_prefix: 0, actions: [Action.from({ account: 'core.vaulta', name: 'transfer',
      authorization: [{ actor: 'alice', permission: 'active' }], data: { from: 'alice', to: 'bob', quantity: '1.0000 A', memo: '' } }, coreActionAbi('core.vaulta', 'transfer')!)] });
  return { transaction, chainId: CHAINS.vaulta.chainIdHash, chainSlug: 'vaulta' as const, actor: 'alice', permission: 'active', isCurrent };
}
const result = (o: ReturnType<typeof options>) => JSON.stringify({ ...Serializer.objectify(o.transaction),
  signatures: [String(key.signDigest(o.transaction.signingDigest(o.chainId)))] });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  jest.mocked(readDirectSigningKeys).mockResolvedValue([publicKey]);
});
afterEach(() => { cancelColdSigning(); jest.useRealTimers(); });

test('TP opens no relay and only completes after signature and fresh authority checks', async () => {
  const o = options(), signed = requestColdSignature(o); await tick();
  expect(coldSigningSnapshot()!.qr).toContain('eosio:signTransaction-');
  expect(listenLinkChannel).not.toHaveBeenCalled();
  expect(await acceptColdSignature(result(o), coldSigningSnapshot()!.id)).toBe(true);
  expect((await signed).verifyDigest(o.transaction.signingDigest(o.chainId), key.toPublic())).toBe(true);
  expect(readDirectSigningKeys).toHaveBeenCalledTimes(2);
  expect(coldSigningSnapshot()).toBeNull();
  expect(jest.getTimerCount()).toBe(0);
});
test('bad data keeps the pending request usable and a correct retry completes', async () => {
  const o = options(), signed = requestColdSignature(o); await tick();
  const id = coldSigningSnapshot()!.id;
  expect(await acceptColdSignature('{invalid', id)).toBe(false);
  expect(coldSigningSnapshot()!.validating).toBe(false);
  expect(coldSigningSnapshot()!.error).toBeTruthy();
  expect(await acceptColdSignature(result(o), id)).toBe(true);
  await signed;
});
test('revoked authority cannot complete even with a valid signature', async () => {
  const o = options(), signed = requestColdSignature(o); const cancelled = expect(signed).rejects.toThrow('cancelled'); await tick();
  jest.mocked(readDirectSigningKeys).mockResolvedValueOnce([]);
  expect(await acceptColdSignature(result(o), coldSigningSnapshot()!.id)).toBe(false);
  expect(coldSigningSnapshot()!.error).toBe('coldSigning.keyChanged');
  cancelColdSigning(); await cancelled;
});
test('a changed context cancels pending work and late signed results cannot revive it', async () => {
  let current = true; const o = options(() => current), signed = requestColdSignature(o);
  const rejected = expect(signed).rejects.toThrow('requestChanged'); await tick(); const id = coldSigningSnapshot()!.id;
  current = false; await jest.advanceTimersByTimeAsync(250); await rejected;
  expect(await acceptColdSignature(result(o), id)).toBe(false);
  expect(coldSigningSnapshot()).toBeNull();
});
test('expiry cancels the request without returning or broadcasting a signature', async () => {
  const o = options(), signed = requestColdSignature(o); const rejected = expect(signed).rejects.toThrow('expired'); await tick();
  await jest.advanceTimersByTimeAsync(120001); await rejected;
  expect(coldSigningSnapshot()).toBeNull(); expect(jest.getTimerCount()).toBe(0);
});
test('concurrent requests are rejected and cancellation cannot leak a response into a new request', async () => {
  const o = options(), first = requestColdSignature(o); const rejected = expect(first).rejects.toThrow('cancelled'); await tick(); const old = coldSigningSnapshot()!.id;
  await expect(requestColdSignature(o)).rejects.toThrow('busy'); cancelColdSigning(); await rejected;
  const second = requestColdSignature(o); await tick();
  expect(await acceptColdSignature(result(o), old)).toBe(false);
  expect(await acceptColdSignature(result(o), coldSigningSnapshot()!.id)).toBe(true); await second;
});
