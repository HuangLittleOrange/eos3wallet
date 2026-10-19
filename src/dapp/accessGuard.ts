/** Page origins for explicit ESR links; connecting wallet APIs still requires HTTPS. */
export function dappPageOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch { return null; }
}

/** Browser-session permissions. Never persisted or shared across wallet contexts. */
export function secureDappOrigin(url: string): string | null {
  const origin = dappPageOrigin(url);
  return origin?.startsWith('https://') ? origin : null;
}

export class DappAccessGuard {
  private context = '';
  private origin: string | null = null;
  private pageOrigin: string | null = null;
  private document = '';
  private epoch = 0;
  private requests = new Map<string, { epoch: number }>();
  private grants = new Set<string>();

  navigate(url: string, context: string): void {
    this.origin = secureDappOrigin(url);
    this.pageOrigin = dappPageOrigin(url);
    this.context = context;
    this.document = '';
    this.epoch++;
    this.requests.clear();
  }

  accept(id: unknown, document: unknown, sourceUrl: string, context: string, method?: string): boolean {
    // ESR links open the same explicit confirmation flow as scanned requests.
    // Accepting a link from HTTP never grants access to account/provider APIs.
    const expectedOrigin = method === 'esrRequest' ? this.pageOrigin : this.origin;
    if (context !== this.context || !expectedOrigin || dappPageOrigin(sourceUrl) !== expectedOrigin) return false;
    if (typeof id !== 'string' || typeof document !== 'string' || !document || document.length > 128 ||
        !id.startsWith(document + ':') || id.length > 180 || this.requests.has(id) || this.requests.size >= 512) return false;
    if (this.document && this.document !== document) return false;
    this.document = document;
    this.requests.set(id, { epoch: this.epoch });
    return true;
  }

  current(id: string, context: string): boolean {
    return context === this.context && this.requests.get(id)?.epoch === this.epoch;
  }

  /** A page may reuse an id after cancellation/completion. Its new request must
   * never inherit an outstanding native authentication from the previous one.
   */
  capture(id: string, context: string): () => boolean {
    const request = this.requests.get(id);
    return () => !!request && this.current(id, context) && this.requests.get(id) === request;
  }

  cancelPending(): void { this.epoch++; this.requests.clear(); }

  finish(id: string, context: string): boolean {
    if (!this.current(id, context)) return false;
    this.requests.delete(id);
    return true;
  }

  private grantKey(): string { return JSON.stringify([this.origin, this.context]); }
  connected(): boolean { return !!this.origin && this.grants.has(this.grantKey()); }
  connect(id: string, context: string): boolean {
    if (!this.current(id, context) || !this.origin) return false;
    this.grants.add(this.grantKey());
    return true;
  }
  disconnect(): void {
    this.grants.delete(this.grantKey());
    // A new connection may grant new requests, never revive an old approval.
    this.cancelPending();
  }
}
