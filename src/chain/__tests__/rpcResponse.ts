import { ReadableStream } from 'node:stream/web';

/** RPC fixtures expose a real incremental body for the native fetch path. */
export function rpcResponse(value: unknown): Response {
  const text = JSON.stringify(value);
  return { ok: true, headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text)); controller.close();
    } }, { highWaterMark: 0 }),
    json: async () => value, text: async () => text,
  } as unknown as Response;
}

export function stalledRpcResponse(): Response {
  return { ok: true, headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }),
  } as unknown as Response;
}
