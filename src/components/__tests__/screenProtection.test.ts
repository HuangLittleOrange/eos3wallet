jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(async () => {}),
  allowScreenCaptureAsync: jest.fn(async () => {}),
  enableAppSwitcherProtectionAsync: jest.fn(async () => {}),
  disableAppSwitcherProtectionAsync: jest.fn(async () => {}),
}));
import * as Capture from 'expo-screen-capture';
import { acquireScreenProtection, releaseScreenProtection } from '../useScreenCaptureGuard';

beforeEach(() => jest.clearAllMocks());
test('one sensitive screen cannot disable another screen’s app-switcher protection', async () => {
  await acquireScreenProtection('export');
  await acquireScreenProtection('import');
  expect(Capture.enableAppSwitcherProtectionAsync).toHaveBeenCalledTimes(1);
  await releaseScreenProtection('export');
  expect(Capture.disableAppSwitcherProtectionAsync).not.toHaveBeenCalled();
  await releaseScreenProtection('import');
  expect(Capture.disableAppSwitcherProtectionAsync).toHaveBeenCalledTimes(1);
});
test('cleanup waits for an outstanding native acquire', async () => {
  let finish!: () => void;
  (Capture.preventScreenCaptureAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const acquired = acquireScreenProtection('cancelled');
  const released = releaseScreenProtection('cancelled');
  await Promise.resolve();
  expect(Capture.allowScreenCaptureAsync).not.toHaveBeenCalled();
  finish();
  await acquired;
  await released;
  expect(Capture.allowScreenCaptureAsync).toHaveBeenCalledWith('cancelled');
});
test('a failed protection request rejects instead of enabling secret display', async () => {
  (Capture.enableAppSwitcherProtectionAsync as jest.Mock).mockRejectedValueOnce(new Error('native unavailable'));
  await expect(acquireScreenProtection('failed')).rejects.toThrow('native unavailable');
  expect(Capture.allowScreenCaptureAsync).toHaveBeenCalledWith('failed');
  await acquireScreenProtection('retry');
  await releaseScreenProtection('retry');
});
