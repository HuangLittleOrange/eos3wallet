import { ABI, Action, Serializer, Transaction } from '@wharfkit/antelope';
import { coreActionAbi } from './coreTokenAbi';
import type { ActionSpec } from './transact';

/** Fields not represented by the confirmation UI must never be signed silently. */
export function assertVisibleTransaction(transaction: Transaction): void {
  if (!transaction.actions.length || transaction.context_free_actions.length ||
      transaction.transaction_extensions.length || Number(transaction.delay_sec) !== 0) {
    throw new Error('Unsupported transaction fields');
  }
  const expiration = transaction.expiration.toMilliseconds();
  if (!Number.isFinite(expiration) || expiration <= Date.now() || expiration > Date.now() + 600_000) {
    throw new Error('Invalid transaction expiration');
  }
}

/** A partial ABI decode may hide trailing action bytes. Require a complete round trip. */
export function decodeVisibleAction(action: Action, abi: ABI): Record<string, any> {
  abi = coreActionAbi(String(action.account), String(action.name)) ?? abi;
  const data = Serializer.objectify(action.decodeData(abi)) as Record<string, any>;
  const encoded = Action.from({ account: action.account, name: action.name,
    authorization: action.authorization, data }, abi);
  if (encoded.data.hexString !== action.data.hexString) throw new Error('Incomplete action decoding');
  return data;
}

export function assertResolvedActionsMatch(transaction: Transaction, actions: ActionSpec[], actor: string, permission: string,
  verifiedAbis?: ReadonlyMap<string, ABI>): void {
  assertVisibleTransaction(transaction);
  if (transaction.actions.length !== actions.length) throw new Error('Transaction actions changed');
  transaction.actions.forEach((actual, index) => {
    const expected = actions[index];
    if (String(actual.account) !== expected.account || String(actual.name) !== expected.name ||
        actual.authorization.length !== 1 || String(actual.authorization[0].actor) !== actor ||
        String(actual.authorization[0].permission) !== permission) throw new Error('Transaction authorization changed');
    const abi = coreActionAbi(expected.account, expected.name) ?? verifiedAbis?.get(expected.account);
    if (!abi) throw new Error('Unverified action ABI');
    if (Action.from({ ...expected, authorization: actual.authorization }, abi).data.hexString !== actual.data.hexString) {
      throw new Error('Action differs from confirmed content');
    }
  });
}
