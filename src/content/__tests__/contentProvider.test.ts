jest.mock('../contentApi', () => ({ fetchAppContent: jest.fn() }));
jest.mock('../contentCache', () => ({ readContentCache: jest.fn(), writeContentCache: jest.fn() }));
jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  AppState: { currentState: 'active', addEventListener: jest.fn() },
}));

import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { AppContentProvider, useAppContent } from '../AppContentContext';
import { readContentCache, writeContentCache } from '../contentCache';
import { fetchAppContent } from '../contentApi';
import { DEFAULT_CONTENT, DEFAULT_PROJECTS } from '../defaults';
import type { AppContentResponse } from '../types';

const { create, act } = require('react-test-renderer');
let renderer: { unmount(): void; update(element: React.ReactElement): void } | undefined;
let state: ReturnType<typeof useAppContent>;
const response: AppContentResponse = { schemaVersion: 1, content: DEFAULT_CONTENT, projects: [] };
function Consumer({ active }: { active: boolean }) {
  state = useAppContent();
  const { activate } = state;
  React.useEffect(() => { if (active) return activate(); }, [active, activate]);
  return null;
}
const tree = (active = true) => React.createElement(AppContentProvider, null, React.createElement(Consumer, { active }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  jest.mocked(AppState.addEventListener).mockImplementation(() => ({ remove: jest.fn() }));
  jest.mocked(readContentCache).mockResolvedValue(null);
  jest.mocked(writeContentCache).mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => { renderer?.unmount(); }); renderer = undefined; });

it('does not read operations storage or connect at startup, even on foreground events', async () => {
  jest.useFakeTimers();
  let onChange!: (state: AppStateStatus) => void;
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    onChange = callback;
    return { remove: jest.fn() };
  });
  try {
    await act(async () => { renderer = create(tree(false)); });
    await act(async () => { onChange('active'); await jest.advanceTimersByTimeAsync(15 * 60 * 1000); });
    expect(readContentCache).not.toHaveBeenCalled();
    expect(fetchAppContent).not.toHaveBeenCalled();
    expect(state.loading).toBe(false);
  } finally {
    await act(async () => { renderer?.unmount(); renderer = undefined; });
    jest.useRealTimers();
  }
});

it('reuses fresh results across page changes and foreground, but explicit refresh bypasses the limit', async () => {
  jest.mocked(fetchAppContent).mockResolvedValue(response);
  let onChange!: (state: AppStateStatus) => void;
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    onChange = callback;
    return { remove: jest.fn() };
  });
  await act(async () => { renderer = create(tree()); });
  await act(async () => { renderer?.update(tree(false)); });
  await act(async () => { onChange('active'); renderer?.update(tree()); });
  expect(fetchAppContent).toHaveBeenCalledTimes(1);
  expect(readContentCache).toHaveBeenCalledTimes(1);
  await act(async () => { await state.refresh(); });
  expect(fetchAppContent).toHaveBeenCalledTimes(2);
});

it('stops hidden-page polling and refreshes stale results on the next visible page', async () => {
  jest.useFakeTimers();
  let onChange!: (state: AppStateStatus) => void;
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    onChange = callback;
    return { remove: jest.fn() };
  });
  try {
    jest.mocked(fetchAppContent).mockResolvedValue(response);
    await act(async () => { renderer = create(tree()); });
    await act(async () => { renderer?.update(tree(false)); });
    await act(async () => { await jest.advanceTimersByTimeAsync(10 * 60 * 1000); onChange('active'); });
    expect(fetchAppContent).toHaveBeenCalledTimes(1);
    await act(async () => { renderer?.update(tree()); });
    expect(fetchAppContent).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => { renderer?.unmount(); renderer = undefined; });
    jest.useRealTimers();
  }
});

it('does not fetch when leaving the page before cache hydration finishes', async () => {
  let resolveCache!: (value: typeof response) => void;
  jest.mocked(readContentCache).mockImplementation(() => new Promise((done) => { resolveCache = done; }));
  await act(async () => { renderer = create(tree()); });
  await act(async () => { renderer?.update(tree(false)); resolveCache(response); });
  expect(fetchAppContent).not.toHaveBeenCalled();
  expect(state.projects).toEqual([]);
  await act(async () => { renderer?.update(tree()); });
  expect(fetchAppContent).toHaveBeenCalledTimes(1);
});

it('rate limits failed automatic refreshes while allowing a manual retry', async () => {
  jest.mocked(fetchAppContent).mockRejectedValue(new Error('offline'));
  await act(async () => { renderer = create(tree()); });
  await act(async () => { renderer?.update(tree(false)); });
  await act(async () => { renderer?.update(tree()); });
  expect(fetchAppContent).toHaveBeenCalledTimes(1);
  await act(async () => { await state.refresh(); });
  expect(fetchAppContent).toHaveBeenCalledTimes(2);
});

it('replaces defaults with an explicitly empty remote catalog', async () => {
  jest.mocked(fetchAppContent).mockResolvedValue(response);
  await act(async () => { renderer = create(tree()); });
  expect(state.projects).toEqual([]);
  expect(state.source).toBe('remote');
  expect(state.loading).toBe(false);
  expect(writeContentCache).toHaveBeenCalledWith(response);
});

it('coalesces visible consumers and keeps effect replay from opening duplicate connections', async () => {
  jest.mocked(fetchAppContent).mockResolvedValue(response);
  await act(async () => {
    renderer = create(React.createElement(React.StrictMode, null,
      React.createElement(AppContentProvider, null,
        React.createElement(Consumer, { active: true }), React.createElement(Consumer, { active: true })
      )
    ));
  });
  expect(fetchAppContent).toHaveBeenCalledTimes(1);
  expect(state.source).toBe('remote');
});

it('uses bundled content only for sections that have never been published', async () => {
  jest.mocked(fetchAppContent).mockResolvedValue({ schemaVersion: 1, content: null, projects: null });
  await act(async () => { renderer = create(tree()); });
  expect(state.content).toEqual(DEFAULT_CONTENT);
  expect(state.projects).toEqual(DEFAULT_PROJECTS);
  jest.mocked(fetchAppContent).mockResolvedValue({ ...response, content: { ...DEFAULT_CONTENT, banners: [], links: [] } });
  await act(async () => { await state.refresh(); });
  expect(state.content.banners).toEqual([]);
  expect(state.content.links).toEqual([]);
  expect(state.projects).toEqual([]);
});

it('keeps the last successful remote content when later requests fail', async () => {
  jest.mocked(fetchAppContent).mockResolvedValue(response);
  await act(async () => { renderer = create(tree()); });
  jest.mocked(fetchAppContent).mockRejectedValue(new Error('offline'));
  await act(async () => { await state.refresh(); });
  expect(state.projects).toEqual([]);
  expect(state.source).toBe('remote');
  expect(state.error).toBe('offline');
});

it('refreshes on foreground and every five minutes while active, then removes listeners', async () => {
  jest.useFakeTimers();
  const originalState = AppState.currentState;
  let onChange!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  jest.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
    onChange = callback;
    return { remove };
  });
  try {
    AppState.currentState = 'active';
    jest.mocked(fetchAppContent).mockResolvedValue(response);
    await act(async () => { renderer = create(tree()); });
    expect(fetchAppContent).toHaveBeenCalledTimes(1);
    await act(async () => { await jest.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(fetchAppContent).toHaveBeenCalledTimes(2);
    AppState.currentState = 'background';
    await act(async () => { await jest.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(fetchAppContent).toHaveBeenCalledTimes(2);
    AppState.currentState = 'active';
    await act(async () => { onChange('active'); });
    expect(fetchAppContent).toHaveBeenCalledTimes(3);
    await act(async () => { renderer?.unmount(); renderer = undefined; });
    expect(remove).toHaveBeenCalled();
    await act(async () => { await jest.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(fetchAppContent).toHaveBeenCalledTimes(3);
  } finally {
    if (renderer) await act(async () => { renderer?.unmount(); renderer = undefined; });
    AppState.currentState = originalState;
    jest.useRealTimers();
  }
});

it('retains cached content and exposes retry when a refresh fails', async () => {
  jest.mocked(readContentCache).mockResolvedValue(response);
  jest.mocked(fetchAppContent).mockRejectedValue(new Error('offline'));
  await act(async () => { renderer = create(tree()); });
  expect(state.projects).toEqual([]);
  expect(state.source).toBe('cache');
  expect(state.error).toBe('offline');
  jest.mocked(fetchAppContent).mockResolvedValue({ ...response, projects: DEFAULT_PROJECTS });
  await act(async () => { await state.refresh(); });
  expect(state.projects).toHaveLength(10);
  expect(state.error).toBeNull();
});

it('coalesces simultaneous refreshes and does not let late cache hydration replace remote data', async () => {
  let resolveCache!: (value: typeof response) => void;
  let resolveRemote!: (value: typeof response) => void;
  jest.mocked(readContentCache).mockImplementation(() => new Promise((done) => { resolveCache = done; }));
  jest.mocked(fetchAppContent).mockImplementation(() => new Promise((done) => { resolveRemote = done; }));
  await act(async () => { renderer = create(tree()); });
  let first!: Promise<void>;
  await act(async () => { first = state.refresh(); expect(state.refresh()).toBe(first); });
  await act(async () => { resolveRemote(response); await first; });
  await act(async () => { resolveCache({ ...response, projects: DEFAULT_PROJECTS }); });
  expect(state.projects).toEqual([]);
  expect(state.source).toBe('remote');
});

it('aborts an outstanding request when the provider unmounts and does not persist its result', async () => {
  let resolveRemote!: (value: typeof response) => void;
  let signal: AbortSignal | undefined;
  jest.mocked(fetchAppContent).mockImplementation((value) => {
    signal = value;
    return new Promise((done) => { resolveRemote = done; });
  });
  await act(async () => { renderer = create(tree()); });
  await act(async () => { renderer?.unmount(); renderer = undefined; });
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolveRemote(response); });
  expect(writeContentCache).not.toHaveBeenCalled();
});
