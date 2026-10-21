import { DAPP_SESSION_FAILURE_CODES } from './sessionFailure';

/** Observe explicit same-origin login failures without consuming/changing the
 * page's responses, credentials, storage, or request/retry behavior. Never send
 * response bodies, request headers, query strings or tokens over the bridge.
 */
export function buildInjectedSessionFailureScript(): string {
  return String.raw`
  var sessionGeneration = 0;
  var sessionFailureReported = false;
  function sessionIdentityChanged() { sessionGeneration++; sessionFailureReported = false; }
  (function () {
    var codes = ${JSON.stringify(DAPP_SESSION_FAILURE_CODES)};
    function classify(status, body) {
      if (status !== 401 && status !== 403) return null;
      if (!body || typeof body !== 'object') return null;
      var error = body.error;
      var code = body.code !== undefined && body.code !== null ? body.code :
        typeof error === 'string' ? error : error && typeof error === 'object' ? error.code : null;
      if (typeof code !== 'string') return null;
      code = code.toUpperCase();
      return codes.indexOf(code) >= 0 ? code : null;
    }
    var MAX_BODY = 8192;
    function sameOrigin(url) {
      try {
        var parsed = new URL(url, window.location.href);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.origin === window.location.origin;
      } catch (e) { return false; }
    }
    function report(generation, url, status, body) {
      if (sessionFailureReported || generation !== sessionGeneration || !sameOrigin(url)) return;
      var code = classify(status, body);
      if (!code) return;
      sessionFailureReported = true;
      // Only a minimal, already classified signal enters native code.
      call('dappSessionFailure', { status: status, code: code }).then(function (accepted) {
        if (!accepted && generation === sessionGeneration) sessionFailureReported = false;
      }).catch(function () {});
    }
    function observeResponse(generation, requestUrl, response) {
      if (sessionFailureReported || generation !== sessionGeneration) return;
      if (!sameOrigin(requestUrl) || !sameOrigin(response.url) || (response.status !== 401 && response.status !== 403)) return;
      if (!/application\/(?:[a-z0-9.+-]+\+)?json/i.test(response.headers.get('content-type') || '') ||
          Number(response.headers.get('content-length')) > MAX_BODY) return;
      if (!response.body || typeof response.body.getReader !== 'function' || typeof TextDecoder !== 'function') return;
      var copy = response.clone();
      // Bound observation even when an error response has no Content-Length.
      var reader = copy.body.getReader();
      var decoder = new TextDecoder();
      var length = 0;
      var text = '';
      function read() {
        return reader.read().then(function (part) {
          if (generation !== sessionGeneration) { void reader.cancel().catch(function () {}); return; }
          if (part.done) {
            text += decoder.decode();
            try { report(generation, response.url, response.status, JSON.parse(text)); } catch (e) {}
            return;
          }
          length += part.value.byteLength;
          if (length > MAX_BODY) { void reader.cancel().catch(function () {}); return; }
          text += decoder.decode(part.value, { stream: true });
          return read();
        });
      }
      read().catch(function () {});
    }
    if (typeof window.fetch === 'function') {
      var originalFetch = window.fetch;
      window.fetch = function (input, init) {
        var generation = sessionGeneration;
        var requestUrl = typeof input === 'string' ? input : input && input.url || String(input);
        return originalFetch.apply(this, arguments).then(function (response) {
          try { observeResponse(generation, requestUrl, response); } catch (e) {}
          return response;
        });
      };
    }
    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      var urls = new WeakMap();
      var prototype = window.XMLHttpRequest.prototype;
      var originalOpen = prototype.open;
      var originalSend = prototype.send;
      prototype.open = function (method, url) {
        urls.set(this, String(url));
        return originalOpen.apply(this, arguments);
      };
      prototype.send = function () {
        var xhr = this;
        var requestUrl = urls.get(xhr);
        var generation = sessionGeneration;
        function onEnd() {
          try {
            if (!sameOrigin(requestUrl) || !sameOrigin(xhr.responseURL) || (xhr.status !== 401 && xhr.status !== 403)) return;
            if (!/application\/(?:[a-z0-9.+-]+\+)?json/i.test(xhr.getResponseHeader('content-type') || '')) return;
            var body = null;
            if (xhr.responseType === 'json') body = xhr.response;
            else if ((!xhr.responseType || xhr.responseType === 'text') && xhr.responseText.length <= MAX_BODY) body = JSON.parse(xhr.responseText);
            report(generation, xhr.responseURL, xhr.status, body);
          } catch (e) {}
        }
        xhr.addEventListener('loadend', onEnd, { once: true });
        try { return originalSend.apply(xhr, arguments); }
        catch (error) { xhr.removeEventListener('loadend', onEnd); throw error; }
      };
    }
  })();
`;
}
