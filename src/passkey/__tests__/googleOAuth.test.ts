jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../net/fetchRetry', () => ({ fetchWithRetry: jest.fn() }));

import {
  GOOGLE_OAUTH_RETURN_URL, googleOAuthStartUrl, googleOAuthTokenFromUrl,
  platformPasskeyRegisterOptions, platformPasskeyRegisterVerify,
} from '../eos3Api';
import { fetchWithRetry } from '../../net/fetchRetry';

it('uses the exact backend allowlisted callback and a registered native scheme', () => {
  const url = new URL(googleOAuthStartUrl());
  expect(url.origin + url.pathname).toBe('https://eos3.app/api/auth/google/start');
  expect(url.searchParams.get('returnTo')).toBe('eos3wallet://passkey-create');
  expect(require('../../../app.json').expo.scheme).toContain(new URL(GOOGLE_OAUTH_RETURN_URL).protocol.slice(0, -1));
});

it('decodes the fragment session token without relying on browser cookies', () => {
  expect(googleOAuthTokenFromUrl(`${GOOGLE_OAUTH_RETURN_URL}#token=session%2Btoken%3D`)).toBe('session+token=');
});

it('treats provider cancellation as cancellation', () => {
  expect(googleOAuthTokenFromUrl(`${GOOGLE_OAUTH_RETURN_URL}?authError=oauth_cancelled&diagnostic=example`)).toBeNull();
});

it.each([
  'aurorawallet://passkey-create#token=secret',
  'eos3wallet://passkey-create.evil#token=secret',
  'eos3wallet://user@passkey-create#token=secret',
  'eos3wallet://passkey-create/extra#token=secret',
  'https://eos3.app/passkey-create#token=secret',
  'invalid',
  `${GOOGLE_OAUTH_RETURN_URL}?authError=oauth_state_invalid#token=secret`,
  `${GOOGLE_OAUTH_RETURN_URL}?token=secret`,
  GOOGLE_OAUTH_RETURN_URL,
  `${GOOGLE_OAUTH_RETURN_URL}#token=%20`,
  `${GOOGLE_OAUTH_RETURN_URL}#token=one&token=two`,
])('rejects invalid or failed callbacks without exposing their contents: %s', (url) => {
  expect(() => googleOAuthTokenFromUrl(url)).toThrow('eos3Error.googleAuthFailed');
});

it('sends the session on both registration requests while preserving challenge cookies', async () => {
  jest.mocked(fetchWithRetry).mockResolvedValueOnce({
    ok: true, text: async () => JSON.stringify({ publicKey: { rp: { name: 'EOS' } } }),
  } as Response).mockResolvedValueOnce({
    ok: true, text: async () => JSON.stringify({ hasWallet: true }),
  } as Response);
  const token = googleOAuthTokenFromUrl(`${GOOGLE_OAUTH_RETURN_URL}#token=session-token`)!;
  const options = await platformPasskeyRegisterOptions(token);
  expect(options.publicKey.rp.id).toBe('eos3.app');
  const attestation = { id: 'credential' } as Parameters<typeof platformPasskeyRegisterVerify>[0];
  await platformPasskeyRegisterVerify(attestation, token);
  for (const [index, path] of ['options', 'verify'].entries()) {
    expect(fetchWithRetry).toHaveBeenNthCalledWith(index + 1,
      `https://eos3.app/api/passkey-chain/register/${path}`, expect.objectContaining({
        method: 'POST', credentials: 'include',
        headers: expect.objectContaining({ authorization: 'Bearer session-token' }),
        ...(path === 'verify' ? { body: JSON.stringify({ response: attestation }) } : {}),
      }));
  }
});
