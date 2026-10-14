import { tokenPocketUserAgent } from '../token-pocket-user-agent';

test('Android keeps the device information and TP token without a WebView marker', () => {
  const result = tokenPocketUserAgent('android', 36, { Release: '16', Model: 'Pixel 9' });
  expect(result.applicationNameForUserAgent).toBe('TokenPocket_Android');
  expect(result.userAgent).toContain('Linux; Android 16; Pixel 9');
  expect(result.userAgent).toContain('Mobile Safari/537.36 TokenPocket_Android');
  expect(result.userAgent).not.toContain('; wv');
});
test('Android without native constants retains the existing fallback', () => {
  expect(tokenPocketUserAgent('android', 36).userAgent).toContain('Linux; Android 36; Android');
});
test('iOS retains the system user agent and appends only its TP token', () => {
  expect(tokenPocketUserAgent('ios', '18.0')).toEqual({
    userAgent: undefined, applicationNameForUserAgent: 'TokenPocket_iOS',
  });
});
