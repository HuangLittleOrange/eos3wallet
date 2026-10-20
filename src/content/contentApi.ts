import { fetchPublicJSON, OPERATIONS_API_BASE_URL } from '../net/publicApi';
import { parseAppContentResponse } from './validation';
import type { AppContentResponse } from './types';

/** Public, read-only URL. No administrator credential belongs in the app bundle. */
export const CONTENT_API_BASE_URL = OPERATIONS_API_BASE_URL;
// Keep network-aware responses out of the cache read by older, mainnet-only builds.
export const CONTENT_CACHE_KEY = 'eos3.content.networks.v1:' + CONTENT_API_BASE_URL;
// Each published document is limited to 1 MiB by the server. Allow the catalog,
// operations document and response/cache envelope to travel together.
export const MAX_CONTENT_LENGTH = 3 * 1_048_576;

export async function fetchAppContent(signal?: AbortSignal): Promise<AppContentResponse> {
  return parseAppContentResponse(await fetchPublicJSON(CONTENT_API_BASE_URL + '/api/app-content?discoveryNetworks=1', {
    signal, maxLength: MAX_CONTENT_LENGTH, label: 'Content',
  }));
}
