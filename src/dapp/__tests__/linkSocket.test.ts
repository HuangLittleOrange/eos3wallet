import { listenLinkChannel } from '../linkSocket';

class Socket {
  static instances: Socket[] = [];
  binaryType = '';
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  close = jest.fn();
  constructor(readonly url: string) { Socket.instances.push(this); }
}
const originalSocket = global.WebSocket;
beforeEach(() => {
  jest.useFakeTimers();
  Socket.instances = [];
  global.WebSocket = Socket as any;
});
afterEach(() => { global.WebSocket = originalSocket; jest.useRealTimers(); });

it('receives a buffered callback while Android timers remain paused after a socket failure', () => {
  const receive = jest.fn();
  const listener = listenLinkChannel('https://cb.anchor.link/test', receive, { retryImmediately: () => true });
  Socket.instances[0].onclose!();
  // No timer is advanced: this must work while JavaTimerManager is paused.
  expect(Socket.instances).toHaveLength(2);
  const payload = new TextEncoder().encode('{"sa":"alice"}');
  Socket.instances[1].onmessage!({ data: payload.buffer });
  expect(receive).toHaveBeenCalledWith(payload);
  listener.stop();
  expect(jest.getTimerCount()).toBe(0);
});

it('bounds immediate retries and preserves backoff for a persistent failure', async () => {
  const listener = listenLinkChannel('https://cb.anchor.link/test', jest.fn(), { retryImmediately: () => true });
  for (let index = 0; index < 4; index++) Socket.instances[index].onclose!();
  expect(Socket.instances).toHaveLength(4);
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(1600);
  expect(Socket.instances).toHaveLength(5);
  listener.stop();
  expect(jest.getTimerCount()).toBe(0);
});

it('keeps normal clients on backoff and ignores repeated close events from the old socket', async () => {
  const listener = listenLinkChannel('https://cb.anchor.link/test', jest.fn());
  Socket.instances[0].onclose!();
  Socket.instances[0].onclose!();
  expect(Socket.instances).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(100);
  expect(Socket.instances).toHaveLength(2);
  listener.stop();
});

it('ignores late frames and disconnects without reconnecting after cancellation', () => {
  const receive = jest.fn();
  const listener = listenLinkChannel('https://cb.anchor.link/test', receive, { retryImmediately: () => true });
  listener.stop();
  Socket.instances[0].onmessage!({ data: new Uint8Array([1]).buffer });
  Socket.instances[0].onclose!();
  expect(receive).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});
