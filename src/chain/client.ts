import { APIClient, Asset, Name } from '@wharfkit/antelope';
import { CHAINS, ChainId, NodeInfo } from './config';
import { t } from '../i18n';
import { fetchWithTimeout } from '../net/fetchRetry';

// ---------- 对外的数据结构 ----------

export type ResourceUsage = {
  used: number;
  max: number;
  available: number;
  pct: number; // 已用百分比
  /** 系统账户等资源不受限 */
  unlimited: boolean;
  /** 未抵押/未租用,没有额度 */
  unallocated: boolean;
};

export type AccountResources = {
  account: string;
  created: string;
  cpu: ResourceUsage; // 单位 微秒
  net: ResourceUsage; // 单位 字节
  ram: ResourceUsage; // 单位 字节
  /** 自抵押(自己抵押给自己) */
  selfStakedCpu: string;
  selfStakedNet: string;
  /** 赎回中 */
  refunding: string;
  refundTime?: string;
  /** 系统代币余额 */
  coreBalance: string;
  /** 权限公钥 */
  permissions: { name: string; parent: string; keys: string[] }[];
};

export type TokenBalance = {
  symbol: string;
  contract: string;
  amount: number;
  precision: number;
  /** 原始字符串,如 "12.3456 EOS" */
  raw: string;
};

export type ChainAction = {
  id: string;
  seq: number;
  time: string;
  contract: string;
  action: string;
  from?: string;
  to?: string;
  quantity?: string;
  memo?: string;
  /** 相对当前账户是转入还是转出 */
  direction?: 'in' | 'out';
  /** 该交易被打包进的区块高度,Hyperion 的 get_actions 原生返回,交易详情页展示用 */
  blockNum?: number;
};

export type ActionsPage = {
  actions: ChainAction[];
  /** 是否可能还有更早的记录——不代表精确的"是否还有下一页",只是"值不值得再翻一页"的提示 */
  hasMore: boolean;
};

export type RamMarket = {
  /** 每 KB 多少系统代币 */
  pricePerKb: number;
};

export type PowerupResourceState = {
  weight: number;
  exponent: number;
  decaySecs: number;
  minPrice: number;
  maxPrice: number;
  utilization: number;
  adjustedUtilization: number;
  utilizationTimestamp: number;
};

export type PowerupMarket = {
  net: PowerupResourceState;
  cpu: PowerupResourceState;
  powerupDays: number;
  minPowerupFee: number;
  /** 1 单位 CPU 权重当前折合多少微秒可用 CPU(采样自 eosio.reserv,随全网负载浮动) */
  cpuUsPerWeight: number;
  /** 1 单位 NET 权重当前折合多少字节可用带宽(采样自 eosio.reserv) */
  netBytesPerWeight: number;
};

/**
 * 带重试的 JSON 请求。fetchWithTimeout 见 net/fetchRetry.ts——国内网络到境外
 * 节点有时不是快速失败,而是请求发出去后石沉大海,不加超时会一直转圈转到
 * 底层网络栈自己放弃为止。
 * 国内网络到境外节点常有偶发 TLS 握手失败,单次请求不足以判定端点不可用。
 */
async function fetchJson(url: string, tries = 3): Promise<any> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ---------- 客户端 ----------

export class ChainClient {
  readonly chainId: ChainId;
  readonly node: NodeInfo;
  /** 历史节点(Hyperion),和 node 各自独立选择——没配就是这条链目前没有可用的历史节点 */
  readonly historyNode: NodeInfo | undefined;
  private api: APIClient;

  constructor(chainId: ChainId, node: NodeInfo, historyNode?: NodeInfo) {
    this.chainId = chainId;
    this.node = node;
    this.historyNode = historyNode;
    this.api = new APIClient({ url: node.url });
  }

  get config() {
    return CHAINS[this.chainId];
  }

  /** 链信息:区块高度 + 延迟 */
  async getInfo(): Promise<{ headBlock: number; chainId: string; latencyMs: number; chainTime: string }> {
    const t0 = Date.now();
    const info = await this.api.v1.chain.get_info();
    return {
      headBlock: Number(info.head_block_num),
      chainId: String(info.chain_id),
      latencyMs: Date.now() - t0,
      chainTime: new Date(info.head_block_time.toMilliseconds()).toISOString(),
    };
  }

  /** 账户资源:CPU / NET / RAM / 抵押 / 赎回 */
  async getAccount(account: string): Promise<AccountResources> {
    const a: any = await this.api.v1.chain.get_account(Name.from(account));

    // 注意:cpu_limit.used 是会随时间衰减的历史累计值,
    // current_used 才是当前真实占用 —— 取不到时才退回 used。
    const mk = (limit: any): ResourceUsage => {
      const rawMax = Number(limit?.max ?? 0);
      const rawUsed = Number(limit?.current_used ?? limit?.used ?? 0);
      // max = -1 表示不受限(系统账户)
      const unlimited = rawMax < 0;
      const m = unlimited ? 0 : Math.max(rawMax, 0);
      const u = Math.max(rawUsed, 0);
      return {
        used: u,
        max: m,
        available: unlimited ? 0 : Math.max(m - u, 0),
        pct: unlimited ? 0 : m > 0 ? Math.min(100, (u / m) * 100) : 0,
        unlimited,
        unallocated: !unlimited && m === 0,
      };
    };

    const cpu = mk(a.cpu_limit);
    const net = mk(a.net_limit);
    const ram = mk({ max: a.ram_quota, current_used: a.ram_usage });

    const self = a.self_delegated_bandwidth;
    const refund = a.refund_request;

    return {
      account,
      created: String(a.created ?? ''),
      cpu,
      net,
      ram,
      selfStakedCpu: self ? String(self.cpu_weight) : `0.0000 ${this.config.symbol}`,
      selfStakedNet: self ? String(self.net_weight) : `0.0000 ${this.config.symbol}`,
      refunding: refund
        ? String(Asset.from(refund.cpu_amount).value + Asset.from(refund.net_amount).value) +
          ` ${this.config.symbol}`
        : `0.0000 ${this.config.symbol}`,
      refundTime: refund ? String(refund.request_time) : undefined,
      coreBalance: String(a.core_liquid_balance ?? `0.0000 ${this.config.symbol}`),
      permissions: (a.permissions ?? []).map((p: any) => ({
        name: String(p.perm_name),
        parent: String(p.parent),
        keys: (p.required_auth?.keys ?? []).map((k: any) => String(k.key)),
      })),
    };
  }

  /**
   * 某个自定义权限当前 linkauth 了哪些 action(撤销授权前要先逐条 unlinkauth,
   * 不然 deleteauth 会因为权限还被引用而失败)。get_account 直接给出
   * permissions[].linked_actions;action 为空表示绑的是整个合约。
   */
  async getLinkedActions(account: string, permission: string): Promise<{ contract: string; action: string }[]> {
    const a: any = await this.api.v1.chain.get_account(Name.from(account));
    const perm = (a.permissions ?? []).find((p: any) => String(p.perm_name) === permission);
    return (perm?.linked_actions ?? []).map((la: any) => ({
      contract: String(la.account),
      action: la.action == null ? '' : String(la.action),
    }));
  }

  /** 单个合约的代币余额 */
  async getBalance(contract: string, account: string, symbol?: string): Promise<TokenBalance[]> {
    const res = await this.api.v1.chain.get_currency_balance(
      Name.from(contract),
      Name.from(account),
      symbol
    );
    return res.map((a) => {
      const asset = Asset.from(a);
      return {
        symbol: String(asset.symbol.code),
        contract,
        amount: asset.value,
        precision: asset.symbol.precision,
        raw: String(asset),
      };
    });
  }

  /** 账户持有的全部代币 —— 走 Hyperion,标准节点没有此接口 */
  async getTokens(account: string): Promise<TokenBalance[]> {
    if (!this.historyNode) throw new Error(t('clientError.noHistoryNode'));
    const url = `${this.historyNode.url}/v2/state/get_tokens?account=${encodeURIComponent(account)}`;
    const j = await fetchJson(url);
    return (j.tokens ?? [])
      .filter((t: any) => Number(t.amount) > 0)
      .map((t: any) => ({
        symbol: t.symbol,
        contract: t.contract,
        amount: Number(t.amount),
        precision: Number(t.precision ?? 4),
        raw: `${t.amount} ${t.symbol}`,
      }));
  }

  /**
   * 交易记录 —— 走 Hyperion。skip 用来翻页(该接口原生支持基于偏移量的分页),
   * WalletContext 首次刷新只要第一页;TxRecordScreen/TokenDetailScreen 滑到底
   * 再各自带上累计长度当 skip 接着往下翻。
   */
  async getActions(account: string, opts?: { limit?: number; skip?: number }): Promise<ActionsPage> {
    if (!this.historyNode) throw new Error(t('clientError.noHistoryNode'));
    const limit = opts?.limit ?? 30;
    const skip = opts?.skip ?? 0;
    const url =
      `${this.historyNode.url}/v2/history/get_actions?account=${encodeURIComponent(account)}` +
      `&limit=${limit}&skip=${skip}&sort=desc&filter=*:transfer`;
    const j = await fetchJson(url);
    const actions: ChainAction[] = (j.actions ?? []).map((x: any) => {
      const act = x.act ?? {};
      const d = act.data ?? {};
      return {
        id: x.trx_id,
        seq: x.global_sequence,
        time: x['@timestamp'] ?? x.timestamp,
        contract: act.account,
        action: act.name,
        from: d.from,
        to: d.to,
        quantity: d.quantity ?? (d.amount ? `${d.amount} ${d.symbol ?? ''}`.trim() : undefined),
        memo: d.memo,
        direction: d.to === account ? 'in' : d.from === account ? 'out' : undefined,
        blockNum: typeof x.block_num === 'number' ? x.block_num : undefined,
      } as ChainAction;
    });
    // Hyperion 不总是给靠谱的 total —— 用"这页是不是被吃满"这种经验判断
    // 是否还有下一页,比依赖不稳定的 total.value 更可靠
    return { actions, hasMore: actions.length >= limit };
  }

  /**
   * 通用表查询直通 —— 给 DApp 浏览器里的 TokenPocket 兼容接口用
   * (tp.getEosTableRows / tp.getTableRows)。纯读操作,不涉及签名,
   * 参数原样交给节点,由调用方自己保证合法性。
   */
  async getTableRows(params: Record<string, any>): Promise<any> {
    return this.api.v1.chain.get_table_rows(params as any);
  }

  /** RAM 市场价 —— 从 eosio 的 rammarket 表用 Bancor 公式算 */
  async getRamPrice(): Promise<RamMarket> {
    const res: any = await this.api.v1.chain.get_table_rows({
      code: Name.from('eosio'),
      scope: Name.from('eosio'),
      table: Name.from('rammarket'),
      limit: 1,
      json: true,
    });
    const row = res.rows?.[0];
    if (!row) return { pricePerKb: 0 };
    const quote = Asset.from(row.quote.balance).value; // 系统代币
    const base = Asset.from(row.base.balance).value; // RAM 字节
    // 每字节价格 = quote/base,乘 1024 得每 KB
    return { pricePerKb: base > 0 ? (quote / base) * 1024 : 0 };
  }

  /**
   * PowerUp 市场状态——CPU/NET 各自的租用定价曲线参数,来自 powup.state 表。
   * 这张表固定长在真正的系统账户 eosio 上,不管这条链的资源 action 打给谁
   * (Vaulta 主网上 delegatebw/buyram/powerup 打的是 core.vaulta,但那只是
   * 转发代理——底层价格状态、rammarket 一样,始终是 eosio 名下这一份)。
   * 单例表,scope 固定是空 name(即空字符串)。
   */
  async getPowerupState(): Promise<PowerupMarket | null> {
    // 修复报价和后台预取不能被无超时的 RPC 永久挂住。
    const api = new APIClient({ url: this.node.url, fetch: fetchWithTimeout });
    // 除了定价曲线,还要采样 eosio.reserv(系统持有全部未租出 powerup 权重的
    // 保留账户)算出「1 单位权重折合多少 µs/字节」——powup.state 里的 weight、
    // utilization 全都是和抵押同单位的资源权重,不是微秒/字节,不拿这个比例
    // 换算的话,「一笔转账 300µs」和权重差着上万倍,估算完全没有意义。
    // 这也是 Greymass @greymass/eosio-resources 库的标准采样做法。
    const [res, reserv] = (await Promise.all([
      api.v1.chain.get_table_rows({
        code: Name.from('eosio'),
        scope: '',
        table: Name.from('powup.state'),
        limit: 1,
        json: true,
      }),
      api.v1.chain.get_account(Name.from('eosio.reserv')),
    ])) as [any, any];
    const row = res.rows?.[0];
    if (!row) return null;

    const cpuUsPerWeight = Number(reserv?.cpu_limit?.max ?? 0) / Number(reserv?.cpu_weight ?? 0);
    const netBytesPerWeight = Number(reserv?.net_limit?.max ?? 0) / Number(reserv?.net_weight ?? 0);
    if (
      !Number.isFinite(cpuUsPerWeight) || cpuUsPerWeight <= 0 ||
      !Number.isFinite(netBytesPerWeight) || netBytesPerWeight <= 0
    ) {
      return null;
    }

    const toSec = (iso: string) => Math.floor(new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime() / 1000);
    const mk = (r: any): PowerupResourceState => ({
      weight: Number(r.weight),
      exponent: Number(r.exponent),
      decaySecs: Number(r.decay_secs),
      minPrice: Number(Asset.from(r.min_price).units),
      maxPrice: Number(Asset.from(r.max_price).units),
      utilization: Number(r.utilization),
      adjustedUtilization: Number(r.adjusted_utilization),
      utilizationTimestamp: toSec(String(r.utilization_timestamp)),
    });

    return {
      net: mk(row.net),
      cpu: mk(row.cpu),
      powerupDays: Number(row.powerup_days),
      minPowerupFee: Number(Asset.from(row.min_powerup_fee).units),
      cpuUsPerWeight,
      netBytesPerWeight,
    };
  }
}

/** 测量单个 RPC 节点延迟与区块高度,供节点切换页使用 */
export async function probeNode(node: NodeInfo): Promise<{ ms: number; block: number } | null> {
  try {
    const t0 = Date.now();
    // 探测本来就是给用户看"这个节点值不值得选"用的,更不能自己在这儿先挂半天——
    // 单独给个短一点的超时,拖太久直接判不可用,比陪它一起转圈更有用。
    const r = await fetchWithTimeout(`${node.url}/v1/chain/get_info`, { method: 'POST' }, 5000);
    if (!r.ok) return null;
    const j = await r.json();
    return { ms: Date.now() - t0, block: Number(j.head_block_num) };
  } catch {
    return null;
  }
}

/**
 * 测量历史节点(Hyperion)延迟与索引进度,走 /v2/health——历史节点不一定是
 * 标准链节点,不能复用 probeNode 打 /v1/chain/get_info。
 * block 这里指"索引到的区块高度"(last_indexed_block),不是链头高度,
 * 两者含义不同,调用方展示时要用不同的文案区分。
 */
export async function probeHistoryNode(node: NodeInfo): Promise<{ ms: number; block: number } | null> {
  try {
    const t0 = Date.now();
    const r = await fetchWithTimeout(`${node.url}/v2/health`, undefined, 5000);
    if (!r.ok) return null;
    const j = await r.json();
    const block = Number(j.last_indexed_block);
    return { ms: Date.now() - t0, block: Number.isFinite(block) ? block : 0 };
  } catch {
    return null;
  }
}
