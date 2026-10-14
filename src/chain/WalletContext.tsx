import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { CHAINS, ChainId, DEFAULT_CHAIN, NodeInfo } from './config';
import { useNodeCatalog } from './NodeCatalogContext';
import { BUILTIN_NODE_CATALOG, NodeCatalog } from './nodeCatalog';
import { AccountResources, ChainAction, ChainClient, probeNode, TokenBalance } from './client';
import { listCustomNodes, NodeKind } from './customNodes';
import { listWallets, signingPermission, StoredWallet, WalletReadError } from '../crypto/vault';
import { DEFAULT_PRICE_SOURCE, fetchPrices, PriceSnapshot, PriceSourceId } from './prices';
import { ChainAccount, loadSession, saveSession } from './session';
import { pickChainAccount } from './chainAccount';
import { loadTokenSnapshot, saveTokenSnapshot } from './walletCache';
import { t } from '../i18n';
import { refreshResourceRepairFee } from './resourceRepairQuote';

type Status = 'idle' | 'loading' | 'ready' | 'error';

/** 节点连不上时最多自动切换几轮——切过这么多轮还是不行,大概率是本机网络本身有问题,不用再试 */
const MAX_FAILOVER_ROUNDS = 2;

/** 按 id 找一个节点,默认节点列表里没有就去自定义节点里找——恢复上次会话/自动切换都要用 */
async function resolveNode(chainId: ChainId, kind: NodeKind, id: string | undefined, catalog: NodeCatalog = BUILTIN_NODE_CATALOG): Promise<NodeInfo | null> {
  if (!id) return null;
  const defaults = catalog[chainId][kind];
  const found = defaults.find((n) => n.id === id);
  if (found) return found;
  const customs = await listCustomNodes(chainId, kind).catch(() => []);
  return customs.find((n) => n.id === id) ?? null;
}

/**
 * 会话/配置状态:选中的链、账户、节点和全部操作函数。
 * 只在用户主动切换(链/账户/节点/行情源)或钱包列表变化时才更新——和下面
 * 每次刷新都要跳动好几次的实时数据分开两个 context,只关心"当前在哪、
 * 用哪个账户"的页面(导入流程、节点页、设置页……)用 useWalletSession()
 * 订阅这半边,就不会被每次数据刷新拖着重渲染。
 */
type WalletSessionState = {
  chainId: ChainId;
  rpcNodes: NodeInfo[];
  defaultHistoryNodes: NodeInfo[];
  node: NodeInfo;
  /** 历史节点(Hyperion)——和 node 各自独立选择,切 RPC 节点不会带着它一起变 */
  historyNode: NodeInfo;
  account: string;
  /** 只读模式:当前账户没有本机保存的私钥 */
  readOnly: boolean;
  /**
   * 当前账户对应的本机钱包记录(含在哪条链上添加的),按账户名 + 链一起匹配——
   * 账户名是链内资源,不能只凭账户名同名就把别的链上添加的钱包记录拿来当
   * "这就是现在这条链上的这个账户"用,那样会把不相干的密钥/凭据张冠李戴。
   * 没有 chainId 的是这个字段上线前存的旧数据,按主网处理。
   *
   * 同一个账户在本机可能存着不止一把钥匙(比如 active、owner 分开导入),
   * 这里选出来的是"当前实际要用来签名的那一把"——优先用 switchWallet()
   * 显式选中的那条记录,没有显式选过(或选的那条已经不在了)时,
   * 退回该账户下标了 active 权限的那条,再退回随便一条,不会是"不确定选哪个"。
   */
  currentWallet: StoredWallet | undefined;
  /** 切换到某个账户下具体某一把钥匙(而不只是账户名)——同账户多把钥匙时用这个精确选中 */
  switchWallet: (walletId: string) => void;
  /** 本机已保存的钱包(不含密钥材料) */
  wallets: StoredWallet[];
  /** 首次读取本机钱包列表是否已完成 —— 用于判断"是否首次无账户"时避免闪烁 */
  walletsLoaded: boolean;
  /** true = 本机确实读到了钱包索引,但解不开(设备密钥失效等),不是真的没有钱包 */
  walletsReadError: boolean;
  /** 当前会话包含用户选择的账户,含主动导入的观察账户。 */
  hasSession: boolean;
  /** 当前链存在已选账户;没有账户时 account 为空字符串。 */
  hasAccount: boolean;
  reloadWallets: () => Promise<void>;

  /** 当前选用的行情源(CoinGecko/Binance),和 RPC/历史节点一样在节点页独立切换 */
  priceSource: PriceSourceId;
  client: ChainClient;

  setChain: (id: ChainId) => void;
  setNode: (n: NodeInfo) => void;
  setHistoryNode: (n: NodeInfo) => void;
  setPriceSource: (id: PriceSourceId) => void;
  setAccount: (a: string) => void;
  /** force: 忽略行情的 60 秒缓存,强制现拉最新价——只给下拉刷新这类用户主动要求「现在就要」的场景用 */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
};

/** 实时链上数据:每次 refresh() 会分批落位好几次,订阅了就要跟着渲染好几次 */
type WalletLiveState = {
  status: Status;
  error: string | null;
  headBlock: number;
  latencyMs: number;

  resources: AccountResources | null;
  tokens: TokenBalance[];
  actions: ChainAction[];
  /**
   * 这次刷新时历史索引(Hyperion)有没有拉挂。actions 为空有两种完全不同的
   * 含义——"这个账户确实一笔交易都没有"和"历史节点没给出结果",只看
   * actions.length 是分不出来的,界面上却必须说成两句不同的话。
   */
  actionsFailed: boolean;
  ramPricePerKb: number;
  prices: PriceSnapshot | null;

  /**
   * 上一次成功刷新时留下的代币快照,只给"看一眼"的展示页(如 WalletScreen)
   * 在 status === 'loading' 且 tokens 还是空的这段空档里先垫一下,不是权威数据。
   * 任何要签名/广播的流程必须继续用上面的 tokens/resources,不能读这个。
   */
  cachedTokens: TokenBalance[] | null;
  cachedAt: number | null;
};

type WalletState = WalletSessionState & WalletLiveState;

const SessionCtx = createContext<WalletSessionState | null>(null);
const LiveCtx = createContext<WalletLiveState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const catalog=useNodeCatalog();
  const catalogRef=useRef(catalog);catalogRef.current=catalog;
  const previousCatalog=useRef(catalog);
  const [chainId, setChainId] = useState<ChainId>(DEFAULT_CHAIN);
  const [node, setNodeState] = useState<NodeInfo>(catalogRef.current[DEFAULT_CHAIN].rpc[0]);
  const [historyNode, setHistoryNodeState] = useState<NodeInfo>(catalogRef.current[DEFAULT_CHAIN].history[0]);
  const [account, setAccountState] = useState('');
  // 显式选中的具体那条 StoredWallet(而不只是账户名)——同一账户存着多把钥匙时,
  // 靠这个记住"当前是拿哪把在签",不设置就退回 currentWallet 的默认挑选逻辑
  const [walletId, setWalletIdState] = useState<string | undefined>(undefined);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [headBlock, setHeadBlock] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);
  const [resources, setResources] = useState<AccountResources | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [actions, setActions] = useState<ChainAction[]>([]);
  const [actionsFailed, setActionsFailed] = useState(false);
  const [ramPricePerKb, setRamPrice] = useState(0);
  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [walletsLoaded, setWalletsLoaded] = useState(false);
  const [walletsReadError, setWalletsReadError] = useState(false);
  const hasSession = !!account;
  const [prices, setPrices] = useState<PriceSnapshot | null>(null);
  const [priceSource, setPriceSource] = useState<PriceSourceId>(DEFAULT_PRICE_SOURCE);
  const [cachedTokens, setCachedTokens] = useState<TokenBalance[] | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const loadedWalletsRef = useRef<StoredWallet[]>([]);
  const activeSessionRef = useRef({ chainId, account, walletId, nodeId: node.id, historyNodeId: historyNode.id });
  activeSessionRef.current = { chainId, account, walletId, nodeId: node.id, historyNodeId: historyNode.id };

  const client = useMemo(
    () => new ChainClient(chainId, node, historyNode),
    [chainId, node, historyNode]
  );

  // 上次会话(账户/链/节点)是否已经恢复完成。恢复完成之前不发任何链上请求——
  // 不然启动瞬间会先给 useState 初始值里的占位账户+默认节点白跑一整轮刷新
  // (六个请求),几百毫秒后 session 恢复回真实账户又全部重来一遍,既浪费
  // 流量又挤占真实数据的带宽,让首屏可用数据更晚到。
  const [bootReady, setBootReady] = useState(false);

  // 每次账户/链切换,先把上次留下的快照垫上,给 WalletScreen 一个立等可见的数字,
  // 不用整个空转到这次 refresh() 跑完;没有快照就是 null,该转还是转
  useEffect(() => {
    if (!bootReady || !account) {
      setCachedTokens(null);
      setCachedAt(null);
      return;
    }
    let cancelled = false;
    setCachedTokens(null);
    setCachedAt(null);
    loadTokenSnapshot(chainId, account).then((snap) => {
      if (cancelled || !snap) return;
      setCachedTokens(snap.tokens);
      setCachedAt(snap.updatedAt);
    });
    return () => {
      cancelled = true;
    };
  }, [bootReady, chainId, account]);

  // 只在 App 这次启动的首次加载时恢复上次用的账户/链,后续手动 reloadWallets()
  // (比如新建/导入钱包后)不应该覆盖用户当下正在看的账户。
  const sessionRestoredRef = useRef(false);
  // 每次 refresh() 递增,用来判断"这次刷新是不是还是最新的一次"——
  // 见下面 REFRESH_TIMEOUT_MS 那段注释
  const refreshSeqRef = useRef(0);
  // 连续自动切节点失败了几轮,见 MAX_FAILOVER_ROUNDS
  const failoverCountRef = useRef(0);
  /**
   * 每条链各自最后一次在用的账户(见 Session.perChain)。切链时按目标链取回,
   * 不把当前这条链的账户带过去。放 ref 不放 state:它只在切链那一刻被读一次,
   * 没有任何界面订阅它,做成 state 只会让 setChain/持久化的依赖跟着一起抖。
   */
  const chainAccountsRef = useRef<Partial<Record<ChainId, ChainAccount>>>({});

  /**
   * 写会话。除了"最后停在哪条链的哪个账户",顺手把这条链当前的账户记进
   * perChain —— 切链时要靠它把每条链各自的账户原样还回来。
   */
  const persistSession = useCallback(
    (s: { chainId: ChainId; account: string; walletId?: string; nodeId: string; historyNodeId: string }) => {
      chainAccountsRef.current = {
        ...chainAccountsRef.current,
        [s.chainId]: { account: s.account, walletId: s.walletId, hasAccount: !!s.account },
      };
      saveSession({ ...s, hasAccount: !!s.account, perChain: chainAccountsRef.current });
    },
    []
  );

  /** 记住这次切换,下次启动直接用这个节点,而不是退回默认第一个 */
  const setNode = useCallback(
    (n: NodeInfo) => {
      setNodeState(n);
      persistSession({ chainId, account, walletId, nodeId: n.id, historyNodeId: historyNode.id });
    },
    [chainId, account, walletId, historyNode, persistSession]
  );

  const setHistoryNode = useCallback(
    (n: NodeInfo) => {
      setHistoryNodeState(n);
      persistSession({ chainId, account, walletId, nodeId: node.id, historyNodeId: n.id });
    },
    [chainId, account, walletId, node, persistSession]
  );

  useEffect(()=>{
    if(!bootReady)return;
    const previous=previousCatalog.current[chainId];
    const next=catalog[chainId];
    const rpc=next.rpc.find(n=>n.id===node.id)??(previous.rpc.some(n=>n.id===node.id)?next.rpc[0]:node);
    const history=next.history.find(n=>n.id===historyNode.id)??(previous.history.some(n=>n.id===historyNode.id)?next.history[0]:historyNode);
    const changed=rpc.url!==node.url||rpc.id!==node.id||rpc.name!==node.name||history.url!==historyNode.url||history.id!==historyNode.id||history.name!==historyNode.name;
    if(changed){setNodeState(rpc);setHistoryNodeState(history);persistSession({chainId,account,walletId,nodeId:rpc.id,historyNodeId:history.id});}
    previousCatalog.current=catalog;
  },[catalog,bootReady,chainId,node,historyNode,account,walletId,persistSession]);

  const reloadWallets = useCallback(async () => {
    let loaded: StoredWallet[] = [];
    let readFailed = false;
    try {
      // SecureStore 在启动瞬间偶尔会因为原生模块/Keystore 还没就绪而读失败,
      // 属于一过性抖动而非真的读不出来 —— 重试几次再认输,避免把"稍等一下就好"
      // 误判成"钱包没了"进而卡死在引导页(initialRouteName 只在挂载时算一次)。
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          loaded = await listWallets();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
      loadedWalletsRef.current = loaded;
      setWallets(loaded);
      setWalletsReadError(false);
    } catch (e) {
      readFailed = true;
      setWalletsReadError(e instanceof WalletReadError);
    } finally {
      if (!sessionRestoredRef.current) {
        sessionRestoredRef.current = true;
        // 没有这一步的话,每次冷启动/热重载账户都会被打回硬编码的示例只读账户 ——
        // 本机钱包数据其实好好的,用户却会以为自己的账户不见了。
        const session = await loadSession().catch(() => null);
        if (session && CHAINS[session.chainId]) {
          setChainId(session.chainId);
          // 每条链各自的账户也要一起恢复,不然重开 App 后第一次切链会因为
          // 这张表是空的而退回默认账户,把上次在那条链上看的账户丢掉
          chainAccountsRef.current = {
            ...(session.perChain ?? {}),
            [session.chainId]: { account: session.account, walletId: session.walletId, hasAccount: session.hasAccount },
          };
          // 节点也要恢复成上次用的那个(可能是自定义节点)——不然每次冷启动
          // 都退回默认列表第一个,等于用户手动挑、测速选的节点白选了
          const [restoredNode, restoredHistoryNode] = await Promise.all([
            resolveNode(session.chainId, 'rpc', session.nodeId, catalogRef.current),
            resolveNode(session.chainId, 'history', session.historyNodeId, catalogRef.current),
          ]);
          setNodeState(restoredNode ?? catalogRef.current[session.chainId].rpc[0]);
          setHistoryNodeState(restoredHistoryNode ?? catalogRef.current[session.chainId].history[0]);
          const selected = readFailed && session.hasAccount === true
            ? { account: session.account, walletId: session.walletId }
            : pickChainAccount(session.chainId, chainAccountsRef.current[session.chainId], loaded);
          setAccountState(selected.account);
          setWalletIdState(selected.walletId);
          if (!readFailed) persistSession({
            chainId: session.chainId,
            ...selected,
            nodeId: restoredNode?.id ?? catalogRef.current[session.chainId].rpc[0].id,
            historyNodeId: restoredHistoryNode?.id ?? catalogRef.current[session.chainId].history[0].id,
          });
        } else if (loaded.length > 0) {
          // 还没存过 session(比如这个功能上线前就已经导入过钱包),
          // 但本机确实存着钱包 —— 默认显示它,而不是通用的示例只读账户。
          setAccountState(loaded[0].account);
          setWalletIdState(loaded[0].id);
          const restoredChain = loaded[0].chainId ?? DEFAULT_CHAIN;
          setChainId(restoredChain);
          setNodeState(catalogRef.current[restoredChain].rpc[0]);
          setHistoryNodeState(catalogRef.current[restoredChain].history[0]);
          persistSession({
            chainId: restoredChain, account: loaded[0].account, walletId: loaded[0].id,
            nodeId: catalogRef.current[restoredChain].rpc[0].id,
            historyNodeId: catalogRef.current[restoredChain].history[0].id,
          });
        }
      } else if (!readFailed) {
        // 删除的钱包不能被旧会话重新解释成观察账户。
        for (const id of Object.keys(CHAINS) as ChainId[]) {
          const selected = pickChainAccount(id, chainAccountsRef.current[id], loaded);
          chainAccountsRef.current[id] = { ...selected, hasAccount: !!selected.account };
        }
        const active = activeSessionRef.current;
        const selected = pickChainAccount(active.chainId, chainAccountsRef.current[active.chainId], loaded);
        setAccountState(selected.account);
        setWalletIdState(selected.walletId);
        persistSession({ ...active, ...selected });
      }
      setWalletsLoaded(true);
      // 到这里链/账户/节点已经是最终值(要么恢复了上次会话,要么确认无可恢复),
      // 依赖它们的 refresh / 快照加载现在才可以放行
      setBootReady(true);
    }
  }, [persistSession]);

  useEffect(() => {
    reloadWallets();
  }, [reloadWallets]);

  const refresh = useCallback(
    async (opts?: { force?: boolean }) => {
      const mySeq = ++refreshSeqRef.current;
      if (!account) {
        setStatus('idle');
        setError(null);
        setResources(null);
        setTokens([]);
        setActions([]);
        setActionsFailed(false);
        setHeadBlock(0);
        setLatencyMs(0);
        setRamPrice(0);
        setPrices(null);
        return;
      }
      setStatus('loading');
      setError(null);

      // 链信息 / 账户资源 / 代币余额:原来是排成一串顺序 await,一次刷新要
      // 挨个等完六次节点往返;这几个请求彼此独立,并发发起,总耗时约等于
      // 其中最慢的一个,而不是全部加起来 —— 这是很多页面打开都要转好一阵的主因。
      // 代币这一项保留原来"优先 Hyperion 全量,失败则退回只查系统代币"的兜底,
      // 两次都失败时和 getInfo/getAccount 一样算作致命错误。
      const fetchTokens = async () => {
        let list: TokenBalance[];
        try {
          const t = await client.getTokens(account);
          list = t.length ? t : await client.getBalance(client.config.systemToken, account);
        } catch {
          list = await client.getBalance(client.config.systemToken, account);
        }
        // 系统代币(EOS)哪怕余额是 0 也固定摆在第一位——参考 TP 的做法。
        // EOSIO 链上零余额账户表压根没有那一行,get_currency_balance/Hyperion
        // 都会直接把它漏掉,不补的话零余额新账户的资产列表会显得"这条链的原生币都没有",
        // 容易被当成账户有问题;不在别处(如 client.ts)补是因为那边是通用查询,
        // "该不该给零余额也占一行"是展示层的产品决定,不该混进查询语义里。
        const sys = list.find(
          (t) => t.contract === client.config.systemToken && t.symbol === client.config.symbol
        );
        const rest = list.filter((t) => t !== sys);
        const systemEntry: TokenBalance = sys ?? {
          symbol: client.config.symbol,
          contract: client.config.systemToken,
          amount: 0,
          precision: client.config.precision,
          raw: `${(0).toFixed(client.config.precision)} ${client.config.symbol}`,
        };
        return [systemEntry, ...rest];
      };

      // 交易记录 / RAM 价格 / 行情:各自已经做过兜底,失败不影响主流程,
      // 提前发起、最后再取结果,不用等它们决定要不要往下走。
      // 行情默认吃 60 秒内存缓存(prices.ts 里本来就有,之前这里传 true 把它
      // 强制绕过了,导致每次切账户/广播完交易都硬打一次 CoinGecko),只有
      // 下拉刷新这种用户主动要"现在就要"的场景才传 force 跳过缓存。
      // 失败不再直接吞成空数组 —— 记下来,好让界面区分"没有记录"和"没查到"
      const actionsPromise = client.getActions(account).then(
        (page) => ({ ok: true, list: page.actions }),
        () => ({ ok: false, list: [] as ChainAction[] })
      );
      const ramPromise = client.getRamPrice().then(
        (r) => r.pricePerKb,
        () => 0
      );
      const pricesPromise = fetchPrices(priceSource, !!opts?.force);

      // 首页转圈不能没有上限。actions/ram/prices 各自内部都已经有超时兜底
      // (client.ts / prices.ts 的 fetchWithTimeout),真正没有超时保护的是
      // get_info / get_account 用的 @wharfkit/antelope 的 APIClient——它走的
      // 是自己的 fetch,不经过我们这层封装。这里再加一层"总闸"超时:
      // 15 秒还没拿到核心数据,就不再干等,直接判定失败、给出可以点的重试,
      // 而不是让转圈没有尽头、也看不出到底卡在哪一步。
      const REFRESH_TIMEOUT_MS = 15000;
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(t('walletCtxError.requestTimeout'))), REFRESH_TIMEOUT_MS);
      });
      // 主流程正常跑完的话这个 timeout promise 最终会在没人等它的情况下 reject——
      // 补一个空 catch,避免那时候被当成 unhandled rejection 打进控制台。
      timeout.catch(() => {});

      // 用户切账户/下拉刷新可能在上一次 refresh() 还没跑完时又触发了新的一次——
      // 旧的那次哪怕最终跑完了(甚至跑得比新的还慢),结果也不该覆盖新的状态,
      // 靠这个序号判断"我还是不是最新的那次"。
      const stale = () => refreshSeqRef.current !== mySeq;

      try {
        const [info, res, tokens] = await Promise.race([
          Promise.all([client.getInfo(), client.getAccount(account), fetchTokens()]),
          timeout,
        ]);
        if (stale()) return;

        setHeadBlock(info.headBlock);
        setLatencyMs(info.latencyMs);
        setResources(res);
        setTokens(tokens);
        // 给下次冷启动/切回这个账户时垫场用,不影响这次已经在用真实数据的页面
        saveTokenSnapshot(chainId, account, tokens);

        // 核心数据(余额/资源)一到手就算刷新完成——交易记录/RAM 价/行情各自
        // 内部带重试,最坏能拖上几十秒,不该让下拉刷新的转圈陪它们一起挂着;
        // 它们到货后再逐项落位。
        failoverCountRef.current = 0;
        setStatus('ready');

        // 每落一项都要重新确认"我还是不是最新一次刷新"——用户可能已经切走
        // 账户,旧账户的交易记录绝不能挂到新账户名下(消息中心也吃这份数据)。
        const actionsRes = await actionsPromise;
        if (stale()) return;
        setActions(actionsRes.list);
        setActionsFailed(!actionsRes.ok);

        const ram = await ramPromise;
        if (stale()) return;
        setRamPrice(ram);

        const priceSnap = await pricesPromise;
        if (stale()) return;
        setPrices(priceSnap);
      } catch (e: any) {
        if (stale()) return;

        // 先探测一下当前节点是不是真的连不上——如果它其实好好的,说明刚才
        // 的失败是别的原因(比如账户名不对),不该盲目切节点,原样把错误
        // 显示出来,切了反而掩盖真实原因、还白白多等一轮探测。
        const currentAlive = await probeNode(client.node);
        if (stale()) return;

        if (currentAlive) {
          setError(e?.message ? String(e.message) : t('walletCtxError.loadFailed'));
          setStatus('error');
          return;
        }

        if (failoverCountRef.current >= MAX_FAILOVER_ROUNDS) {
          setError(t('walletCtxError.networkError'));
          setStatus('error');
          return;
        }

        // 当前节点真的连不上——并发探测同一条链上的其他节点(默认 + 自定义),
        // 一次性测完全部候选、挑最快能用的自动切过去,比一个个顺序重试快得多。
        // 切节点会换出一个新 client,下面那个依赖 refresh 的 useEffect 会
        // 自动用新节点重新刷新一遍,这里不用手动重试。
        const customs = await listCustomNodes(chainId, 'rpc').catch(() => []);
        const candidates = [...catalogRef.current[chainId].rpc, ...customs].filter((n) => n.id !== client.node.id);
        const probed = await Promise.all(candidates.map(async (n) => ({ n, r: await probeNode(n) })));
        if (stale()) return;

        const alive = probed
          .filter((p): p is { n: NodeInfo; r: { ms: number; block: number } } => p.r !== null)
          .sort((a, b) => a.r.ms - b.r.ms);

        if (alive.length > 0) {
          failoverCountRef.current += 1;
          setNode(alive[0].n);
        } else {
          setError(t('walletCtxError.networkError'));
          setStatus('error');
        }
      }
    },
    [client, account, chainId, priceSource, setNode]
  );

  useEffect(() => {
    if (!bootReady) return;
    refresh();
  }, [bootReady, refresh]);

  const setChain = useCallback(
    (id: ChainId) => {
      // 已经在这条链上就什么都不做 —— 不然像 WalletListSheet 左侧链导轨那种
      // "点哪个都调一下 setChain"的写法,点到已经选中的那条链也会把当前正在
      // 看的账户顺手重置成默认账户,本机钱包数据没丢,只是"当前查看的账户"
      // 这个纯展示指针被误伤,表现出来就像账户凭空消失了。
      if (id === chainId) return;

      // 先把离开这条链时正在看的账户记下来 —— 切去测试网看一眼再切回来,
      // 主网这边正在看的账户(哪怕只是观察态)要原样还在
      chainAccountsRef.current = {
        ...chainAccountsRef.current,
        [chainId]: { account, walletId, hasAccount: !!account },
      };

      // 切链不把当前账户带过去,只在目标链自己的记录里挑,见 pickChainAccount
      const { account: nextAccount, walletId: nextWalletId } = pickChainAccount(
        id,
        chainAccountsRef.current[id],
        wallets
      );

      setChainId(id);
      const nextNode = catalogRef.current[id].rpc[0];
      const nextHistoryNode = catalogRef.current[id].history[0];
      setNodeState(nextNode);
      setHistoryNodeState(nextHistoryNode);
      setAccountState(nextAccount);
      setWalletIdState(nextWalletId);
      persistSession({
        chainId: id,
        account: nextAccount,
        walletId: nextWalletId,
        nodeId: nextNode.id,
        historyNodeId: nextHistoryNode.id,
      });
    },
    [chainId, account, walletId, wallets, persistSession]
  );

  /**
   * 选择已有钱包时记住它的 id,删除后可清掉会话;没有本机记录则作为观察账户。
   * 从钱包卡片选择具体某把钥匙时使用 switchWallet()。
   */
  const setAccount = useCallback(
    (a: string) => {
      const matchingWallets = loadedWalletsRef.current.filter(
        (x) => x.account === a && (x.chainId ?? DEFAULT_CHAIN) === chainId
      );
      const selectedWallet = matchingWallets.find((x) => (x.authPermissions ?? ['active']).includes('active'))
        ?? matchingWallets[0];
      setAccountState(a);
      setWalletIdState(selectedWallet?.id);
      persistSession({ chainId, account: a, walletId: selectedWallet?.id, nodeId: node.id, historyNodeId: historyNode.id });
    },
    [chainId, node, historyNode, persistSession]
  );

  /** 精确切到某一把钥匙——同一账户存着多把钥匙(比如 active/owner 分开导入)时用这个 */
  const switchWallet = useCallback(
    (id: string) => {
      const target = wallets.find((x) => x.id === id);
      if (!target) return;
      setAccountState(target.account);
      setWalletIdState(id);
      persistSession({ chainId, account: target.account, walletId: id, nodeId: node.id, historyNodeId: historyNode.id });
    },
    [chainId, node, historyNode, wallets, persistSession]
  );

  // 账户名 + 链一起匹配,不能只认账户名——同名账户在不同链上可能是不相干的人。
  // 同一账户可能对应不止一条记录(active/owner 分开导入的两把钥匙):优先用
  // switchWallet() 显式选中的那条;没选过、或选的那条已经不在了(比如被删除),
  // 退回标了 active 权限的那条(日常操作最常用到);再退回随便一条,而不是
  // 让"该用哪把"变成不确定——上线前导入、没有 authPermissions 记录的旧数据
  // 视为可能满足 active,同样能落进这一档兜底。
  const accountWallets = wallets.filter(
    (x) => x.account === account && (x.chainId ?? DEFAULT_CHAIN) === chainId
  );
  const currentWallet =
    accountWallets.find((x) => x.id === walletId) ??
    accountWallets.find((x) => (x.authPermissions ?? ['active']).includes('active')) ??
    accountWallets[0];

  const sponsorPermission = signingPermission(currentWallet);
  const canPrepareSponsorFee = bootReady && walletsLoaded && !!currentWallet;
  useEffect(() => {
    if (!canPrepareSponsorFee) return;
    const prepare = () => { refreshResourceRepairFee(client, account, sponsorPermission).catch(() => {}); };
    prepare();
    // 长时间后台后回到钱包也检查 24 小时有效期;重复进入由缓存合并。
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') prepare();
    });
    return () => subscription.remove();
  }, [canPrepareSponsorFee, client, account, sponsorPermission]);

  const hasAccount = !!account;

  // 会话/配置和实时数据分开 memo、分开两个 Provider——实时数据每次刷新要
  // 分批落位好几次,拆开后只订阅会话半边的页面(useWalletSession)在整个
  // 刷新过程中一次都不用重渲染。两个 value 都必须 memo 化,不然 Provider
  // 每 render 造新对象,拆了也白拆。
  const sessionValue: WalletSessionState = useMemo(
    () => ({
      chainId,
      rpcNodes:catalog[chainId].rpc,
      defaultHistoryNodes:catalog[chainId].history,
      node,
      historyNode,
      account,
      // 只有当前账户在本机、且是这条链上存的私钥,才可签名
      readOnly: !currentWallet,
      currentWallet,
      switchWallet,
      wallets,
      walletsLoaded,
      walletsReadError,
      hasSession,
      hasAccount,
      reloadWallets,
      priceSource,
      client,
      setChain,
      setNode,
      setHistoryNode,
      setPriceSource,
      setAccount,
      refresh,
    }),
    [
      catalog,
      chainId,
      node,
      historyNode,
      account,
      currentWallet,
      switchWallet,
      wallets,
      walletsLoaded,
      walletsReadError,
      hasSession,
      reloadWallets,
      priceSource,
      client,
      setChain,
      setNode,
      setHistoryNode,
      setPriceSource,
      setAccount,
      refresh,
    ]
  );

  const liveValue: WalletLiveState = useMemo(
    () => ({
      status,
      error,
      headBlock,
      latencyMs,
      resources,
      tokens,
      actions,
      actionsFailed,
      ramPricePerKb,
      prices,
      cachedTokens,
      cachedAt,
    }),
    [
      status,
      error,
      headBlock,
      latencyMs,
      resources,
      tokens,
      actions,
      actionsFailed,
      ramPricePerKb,
      prices,
      cachedTokens,
      cachedAt,
    ]
  );

  return (
    <SessionCtx.Provider value={sessionValue}>
      <LiveCtx.Provider value={liveValue}>{children}</LiveCtx.Provider>
    </SessionCtx.Provider>
  );
}

/**
 * 只订阅会话/配置(链、账户、节点、操作函数)——不含余额/交易记录/行情等
 * 实时数据。只关心"当前在哪、操作什么"的页面用这个,整个刷新周期都不会
 * 被拖着重渲染。
 */
export function useWalletSession(): WalletSessionState {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('useWalletSession 必须在 WalletProvider 内使用');
  return v;
}

/** 完整钱包状态(会话 + 实时数据)。要显示余额/记录/行情的页面用这个。 */
export function useWallet(): WalletState {
  const session = useWalletSession();
  const live = useContext(LiveCtx);
  if (!live) throw new Error('useWallet 必须在 WalletProvider 内使用');
  return useMemo(() => ({ ...session, ...live }), [session, live]);
}
