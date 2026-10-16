import { useReadCache } from '../net/useReadCache';
import { authorizedAppsCache, authorizedAppsKey, loadAuthorizedApps } from './authorizedAppsCache';
import type { ChainId } from './config';
export function useAuthorizedApps(chainId: ChainId, account: string) {
  return useReadCache(authorizedAppsCache, account ? authorizedAppsKey(chainId, account) : null,
    () => loadAuthorizedApps(account));
}
