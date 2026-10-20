jest.mock('../contentApi', () => ({ ...jest.requireActual('../contentApi'), fetchAppContent: jest.fn() }));
jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppContentProvider, useAppContent } from '../AppContentContext';
import { CONTENT_API_BASE_URL, CONTENT_CACHE_KEY, fetchAppContent } from '../contentApi';
import { DEFAULT_CONTENT, DEFAULT_PROJECTS } from '../defaults';
import { discoveryForNetwork } from '../networkDiscovery';

const { create, act } = require('react-test-renderer');
let renderer: { unmount(): void } | undefined;
let state: ReturnType<typeof useAppContent>;
function Consumer() {
  state = useAppContent();
  React.useEffect(() => state.activate(), [state.activate]);
  return null;
}
const tree = () => React.createElement(AppContentProvider, null, React.createElement(Consumer));

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest.mocked(fetchAppContent).mockRejectedValue(new Error('offline'));
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer?.unmount(); });
  renderer = undefined;
});

it.each([
  ['an explicitly empty published catalog', []],
  ['a customized published catalog', [{ ...DEFAULT_PROJECTS[0], id: 'retained-app', appUrl: 'https://retained.example' }]],
] as const)('keeps %s after upgrading and restarting offline', async (_name, projects) => {
  const response = { schemaVersion: 1, content: { ...DEFAULT_CONTENT, banners: [], promos: [],
    modules: [], earnItems: [], links: [] }, projects };
  const legacyKey = 'eos3.content.v1:' + CONTENT_API_BASE_URL;
  const raw = JSON.stringify({ version: 1, savedAt: 1, response });
  await AsyncStorage.setItem(legacyKey, raw);
  expect(await AsyncStorage.getItem(CONTENT_CACHE_KEY)).toBeNull();

  for (let launch = 0; launch < 2; launch++) {
    await act(async () => { renderer = create(tree()); });
    expect(state.source).toBe('cache');
    expect(state.error).toBe('offline');
    expect(state.loading).toBe(false);
    expect(state.projects).toEqual(projects);
    expect(state.content.banners).toEqual([]);
    expect(state.content.modules).toEqual([]);
    expect(state.content.links).toEqual([]);
    expect(discoveryForNetwork(state.content, state.projects, 'vaulta').projects).toEqual(projects);
    expect(discoveryForNetwork(state.content, state.projects, 'jungle4').projects).toEqual([]);
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
  }
  expect(fetchAppContent).toHaveBeenCalledTimes(2);
  expect(await AsyncStorage.getItem(legacyKey)).toBe(raw);
});
