// Handles standalone QR/Link requests without opening a placeholder WebView.
// Only a foreground callback navigates to an actual DApp page.
import React, { useEffect } from 'react';

import { useDappSession } from './DappSessionContext';
import EsrFlowOverlay from './esr-flow-overlay';
import { useEsrFlow } from './useEsrFlow';

export default function EsrRequestHost() {
  const { pendingEsr, clearPendingEsr, openDapp } = useDappSession();
  const flow = useEsrFlow({ onRedirect: openDapp });

  // Claim before parsing so this slot cannot deliver the request twice.
  useEffect(() => {
    if (!pendingEsr) return;
    clearPendingEsr();
    void flow.open(pendingEsr);
  }, [pendingEsr, clearPendingEsr, flow.open]);

  return <EsrFlowOverlay flow={flow} />;
}
