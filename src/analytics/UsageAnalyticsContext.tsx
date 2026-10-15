import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usageAnalytics } from './nativeAnalytics';
import type { AnalyticsState } from './usageAnalytics';

type Value = AnalyticsState & { setEnabled(enabled: boolean): Promise<void> };
const Context = createContext<Value>({ ready: true, available: false, enabled: false, error: false, setEnabled: async () => {} });
export function UsageAnalyticsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(usageAnalytics.snapshot);
  useEffect(() => {
    const unsubscribe = usageAnalytics.subscribe(setState);
    void usageAnalytics.start();
    return unsubscribe;
  }, []);
  return <Context.Provider value={{ ...state, setEnabled: usageAnalytics.setEnabled }}>{children}</Context.Provider>;
}
export const useUsageAnalytics = () => useContext(Context);
