import { useReadCache } from '../net/useReadCache';
import { authorizedAppsCache, authorizedAppsKey, loadAuthorizedApps } from './authorizedAppsCache';
import type { ChainId } from './config';
export function useAuthorizedApps(chainId: ChainId, account: string) {
  // The EOS³ service indexes Vaulta paylimit authorizations, not other networks.
  return useReadCache(authorizedAppsCache, chainId === 'vaulta' && account ? authorizedAppsKey(chainId, account) : null,
    () => loadAuthorizedApps(account));
}
