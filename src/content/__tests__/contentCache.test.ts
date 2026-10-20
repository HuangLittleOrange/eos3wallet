import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTENT_API_BASE_URL, CONTENT_CACHE_KEY, MAX_CONTENT_LENGTH } from '../contentApi';
import { DEFAULT_CONTENT, DEFAULT_PROJECTS } from '../defaults';
import { readContentCache, writeContentCache } from '../contentCache';

beforeEach(async () => { await AsyncStorage.clear(); });
const legacyKey = 'eos3.content.v1:' + CONTENT_API_BASE_URL;

it('reads a validated legacy catalog when the network-aware cache is absent', async () => {
  const response = { schemaVersion: 1 as const, content: DEFAULT_CONTENT, projects: [] };
  const raw = JSON.stringify({ version: 1, savedAt: 1, response });
  await AsyncStorage.setItem(legacyKey, raw);
  expect(await readContentCache()).toEqual(response);
  expect(await AsyncStorage.getItem(legacyKey)).toBe(raw);
  expect(await AsyncStorage.getItem(CONTENT_CACHE_KEY)).toBeNull();
});

it('prefers the new empty catalog over an older populated catalog', async () => {
  await AsyncStorage.setItem(legacyKey, JSON.stringify({ version: 1, savedAt: 1,
    response: { schemaVersion: 1, content: DEFAULT_CONTENT, projects: DEFAULT_PROJECTS } }));
  const response = { schemaVersion: 1 as const, content: DEFAULT_CONTENT, projects: [] };
  await writeContentCache(response);
  expect(await readContentCache()).toEqual(response);
});

it('does not revive the old catalog when a present new cache is invalid', async () => {
  await AsyncStorage.setItem(legacyKey, JSON.stringify({ version: 1, savedAt: 1,
    response: { schemaVersion: 1, content: DEFAULT_CONTENT, projects: DEFAULT_PROJECTS } }));
  await AsyncStorage.setItem(CONTENT_CACHE_KEY, 'broken json');
  expect(await readContentCache()).toBeNull();
});

it.each(['broken json', '{"version":2,"savedAt":1}',
  '{"version":1,"savedAt":1,"response":{"schemaVersion":1,"content":{},"projects":[]}}',
  ' '.repeat(MAX_CONTENT_LENGTH + 1)])('rejects invalid legacy cache %#', async (raw) => {
  await AsyncStorage.setItem(legacyKey, raw);
  expect(await readContentCache()).toBeNull();
});

it('does not overwrite the mainnet-only cache used by older app versions', async () => {
  const oldKey = CONTENT_CACHE_KEY.replace('content.networks.v1:', 'content.v1:');
  await AsyncStorage.setItem(oldKey, 'legacy-catalog');
  await writeContentCache({ schemaVersion: 1, content: DEFAULT_CONTENT, projects: [] });
  expect(await AsyncStorage.getItem(oldKey)).toBe('legacy-catalog');
  expect(await readContentCache()).not.toBeNull();
});

it('persists empty published lists so offline mode does not revive removed DApps', async () => {
  const response = { schemaVersion: 1 as const, content: DEFAULT_CONTENT, projects: [] };
  await writeContentCache(response);
  expect(await readContentCache()).toEqual(response);
});

it.each(['broken json', '{"version":2,"savedAt":1}', '{"version":1,"savedAt":1,"response":{"schemaVersion":1,"content":{},"projects":[]}}'])('ignores corrupt cached content %s', async (raw) => {
  await AsyncStorage.setItem(CONTENT_CACHE_KEY, raw);
  expect(await readContentCache()).toBeNull();
});
