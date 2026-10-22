import { ABI, Action, Name, Serializer, Transaction } from '@wharfkit/antelope';
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

type AbiField = { name: string; type: string };
type AbiStruct = { name: string; fields: AbiField[] };
type AbiAlias = { new_type_name: string; type: string };
type AbiAction = { name: string; type: string };

/**
 * `Name.from()` silently maps every character outside [a-z1-5] to '.', so a DApp
 * could show "alice-smith" while the bytes it asks us to sign contain
 * "alice.smith". The byte round-trip below re-encodes the SAME raw value and can
 * never notice that conversion, so walk the ABI and require every name the
 * confirmation displays to survive the round-trip unchanged.
 */
function assertExactDisplayedNames(type: string, value: unknown, abi: ABI, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  const aliases = (abi as unknown as { types?: AbiAlias[] }).types ?? [];
  let resolved = type;
  for (let i = 0; i < 8; i++) {
    const alias = aliases.find((entry) => entry.new_type_name === resolved);
    if (!alias) break;
    resolved = alias.type;
  }
  if (resolved === 'name' || resolved === 'name$') {
    if (typeof value !== 'string' || String(Name.from(value)) !== value) {
      throw new Error('Action name would be rewritten');
    }
    return;
  }
  if (resolved.endsWith('[]')) {
    if (!Array.isArray(value)) return;
    for (const item of value) assertExactDisplayedNames(resolved.slice(0, -2), item, abi, depth + 1);
    return;
  }
  const structs = (abi as unknown as { structs?: AbiStruct[] }).structs ?? [];
  const struct = structs.find((entry) => entry.name === resolved);
  if (!struct || typeof value !== 'object' || Array.isArray(value)) return;
  for (const field of struct.fields) {
    if (Object.prototype.hasOwnProperty.call(value, field.name)) {
      assertExactDisplayedNames(field.type, (value as Record<string, unknown>)[field.name], abi, depth + 1);
    }
  }
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
    const actionType = ((abi as unknown as { actions?: AbiAction[] }).actions ?? [])
      .find((entry) => entry.name === expected.name)?.type ?? expected.name;
    assertExactDisplayedNames(String(actionType), expected.data, abi);
    if (Action.from({ ...expected, authorization: actual.authorization }, abi).data.hexString !== actual.data.hexString) {
      throw new Error('Action differs from confirmed content');
    }
  });
}
