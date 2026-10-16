let mockFocused = true;
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (effect: () => (() => void) | void) =>
  require('react').useEffect(() => mockFocused ? effect() : undefined, [effect, mockFocused]) }));
jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { ReadCache } from '../readCache';
import { useReadCache } from '../useReadCache';
const { act, create } = require('react-test-renderer');
let renderer: any, state: ReturnType<typeof useReadCache<string[]>>;
function Harness({ cache, scope, load }: { cache: ReadCache<string[]>; scope: string; load: () => Promise<string[]> }) {
  state = useReadCache(cache, scope, load); return null;
}
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers(); jest.clearAllMocks(); mockFocused = true; AppState.currentState = 'active'; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; jest.clearAllTimers(); jest.useRealTimers(); });

test('fresh navigation reuses data; stale visible data refreshes, inactive and blurred pages stop polling', async () => {
  const cache = new ReadCache<string[]>(60000); const load = jest.fn(async () => ['latest']); cache.remember('alice', ['saved']);
  const props = { cache, scope: 'alice', load };
  await act(async () => { renderer = create(React.createElement(Harness, props)); });
  expect(state.data).toEqual(['saved']); expect(load).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(60000)); expect(load).toHaveBeenCalledTimes(1);
  AppState.currentState = 'background';
  await act(async () => jest.advanceTimersByTime(60000)); expect(load).toHaveBeenCalledTimes(1);
  AppState.currentState = 'active';
  await act(async () => jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1]('active'));
  expect(load).toHaveBeenCalledTimes(2);
  mockFocused = false; await act(async () => renderer.update(React.createElement(Harness, props)));
  await act(async () => jest.advanceTimersByTime(60000)); expect(load).toHaveBeenCalledTimes(2);
});

test('a slow hydration after changing account never calls the new loader under the old key', async () => {
  let finish!: (raw: string | null) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const cache = new ReadCache<string[]>(60000, { storagePrefix: 'focus.', validate: (data): data is string[] => Array.isArray(data) });
  const alice = jest.fn(async () => ['alice']), bob = jest.fn(async () => ['bob']);
  await act(async () => { renderer = create(React.createElement(Harness, { cache, scope: 'alice', load: alice })); });
  await act(async () => renderer.update(React.createElement(Harness, { cache, scope: 'bob', load: bob })));
  await act(async () => finish(null));
  expect(alice).not.toHaveBeenCalled(); expect(bob).toHaveBeenCalledTimes(1);
  expect(cache.get('alice').data).toBeUndefined(); expect(state.data).toEqual(['bob']);
});
test('an already requested refresh captures its account before hydration, and old callbacks cannot refresh the new account', async () => {
  let finish!: (raw: string | null) => void;
  jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const cache = new ReadCache<string[]>(60000, { storagePrefix: 'manual.', validate: (data): data is string[] => Array.isArray(data) });
  const alice = jest.fn(async () => ['alice']), bob = jest.fn(async () => ['bob']);
  await act(async () => { renderer = create(React.createElement(Harness, { cache, scope: 'alice', load: alice })); });
  const oldRefresh = state.refresh; const pending = oldRefresh();
  await act(async () => renderer.update(React.createElement(Harness, { cache, scope: 'bob', load: bob })));
  await act(async () => { finish(null); await pending; });
  expect(cache.get('alice').data).toEqual(['alice']); expect(cache.get('bob').data).toEqual(['bob']);
  await expect(oldRefresh()).rejects.toThrow('context changed');
  expect(alice).toHaveBeenCalledTimes(1); expect(bob).toHaveBeenCalledTimes(1);
});
