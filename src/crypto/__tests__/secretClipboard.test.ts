import { SecretClipboard } from '../secretClipboard';

let text: string;
let clipboard: { getStringAsync: jest.Mock; setStringAsync: jest.Mock };
beforeEach(() => {
  jest.useFakeTimers(); text = '';
  clipboard = { getStringAsync: jest.fn(async () => text),
    setStringAsync: jest.fn(async (value: string) => { text = value; }) };
});
afterEach(() => jest.useRealTimers());

test('explicit export clears its value after thirty seconds', async () => {
  const owner = new SecretClipboard(clipboard);
  expect(await owner.copy('test-secret', () => true)).toBe(true);
  expect(text).toBe('test-secret');
  await jest.advanceTimersByTimeAsync(30_000);
  expect(text).toBe('');
});
test('exit/background cleanup does not wait for the timer', async () => {
  const owner = new SecretClipboard(clipboard);
  await owner.copy('test-secret', () => true);
  await owner.clear();
  expect(text).toBe('');
});
test('does not delete another value the user copied later', async () => {
  const owner = new SecretClipboard(clipboard);
  await owner.copy('test-secret', () => true); text = 'public address';
  await owner.clear(); expect(text).toBe('public address');
});
test('cancellation clears a native copy that completes after leaving the screen', async () => {
  let finish!: () => void;
  clipboard.setStringAsync.mockImplementationOnce((value: string) => new Promise<void>((resolve) => {
    finish = () => { text = value; resolve(); };
  }));
  const owner = new SecretClipboard(clipboard);
  const copied = owner.copy('test-secret', () => true);
  await Promise.resolve();
  const cleared = owner.clear(); finish();
  expect(await copied).toBe(false); await cleared;
  expect(text).toBe('');
});
test('queued copies from a cancelled export cannot restore a secret', async () => {
  const owner = new SecretClipboard(clipboard);
  const copied = owner.copy('test-secret', () => true);
  const cleared = owner.clear();
  expect(await copied).toBe(false); await cleared;
  expect(clipboard.setStringAsync).not.toHaveBeenCalled();
});
test('a stale confirmation never writes and native failures never report success', async () => {
  const owner = new SecretClipboard(clipboard);
  expect(await owner.copy('test-secret', () => false)).toBe(false);
  clipboard.setStringAsync.mockResolvedValueOnce(false);
  expect(await owner.copy('test-secret', () => true)).toBe(false);
});

