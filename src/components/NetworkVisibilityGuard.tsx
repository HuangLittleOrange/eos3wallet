import { useEffect } from 'react';
import { useWalletSession } from '../chain/WalletContext';
import { DEFAULT_CHAIN } from '../chain/config';
import { useNetworkVisibility } from '../chain/networkVisibility';

/** Wait for both persisted settings and the wallet session before applying hidden-network fallback. */
export default function NetworkVisibilityGuard() {
  const { chainId, setChain, walletsLoaded } = useWalletSession();
  const { enabled, ready, readError } = useNetworkVisibility();
  useEffect(() => {
    if (walletsLoaded && ready && !readError && !enabled.includes(chainId)) setChain(DEFAULT_CHAIN);
  }, [chainId, setChain, walletsLoaded, enabled, ready, readError]);
  return null;
}
