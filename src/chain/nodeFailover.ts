import { CHAINS, type ChainId, type NodeInfo } from './config';
import { fetchWithTimeout } from '../net/fetchRetry';

export type ReadNodeKind = 'rpc' | 'history';
export type NodeFailoverOptions = {
  candidates?: (kind: ReadNodeKind) => Promise<NodeInfo[]>;
  onSwitch?: (kind: ReadNodeKind, node: NodeInfo) => void;
};
type Reply = { status: number; text: string; json: any; headers: Record<string, string> };
const REQUEST_TIMEOUT = 4000;
const COOLDOWN = 60000;
const MAX_ATTEMPTS = 3;
const base = (url: string) => url.replace(/\/+$/, '');

/** Only read requests enter this pool. Signed broadcasts must never be retried here. */
export class ReadNodePool {
  private current: NodeInfo;
  private failed = new Map<string, number>();
  private selecting?: Promise<NodeInfo>;
  private announced: string;
  constructor(private chainId: ChainId, private kind: ReadNodeKind, node: NodeInfo,
    private options: NodeFailoverOptions = {}) {
    this.current = node;
    this.announced = base(node.url);
  }

  private async fetch(node: NodeInfo, path: string, init?: RequestInit): Promise<Reply> {
    // Include body consumption in the deadline: receiving headers alone is not success.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchWithTimeout(base(node.url) + path, init, REQUEST_TIMEOUT);
          const text = await response.text();
          let json: any;
          try { json = JSON.parse(text); } catch { /* Invalid payload triggers failover. */ }
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => { headers[key] = value; });
          return { status: response.status, text, json, headers };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Node request timed out')), REQUEST_TIMEOUT);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private async verify(node: NodeInfo): Promise<NodeInfo> {
    const reply = await this.fetch(node, this.kind === 'rpc' ? '/v1/chain/get_info' : '/v2/health',
      this.kind === 'rpc' ? { method: 'POST' } : undefined);
    const chain = this.kind === 'rpc' ? reply.json?.chain_id
      : reply.json?.health?.find((item: any) => item.service === 'NodeosRPC')?.service_data?.chain_id;
    if (reply.status !== 200 || chain !== CHAINS[this.chainId].chainIdHash)
      throw new Error('Node chain verification failed');
    return node;
  }

  private async select(excluded: Set<string>): Promise<NodeInfo> {
    if (this.selecting) {
      try {
        const selected = await this.selecting;
        if (!excluded.has(base(selected.url))) return selected;
      } catch { /* This request may have additional candidates available. */ }
    }
    const select = async () => {
      const nodes = this.options.candidates ? await this.options.candidates(this.kind)
        : this.kind === 'rpc' ? CHAINS[this.chainId].nodes : CHAINS[this.chainId].historyNodes;
      const unique = [...new Map(nodes.map(node => [base(node.url), node])).values()];
      const candidates = unique.filter(node => !excluded.has(base(node.url))
        && Date.now() - (this.failed.get(base(node.url)) ?? -Infinity) >= COOLDOWN);
      if (!candidates.length) throw new Error('No available node');
      // Race verified nodes; a dead candidate does not delay a healthy one.
      const winner = await Promise.any(candidates.map(async node => {
        try { return await this.verify(node); }
        catch (error) { this.failed.set(base(node.url), Date.now()); throw error; }
      }));
      this.current = winner;
      return winner;
    };
    const pending = select();
    this.selecting = pending;
    try { return await pending; }
    finally { if (this.selecting === pending) this.selecting = undefined; }
  }

  async read(path: string, init?: RequestInit, valid: (json: any) => boolean = json => json != null): Promise<Reply> {
    if (this.kind === 'rpc' && !/^\/v1\/chain\/get_[a-z_]+$/.test(path))
      throw new Error('Only chain reads support automatic failover');
    const tried = new Set<string>();
    let node = this.current;
    let last: unknown = new Error('No available node');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (init?.signal?.aborted) throw new Error('Request cancelled');
      tried.add(base(node.url));
      try {
        const reply = await this.fetch(node, path, init);
        if (init?.signal?.aborted) throw new Error('Request cancelled');
        // A structured nodeos exception is a definitive business result, e.g. unknown account.
        // Rate limits and server/proxy failures still warrant another endpoint.
        if (this.kind === 'rpc' && reply.status >= 400 && reply.json?.error?.name
          && ![408, 429, 502, 503, 504].includes(reply.status)) return reply;
        if (reply.status < 200 || reply.status >= 300 || !valid(reply.json))
          throw new Error(`Node response unavailable (HTTP ${reply.status})`);
        if (base(this.current.url) === base(node.url) && this.announced !== base(node.url)) {
          this.announced = base(node.url);
          this.options.onSwitch?.(this.kind, node);
        }
        return reply;
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        last = error;
        this.failed.set(base(node.url), Date.now());
      }
      if (attempt === MAX_ATTEMPTS - 1) break;
      try {
        node = !tried.has(base(this.current.url)) ? this.current : await this.select(tried);
      } catch { break; }
    }
    throw last;
  }
}
