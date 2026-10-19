jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
import { ReadableStream } from 'node:stream/web';
import { fetch as nativeFetch } from 'expo/fetch';
import { CHAINS } from '../config';
import { readTrustedRpc } from '../trustedRpc';

const limit = 2 * 1024 * 1024;
const chainId = CHAINS.vaulta.chainIdHash;
const network = jest.mocked(nativeFetch);
const failure = () => new Error('unverified');
const query = () => readTrustedRpc(chainId, async read => {
  const value = await read('/v1/chain/get_account', {});
  return { key: JSON.stringify(value), value };
}, failure);

function response(chunks: Uint8Array[], length: string | null = null) {
  let offset = 0;
  const cancel = jest.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === chunks.length) controller.close();
      else controller.enqueue(chunks[offset++]);
    }, cancel,
  }, { highWaterMark: 0 });
  // Deliberately models the old full-buffer reader too, so regressions fail on
  // the number of bytes read rather than on an incomplete test double.
  const text = jest.fn(async () => {
    const reader = body.getReader(); const values: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength; values.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = new Uint8Array(size); let at = 0;
    for (const value of values) { data.set(value, at); at += value.byteLength; }
    return new TextDecoder().decode(data);
  });
  return { value: { ok: true, headers: { get: () => length }, body, text } as any,
    body, cancel, text, readBytes: () => chunks.slice(0, offset).reduce((n, c) => n + c.byteLength, 0) };
}
const json = (data: unknown) => response([new TextEncoder().encode(JSON.stringify(data))]).value;
function serve(make: (url: string, init: any) => any) {
  network.mockImplementation(async (input, init) => String(input).endsWith('/get_info')
    ? json({ chain_id: chainId }) : make(String(input), init));
}
beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = jest.fn().mockRejectedValue(new Error('Legacy buffered fetch is forbidden for trusted RPC'));
});
afterEach(() => { jest.useRealTimers(); });

test('reads bounded UTF-8 JSON across split code points with the native streaming transport', async () => {
  const value = { name: '中文😀' }, bytes = new TextEncoder().encode(JSON.stringify(value));
  const replies: ReturnType<typeof response>[] = [];
  serve(() => {
    const reply = response(Array.from(bytes, byte => Uint8Array.of(byte)));
    replies.push(reply); return reply.value;
  });
  await expect(query()).resolves.toEqual(value);
  expect(replies.every(reply => !reply.text.mock.calls.length && !reply.body.locked)).toBe(true);
  expect(network.mock.calls.every(([, init]) => init?.credentials === 'omit' && init?.redirect === 'error')).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('accepts valid JSON at exactly the byte limit', async () => {
  const text = '"' + 'x'.repeat(limit - 2) + '"';
  serve(() => response([new TextEncoder().encode(text)]).value);
  await expect(query()).resolves.toHaveLength(limit - 2);
});

test.each([null, '1'])('stops oversized chunked bodies before full buffering with Content-Length=%s', async length => {
  const replies: { reply: ReturnType<typeof response>; signal: AbortSignal }[] = [];
  serve((_url, init) => {
    const reply = response(Array.from({ length: 128 }, () => new Uint8Array(65536).fill(32)), length);
    replies.push({ reply, signal: init.signal }); return reply.value;
  });
  expect(await query().then(() => false, () => true)).toBe(true);
  for (const { reply, signal } of replies) {
    expect(reply.readBytes()).toBeLessThanOrEqual(limit + 65536);
    expect(reply.text).not.toHaveBeenCalled();
    expect(reply.cancel).toHaveBeenCalledTimes(1);
    expect(reply.body.locked).toBe(false);
    expect(signal.aborted).toBe(true);
  }
});

test('enforces bytes rather than decoded character count', async () => {
  const data = new TextEncoder().encode('"' + '中'.repeat(Math.ceil(limit / 3)) + '"');
  serve(() => response([data]).value);
  expect(await query().then(() => false, () => true)).toBe(true);
});

test('rejects an oversized declared body without reading it', async () => {
  const replies: ReturnType<typeof response>[] = [];
  serve(() => {
    const reply = response([Uint8Array.of(32)], String(limit + 1));
    replies.push(reply); return reply.value;
  });
  await expect(query()).rejects.toThrow('unverified');
  expect(replies.every(reply => reply.readBytes() === 0 && !reply.text.mock.calls.length)).toBe(true);
});

test('one oversized source cannot prevent the remaining independent sources from forming a quorum', async () => {
  const oversized = response(Array.from({ length: 128 }, () => new Uint8Array(65536).fill(32)));
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  oversized.cancel.mockImplementation(() => { resume(); });
  serve(async url => {
    if (url.startsWith(CHAINS.vaulta.nodes[0].url + '/')) return oversized.value;
    await gate; return json({ account_name: 'alice' });
  });
  await expect(query()).resolves.toEqual({ account_name: 'alice' });
  expect(oversized.readBytes()).toBeLessThanOrEqual(limit + 65536);
  expect(oversized.cancel).toHaveBeenCalledTimes(1);
});

test.each(['cancel', 'timeout', 'stalled cancel acknowledgement'])('a stalled stream is cancelled and its lock released on %s', async reason => {
  jest.useFakeTimers();
  const replies: { body: ReadableStream<Uint8Array>; cancel: jest.Mock; signal: AbortSignal }[] = [];
  serve((_url, init) => {
    const cancel = jest.fn(() => reason === 'stalled cancel acknowledgement' ? new Promise<void>(() => {}) : undefined);
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    replies.push({ body, cancel, signal: init.signal });
    return { ok: true, headers: { get: () => null }, body, text: () => new Promise(() => {}) };
  });
  const controller = new AbortController();
  const result = expect(readTrustedRpc(chainId, async read => ({ key: 'value', value: await read('/data', {}) }),
    failure, controller.signal)).rejects.toThrow('unverified');
  await jest.advanceTimersByTimeAsync(0);
  expect(replies.length).toBeGreaterThan(0);
  if (reason !== 'timeout') controller.abort();
  else await jest.advanceTimersByTimeAsync(12001);
  await result;
  await Promise.resolve();
  for (const reply of replies) {
    expect(reply.signal.aborted).toBe(true);
    expect(reply.cancel).toHaveBeenCalledTimes(1);
    expect(reply.body.locked).toBe(false);
  }
  expect(jest.getTimerCount()).toBe(0);
});

test('a response arriving after cancellation is closed without reading its body', async () => {
  jest.useFakeTimers();
  const replies: ReturnType<typeof response>[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  serve(async () => {
    await gate;
    const reply = response([Uint8Array.of(123, 125)]); replies.push(reply);
    return reply.value;
  });
  const controller = new AbortController();
  const result = expect(readTrustedRpc(chainId, async read => ({ key: 'value', value: await read('/data', {}) }),
    failure, controller.signal)).rejects.toThrow('unverified');
  await jest.advanceTimersByTimeAsync(0);
  controller.abort(); await result;
  release(); await jest.advanceTimersByTimeAsync(0);
  expect(replies.length).toBeGreaterThan(0);
  for (const reply of replies) {
    expect(reply.readBytes()).toBe(0);
    expect(reply.cancel).toHaveBeenCalledTimes(1);
    expect(reply.body.locked).toBe(false);
  }
  expect(jest.getTimerCount()).toBe(0);
});

test('a missing streaming body is rejected without an unbounded text fallback', async () => {
  const text = jest.fn(async () => '{}');
  serve(() => ({ ok: true, headers: { get: () => null }, body: null, text }));
  await expect(query()).rejects.toThrow('unverified');
  expect(text).not.toHaveBeenCalled();
});
