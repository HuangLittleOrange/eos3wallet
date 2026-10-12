import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { DEFAULT_CONTENT, DEFAULT_PROJECTS } from './defaults';
import { fetchAppContent } from './contentApi';
import { readContentCache, writeContentCache } from './contentCache';
import type { AppBrowseProject, AppContent, AppContentResponse } from './types';

export type AppContentState = {
  content: AppContent;
  projects: AppBrowseProject[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  source: 'builtin' | 'cache' | 'remote';
  refresh: () => Promise<void>;
  activate: () => () => void;
};
type State = Omit<AppContentState, 'refresh' | 'activate'>;
const Ctx = createContext<AppContentState | null>(null);
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
function dataFrom(response: AppContentResponse) {
  return { content: response.content ?? DEFAULT_CONTENT, projects: response.projects ?? DEFAULT_PROJECTS };
}

export function AppContentProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ content: DEFAULT_CONTENT, projects: DEFAULT_PROJECTS,
    source: 'builtin', loading: false, refreshing: false, error: null });
  const mounted = useRef(false);
  const generation = useRef(0);
  const remoteGeneration = useRef(-1);
  const version = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const hydration = useRef<Promise<void> | null>(null);
  const visibleConsumers = useRef(0);
  const lastAttemptAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    if (!mounted.current) return Promise.resolve();
    lastAttemptAt.current = Date.now();
    const requestVersion = ++version.current;
    const requestController = new AbortController();
    controller.current = requestController;
    setState((current) => ({ ...current, loading: current.source === 'builtin', refreshing: true, error: null }));
    const request = (async () => {
      try {
        const response = await fetchAppContent(requestController.signal);
        if (!mounted.current || requestVersion !== version.current) return;
        remoteGeneration.current = generation.current;
        setState({ ...dataFrom(response), source: 'remote', loading: false, refreshing: false, error: null });
        // A cache write failure does not make successfully fetched content invalid.
        await writeContentCache(response).catch(() => {});
      } catch (error) {
        if (mounted.current && requestVersion === version.current && !requestController.signal.aborted) {
          setState((current) => ({ ...current, loading: false, refreshing: false,
            error: error instanceof Error ? error.message : 'Unable to load app content' }));
        }
      } finally {
        if (requestVersion === version.current) {
          pending.current = null;
          controller.current = null;
        }
      }
    })();
    pending.current = request;
    return request;
  }, []);

  const hydrate = useCallback(() => {
    if (hydration.current) return hydration.current;
    const hydrationGeneration = generation.current;
    hydration.current = readContentCache().then((cached) => {
      if (cached && mounted.current && hydrationGeneration === generation.current && remoteGeneration.current !== hydrationGeneration) {
        setState((current) => ({ ...current, ...dataFrom(cached), source: 'cache' }));
      }
    }).catch(() => {});
    return hydration.current;
  }, []);

  const refreshIfStale = useCallback(() => {
    if (!mounted.current || visibleConsumers.current === 0 || AppState.currentState !== 'active') return;
    // Throttle failed attempts too, so navigating between pages cannot hammer an offline service.
    if (lastAttemptAt.current !== null && Date.now() - lastAttemptAt.current < REFRESH_INTERVAL_MS) return;
    void refresh();
  }, [refresh]);

  const stopTimer = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const activate = useCallback(() => {
    const activationGeneration = generation.current;
    let released = false;
    visibleConsumers.current += 1;
    // Cache reads and network requests begin only when an operations-backed page is visible.
    void hydrate().then(() => {
      if (released || activationGeneration !== generation.current || !mounted.current || visibleConsumers.current === 0) return;
      refreshIfStale();
      if (timer.current === null) timer.current = setInterval(refreshIfStale, REFRESH_INTERVAL_MS);
    });
    return () => {
      if (released) return;
      released = true;
      if (activationGeneration !== generation.current) return;
      visibleConsumers.current = Math.max(0, visibleConsumers.current - 1);
      if (visibleConsumers.current === 0) stopTimer();
    };
  }, [hydrate, refreshIfStale, stopTimer]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshIfStale();
    });
    return () => {
      mounted.current = false;
      generation.current += 1;
      version.current += 1;
      controller.current?.abort();
      controller.current = null;
      pending.current = null;
      hydration.current = null;
      visibleConsumers.current = 0;
      subscription.remove();
      stopTimer();
    };
  }, [refreshIfStale, stopTimer]);

  const value = useMemo(() => ({ ...state, refresh, activate }), [state, refresh, activate]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppContent(): AppContentState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAppContent requires AppContentProvider');
  return value;
}
