jest.mock('../client', () => ({ probeNode: jest.fn(async () => ({ ms: 10, block: 1 })), probeHistoryNode: jest.fn(async () => ({ ms: 20, block: 1 })) }));
jest.mock('../prices', () => ({ probePriceSource: jest.fn(async () => ({ ms: 30, covered: 2 })) }));
import { probeNode, probeHistoryNode } from '../client';
import { probePriceSource } from '../prices';
import { peekNodeProbe, readNodeProbe, readPriceProbe } from '../nodeProbeCache';
let scope = 0;
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
test('display probes share endpoint reads, expire after a minute and honor explicit retesting', async () => {
  const node = { id: 'same', name: 'Node', url: `https://node-${++scope}.example` };
  await Promise.all([readNodeProbe('vaulta', 'rpc', node), readNodeProbe('vaulta', 'rpc', node)]);
  await readNodeProbe('vaulta', 'rpc', { ...node, id: 'renamed' }); expect(probeNode).toHaveBeenCalledTimes(1);
  expect(peekNodeProbe('vaulta', 'rpc', node)).toEqual({ ms: 10, block: 1 });
  await readNodeProbe('vaulta', 'rpc', node, true); expect(probeNode).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(60000); await readNodeProbe('vaulta', 'rpc', node); expect(probeNode).toHaveBeenCalledTimes(3);
  await readNodeProbe('jungle4', 'rpc', node); expect(probeNode).toHaveBeenCalledTimes(4);
  await readNodeProbe('vaulta', 'history', node); expect(probeHistoryNode).toHaveBeenCalledTimes(1);
});
test('failed probes are reusable null results and price-source probes also share reads', async () => {
  const node = { id: 'failed', name: 'Failed', url: `https://node-${++scope}.example` };
  jest.mocked(probeNode).mockResolvedValueOnce(null);
  await readNodeProbe('vaulta', 'rpc', node); await readNodeProbe('vaulta', 'rpc', node);
  expect(peekNodeProbe('vaulta', 'rpc', node)).toBeNull(); expect(probeNode).toHaveBeenCalledTimes(1);
  await Promise.all([readPriceProbe('coingecko'), readPriceProbe('coingecko')]); expect(probePriceSource).toHaveBeenCalledTimes(1);
});
