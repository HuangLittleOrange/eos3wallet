import { ReadCache } from '../net/readCache';
import { EOS3_BASE_URL } from '../passkey/constants';
import { fetchAuthorizedApps, type AuthorizedAppsOverview } from './permissions';
import type { ChainId } from './config';

function valid(value: unknown): value is AuthorizedAppsOverview {
  const data = value as AuthorizedAppsOverview | null;
  const asset = (value: any) => value && typeof value.tokenContract === 'string' && typeof value.symbol === 'string'
    && Number.isInteger(value.precision) && value.precision >= 0 && value.precision <= 18;
  return !!data && typeof data.eosAccount === 'string' && Array.isArray(data.permissions)
    && data.permissions.every(app => app && typeof app.permission === 'string' && typeof app.parent === 'string'
      && typeof app.managedByPayLimit === 'boolean' && typeof app.active === 'boolean'
      && ['botIdHash', 'botUsername', 'deviceLabel', 'displayName', 'projectName', 'projectDescription', 'createdAt']
        .every(key => (app as any)[key] == null || typeof (app as any)[key] === 'string')
      && Array.isArray(app.assets) && app.assets.every(item => asset(item)
        && ['perTxLimit', 'dailyLimit', 'dailySpent', 'totalBudget', 'totalSpent']
          .every(key => (item as any)[key] == null || typeof (item as any)[key] === 'string')))
    && Array.isArray(data.assetCatalog) && data.assetCatalog.every(asset);
}
export const authorizedAppsCache = new ReadCache<AuthorizedAppsOverview>(60 * 60 * 1000,
  { storagePrefix: 'eos3.authorizedDisplay.v1.', validate: valid });
export const authorizedAppsKey = (chainId: ChainId, account: string) => JSON.stringify([EOS3_BASE_URL, chainId, account]);
export async function loadAuthorizedApps(account: string): Promise<AuthorizedAppsOverview> {
  const data = await fetchAuthorizedApps(account);
  if (data.eosAccount !== account) throw new Error('Account response mismatch');
  return { eosAccount: data.eosAccount, permissions: data.permissions, assetCatalog: data.assetCatalog ?? [] };
}
export function invalidateAuthorizedApps(chainId: ChainId, account: string) {
  authorizedAppsCache.invalidate(authorizedAppsKey(chainId, account));
}
