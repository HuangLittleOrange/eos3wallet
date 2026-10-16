import { ReadCache } from '../net/readCache';
import type { ChainClient } from './client';
import type { RexBalances } from './rex';
// Display only; RexOperations always reads live balances again before reviewing an action.
export const rexDisplayCache = new ReadCache<RexBalances>(30000);
export const rexDisplayKey = (client: ChainClient, account: string) => JSON.stringify([client.chainId, client.node?.url, account]);
