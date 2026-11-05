import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTENT_API_BASE_URL, CONTENT_CACHE_KEY, MAX_CONTENT_LENGTH } from './contentApi';
import type { AppContentResponse } from './types';
import { parseAppContentResponse } from './validation';

export async function readContentCache(): Promise<AppContentResponse | null> {
  try {
    // An offline upgrade still needs the last published mainnet catalog, including
    // deliberately empty lists. Only a missing new cache may use the legacy key;
    // never replace a newer catalog or write back into the cache used by old builds.
    const raw = await AsyncStorage.getItem(CONTENT_CACHE_KEY)
      ?? await AsyncStorage.getItem('eos3.content.v1:' + CONTENT_API_BASE_URL);
    if (!raw || raw.length > MAX_CONTENT_LENGTH) return null;
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt <= 0) return null;
    return parseAppContentResponse(value.response);
  } catch { return null; }
}

export async function writeContentCache(response: AppContentResponse): Promise<void> {
  await AsyncStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), response }));
}
