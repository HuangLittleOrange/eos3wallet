import { EOS3_BASE_URL } from '../passkey/constants';
import { fetchWithRetry } from './fetchRetry';

/** Read-only operations service; administrator credentials never belong here. */
export const OPERATIONS_API_BASE_URL = (process.env.EXPO_PUBLIC_CONTENT_API_URL || EOS3_BASE_URL).replace(/\/+$/, '');

export class PublicApiError extends Error {
  constructor(public readonly kind: 'network' | 'server' | 'invalid', message: string) { super(message); }
}

/** A single deadline covers connection, retries and the complete response body. */
export async function fetchPublicJSON(url: string, options: {
  signal?: AbortSignal;
  maxLength: number;
  label: string;
  timeoutMs?: number;
}): Promise<unknown> {
  const { signal, maxLength, label, timeoutMs = 8000 } = options;
  const aborted = () => signal?.reason ?? Object.assign(new Error(label + ' request aborted'), { name: 'AbortError' });
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const cancel = (reason: unknown) => { controller.abort(); rejectCancelled(reason); };
  const onAbort = () => cancel(aborted());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel(new PublicApiError('network', label + ' request timed out')), timeoutMs);
  try {
    const request = (async () => {
      let response: Response;
      try {
        response = await fetchWithRetry(url, {
          signal: controller.signal, credentials: 'omit', headers: { Accept: 'application/json' },
        }, { attempts: 2 });
      } catch (error) {
        if (signal?.aborted) throw aborted();
        throw new PublicApiError('network', error instanceof Error ? error.message : label + ' connection failed');
      }
      if (!response.ok) throw new PublicApiError('server', label + ' service HTTP ' + response.status);
      const tooLarge = () => new PublicApiError('invalid', label + ' response too large');
      if (Number(response.headers.get('content-length')) > maxLength) throw tooLarge();
      let body: string;
      try { body = await response.text(); }
      catch { throw new PublicApiError('network', label + ' response could not be read'); }
      if (body.length > maxLength) throw tooLarge();
      try { return JSON.parse(body) as unknown; }
      catch { throw new PublicApiError('invalid', label + ' response is not JSON'); }
    })();
    return await Promise.race([request, cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
