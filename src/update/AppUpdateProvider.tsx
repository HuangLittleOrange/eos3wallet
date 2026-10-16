import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import AppUpdateSheet from '../components/AppUpdateSheet';
import { hasOpenLayers, subscribeLayers } from '../components/modalLayers';
import { canCheckUpdates, checkForUpdate, type AppRelease } from './appUpdate';

const FOREGROUND_CHECK_INTERVAL = 5 * 60 * 1000;
const releaseKey = (release: AppRelease) => `${release.platform}:${release.versionCode}`;
type UpdateState = { checkUpdates: () => Promise<AppRelease | null> };
const UpdateContext = createContext<UpdateState | null>(null);

/** One installer/prompt for the entire app. Remote responses contain release metadata only. */
export function AppUpdateProvider({ children }: { children: React.ReactNode }) {
  const [release, setRelease] = useState<AppRelease | null>(null);
  const visible = useRef<AppRelease | null>(null);
  const pending = useRef<AppRelease | null>(null);
  const dismissed = useRef(new Set<string>());
  const inFlight = useRef<Promise<AppRelease | null> | null>(null);
  const lastAttempt = useRef<number | null>(null);
  const alive = useRef(false);
  const appState = useRef<AppStateStatus | null>(AppState.currentState);

  const show = useCallback((next: AppRelease | null, manual = false) => {
    if (!alive.current) return;
    if (!next) {
      pending.current = null;
      visible.current = null;
      setRelease(null); // A withdrawn release also withdraws a mandatory prompt.
      return;
    }
    if (!manual && !next.forceUpdate && dismissed.current.has(releaseKey(next))) {
      pending.current = null;
      visible.current = null;
      setRelease(null);
      return;
    }
    // Avoid covering an in-progress wallet confirmation with an optional startup prompt.
    if ((appState.current != null && appState.current !== 'active')
      || (!manual && !next.forceUpdate && !visible.current && hasOpenLayers())) {
      pending.current = next;
      return;
    }
    pending.current = null;
    visible.current = next;
    setRelease(next);
  }, []);

  const check = useCallback(async (manual: boolean) => {
    if (!canCheckUpdates) return null;
    if (!inFlight.current) {
      lastAttempt.current = Date.now();
      const request = checkForUpdate().finally(() => {
        if (inFlight.current === request) inFlight.current = null;
      });
      inFlight.current = request;
    }
    const next = await inFlight.current;
    show(next, manual);
    return next;
  }, [show]);
  const checkUpdates = useCallback(() => check(true), [check]);

  useEffect(() => {
    alive.current = true;
    const flush = () => {
      const next = pending.current;
      if (next && (appState.current === 'active' || appState.current == null)
        && (next.forceUpdate || !hasOpenLayers())) show(next);
    };
    const automatic = () => {
      if (appState.current != null && appState.current !== 'active') return;
      flush();
      if (lastAttempt.current !== null && !visible.current?.forceUpdate
        && Date.now() - lastAttempt.current < FOREGROUND_CHECK_INTERVAL) return;
      void check(false).catch(() => {}); // Startup/network errors never obstruct the wallet.
    };
    automatic();
    const unsubscribe = subscribeLayers(flush);
    const subscription = AppState.addEventListener('change', state => {
      const previous = appState.current;
      appState.current = state;
      if (state === 'active' && previous !== 'active') automatic();
    });
    return () => { alive.current = false; unsubscribe(); subscription.remove(); };
  }, [check, show]);

  const close = useCallback(() => {
    const current = visible.current;
    if (!current || current.forceUpdate) return;
    dismissed.current.add(releaseKey(current));
    visible.current = null;
    setRelease(null);
  }, []);

  return (
    <UpdateContext.Provider value={{ checkUpdates }}>
      {children}
      {release ? <AppUpdateSheet key={`${release.id}:${releaseKey(release)}`} release={release} onClose={close} /> : null}
    </UpdateContext.Provider>
  );
}

export function useAppUpdates(): UpdateState {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('useAppUpdates requires AppUpdateProvider');
  return value;
}
