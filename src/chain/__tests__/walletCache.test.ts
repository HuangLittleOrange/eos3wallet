import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadTokenSnapshot, peekTokenSnapshot, saveTokenSnapshot } from '../walletCache';
import { requestLiveAccount } from '../liveAccountRequest';
const tokens = [{ contract: 'core.vaulta', symbol: 'A', precision: 4, amount: 10, raw: '10.0000 A' }];
beforeEach(async () => { jest.clearAllMocks(); await AsyncStorage.clear(); });

test('token snapshots are immediately reusable and isolated by chain/account', async () => {
  await saveTokenSnapshot('vaulta', 'alice', tokens);
  expect(peekTokenSnapshot('vaulta', 'alice')?.tokens).toEqual(tokens);
  expect((await loadTokenSnapshot('vaulta', 'alice'))?.tokens).toEqual(tokens);
  expect(peekTokenSnapshot('vaulta', 'bob')).toBeNull();
  expect(peekTokenSnapshot('jungle4', 'alice')).toBeNull();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled();
});

test('cold disk reads are shared and cannot replace a newer RPC snapshot', async () => {
  let finish!: (raw: string) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = loadTokenSnapshot('vaulta', 'race');
  const second = loadTokenSnapshot('vaulta', 'race');
  expect(first).toBe(second);
  await saveTokenSnapshot('vaulta', 'race', tokens);
  finish(JSON.stringify({ tokens: [], updatedAt: 0 }));
  expect((await first)?.tokens).toEqual(tokens);
});

test('persisted token rows survive restart and malformed snapshots are ignored', async () => {
  await AsyncStorage.setItem('aurora.balanceSnapshot.v1.vaulta.cold', JSON.stringify({ tokens, updatedAt: 1 }));
  expect((await loadTokenSnapshot('vaulta', 'cold'))?.tokens).toEqual(tokens);
  const invalid = [null, { tokens: [null], updatedAt: 1 }, { tokens: [{ ...tokens[0], amount: -1 }], updatedAt: 1 },
    { tokens, updatedAt: Date.now() + 120000 }, { tokens: [{ ...tokens[0], precision: 100 }], updatedAt: 1 }];
  for (const [i, value] of invalid.entries()) {
    await AsyncStorage.setItem('aurora.balanceSnapshot.v1.vaulta.bad' + i, JSON.stringify(value));
    expect(await loadTokenSnapshot('vaulta', 'bad' + i)).toBeNull();
  }
});

test('live account readers share only in-flight requests, never completed authorization data', async () => {
  let finish!: (value: any) => void;
  const client = { getAccount: jest.fn(() => new Promise(resolve => { finish = resolve; })) } as any;
  const first = requestLiveAccount(client, 'alice');
  expect(requestLiveAccount(client, 'alice')).toBe(first);
  await Promise.resolve();
  finish({ account: 'alice', permissions: [] }); await first;
  const next = requestLiveAccount(client, 'alice');
  expect(next).not.toBe(first);
  await Promise.resolve(); finish({ account: 'alice', permissions: [] }); await next;
  expect(client.getAccount).toHaveBeenCalledTimes(2);
});
