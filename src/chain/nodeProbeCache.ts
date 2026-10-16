import { ReadCache } from '../net/readCache';
import { probeNode, probeHistoryNode } from './client';
import type { ChainId, NodeInfo } from './config';
import { probePriceSource, type PriceSourceId } from './prices';
type Probe = { ms: number; block: number } | null;
type PriceProbe = { ms: number; covered: number } | null;
const nodes = new ReadCache<Probe>(60000);
const prices = new ReadCache<PriceProbe>(60000);
const nodeKey = (chain: ChainId, kind: 'rpc' | 'history', node: NodeInfo) => JSON.stringify([chain, kind, node.url.replace(/\/+$/, '')]);
export const peekNodeProbe = (chain: ChainId, kind: 'rpc' | 'history', node: NodeInfo) => nodes.get(nodeKey(chain, kind, node)).data;
export const peekPriceProbe = (source: PriceSourceId) => prices.get(source).data;
/** Display metrics only. Automatic node failover continues to probe the live network directly. */
export const readNodeProbe = (chain: ChainId, kind: 'rpc' | 'history', node: NodeInfo, force = false) =>
  nodes.fetch(nodeKey(chain, kind, node), () => kind === 'rpc' ? probeNode(node) : probeHistoryNode(node), force).catch(() => null);
export const readPriceProbe = (source: PriceSourceId, force = false) => prices.fetch(source, () => probePriceSource(source), force).catch(() => null);
