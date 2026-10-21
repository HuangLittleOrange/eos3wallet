// Access-token rejection may be recovered by the DApp's refresh flow. It does
// not prove that its login session has ended. Only explicit session codes qualify.
export const DAPP_SESSION_FAILURE_CODES = ['SESSION_EXPIRED', 'SESSION_INVALID', 'INVALID_SESSION'];

/** A HTTP failure is not by itself evidence of an expired DApp login.
 * The injected observer shares this allowlist.
 * Only machine-readable session errors qualify; never match error messages,
 * chain permission failures, transaction expiration, or HTTP status alone.
 */
export function dappSessionFailureCode(status: unknown, body: unknown): string | null {
  if (status !== 401 && status !== 403) return null;
  if (!body || typeof body !== 'object') return null;
  const value = body as { code?: unknown; error?: unknown };
  const error = value.error;
  const code = value.code ?? (typeof error === 'string' ? error :
    error && typeof error === 'object' ? (error as { code?: unknown }).code : null);
  if (typeof code !== 'string') return null;
  const normalized = code.toUpperCase();
  return DAPP_SESSION_FAILURE_CODES.includes(normalized)
    ? normalized : null;
}

/** A DApp callback explicitly rejected the login, rather than a node or network. */
export class DappSessionRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DappSessionRejectedError';
  }
}

/** A third-party callback must not make us buffer an unbounded error body. */
export async function readDappSessionFailure(response: Pick<Response, 'status' | 'headers' | 'body'>): Promise<string | null> {
  if ((response.status !== 401 && response.status !== 403) ||
      !/application\/(?:[a-z0-9.+-]+\+)?json/i.test(response.headers?.get('content-type') ?? '') ||
      Number(response.headers?.get('content-length')) > 8192 || !response.body || typeof TextDecoder !== 'function') return null;
  const reader = response.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 2000);
  try {
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) { void reader.cancel().catch(() => {}); return null; }
      text += decoder.decode(part.value, { stream: true });
    }
    if (timedOut) return null;
    text += decoder.decode();
    return dappSessionFailureCode(response.status, JSON.parse(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
