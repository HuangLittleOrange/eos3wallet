/** Shared by native navigation, QR scanning and the injected page script.
 * Only eosio://link is ESR; eosio:account payment links keep their own route.
 */
export const ESR_LINK_PATTERN = /^(?:esr:|anchor:|eosio:\/\/link)/i;

// WebView applies this list before our navigation callback. Including ESR
// schemes also covers links hidden inside a closed shadow root.
export const ESR_BROWSER_ORIGIN_WHITELIST = ['http://*', 'https://*', 'esr:*', 'anchor:*', 'eosio://link*'];

export function isEsrLink(url: unknown): boolean {
  return typeof url === 'string' && ESR_LINK_PATTERN.test(url.trim());
}

/** Normalize Anchor's legacy transport to an ESR URI without decoding payloads. */
export function normalizeEsr(url: string): string | null {
  const value = url.trim();
  if (/^esr:/i.test(value)) return value;
  const match = value.match(/^(?:anchor|eosio):\/\/link[/?]?(.*)$/i);
  if (!match?.[1]) return null;
  return `esr://${match[1].replace(/^\?/, '')}`;
}
