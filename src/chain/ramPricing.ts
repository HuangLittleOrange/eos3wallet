import { Asset } from '@wharfkit/antelope';
import { t } from '../i18n';

export type RamPurchaseQuote = {
  targetBytes: number;
  estimatedBytes: number;
  /** Net payment into the RAM market, after the chain fee. */
  marketCost: string;
  chainFee: string;
  /** Total debited by buyrambytes at this market snapshot. Not a spending cap. */
  total: string;
};

/** Mirror the deployed system's buyrambytes -> buyram integer rounding:
 * cost = floor(quote * bytes / (base - bytes)); gross = floor(cost / .995);
 * fee = ceil(gross / 200), taken from gross, never added a second time.
 * Source: VaultaFoundation/system-contracts, eosio.system/src/delegate_bandwidth.cpp
 * and exchange_state.cpp. core.vaulta forwards these amounts 1:1 from A to EOS.
 * BigInt keeps token units exact instead of rounding through JS token floats.
 */
export function quoteRamBytes(opts: {
  ramReserve: string;
  tokenReserve: string;
  bytes: number;
  symbol: string;
  precision: number;
}): RamPurchaseQuote {
  try {
    const base = Asset.from(opts.ramReserve);
    const quote = Asset.from(opts.tokenReserve);
    if (base.symbol.name !== 'RAM' || base.symbol.precision !== 0 ||
        quote.symbol.name !== 'EOS' || quote.symbol.precision !== opts.precision ||
        !Number.isInteger(opts.bytes) || opts.bytes <= 0 || opts.bytes > 0xffffffff) throw new Error();
    const ram = BigInt(base.units.toString());
    const tokens = BigInt(quote.units.toString());
    const bytes = BigInt(opts.bytes);
    if (ram <= bytes || tokens <= 0n) throw new Error();
    const cost = tokens * bytes / (ram - bytes);
    const total = cost * 200n / 199n;
    const fee = (total + 199n) / 200n;
    const marketCost = total - fee;
    const estimatedBytes = marketCost * ram / (tokens + marketCost);
    if (marketCost <= 0n || estimatedBytes <= 0n || total > (1n << 62n) - 1n) throw new Error();
    const asset = (units: bigint) => String(Asset.fromUnits(units.toString(), `${opts.precision},${opts.symbol}`));
    return { targetBytes: opts.bytes, estimatedBytes: Number(estimatedBytes),
      marketCost: asset(marketCost), chainFee: asset(fee), total: asset(total) };
  } catch {
    throw new Error(t('repair.ramQuoteUnavailable'));
  }
}
