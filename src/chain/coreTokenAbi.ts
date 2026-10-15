import { ABI } from '@wharfkit/antelope';

/** Fixed transfer wire format, independent of an RPC's ABI response.
 * Antelope reference: contracts/eosio.token/include/eosio.token/eosio.token.hpp
 * The deployed core.vaulta transfer uses the same from/to/quantity/memo layout.
 * A contract upgrade that changes it must be reviewed, never accepted from RPC silently.
 */
const transferAbi = ABI.from({ version: 'eosio::abi/1.2', structs: [{
  name: 'transfer', base: '', fields: [
    { name: 'from', type: 'name' }, { name: 'to', type: 'name' },
    { name: 'quantity', type: 'asset' }, { name: 'memo', type: 'string' },
  ],
}], actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }] });

export function coreTransferAbi(account: string, action: string): ABI | null {
  return action === 'transfer' && ['core.vaulta', 'eosio.token'].includes(account) ? transferAbi : null;
}

// REX resource wire layouts are pinned as well: a node ABI must not turn the
// reviewed REX amount into an A withdrawal or change owner/amount field order.
const rexAbi = ABI.from({ version: 'eosio::abi/1.2', structs: [
  ['deposit', [['owner', 'name'], ['amount', 'asset']]],
  ['buyrex', [['from', 'name'], ['amount', 'asset']]],
  ['sellrex', [['from', 'name'], ['rex', 'asset']]],
  ['withdraw', [['owner', 'name'], ['amount', 'asset']]],
  ['mvfrsavings', [['owner', 'name'], ['rex', 'asset']]],
  ['cnclrexorder', [['owner', 'name']]],
].map(([name, fields]) => ({ name: name as string, base: '', fields: (fields as string[][]).map(([name, type]) => ({ name, type })) })),
actions: ['deposit', 'buyrex', 'sellrex', 'withdraw', 'mvfrsavings', 'cnclrexorder'].map((name) => ({ name, type: name, ricardian_contract: '' })) });

export function coreActionAbi(account: string, action: string): ABI | null {
  return coreTransferAbi(account, action) ?? (['core.vaulta', 'eosio'].includes(account) &&
    ['deposit', 'buyrex', 'sellrex', 'withdraw', 'mvfrsavings', 'cnclrexorder'].includes(action) ? rexAbi : null);
}
