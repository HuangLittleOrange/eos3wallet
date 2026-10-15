jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
import { ABI, PackedTransaction, PrivateKey, Serializer, Signature } from '@wharfkit/antelope';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import { transact } from '../transact';
import { CHAINS } from '../config';
import { coreTransferAbi } from '../coreTokenAbi';

const key = PrivateKey.generate('K1'); // synthetic, unfunded test key
const request = () => ({ account: 'core.vaulta', name: 'transfer', data: {
  from: 'alice', to: 'bob', quantity: '1.0000 A', memo: 'attacker',
} });
const transferAbi = coreTransferAbi('core.vaulta', 'transfer')!;
let calls: { url: string; body: any }[];
let spies: jest.SpyInstance[];
function rpc(abi = transferAbi, beforeResponse?: (url: string) => void, authorizationFailure = false) {
  globalThis.fetch = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
    beforeResponse?.(String(url));
    let body: any;
    if (String(url).endsWith('/get_raw_abi')) body = { account_name: 'core.vaulta', code_hash: '00'.repeat(32),
      abi_hash: '00'.repeat(32), abi: Buffer.from(Serializer.encode({ object: abi }).array).toString('base64') };
    else if (String(url).endsWith('/get_info')) body = {
      server_version: '0', chain_id: CHAINS.vaulta.chainIdHash, head_block_num: 1000, last_irreversible_block_num: 990,
      last_irreversible_block_id: '000003de' + 'ab'.repeat(28), head_block_id: '000003e8' + 'cd'.repeat(28),
      head_block_time: new Date().toISOString().slice(0, -1), head_block_producer: 'eosio',
      virtual_block_cpu_limit: 0, virtual_block_net_limit: 0, block_cpu_limit: 0, block_net_limit: 0,
    };
    else if (String(url).endsWith('/send_transaction')) body = authorizationFailure
      ? { code: 500, message: 'Internal Service Error', error: { code: 3090003, name: 'unsatisfied_authorization', what: 'Provided keys, permissions, and delays do not satisfy declared authorizations', details: [] } }
      : { transaction_id: 'aa'.repeat(32) };
    else if (authorizationFailure && String(url).endsWith('/get_account')) body = { account_name: 'alice', permissions: ['active', 'owner'].map(name => ({
      perm_name: name, parent: name === 'owner' ? '' : 'owner', required_auth: { threshold: 1, keys: [], accounts: [], waits: [] }
    })) };
    else throw new Error('Unexpected RPC endpoint');
    const rejected = authorizationFailure && String(url).endsWith('/send_transaction');
    return { ok: !rejected, status: rejected ? 500 : 200, json: async () => body, clone: () => ({ json: async () => body }), headers: { entries: () => [['content-type', 'application/json']] },
      text: async () => JSON.stringify(body) } as any;
  });
}
const options = () => ({ chainId: 'vaulta' as const, node: { id: 'test', name: 'test', url: 'https://rpc.invalid' },
  actor: 'alice', signer: { kind: 'privatekey' as const, privateKey: String(key) }, actions: [request()] });
beforeEach(() => {
  jest.clearAllMocks(); calls = [];
  spies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method as 'log').mockImplementation(() => {}));
});
afterEach(() => spies.forEach((spy) => spy.mockRestore()));

test('real private-key plugin sends only signed transaction bytes, without logs/clipboard/plaintext storage', async () => {
  rpc(); const result = await transact(options());
  const sent = calls.find((call) => call.url.endsWith('/send_transaction'))!.body;
  const transaction = PackedTransaction.from(sent).getTransaction();
  expect(result.txId).toBe(String(transaction.id));
  expect(Serializer.objectify(transaction.actions[0].decodeData(transferAbi))).toEqual(request().data);
  expect(Signature.from(sent.signatures[0]).verifyDigest(transaction.signingDigest(CHAINS.vaulta.chainIdHash), key.toPublic())).toBe(true);
  for (const secret of [String(key), key.toWif(), key.data.hexString]) expect(JSON.stringify(calls)).not.toContain(secret);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled(); expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled(); spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
});
test('real signing boundary rejects a malicious RPC ABI before broadcasting', async () => {
  const malicious = ABI.from({ structs: [{ name: 'transfer', base: '', fields: [
    { name: 'from', type: 'name' }, { name: 'memo', type: 'name' }, { name: 'quantity', type: 'asset' }, { name: 'to', type: 'string' },
  ] }], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });
  rpc(malicious); await expect(transact(options())).rejects.toThrow('differs');
  expect(calls.some((call) => call.url.endsWith('/send_transaction'))).toBe(false);
});
test('wallet/network cancellation during RPC preparation stops the real broadcast', async () => {
  let current = true; rpc(transferAbi, () => { current = false; });
  await expect(transact({ ...options(), isCurrent: () => current })).rejects.toThrow('requestChanged');
  expect(calls.some((call) => call.url.endsWith('/send_transaction'))).toBe(false);
});
test('mutating the original action during preparation cannot change the reviewed transfer', async () => {
  const opts = options(); rpc(transferAbi, () => { opts.actions[0].data.to = 'carol'; });
  await transact(opts);
  const sent = calls.find((call) => call.url.endsWith('/send_transaction'))!.body;
  const transaction = PackedTransaction.from(sent).getTransaction();
  expect(String((transaction.actions[0].decodeData(transferAbi) as any).to)).toBe('bob');
});


test('a real Session RPC permission rejection becomes a clear error after the normal signed attempt, without retries or secret disclosure', async () => {
  rpc(transferAbi, undefined, true);
  await expect(transact(options())).rejects.toThrow('chainError.keyNotAuthorized');
  const sends = calls.filter(call => call.url.endsWith('/send_transaction'));
  expect(sends).toHaveLength(1);
  const sendIndex = calls.findIndex(call => call.url.endsWith('/send_transaction'));
  const readIndex = calls.findIndex(call => call.url.endsWith('/get_account'));
  expect(readIndex).toBeGreaterThan(sendIndex);
  const diagnostics = calls.slice(sendIndex + 1);
  expect(diagnostics.map(call => call.url.split('/').pop()).sort()).toEqual(['get_account', 'get_info']);
  const allOutput = JSON.stringify({ calls, logs: spies.map(spy => spy.mock.calls) });
  for (const secret of [String(key), key.toWif(), key.data.hexString]) expect(allOutput).not.toContain(secret);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
});
