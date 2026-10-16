jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { quoteRamBytes } from '../ramPricing';

// Independent market snapshot: EOS Rio, EOS Nation and EOS Support agreed at
// 2026-10-16T16:14:29Z. Expected amounts follow the deployed contract's integer
// truncation and its fee rounding, rather than adding 0.5% to a spot quote.
const snapshot = { ramReserve: '75027854801 RAM', tokenReserve: '25419523.8353 EOS',
  bytes: 1024, symbol: 'A', precision: 4 };

test('full 1KB quote includes the chain fee exactly once and predicts integer RAM output', () => {
  expect(quoteRamBytes(snapshot)).toEqual({ targetBytes: 1024, estimatedBytes: 1023,
    marketCost: '0.3468 A', chainFee: '0.0018 A', total: '0.3486 A' });
});

test('models the finite market curve and fee rounding, not a linear spot-price estimate', () => {
  expect(quoteRamBytes({ ...snapshot, ramReserve: '1000000 RAM', tokenReserve: '100.0000 EOS' })).toEqual({
    targetBytes: 1024, estimatedBytes: 1022, marketCost: '0.1024 A', chainFee: '0.0006 A', total: '0.1030 A',
  });
});

test('uses exact integer reserves beyond the JS safe-integer range', () => {
  expect(quoteRamBytes({ ...snapshot, ramReserve: '9007199254740993 RAM', tokenReserve: '900719925474.0993 EOS' })).toEqual({
    targetBytes: 1024, estimatedBytes: 1022, marketCost: '0.1023 A', chainFee: '0.0006 A', total: '0.1029 A',
  });
});

test('uses the configured display token for Jungle4 while preserving the chain quote units', () => {
  expect(quoteRamBytes({ ...snapshot, symbol: 'EOS' })).toMatchObject({
    marketCost: '0.3468 EOS', chainFee: '0.0018 EOS', total: '0.3486 EOS',
  });
});

test.each([
  { bytes: 0 }, { bytes: -1 }, { bytes: 0.5 }, { bytes: 0x100000000 },
  { ramReserve: '0 RAM' }, { ramReserve: '1024 RAM' }, { ramReserve: '-5000 RAM' },
  { ramReserve: '1000000 EOS' }, { ramReserve: '1000000.0000 RAM' },
  { tokenReserve: '0.0000 EOS' }, { tokenReserve: '25419523.8353 FAKE' },
  { tokenReserve: '25419523.83 EOS' }, { tokenReserve: 'broken' },
  { tokenReserve: '0.0001 EOS' },
])('unavailable, malformed or unusable markets cannot produce a zero/free quote: %j', overrides => {
  expect(() => quoteRamBytes({ ...snapshot, ...overrides })).toThrow('repair.ramQuoteUnavailable');
});
