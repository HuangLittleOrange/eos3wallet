import AsyncStorage from '@react-native-async-storage/async-storage';
import { authorizeLinkSession, isKnownLinkSession, listLinkSessions, recordLinkSession, revokeLinkSession, type LinkSession } from '../linkSessions';

const session = (requestKey: string): LinkSession => ({ requestKey, name: requestKey,
  account: 'alice', chainId: 'vaulta', createdAt: 1 });

beforeEach(async () => { jest.restoreAllMocks(); await AsyncStorage.clear(); });

it('unrelated login cannot restore a concurrently revoked sender', async () => {
  await recordLinkSession(session('revoked'));
  await Promise.all([revokeLinkSession('revoked'), recordLinkSession(session('new'))]);
  await expect(isKnownLinkSession('revoked')).resolves.toBe(false);
  await expect(isKnownLinkSession('new')).resolves.toBe(true);
});

it('concurrent revocations both remain effective', async () => {
  await recordLinkSession(session('first')); await recordLinkSession(session('second'));
  await Promise.all([revokeLinkSession('first'), revokeLinkSession('second')]);
  await expect(listLinkSessions()).resolves.toEqual([]);
});

it('concurrent independent logins retain both sessions', async () => {
  await Promise.all([recordLinkSession(session('first')), recordLinkSession(session('second'))]);
  expect((await listLinkSessions()).map(s => s.requestKey).sort()).toEqual(['first', 'second']);
});

it('explicit fresh login after revoke is supported', async () => {
  await recordLinkSession(session('sender')); await revokeLinkSession('sender');
  await expect(isKnownLinkSession('sender')).resolves.toBe(false);
  await recordLinkSession(session('sender'));
  await expect(isKnownLinkSession('sender')).resolves.toBe(true);
});

it('a failed write rejects its caller without poisoning later mutations', async () => {
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage failure'));
  await expect(recordLinkSession(session('failed'))).rejects.toThrow('storage failure');
  await recordLinkSession(session('valid'));
  await expect(isKnownLinkSession('failed')).resolves.toBe(false);
  await expect(isKnownLinkSession('valid')).resolves.toBe(true);
});

it('a queued login owns a snapshot of its input', async () => {
  const input = session('original'); const writing = recordLinkSession(input);
  input.requestKey = 'changed'; await writing;
  await expect(isKnownLinkSession('original')).resolves.toBe(true);
  await expect(isKnownLinkSession('changed')).resolves.toBe(false);
});

it('revocation immediately cancels pending requests even if persistence fails', async () => {
  await recordLinkSession(session('sender'));
  const signal = (await authorizeLinkSession('sender'))!;
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage failure'));
  const removal = revokeLinkSession('sender'); expect(signal.aborted).toBe(true);
  await expect(removal).rejects.toThrow('storage failure');
  await expect(isKnownLinkSession('sender')).resolves.toBe(true);
  await revokeLinkSession('sender'); await expect(isKnownLinkSession('sender')).resolves.toBe(false);
});

it('admission waits for a queued revocation and cannot use a stale persisted list', async () => {
  await recordLinkSession(session('sender'));
  const removal = revokeLinkSession('sender');
  await expect(authorizeLinkSession('sender')).resolves.toBeNull(); await removal;
});

it('an allowlist read completing after revoke and relogin cannot revive its old lifetime', async () => {
  await recordLinkSession(session('sender'));
  const getItem = AsyncStorage.getItem.bind(AsyncStorage);
  let resolve!: (value: string | null) => void;
  const staleRead = new Promise<string | null>(done => { resolve = done; });
  jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(() => staleRead);
  const admitted = authorizeLinkSession('sender');
  // Let admission enter its asynchronous storage read before revoking.
  await Promise.resolve(); await Promise.resolve();
  await revokeLinkSession('sender'); await recordLinkSession(session('sender'));
  resolve(JSON.stringify([session('sender')]));
  await expect(admitted).resolves.toBeNull();
  const fresh = await authorizeLinkSession('sender'); expect(fresh?.aborted).toBe(false);
  await revokeLinkSession('sender'); expect(fresh?.aborted).toBe(true);
  expect(await getItem('aurora.link.sessions.v1')).toBe('[]');
});
