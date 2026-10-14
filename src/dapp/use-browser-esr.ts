import { useCallback } from 'react';
import type { WebViewProps } from 'react-native-webview';

import { dappPageOrigin } from './accessGuard';
import { ESR_BROWSER_ORIGIN_WHITELIST, isEsrLink } from './esr-links';
import { useEsrFlow } from './useEsrFlow';

type BridgeRequest = { method: string; params?: { uri?: unknown } };

/** Browser entry points share one flow, so duplicate bridge/navigation events
 * cannot create competing confirmations. The host owns ordinary page navigation.
 */
export function useBrowserEsr(navigate: (url: string) => void) {
  const flow = useEsrFlow({ onRedirect: navigate });

  const interceptUrl = useCallback((url: string): boolean => {
    if (!isEsrLink(url)) return false;
    void flow.open(url);
    return true;
  }, [flow.open]);

  // Call only after the host validates the bridge token, page and document.
  const handleBridgeRequest = useCallback((request: BridgeRequest, acknowledge: () => void): boolean => {
    if (request.method !== 'esrRequest') return false;
    acknowledge();
    void flow.open(String(request.params?.uri ?? ''));
    return true;
  }, [flow.open]);

  const onOpenWindow = useCallback<NonNullable<WebViewProps['onOpenWindow']>>((event) => {
    const target = event.nativeEvent.targetUrl;
    if (!interceptUrl(target) && dappPageOrigin(target)) navigate(target);
  }, [interceptUrl, navigate]);

  return {
    flow,
    originWhitelist: ESR_BROWSER_ORIGIN_WHITELIST,
    interceptUrl,
    handleBridgeRequest,
    onOpenWindow,
    invalidate: flow.invalidate,
  };
}
