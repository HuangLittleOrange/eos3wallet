import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTENT_CACHE_KEY, MAX_CONTENT_LENGTH } from './contentApi';
import type { AppContentResponse } from './types';
import { parseAppContentResponse } from './validation';

export async function readContentCache(): Promise<AppContentResponse | null> {
  try {
    const raw = await AsyncStorage.getItem(CONTENT_CACHE_KEY);
    if (!raw || raw.length > MAX_CONTENT_LENGTH) return null;
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt <= 0) return null;
    return parseAppContentResponse(value.response);
  } catch { return null; }
}

export async function writeContentCache(response: AppContentResponse): Promise<void> {
  await AsyncStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify({ version: 1, savedAt: Date.now(), response }));
}
