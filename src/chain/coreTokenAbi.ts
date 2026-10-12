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
