jest.mock('expo', () => ({ requireNativeModule: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key }));
import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';
import { beginAnchorAuthorization } from '../anchorAuthorization';

beforeEach(() => { jest.clearAllMocks(); });
it('keeps a distinct native lease until stopped and only releases it once', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  const start = jest.fn().mockResolvedValue(undefined), stop = jest.fn().mockResolvedValue(undefined);
  jest.mocked(requireNativeModule).mockReturnValue({ start, stop } as any);
  const release = await beginAnchorAuthorization();
  expect(start).toHaveBeenCalledWith(expect.any(String), 'import.viaAnchor', 'anchorImport.waiting');
  expect(stop).not.toHaveBeenCalled();
  release(); release();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledWith(start.mock.calls[0][0]);
});
it('propagates startup failure before a browser may be opened', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.mocked(requireNativeModule).mockReturnValue({ start: jest.fn().mockRejectedValue(new Error('unavailable')) } as any);
  await expect(beginAnchorAuthorization()).rejects.toThrow('unavailable');
});
it('does not request the Android module on iOS', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const release = await beginAnchorAuthorization(); release();
  expect(requireNativeModule).not.toHaveBeenCalled();
});
