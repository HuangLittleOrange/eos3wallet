import { ESR_LINK_PATTERN } from './esr-links';

/** Runs inside the provider's closure and uses its authenticated call() bridge.
 * Native navigation remains the fallback for location.href and closed shadow roots.
 */
export function buildInjectedEsrScript(): string {
  return `
  function isSignReq(u) {
    if (typeof u !== 'string') return false;
    var s = u.trim();
    return ${ESR_LINK_PATTERN.toString()}.test(s);
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href') || '';
    if (isSignReq(href)) {
      ev.preventDefault();
      ev.stopPropagation();
      call('esrRequest', { uri: href }).catch(function () {});
    }
  }, true);

  ['assign', 'replace'].forEach(function (m) {
    var orig = window.location[m];
    try {
      window.location[m] = function (u) {
        if (isSignReq(u)) { call('esrRequest', { uri: u }).catch(function () {}); return; }
        return orig.apply(window.location, arguments);
      };
    } catch (e) {}
  });
`;
}
