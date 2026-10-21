import { dappSessionFailureCode, readDappSessionFailure } from '../sessionFailure';

it.each([
  [401, { code: 'SESSION_EXPIRED' }, 'SESSION_EXPIRED'],
  [403, { error: { code: 'INVALID_SESSION' } }, 'INVALID_SESSION'],
  [401, { error: 'session_invalid' }, 'SESSION_INVALID'],
])('recognizes explicit login failure %s %j', (status, body, expected) => {
  expect(dappSessionFailureCode(status, body)).toBe(expected);
});
it.each([
  [0, { code: 'SESSION_EXPIRED' }], [200, { code: 'SESSION_EXPIRED' }],
  [429, { code: 'SESSION_EXPIRED' }], [500, { code: 'SESSION_EXPIRED' }],
  [401, undefined], [403, {}], [401, { message: 'session expired' }],
  [403, { code: 'insufficient_scope' }], [401, { code: 'unauthorized' }],
  [403, { error: { code: 3090003, name: 'unsatisfied_authorization' } }],
  [401, { error: 'invalid_token' }], [401, { code: 'INVALID_TOKEN' }],
  [401, { code: 'TOKEN_EXPIRED' }], [403, { error: { code: 'invalid_token' } }],
  [401, { code: 'expired_tx_exception' }], [401, { code: 'ETIMEDOUT' }],
])('does not turn an ordinary failure into a login failure: %s %j', (status, body) => {
  expect(dappSessionFailureCode(status, body)).toBeNull();
});
it('does not interpret a Bearer token rejection as an unrecoverable login session', async () => {
  await expect(readDappSessionFailure({ status: 401,
    headers: { get: () => 'Bearer error="invalid_token"' }, body: null,
  } as any)).resolves.toBeNull();
});

it('bounds a callback error body even when Content-Length is missing', async () => {
  const cancel = jest.fn(async () => {});
  const read = jest.fn(async () => ({ done: false, value: new Uint8Array(9000) }));
  await expect(readDappSessionFailure({ status: 401, headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
    body: { getReader: () => ({ read, cancel }) } } as any)).resolves.toBeNull();
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('does not classify a timeout while reading the error body as an invalid session', async () => {
  jest.useFakeTimers();
  let finish!: (value: unknown) => void;
  const read = () => new Promise(resolve => { finish = resolve; });
  const cancel = jest.fn(async () => { finish({ done: true }); });
  try {
    const result = readDappSessionFailure({ status: 401, headers: { get: (key: string) => key === 'content-type' ? 'application/json' : null },
      body: { getReader: () => ({ read, cancel }) } } as any);
    jest.advanceTimersByTime(2000);
    await expect(result).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
