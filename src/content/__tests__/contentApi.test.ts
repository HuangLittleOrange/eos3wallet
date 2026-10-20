jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));

import { fetchWithRetry } from '../../net/fetchRetry';
import { fetchAppContent, MAX_CONTENT_LENGTH } from '../contentApi';

const payload = { schemaVersion: 1, content: null, projects: [] };
const reply = (text: () => Promise<string>, status = 200, length?: string) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => length ?? null }, text,
}) as unknown as Response;

beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

it('reads the public catalog without credentials and validates the complete payload', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValue(reply(async () => JSON.stringify(payload)));
  await expect(fetchAppContent()).resolves.toEqual(payload);
  expect(fetchWithRetry).toHaveBeenCalledWith(expect.stringMatching(/\/api\/app-content\?discoveryNetworks=1$/),
    expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) }), { attempts: 2 });
  expect(jest.getTimerCount()).toBe(0);
});

it('times out a stalled body after the response headers arrive', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValue(reply(() => new Promise(() => {})));
  const result = expect(fetchAppContent()).rejects.toThrow('Content request timed out');
  await jest.advanceTimersByTimeAsync(8000);
  await result;
  expect(jest.mocked(fetchWithRetry).mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

it('settles even when a network implementation does not reject after abort', async () => {
  jest.mocked(fetchWithRetry).mockImplementation(() => new Promise(() => {}));
  const result = expect(fetchAppContent()).rejects.toThrow('Content request timed out');
  await jest.advanceTimersByTimeAsync(8000);
  await result;
});

it('cancels reading a stalled body when its caller unmounts', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValue(reply(() => new Promise(() => {})));
  const controller = new AbortController();
  const result = expect(fetchAppContent(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await result;
  expect(jest.getTimerCount()).toBe(0);
});

it('rejects an already cancelled request without connecting', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(fetchAppContent(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchWithRetry).not.toHaveBeenCalled();
});

it('rejects unsuccessful or incomplete responses instead of publishing them', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(reply(async () => '{}', 503));
  await expect(fetchAppContent()).rejects.toThrow('HTTP 503');
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(reply(async () => '{}'));
  await expect(fetchAppContent()).rejects.toThrow('Invalid app content response');
});

it('bounds both declared and actual response size', async () => {
  const text = jest.fn(async () => JSON.stringify(payload));
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(reply(text, 200, String(MAX_CONTENT_LENGTH + 1)));
  await expect(fetchAppContent()).rejects.toThrow('Content response too large');
  expect(text).not.toHaveBeenCalled();
  jest.mocked(fetchWithRetry).mockResolvedValueOnce(reply(async () => ' '.repeat(MAX_CONTENT_LENGTH + 1)));
  await expect(fetchAppContent()).rejects.toThrow('Content response too large');
});
