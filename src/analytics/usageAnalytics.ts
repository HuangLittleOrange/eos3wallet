/** Only preference booleans enter this module. No wallet/user/event payload API exists. */
export const USAGE_ANALYTICS_KEY = 'eos3.usage-analytics.v1';
export type AnalyticsState = { ready: boolean; available: boolean; enabled: boolean; error: boolean };
export type AnalyticsSdk = {
  collection(enabled: boolean): Promise<void>;
  consent(value: { analytics_storage: boolean; ad_storage: false; ad_user_data: false; ad_personalization: false }): Promise<void>;
  reset(): Promise<void>;
};
type Dependencies = {
  available: boolean;
  storage: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  loadSdk(): Promise<AnalyticsSdk>;
};
const consent = (enabled: boolean) => ({ analytics_storage: enabled, ad_storage: false as const,
  ad_user_data: false as const, ad_personalization: false as const });

export function createUsageAnalytics(deps: Dependencies) {
  let state: AnalyticsState = { ready: false, available: deps.available, enabled: false, error: false };
  let sdk: AnalyticsSdk | undefined;
  let queue = Promise.resolve();
  let startup: Promise<void> | undefined;
  let revision = 0;
  const listeners = new Set<(state: AnalyticsState) => void>();
  const update = (patch: Partial<AnalyticsState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener(state)); };
  const enqueue = (task: () => Promise<void>) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  async function stop() {
    if (!sdk) return;
    await sdk.collection(false);
    await sdk.consent(consent(false));
  }
  async function apply(enabled: boolean, version: number) {
    await stop();
    if (version !== revision) return;
    if (enabled) {
      await sdk!.consent(consent(true));
      if (version !== revision) return;
      await sdk!.collection(true);
      if (version !== revision) { await stop(); return; }
    }
    update({ enabled, error: false });
  }
  async function failClosed() {
    update({ enabled: false, error: true });
    try { await stop(); } catch { /* Analytics errors never become wallet errors or telemetry. */ }
  }
  const api = {
    snapshot: () => state,
    subscribe(listener: (state: AnalyticsState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (startup) return startup;
      const version = revision;
      startup = enqueue(async () => {
        if (!deps.available) { update({ ready: true }); return; }
        try {
          sdk = await deps.loadSdk();
          await stop();
          const saved = await deps.storage.getItem(USAGE_ANALYTICS_KEY);
          // Default on only when no preference exists. Preserve explicit opt-out; corrupt or unreadable preferences stay off.
          if (version === revision) await apply(saved === null || saved === 'enabled', version);
        } catch { await failClosed(); }
        finally { update({ ready: true }); }
      });
      return startup;
    },
    setEnabled(enabled: boolean) {
      if (typeof enabled !== 'boolean') return Promise.reject(new Error('Invalid analytics preference'));
      const version = ++revision;
      return enqueue(async () => {
        if (!deps.available) throw new Error('Usage analytics is not configured');
        try {
          sdk ??= await deps.loadSdk();
          // Disabling takes effect before persisting, even if local storage is unavailable.
          if (!enabled) { await stop(); await sdk.reset(); }
          await deps.storage.setItem(USAGE_ANALYTICS_KEY, enabled ? 'enabled' : 'disabled');
          await apply(enabled, version);
        } catch {
          await failClosed();
          throw new Error('Unable to update usage analytics');
        }
      });
    },
  };
  return api;
}
