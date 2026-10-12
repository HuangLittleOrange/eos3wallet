import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTENT_CACHE_KEY } from '../contentApi';
import { DEFAULT_CONTENT } from '../defaults';
import { readContentCache, writeContentCache } from '../contentCache';

beforeEach(async () => { await AsyncStorage.clear(); });

it('persists empty published lists so offline mode does not revive removed DApps', async () => {
  const response = { schemaVersion: 1 as const, content: DEFAULT_CONTENT, projects: [] };
  await writeContentCache(response);
  expect(await readContentCache()).toEqual(response);
});

it.each(['broken json', '{"version":2,"savedAt":1}', '{"version":1,"savedAt":1,"response":{"schemaVersion":1,"content":{},"projects":[]}}'])('ignores corrupt cached content %s', async (raw) => {
  await AsyncStorage.setItem(CONTENT_CACHE_KEY, raw);
  expect(await readContentCache()).toBeNull();
});
