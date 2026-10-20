jest.mock('@react-navigation/native', () => ({ useFocusEffect: (fn: () => void) =>
  require('react').useEffect(() => mockFocused ? fn() : undefined, [fn, mockFocused]) }));
jest.mock('../dappGate', () => ({ listDappHistory: jest.fn(), listDappFavorites: jest.fn(), subscribeDappRecords: jest.fn() }));
import React from 'react';
import { useDappRecords } from '../useDappRecords';
import { listDappHistory, listDappFavorites, subscribeDappRecords } from '../dappGate';
import type { ChainId } from '../../chain/config';
const { create, act } = require('react-test-renderer');
let records: ReturnType<typeof useDappRecords>, renderer: any;
let mockFocused = true;
const listeners = new Set<() => void>();
function Harness({ network }: { network: ChainId }) { records = useDappRecords(network); return null; }
const tree = (network: ChainId = 'vaulta') => React.createElement(Harness, { network });
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks(); listeners.clear(); mockFocused = true;
  jest.mocked(listDappHistory).mockResolvedValue([]);
  jest.mocked(listDappFavorites).mockResolvedValue([]);
  jest.mocked(subscribeDappRecords).mockImplementation(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = undefined; });
test('a slow old-network read cannot replace the current network records', async () => {
  let resolve!: (items: any[]) => void;
  jest.mocked(listDappHistory).mockResolvedValue([{ url: 'https://test.example', visitedAt: 1, networkId: 'jungle4' }]);
  jest.mocked(listDappHistory).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => { renderer = create(tree()); });
  await act(async () => renderer.update(tree('jungle4')));
  expect(records.history[0].url).toBe('https://test.example');
  await act(async () => { resolve([{ url: 'https://main.example', visitedAt: 1, networkId: 'vaulta' }]); });
  expect(records.history[0].url).toBe('https://test.example');
});

test('each refresh reads history and favorites once and separates current and unassigned records', async () => {
  const main = { url: 'https://main.example', visitedAt: 3, networkId: 'vaulta' as const };
  const jungle = { url: 'https://test.example', visitedAt: 2, networkId: 'jungle4' as const };
  const legacy = { url: 'https://old.example', visitedAt: 1 };
  const favorite = { url: main.url, name: 'Main', addedAt: 3, networkId: main.networkId };
  const oldFavorite = { url: legacy.url, name: 'Old', addedAt: 1 };
  jest.mocked(listDappHistory).mockResolvedValue([main, jungle, legacy]);
  jest.mocked(listDappFavorites).mockResolvedValue([favorite,
    { url: jungle.url, name: 'Test', addedAt: 2, networkId: jungle.networkId }, oldFavorite]);
  await act(async () => { renderer = create(tree()); });
  expect(records.history).toEqual([main]);
  expect(records.favorites).toEqual([favorite]);
  expect(records.unassignedHistory).toEqual([legacy]);
  expect(records.unassignedFavorites).toEqual([oldFavorite]);
  expect(listDappHistory).toHaveBeenCalledTimes(1);
  expect(listDappFavorites).toHaveBeenCalledTimes(1);
});

test('hidden pages stop reading storage and refresh changed records on return', async () => {
  await act(async () => { renderer = create(tree()); });
  await act(async () => { listeners.forEach(listener => listener()); });
  expect(listDappHistory).toHaveBeenCalledTimes(2);
  mockFocused = false;
  await act(async () => renderer.update(tree()));
  expect(listeners.size).toBe(0);
  const latest = { url: 'https://latest.example', visitedAt: 2, networkId: 'vaulta' as const };
  jest.mocked(listDappHistory).mockResolvedValue([latest]);
  await act(async () => { listeners.forEach(listener => listener()); });
  expect(listDappHistory).toHaveBeenCalledTimes(2);
  expect(listDappFavorites).toHaveBeenCalledTimes(2);
  mockFocused = true;
  await act(async () => renderer.update(tree()));
  expect(listDappHistory).toHaveBeenCalledTimes(3);
  expect(listDappFavorites).toHaveBeenCalledTimes(3);
  expect(records.history).toEqual([latest]);
  await act(async () => renderer.unmount()); renderer = undefined;
  expect(listeners.size).toBe(0);
});

test('a read that completes after leaving the page cannot update its state', async () => {
  let resolve!: (items: any[]) => void;
  jest.mocked(listDappHistory).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => { renderer = create(tree()); });
  mockFocused = false;
  await act(async () => renderer.update(tree()));
  await act(async () => { resolve([{ url: 'https://late.example', visitedAt: 1, networkId: 'vaulta' }]); });
  expect(records.history).toEqual([]);
});
