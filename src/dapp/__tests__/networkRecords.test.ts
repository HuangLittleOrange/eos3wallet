import AsyncStorage from '@react-native-async-storage/async-storage';
import { addDappHistory, listDappHistory, clearDappHistory, removeDappHistoryItem, setDappThumbnail,
  listDappFavorites, toggleDappFavorite, removeDappFavorite, assignDappRecord, subscribeDappRecords } from '../dappGate';

const url = 'https://same.example';
beforeEach(async () => { await AsyncStorage.clear(); });

test('the same URL has independent favorites and histories on each network', async () => {
  await Promise.all([addDappHistory(url, 'Main', 'vaulta'), addDappHistory(url, 'Test', 'jungle4'),
    toggleDappFavorite(url, 'Main', 'vaulta'), toggleDappFavorite(url, 'Test', 'jungle4')]);
  expect((await listDappHistory('vaulta'))[0].title).toBe('Main');
  expect((await listDappHistory('jungle4'))[0].title).toBe('Test');
  await setDappThumbnail(url, 'main-image', 'vaulta');
  expect((await listDappHistory('jungle4'))[0].thumbnail).toBeUndefined();
  await removeDappHistoryItem(url, 'jungle4');
  expect(await listDappHistory('vaulta')).toHaveLength(1);
  expect(await listDappHistory('jungle4')).toEqual([]);
  await removeDappFavorite(url, 'vaulta');
  expect(await listDappFavorites('vaulta')).toEqual([]);
  expect(await listDappFavorites('jungle4')).toHaveLength(1);
  await clearDappHistory('vaulta');
  expect(await listDappHistory('vaulta')).toEqual([]);
});

test('legacy data remains unassigned until explicitly claimed, retaining its metadata', async () => {
  const old = { url, visitedAt: 123, title: 'Old title', thumbnail: 'old-image' };
  await AsyncStorage.setItem('aurora.dapp.history.v1', JSON.stringify([old]));
  expect(await listDappHistory('vaulta')).toEqual([]);
  expect(await listDappHistory('jungle4')).toEqual([]);
  await clearDappHistory('vaulta');
  expect(await listDappHistory('unassigned')).toEqual([old]);
  await assignDappRecord('history', url, 'jungle4');
  expect(await listDappHistory('unassigned')).toEqual([]);
  expect(await listDappHistory('jungle4')).toEqual([{ ...old, networkId: 'jungle4' }]);
});

test('a claim never overwrites an existing destination record or loses the legacy copy', async () => {
  const old = { url, name: 'Old favorite', addedAt: 12 };
  await AsyncStorage.setItem('aurora.dapp.favorites.v1', JSON.stringify([old]));
  await toggleDappFavorite(url, 'Current favorite', 'vaulta');
  await assignDappRecord('favorite', url, 'vaulta');
  expect(await listDappFavorites('unassigned')).toEqual([old]);
  expect((await listDappFavorites('vaulta'))[0].name).toBe('Current favorite');
});

test('concurrent writes retain both networks, with ten recent entries per network', async () => {
  await Promise.all(Array.from({ length: 15 }, (_, i) => Promise.all([
    addDappHistory(`https://main${i}.example`, undefined, 'vaulta'),
    addDappHistory(`https://test${i}.example`, undefined, 'jungle4'),
  ])));
  expect(await listDappHistory('vaulta')).toHaveLength(10);
  expect(await listDappHistory('jungle4')).toHaveLength(10);
  await clearDappHistory('jungle4');
  expect(await listDappHistory('vaulta')).toHaveLength(10);
  const listener = jest.fn(), unsubscribe = subscribeDappRecords(listener);
  await addDappHistory(url, undefined, 'vaulta');
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  await clearDappHistory('vaulta');
  expect(listener).toHaveBeenCalledTimes(1);
});
