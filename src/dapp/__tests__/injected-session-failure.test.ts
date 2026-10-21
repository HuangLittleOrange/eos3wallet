import { buildInjectedScript } from '../injected';
const { TextDecoder: Decoder } = require('util');

function harness() {
  const sent: any[] = [];
  class Xhr {
    responseURL = 'https://app.example/api/me';
    status = 401;
    responseType = '';
    responseText = '{"code":"SESSION_EXPIRED"}';
    response: unknown;
    headers: Record<string, string> = { 'content-type': 'application/json' };
    handlers = new Map<string, Function>();
    open(_method: string, _url: string) {}
    send(_data?: unknown) {}
    addEventListener(event: string, listener: Function) { this.handlers.set(event, listener); }
    removeEventListener(event: string) { this.handlers.delete(event); }
    getResponseHeader(key: string) { return this.headers[key] ?? null; }
    finish() { const fn = this.handlers.get('loadend'); this.handlers.delete('loadend'); fn?.(); }
  }
  const fetch = jest.fn();
  const win: any = { location: { href: 'https://app.example/', origin: 'https://app.example', assign() {}, replace() {} },
    addEventListener() {}, dispatchEvent() {}, fetch, XMLHttpRequest: Xhr,
    ReactNativeWebView: { postMessage: (raw: string) => sent.push(JSON.parse(raw)) } };
  const script = buildInjectedScript({ account: 'alice', publicKey: 'PUB_K1_test', chainId: 'chain', chainName: 'Vaulta',
    canSign: true, locale: 'en', nodeUrl: 'https://rpc.example', platform: 'ios', appVersion: '1', systemVersion: '26', darkMode: false });
  new Function('window', 'document', 'navigator', 'Event', 'CustomEvent', 'URL', 'TextDecoder', script)(
    win, { addEventListener() {}, dispatchEvent() {} }, {}, function () {}, function () {}, URL, Decoder);
  return { win, fetch, sent, Xhr };
}
function response(status = 401, body = '{"code":"SESSION_EXPIRED"}', url = 'https://app.example/api/me', header?: string) {
  const chunks = [new TextEncoder().encode(body)];
  const reader = { read: jest.fn(async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
    cancel: jest.fn(async () => {}) };
  return { status, url, reader, body: { getReader: () => reader }, text: jest.fn(async () => body), headers: { get: (key: string) => ({
    'content-type': 'application/json', 'www-authenticate': header,
  } as Record<string, string | undefined>)[key] ?? null }, clone: jest.fn(() => ({ body: { getReader: () => reader } })) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('observes explicit same-origin fetch failures and preserves the response and original request', async () => {
  const { win, fetch, sent } = harness();
  const original = response(); fetch.mockResolvedValue(original);
  const options = { method: 'POST', body: 'original-payload', credentials: 'include' };
  expect(await win.fetch('/api/me?private=value', options)).toBe(original);
  await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/me?private=value', options);
  expect(await original.text()).toBe('{"code":"SESSION_EXPIRED"}');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ method: 'dappSessionFailure', params: { status: 401, code: 'SESSION_EXPIRED' } });
  expect(JSON.stringify(sent)).not.toContain('private=value');
  expect(JSON.stringify(sent)).not.toContain('original-payload');
});
it('preserves network rejection without any reconnect signal or retry', async () => {
  const { win, fetch, sent } = harness();
  const error = new TypeError('Network request failed'); fetch.mockRejectedValue(error);
  await expect(win.fetch('/api/me')).rejects.toBe(error);
  expect(sent).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 429, 500])('ignores HTTP %s without an explicit login failure', async status => {
  const { win, fetch, sent } = harness(); fetch.mockResolvedValue(response(status, '{"message":"session expired"}'));
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(0);
});
it.each(['https://rpc.example/v1/chain/get_info', 'https://analytics.example/me'])('ignores another origin: %s', async url => {
  const { win, fetch, sent } = harness(); fetch.mockResolvedValue(response(401, '{"code":"SESSION_EXPIRED"}', url));
  await win.fetch(url); await flush(); expect(sent).toHaveLength(0);
});
it('ignores cross-origin redirects even when the initial URL belongs to the DApp', async () => {
  const { win, fetch, sent } = harness(); fetch.mockResolvedValue(response(401, '{"code":"SESSION_EXPIRED"}', 'https://gateway.example/'));
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(0);
});
it('does not let a response from before a fresh login invalidate the new session', async () => {
  const { win, fetch, sent } = harness(); let complete!: (value: unknown) => void;
  fetch.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const request = win.fetch('/api/me');
  win.__auroraSetAccount('alice', 'PUB_K1_test');
  complete(response()); await request; await flush(); expect(sent).toHaveLength(0);
});
it('coalesces repeated failures within the document', async () => {
  const { win, fetch, sent } = harness(); fetch.mockImplementation(async () => response());
  await win.fetch('/api/me'); await win.fetch('/api/other'); await flush(); expect(sent).toHaveLength(1);
});
it('stops inspecting oversized failure bodies without consuming the original response', async () => {
  const { win, fetch, sent } = harness(); const original = response(401, 'x'.repeat(9000)); fetch.mockResolvedValue(original);
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(0); expect(original.reader.cancel).toHaveBeenCalledTimes(1);
  expect(original.text).not.toHaveBeenCalled();
});
it('lets a DApp refresh an invalid access token and retry successfully without a session notice', async () => {
  const { win, fetch, sent } = harness();
  fetch.mockResolvedValueOnce(response(401, '{"error":"invalid_token"}', undefined, 'Bearer error="invalid_token"'))
    .mockResolvedValueOnce(response(200, '{"access_token":"refreshed"}'))
    .mockResolvedValueOnce(response(200, '{"ok":true}'));
  expect((await win.fetch('/api/me')).status).toBe(401);
  expect((await win.fetch('/api/refresh', { method: 'POST' })).status).toBe(200);
  expect((await win.fetch('/api/me')).status).toBe(200);
  await flush();
  expect(sent).toHaveLength(0);
  expect(fetch.mock.calls.map(args => args[0])).toEqual(['/api/me', '/api/refresh', '/api/me']);
});
it('reports a terminal session rejection from a failed refresh, rather than the original token rejection', async () => {
  const { win, fetch, sent } = harness();
  fetch.mockResolvedValueOnce(response(401, '{"code":"TOKEN_EXPIRED"}'))
    .mockResolvedValueOnce(response(401, '{"code":"SESSION_EXPIRED"}'));
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(0);
  await win.fetch('/api/refresh', { method: 'POST' }); await flush();
  expect(sent).toHaveLength(1); expect(sent[0].params.code).toBe('SESSION_EXPIRED');
});
it('observes XHR login rejection while leaving the page response intact', () => {
  const { Xhr, sent } = harness(); const xhr = new Xhr(); xhr.open('GET', '/api/me'); xhr.send(); xhr.finish();
  expect(sent[0].params).toEqual({ status: 401, code: 'SESSION_EXPIRED' });
  expect(xhr.responseText).toBe('{"code":"SESSION_EXPIRED"}');
});
it('ignores XHR network and permission errors and handles instance reuse', () => {
  const { Xhr, sent } = harness(); const xhr = new Xhr();
  xhr.open('GET', '/api/me'); xhr.send(); xhr.status = 0; xhr.finish();
  xhr.open('GET', '/api/me'); xhr.send(); xhr.status = 403; xhr.responseText = '{"code":"insufficient_scope"}'; xhr.finish();
  expect(sent).toHaveLength(0);
  xhr.open('GET', '/api/me'); xhr.send(); xhr.responseText = '{"error":{"code":"SESSION_EXPIRED"}}'; xhr.finish();
  expect(sent).toHaveLength(1);
});

it('a fresh connection can report a later login failure without reviving an old response', async () => {
  const { win, fetch, sent } = harness(); fetch.mockImplementation(async () => response());
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(1);
  win.__auroraSetAccount('alice', 'PUB_K1_test');
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(2);
});
it('a deferred notification can be reported again after native declines it during signing', async () => {
  const { win, fetch, sent } = harness(); fetch.mockImplementation(async () => response());
  await win.fetch('/api/me'); await flush();
  win.__auroraResolve(sent[0].id, true, false); await flush();
  await win.fetch('/api/me'); await flush(); expect(sent).toHaveLength(2);
});

it('renewing the same account also excludes responses from its previous login', async () => {
  const { win, fetch, sent } = harness();
  win.__auroraSetAccount('alice', 'PUB_K1_test');
  let complete!: (value: unknown) => void;
  fetch.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const request = win.fetch('/api/me');
  win.__auroraSetAccount('alice', 'PUB_K1_test');
  complete(response()); await request; await flush();
  expect(sent).toHaveLength(0);
});


it('XHR can refresh its access token and retry without a session notice', () => {
  const { Xhr, sent } = harness(); const xhr = new Xhr();
  xhr.headers['www-authenticate'] = 'Bearer error="invalid_token"';
  xhr.open('GET', '/api/me'); xhr.send(); xhr.responseText = '{"error":"invalid_token"}'; xhr.finish();
  xhr.open('POST', '/api/refresh'); xhr.send(); xhr.status = 200; xhr.responseText = '{"ok":true}'; xhr.finish();
  xhr.open('GET', '/api/me'); xhr.send(); xhr.finish();
  expect(sent).toHaveLength(0);
});

it.each([true, false])('a silent unchanged permission check preserves an in-flight session failure (connected=%s)', async connected => {
  const { win, fetch, sent } = harness();
  if (connected) win.__auroraSetAccount('alice', 'PUB_K1_test');
  let endRead!: (value: any) => void;
  const original = response();
  original.reader.read.mockImplementationOnce(async () => ({ done: false, value: new TextEncoder().encode('{"code":"SESSION_EXPIRED"}') }))
    .mockImplementationOnce(() => new Promise(resolve => { endRead = resolve; }));
  fetch.mockResolvedValue(original);
  await win.fetch('/api/me'); await flush();
  const check = win.scatter.checkLogin();
  const request = sent.find(m => m.method === 'getIdentityFromPermissions');
  win.__auroraResolve(request.id, true, connected ? { account: 'alice', publicKey: 'PUB_K1_test' } : null);
  await check;
  endRead({ done: true }); await flush();
  expect(sent.filter(m => m.method === 'dappSessionFailure')).toHaveLength(1);
  expect(original.reader.cancel).not.toHaveBeenCalled();
});

it('an explicit same-account login still excludes failures from before that login', async () => {
  const { win, fetch, sent } = harness();
  win.__auroraSetAccount('alice', 'PUB_K1_test');
  let endRead!: (value: any) => void;
  const original = response();
  original.reader.read.mockImplementationOnce(async () => ({ done: false, value: new TextEncoder().encode('{"code":"SESSION_EXPIRED"}') }))
    .mockImplementationOnce(() => new Promise(resolve => { endRead = resolve; }));
  fetch.mockResolvedValue(original);
  await win.fetch('/api/me'); await flush();
  const login = win.scatter.login();
  const request = sent.find(m => m.method === 'getIdentity');
  win.__auroraResolve(request.id, true, { account: 'alice', publicKey: 'PUB_K1_test' }); await login;
  endRead({ done: true }); await flush();
  expect(sent.filter(m => m.method === 'dappSessionFailure')).toHaveLength(0);
});

it('a late silent check cannot replace a newer login identity', async () => {
  const { win, sent } = harness(); win.__auroraSetAccount('alice', 'PUB_K1_old');
  const check = win.scatter.checkLogin();
  const request = sent.find(m => m.method === 'getIdentityFromPermissions');
  win.__auroraSetAccount('bob', 'PUB_K1_new');
  win.__auroraResolve(request.id, true, null); await check;
  expect(win.scatter.identity.accounts[0].name).toBe('bob');
  expect(await win.scatter.getPublicKey()).toBe('PUB_K1_new');
});
