jest.mock('../useEsrFlow', () => ({ useEsrFlow: jest.fn() }));

import React from 'react';
import { Linking } from 'react-native';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/lib/WebViewShared';
import { useEsrFlow } from '../useEsrFlow';
import { useBrowserEsr } from '../use-browser-esr';

const { create, act } = require('react-test-renderer');
const open = jest.fn(async () => {});
const invalidate = jest.fn();
const navigate = jest.fn();
let browser: ReturnType<typeof useBrowserEsr>;
let renderer: any;
function Harness() { browser = useBrowserEsr(navigate); return null; }

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  jest.mocked(useEsrFlow).mockReturnValue({ open, invalidate } as any);
  await act(async () => { renderer = create(React.createElement(Harness)); });
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); jest.restoreAllMocks(); });

test.each(['esr:payload', 'esr://payload', 'anchor://link?payload', 'eosio://link?payload'])(
  'WebView delivers %s to the shared flow instead of the OS', (url) => {
    const external = jest.spyOn(Linking, 'canOpenURL');
    const load = jest.fn();
    const handler = createOnShouldStartLoadWithRequest(load, browser.originWhitelist,
      (request) => !browser.interceptUrl(request.url));
    handler({ nativeEvent: { url, lockIdentifier: 1 } } as any);
    expect(open).toHaveBeenCalledWith(url);
    expect(load).toHaveBeenCalledWith(false, url, 1);
    expect(external).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  }
);

test.each(['https://alcor.exchange/', 'http://192.168.1.2/', 'eosio:alice?amount=1.0000'])
  ('ordinary page/payment navigation is not consumed: %s', (url) => {
    expect(browser.interceptUrl(url)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

test('new-window ESR requests enter the same flow; web links navigate in the browser', () => {
  browser.onOpenWindow({ nativeEvent: { targetUrl: 'anchor://link?payload' } } as any);
  expect(open).toHaveBeenCalledWith('anchor://link?payload');
  expect(navigate).not.toHaveBeenCalled();
  browser.onOpenWindow({ nativeEvent: { targetUrl: 'https://alcor.exchange/market' } } as any);
  expect(navigate).toHaveBeenCalledWith('https://alcor.exchange/market');
  expect(open).toHaveBeenCalledTimes(1);
});

test.each(['javascript:alert(1)', 'file:///secret', 'https://user:password@alcor.exchange/'])
  ('new windows cannot load unsupported or credentialed URLs: %s', (targetUrl) => {
    browser.onOpenWindow({ nativeEvent: { targetUrl } } as any);
    expect(open).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

test('an accepted ESR bridge request is acknowledged and routed to the shared flow', () => {
  const acknowledge = jest.fn();
  expect(browser.handleBridgeRequest({ method: 'esrRequest', params: { uri: 'esr:payload' } }, acknowledge)).toBe(true);
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith('esr:payload');
  expect(browser.handleBridgeRequest({ method: 'getIdentity' }, acknowledge)).toBe(false);
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
});

test('document invalidation and foreground callbacks stay owned by the same flow', () => {
  browser.invalidate();
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(useEsrFlow).toHaveBeenCalledWith({ onRedirect: navigate });
});
