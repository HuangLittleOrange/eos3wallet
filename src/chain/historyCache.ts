import { ReadCache } from '../net/readCache';
import type { ActionsPage, ChainClient } from './client';

function valid(value: unknown): value is ActionsPage {
  const page = value as ActionsPage | null;
  return !!page && typeof page.hasMore === 'boolean' && Array.isArray(page.actions) && page.actions.length <= 100
    && page.actions.every(action => action && typeof action.id === 'string' && Number.isFinite(Number(action.seq))
      && typeof action.time === 'string' && Number.isFinite(Date.parse(action.time))
      && typeof action.contract === 'string' && typeof action.action === 'string'
      && ['from', 'to', 'quantity', 'memo'].every(key => (action as any)[key] == null || typeof (action as any)[key] === 'string')
      && (action.direction === undefined || action.direction === 'in' || action.direction === 'out'));
}
const equal = (left: ActionsPage, right: ActionsPage) => JSON.stringify(left) === JSON.stringify(right);
export const historyCache = new ReadCache<ActionsPage>(60000, { storagePrefix: 'eos3.historyDisplay.v1.', validate: valid, equal });
const olderPages = new ReadCache<ActionsPage>(60000, { validate: valid, equal });
export const historyKey = (client: ChainClient, account: string) => JSON.stringify([client.chainId, client.historyNode?.url, account]);
export function readHistoryPage(client: ChainClient, account: string, options: { skip?: number; limit?: number; force?: boolean; headVersion?: string } = {}) {
  const { skip = 0, limit = 30, force = false } = options;
  const first = skip === 0 && limit === 30;
  return (first ? historyCache : olderPages).fetch(first ? historyKey(client, account)
    : JSON.stringify([historyKey(client, account), options.headVersion, skip, limit]), () => client.getActions(account, { skip, limit }), force);
}
