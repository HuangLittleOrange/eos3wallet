jest.mock('react-native', () => ({ AppState: { currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { AppState } from 'react-native';
import { shouldInvalidateBackground, withSystemAuthentication } from '../systemAuthentication';

beforeEach(() => { AppState.currentState = 'active'; jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

test('only marks an explicitly started native operation and releases the marker on failure', async () => {
  expect(shouldInvalidateBackground()).toBe(true);
  await expect(withSystemAuthentication(async () => {
    expect(shouldInvalidateBackground()).toBe(false);
    throw new Error('cancelled');
  })).rejects.toThrow('cancelled');
  expect(shouldInvalidateBackground()).toBe(true);
});

test('credential picker result waits for the application to return to foreground', async () => {
  AppState.currentState = 'background';
  let released = false;
  const result = withSystemAuthentication(async () => 'synthetic assertion').then((value) => { released = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  expect(released).toBe(false);
  const listener = jest.mocked(AppState.addEventListener).mock.calls[0][1];
  AppState.currentState = 'active'; listener('active');
  await expect(result).resolves.toBe('synthetic assertion');
  expect(shouldInvalidateBackground()).toBe(true);
});

test('remaining in background after native completion rejects rather than releasing credentials', async () => {
  jest.useFakeTimers(); AppState.currentState = 'background';
  const result = withSystemAuthentication(async () => 'synthetic assertion').catch((error) => error);
  await jest.advanceTimersByTimeAsync(5_000);
  expect((await result).message).toBe('dappBrowser.requestChanged');
  expect(shouldInvalidateBackground()).toBe(true);
});
