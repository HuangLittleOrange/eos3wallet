import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { CHAINS, ChainId, DEFAULT_CHAIN, NodeInfo } from './config';
import { useNodeCatalog } from './NodeCatalogContext';
import { BUILTIN_NODE_CATALOG, NodeCatalog } from './nodeCatalog';
import { AccountResources, ChainAction, ChainClient, TokenBalance } from './client';
import { listCustomNodes, NodeKind } from './customNodes';
import { listWallets, signingPermission, StoredWallet, WalletReadError } from '../crypto/vault';
import { DEFAULT_PRICE_SOURCE, fetchPrices, loadPriceSnapshot, peekPrices, PriceSnapshot, PriceSourceId } from './prices';
import { ChainAccount, loadSession, saveSession } from './session';
import { pickChainAccount } from './chainAccount';
import { loadTokenSnapshot, peekTokenSnapshot, saveTokenSnapshot, type TokenSnapshot } from './walletCache';
import { invalidateLiveAccountRequest, requestLiveAccount } from './liveAccountRequest';
import { invalidatePermissionDisplay, rememberPermissionDisplay } from './permissionDisplayCache';
import { t } from '../i18n';
import { refreshResourceRepairFee } from './resourceRepairQuote';
import { historyCache, historyKey, readHistoryPage } from './historyCache';
import { tokenDirectoryCache, tokenDirectoryKey, rememberTokenDirectory, type TokenMetadata } from './tokenDirectory';
import { readTokenBalances } from './tokenBalances';
import { notifyWalletDataChanged, subscribeWalletDataChanges } from './walletDataEvents';
import { authorizedAppsCache, authorizedAppsKey, invalidateAuthorizedApps, loadAuthorizedApps } from './authorizedAppsCache';

type Status = 'idle' | 'loading' | 'ready' | 'error';

const EMPTY_ACTIONS: ChainAction[] = [];
const EMPTY_DIRECTORY: TokenMetadata[] = [];
const BALANCE_REFRESH_MS = 60000;

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
  actionsLoading: boolean;
  ramPricePerKb: number;
  prices: PriceSnapshot | null;

  /**
   * 上一次成功刷新时留下的代币快照,可用于展示和选择代币,不是交易余额依据。
   * 任何要签名/广播的流程必须继续用上面的 tokens/resources,不能读这个。
   */
  cachedTokens: TokenBalance[] | null;
  cachedAt: number | null;
  tokenDirectory: TokenMetadata[];
  tokenDirectoryAt: number | null;
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
  const [statusScope, setStatusScope] = useState('');
  const [infoScope, setInfoScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [headBlock, setHeadBlock] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);
  const [resources, setResources] = useState<AccountResources | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [resourcesScope, setResourcesScope] = useState('');
  const [tokensScope, setTokensScope] = useState('');
  const [ramPricePerKb, setRamPrice] = useState(0);
  const [ramScope, setRamScope] = useState('');
  const [wallets, setWallets] = useState<StoredWallet[]>([]);
  const [walletsLoaded, setWalletsLoaded] = useState(false);
  const [walletsReadError, setWalletsReadError] = useState(false);
  const hasSession = !!account;
  const [prices, setPrices] = useState<PriceSnapshot | null>(null);
  const [pricesScope, setPricesScope] = useState<PriceSourceId | null>(null);
  const [priceSource, setPriceSource] = useState<PriceSourceId>(DEFAULT_PRICE_SOURCE);
  const [tokenSnapshot, setTokenSnapshot] = useState<{ scope: string; value: TokenSnapshot | null } | null>(null);
  const snapshotScope = JSON.stringify([chainId, account]);
  const dataScope = JSON.stringify([chainId, account, node.url, historyNode.url]);
  const activeDataScope = useRef(dataScope); activeDataScope.current = dataScope;
  const selectedPriceSource = useRef(priceSource); selectedPriceSource.current = priceSource;
  const cachedSnapshot = account
    ? (peekTokenSnapshot(chainId, account) ?? (tokenSnapshot?.scope === snapshotScope ? tokenSnapshot.value : null))
    : null;
  const cachedTokens = cachedSnapshot?.tokens ?? null;
  const cachedAt = cachedSnapshot?.updatedAt ?? null;
  const loadedWalletsRef = useRef<StoredWallet[]>([]);
  const activeSessionRef = useRef({ chainId, account, walletId, nodeId: node.id, historyNodeId: historyNode.id });
  activeSessionRef.current = { chainId, account, walletId, nodeId: node.id, historyNodeId: historyNode.id };

  const switchedNode = useRef<(kind: NodeKind, next: NodeInfo) => void>(() => {});
  const currentClient = useRef<ChainClient | null>(null);
  const client = useMemo(() => {
    const created = new ChainClient(chainId, node, historyNode, {
      candidates: async kind => [...catalogRef.current[chainId][kind], ...await listCustomNodes(chainId, kind).catch(() => [])],
      onSwitch: (kind, next) => {
        const active = activeSessionRef.current;
        // A manual node/chain switch retires this client immediately.
        if (currentClient.current !== created || active.chainId !== chainId
          || active.nodeId !== node.id || active.historyNodeId !== historyNode.id) return;
        switchedNode.current(kind, next);
      },
    });
    return created;
  }, [chainId, node, historyNode]);
  currentClient.current = client;
  const actionKey = historyKey(client, account);
  const subscribeHistory = useCallback((listener: () => void) => historyCache.subscribe(actionKey, listener), [actionKey]);
  const readHistory = useCallback(() => historyCache.get(actionKey), [actionKey]);
  const history = useSyncExternalStore(subscribeHistory, readHistory, readHistory);
  const directoryKey = tokenDirectoryKey(chainId, account);
  const subscribeDirectory = useCallback((listener: () => void) => tokenDirectoryCache.subscribe(directoryKey, listener), [directoryKey]);
  const readDirectory = useCallback(() => tokenDirectoryCache.get(directoryKey), [directoryKey]);
  const directory = useSyncExternalStore(subscribeDirectory, readDirectory, readDirectory);
  const actions = history.data?.actions ?? EMPTY_ACTIONS;
  const actionsFailed = !!history.error;
  const actionsLoading = !!account && !history.data && (history.refreshing || statusScope !== dataScope || status === 'loading');

  // 上次会话(账户/链/节点)是否已经恢复完成。恢复完成之前不发任何链上请求——
  // 不然启动瞬间会先给 useState 初始值里的占位账户+默认节点白跑一整轮刷新
  // (六个请求),几百毫秒后 session 恢复回真实账户又全部重来一遍,既浪费
  // 流量又挤占真实数据的带宽,让首屏可用数据更晚到。
  const [bootReady, setBootReady] = useState(false);
  useEffect(() => { if (bootReady && account) void historyCache.hydrate(actionKey); }, [bootReady, account, actionKey]);
  useEffect(() => { if (bootReady && account) void tokenDirectoryCache.hydrate(directoryKey); }, [bootReady, account, directoryKey]);
  useEffect(() => {
    if (!bootReady || !account) return;
    let alive = true;
    const show = (snapshot: PriceSnapshot | null) => {
      if (alive && snapshot) { setPrices(snapshot); setPricesScope(priceSource); }
    };
    const update = () => {
      if (alive && (AppState.currentState === 'active' || AppState.currentState == null)) void fetchPrices(priceSource).then(show);
    };
    void loadPriceSnapshot(priceSource).then(snapshot => { show(snapshot); update(); });
    const timer = setInterval(update, 60000);
    const sub = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => { alive = false; clearInterval(timer); sub.remove(); };
  }, [bootReady, account, priceSource]);

  // 每次账户/链切换,先把上次留下的快照垫上,给 WalletScreen 一个立等可见的数字,
  // 不用整个空转到这次 refresh() 跑完;没有快照就是 null,该转还是转
  useEffect(() => {
    if (!bootReady || !account) {
      return;
    }
    let cancelled = false;
    loadTokenSnapshot(chainId, account).then((snap) => {
      if (cancelled || !snap) return;
      setTokenSnapshot({ scope: JSON.stringify([chainId, account]), value: snap });
      void rememberTokenDirectory(chainId, account, snap.tokens, false, snap.updatedAt);
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
  const lastRefreshAttemptRef = useRef(0);
  const lastBalanceAttempt = useRef(0);
  const balanceGeneration = useRef(0);
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
      currentClient.current = null;
      activeSessionRef.current = { ...activeSessionRef.current, nodeId: n.id };
      setNodeState(n);
      persistSession({ chainId, account, walletId, nodeId: n.id, historyNodeId: historyNode.id });
    },
    [chainId, account, walletId, historyNode, persistSession]
  );

  const setHistoryNode = useCallback(
    (n: NodeInfo) => {
      currentClient.current = null;
      activeSessionRef.current = { ...activeSessionRef.current, historyNodeId: n.id };
      setHistoryNodeState(n);
      persistSession({ chainId, account, walletId, nodeId: node.id, historyNodeId: n.id });
    },
    [chainId, account, walletId, node, persistSession]
  );

  switchedNode.current = (kind, next) => {
    const active = activeSessionRef.current;
    const selected = kind === 'rpc' ? { ...active, nodeId: next.id } : { ...active, historyNodeId: next.id };
    activeSessionRef.current = selected;
    if (kind === 'rpc') setNodeState(next); else setHistoryNodeState(next);
    persistSession(selected);
  };

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
    const previousWallets = loadedWalletsRef.current;
    const wasRestored = sessionRestoredRef.current;
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
      if (wasRestored && !readFailed) {
        for (const added of loaded.filter(wallet => !previousWallets.some(old => old.id === wallet.id)))
          notifyWalletDataChanged({ chainId: added.chainId ?? DEFAULT_CHAIN, accounts: [added.account], permissions: true });
      }
    }
  }, [persistSession]);

  useEffect(() => {
    reloadWallets();
  }, [reloadWallets]);

  const refreshBalances = useCallback(async (force = false, changedContracts: string[] = []) => {
    if (!account) return;
    const generation = ++balanceGeneration.current;
    lastBalanceAttempt.current = Date.now();
    const list = await readTokenBalances(client, account, force, changedContracts);
    if (generation !== balanceGeneration.current || activeDataScope.current !== dataScope) return;
    setTokens(list); setTokensScope(dataScope);
    void saveTokenSnapshot(chainId, account, list);
    setTokenSnapshot({ scope: JSON.stringify([chainId, account]), value: { tokens: list, updatedAt: Date.now() } });
    void rememberTokenDirectory(chainId, account, list, force).catch(() => {});
  }, [client, account, chainId, dataScope]);

  useEffect(() => {
    if (!bootReady || !account) return;
    const update = () => {
      if ((AppState.currentState === 'active' || AppState.currentState == null)
        && Date.now() - lastBalanceAttempt.current >= BALANCE_REFRESH_MS)
        void refreshBalances().catch(() => {}); // Keep previous display rows during a failed background update.
    };
    const timer = setInterval(update, BALANCE_REFRESH_MS);
    const sub = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [bootReady, account, refreshBalances]);

  const refresh = useCallback(
    async (opts?: { force?: boolean; resourcesOnly?: boolean; balanceContracts?: string[] }) => {
      const mySeq = ++refreshSeqRef.current;
      if (!account) {
        setStatus('idle');
        setError(null);
        setResources(null);
        setTokens([]);
        setHeadBlock(0);
        setLatencyMs(0);
        setRamPrice(0);
        setPrices(null);
        return;
      }
      lastRefreshAttemptRef.current = Date.now();
      setStatusScope(dataScope);
      setStatus('loading');
      setError(null);
      const stale = () => refreshSeqRef.current !== mySeq
        || activeDataScope.current !== dataScope
        || activeSessionRef.current.chainId !== chainId || activeSessionRef.current.account !== account;

      // 交易记录 / RAM 价格 / 行情:各自已经做过兜底,失败不影响主流程,
      // 提前发起、最后再取结果,不用等它们决定要不要往下走。
      // 行情默认吃 60 秒内存缓存(prices.ts 里本来就有,之前这里传 true 把它
      // 强制绕过了,导致每次切账户/广播完交易都硬打一次 CoinGecko),只有
      // 下拉刷新这种用户主动要"现在就要"的场景才传 force 跳过缓存。
      // 失败不再直接吞成空数组 —— 记下来,好让界面区分"没有记录"和"没查到"
      // History is display-only and publishes independently, even if core RPCs are slow/offline.
      void readHistoryPage(client, account, { force: true }).catch(() => {});
      void client.getRamPrice().then(r => {
        if (!stale()) { setRamPrice(r.pricePerKb); setRamScope(dataScope); }
      }).catch(() => {});
      const source = selectedPriceSource.current;
      if (!opts?.resourcesOnly) void fetchPrices(source, !!opts?.force).then(snapshot => {
        if (!stale() && source === selectedPriceSource.current) { setPrices(snapshot); setPricesScope(source); }
      });

      // Keep an overall deadline as well as the per-node transport deadlines.
      const REFRESH_TIMEOUT_MS = 15000;
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(t('walletCtxError.requestTimeout'))), REFRESH_TIMEOUT_MS);
      });
      // 主流程正常跑完的话这个 timeout promise 最终会在没人等它的情况下 reject——
      // 补一个空 catch,避免那时候被当成 unhandled rejection 打进控制台。
      timeout.catch(() => {});

      // 用户切账户/下拉刷新可能在上一次 refresh() 还没跑完时又触发了新的一次——
      // 旧的那次哪怕最终跑完了(甚至跑得比新的还慢),结果也不该覆盖新的状态,
      // 靠这个序号判断"我还是不是最新的那次"。
      let accepting = true;

      try {
        const scope = dataScope;
        const accountRead = requestLiveAccount(client, account).then(res => {
          if (accepting && !stale()) {
            setResources(res);
            setResourcesScope(scope);
            rememberPermissionDisplay(client, res);
          }
          return res;
        });
        const tokenRead = opts?.resourcesOnly ? Promise.resolve() : refreshBalances(!!opts?.force, opts?.balanceContracts);
        const [info] = await Promise.race([
          Promise.all([client.getInfo(), accountRead, tokenRead]),
          timeout,
        ]).finally(() => clearTimeout(timeoutId));
        if (stale()) return;

        setInfoScope(dataScope);
        setHeadBlock(info.headBlock);
        setLatencyMs(info.latencyMs);

        // 核心数据(余额/资源)一到手就算刷新完成——交易记录/RAM 价/行情各自
        // 内部带重试,最坏能拖上几十秒,不该让下拉刷新的转圈陪它们一起挂着;
        // 它们到货后再逐项落位。
        setStatus('ready');

      } catch (e: any) {
        if (stale()) return;
        accepting = false;

        // Read transports already attempted verified alternatives independently for RPC and history.
        setError(e?.message ? String(e.message) : t('walletCtxError.loadFailed'));
        setStatus('error');
      }
    },
    [client, account, chainId, setNode, dataScope, refreshBalances]
  );

  useEffect(() => {
    if (!bootReady) return;
    refresh();
  }, [bootReady, refresh]);

  // Reuse the current rows while active; refresh quietly after five minutes,
  // including when returning from the background. Opening a picker never fetches.
  useEffect(() => {
    if (!bootReady || !account) return;
    const refreshIfStale = () => {
      if ((AppState.currentState === 'active' || AppState.currentState == null)
        && Date.now() - lastRefreshAttemptRef.current >= 5 * 60 * 1000) void refresh({ resourcesOnly: true });
    };
    const timer = setInterval(refreshIfStale, 60000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refreshIfStale();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [bootReady, account, refresh]);

  useEffect(() => subscribeWalletDataChanges(change => {
    for (const changedAccount of new Set(change.accounts)) {
      // Preserve the persisted directory if the post-operation network update fails.
      // A successful forced balance read will replace its metadata immediately.
      if (change.permissions) {
        if (change.chainId === chainId) invalidateLiveAccountRequest(client, changedAccount);
        invalidatePermissionDisplay(change.chainId, changedAccount);
        const key = authorizedAppsKey(change.chainId, changedAccount);
        const wasLoaded = authorizedAppsCache.get(key).data !== undefined;
        invalidateAuthorizedApps(change.chainId, changedAccount);
        if (wasLoaded) void authorizedAppsCache.fetch(key, () => loadAuthorizedApps(changedAccount), true).catch(() => {});
      }
    }
    if (!bootReady || change.chainId !== chainId || !change.accounts.includes(account)) return;
    // Keep the display snapshot, but retire pre-mutation balances as a transfer validation source.
    balanceGeneration.current++;
    setTokensScope('');
    invalidateLiveAccountRequest(client, account);
    historyCache.invalidate(historyKey(client, account));
    void refresh({ force: true, balanceContracts: change.balanceContracts });
  }), [bootReady, chainId, account, client, refresh]);

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

      currentClient.current = null;
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
      activeSessionRef.current = { ...activeSessionRef.current, account: a };
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
      activeSessionRef.current = { ...activeSessionRef.current, account: target.account };
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
      status: !account ? 'idle' : statusScope === dataScope ? status : 'loading',
      error: statusScope === dataScope ? error : null,
      headBlock: infoScope === dataScope ? headBlock : 0,
      latencyMs: infoScope === dataScope ? latencyMs : 0,
      resources: resourcesScope === dataScope ? resources : null,
      tokens: tokensScope === dataScope ? tokens : [],
      actions,
      actionsFailed,
      actionsLoading,
      ramPricePerKb: ramScope === dataScope ? ramPricePerKb : 0,
      prices: pricesScope === priceSource ? prices : peekPrices(priceSource),
      cachedTokens,
      cachedAt,
      tokenDirectory: account ? directory.data ?? EMPTY_DIRECTORY : EMPTY_DIRECTORY,
      tokenDirectoryAt: account && directory.data ? directory.updatedAt : null,
    }),
    [
      status,
      error,
      headBlock,
      latencyMs,
      resources,
      tokens,
      resourcesScope,
      statusScope,
      infoScope,
      tokensScope,
      dataScope,
      actions,
      actionsFailed,
      actionsLoading,
      ramPricePerKb,
      ramScope,
      prices,
      pricesScope,
      priceSource,
      cachedTokens,
      cachedAt,
      directory,
      account,
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
