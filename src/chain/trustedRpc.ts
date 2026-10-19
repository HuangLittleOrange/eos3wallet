import { CHAINS } from './config';
import { fetch as fetchRpc } from 'expo/fetch';

const MAX_RESPONSE = 2 * 1024 * 1024;
type RpcRead = (path: string, body: unknown) => Promise<any>;

/** Two distinct built-in HTTPS hosts must agree. A selected/custom endpoint or
 * remote node catalog cannot grant itself trust. Bounds include response bodies.
 * This tolerates one malicious source, not two colluding trust anchors.
 */
export async function readTrustedRpc<T>(chainId: string,
  query: (read: RpcRead) => Promise<{ key: string; value: T }>,
  failure: () => Error, signal?: AbortSignal): Promise<T> {
  const chain = Object.values(CHAINS).find(c => c.chainIdHash.toLowerCase() === chainId.toLowerCase());
  if (!chain) throw failure();
  const hosts = new Set<string>();
  const sources = chain.nodes.filter(node => {
    const url = new URL(node.url);
    if (url.protocol !== 'https:' || hosts.has(url.hostname)) return false;
    hosts.add(url.hostname);
    return true;
  });
  if (signal?.aborted) throw failure();
  const controller = new AbortController();
  let cancel: (() => void) | undefined;
  async function read(url: string, path: string, body: unknown): Promise<any> {
    const requestController = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stopBody = () => {
      if (reader) {
        const current = reader;
        reader = undefined;
        // Never wait for a native cancel acknowledgement to enforce a deadline.
        void current.cancel().catch(() => {});
        current.releaseLock();
      } else if (response?.body) {
        void response.body.cancel().catch(() => {});
      }
    };
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const abort = () => { requestController.abort(); stopBody(); rejectCancelled(failure()); };
    controller.signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 4_000);
    try {
      if (controller.signal.aborted) abort();
      return await Promise.race([(async () => {
        // Expo's native fetch exposes the body incrementally. Legacy RN fetch
        // buffers before exposing it, so it cannot enforce this byte limit.
        // As before, each trusted read makes one attempt within its deadline.
        response = await fetchRpc(url + path, {
          method: 'POST', body: JSON.stringify(body), signal: requestController.signal,
          credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        });
        if (requestController.signal.aborted) { stopBody(); throw failure(); }
        if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE) throw failure();
        reader = response.body?.getReader();
        if (!reader) throw failure();
        const current = reader;
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const { done, value } = await current.read();
          if (requestController.signal.aborted) throw failure();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_RESPONSE) throw failure();
          chunks.push(value);
        }
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder().decode(data));
      })(), cancelled]);
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', abort);
      requestController.abort();
      stopBody();
    }
  }
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<T>((resolve, reject) => {
      const votes = new Map<string, { count: number; value: T }>();
      let next = 0, running = 0, done = false;
      const finish = (value?: { value: T }) => {
        if (done) return;
        done = true;
        controller.abort();
        if (value) resolve(value.value); else reject(failure());
      };
      cancel = () => finish();
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(), 12_000);
      if (signal?.aborted) { finish(); return; }
      const start = () => {
        while (!done && running < 3 && next < sources.length) {
          const node = sources[next++];
          running++;
          void (async () => {
            const info = await read(node.url, '/v1/chain/get_info', {});
            if (info.chain_id !== chain.chainIdHash) throw failure();
            const result = await query((path, payload) => read(node.url, path, payload));
            if (done) return;
            const vote = votes.get(result.key) ?? { count: 0, value: result.value };
            votes.set(result.key, vote);
            if (++vote.count >= 2) finish(vote);
          })().catch(() => {}).finally(() => {
            running--;
            start();
            if (!done && !running && next === sources.length) finish();
          });
        }
        if (!done && !running) finish();
      };
      start();
    });
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    clearTimeout(timer!);
    controller.abort();
  }
}
