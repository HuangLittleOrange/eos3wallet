jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { ChainClient } from '../client';
test('manually added token metadata uses verified chain precision without requiring a balance', async () => {
  const rpc = Object.create(ChainClient.prototype);
  const stats = jest.fn(async () => ({ USDT: { max_supply: '1000000000.000000 USDT' } }));
  rpc.api = { v1: { chain: { get_currency_stats: stats } } };
  expect(await rpc.getTokenMetadata('tethertether', 'USDT')).toEqual({ contract: 'tethertether', symbol: 'USDT', precision: 6 });
  expect(stats).toHaveBeenCalledTimes(1);
  stats.mockResolvedValueOnce({ USDT: { max_supply: '1000000000.0000 EOS' } });
  await expect(rpc.getTokenMetadata('tethertether', 'USDT')).rejects.toThrow('mismatch');
});
