import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { useManualRefresh } from '../chain/useManualRefresh';
import { TokenBalance } from '../chain/client';
import { useWalletPermissionBadges } from '../chain/useWalletPermissionBadges';
import { fmtUSD, fmtAmount, tokenColor, impersonates } from '../chain/format';
import { priceIn, PriceSnapshot } from '../chain/prices';
import TokenBadge from '../components/TokenBadge';
import WalletListSheet from '../components/WalletListSheet';
import ToolsSheet from '../components/ToolsSheet';
import TokenPickerSheet from '../components/TokenPickerSheet';
import { loadTokenPrefs, TokenPrefs } from '../chain/tokenPrefs';
import { listLinkSessions, subscribeLinkSessions } from '../dapp/linkSessions';
import { AuthorizedApp, permissionDisplayAppType, permissionKey } from '../chain/permissions';
import { useAuthorizedApps } from '../chain/useAuthorizedApps';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n, TranslationKey } from '../i18n';

const EMPTY_TOKEN_PREFS: TokenPrefs = { hidden: [], added: [] };

type Nav = NativeStackNavigationProp<RootStackParamList>;

// 权限跟资源管理对调了位置——权限收进「更多工具」(ToolsSheet),资源换到
// 这个首页主操作栏来。
const ACTIONS: { key: string; labelKey: TranslationKey; icon: 'swap-horizontal' | 'arrow-down' | 'chip' | 'view-grid-outline' }[] = [
  { key: 'send', labelKey: 'wallet.send', icon: 'swap-horizontal' },
  { key: 'receive', labelKey: 'wallet.receive', icon: 'arrow-down' },
  { key: 'resource', labelKey: 'tools.resource', icon: 'chip' },
  { key: 'more', labelKey: 'wallet.moreTools', icon: 'view-grid-outline' },
];

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<Nav>();
  const w = useWallet();
  const { t } = useI18n();

  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showNodeTip, setShowNodeTip] = useState(true);
  const [walletSheet, setWalletSheet] = useState(false);
  const [toolsSheet, setToolsSheet] = useState(false);
  const [pickFor, setPickFor] = useState<null | 'send' | 'receive'>(null);
  const prefsScope = JSON.stringify([w.chainId, w.account]);
  const [prefsState, setPrefsState] = useState<{ scope: string; value: TokenPrefs } | null>(null);
  const tokenPrefs = prefsState?.scope === prefsScope ? prefsState.value : EMPTY_TOKEN_PREFS;
  const [linkSessionCount, setLinkSessionCount] = useState(0);

  // 资产区的"资产/授权"分栏——"授权"这栏跟 PermissionScreen 展示的是同一份
  // 数据(paylimit 受限权限),只是给首页开个更快的入口,不用先进"更多工具"。
  // 懒加载:切到这栏才拉一次,避免每次打开首页都多打一发不一定用得上的请求。
  const [assetTab, setAssetTab] = useState<'tokens' | 'permissions'>('tokens');
  const authorized = useAuthorizedApps(w.chainId, assetTab === 'permissions' ? w.account : '');
  const authorizedApps = authorized.data?.permissions.filter(p => p.managedByPayLimit) ?? null;
  const authorizedLoading = authorized.refreshing || (assetTab === 'permissions' && !authorized.data && !authorized.error);
  const authorizedErr = authorized.error ? String(authorized.error.message ?? t('permission.queryFailed')) : null;
  const [authorizedPullScope, setAuthorizedPullScope] = useState<string | null>(null);
  const authorizedPulled = authorizedPullScope === prefsScope;
  const onAuthorizedPull = useCallback(() => {
    setAuthorizedPullScope(prefsScope);
    void authorized.refresh().catch(() => {}).finally(() => {
      setAuthorizedPullScope(current => current === prefsScope ? null : current);
    });
  }, [authorized.refresh, prefsScope]);

  // 首页那颗"已连接 DApp"入口气泡(参考 TP)——不能只在这个页面重新聚焦时
  // 拉一遍,持久会话是 LinkSessionProvider 在后台收到推送/扫码就直接建立的,
  // 用户可能一直停在这个页面上不切走,那样 useFocusEffect 永远不会重跑。
  // 订阅 linkSessions.ts 那份变更广播,建立/撤销会话时都会通知到这里。
  useEffect(() => {
    const load = () => listLinkSessions().then((list) => setLinkSessionCount(list.length));
    load();
    return subscribeLinkSessions(load);
  }, []);

  // 首页展示哪些代币是账户维度的偏好(AddTokenScreen 里手动隐藏/添加过)。
  // 用 useFocusEffect 而不是普通 useEffect——native-stack 默认不会卸载被压在
  // 栈底的这个页面,从 AddTokenScreen 点「取消」/返回回来时组件不会重新挂载,
  // 依赖 chainId/account 的 useEffect 根本不会重跑,改完的隐藏/添加偏好就没法
  // 反映到首页。每次这个页面重新获得焦点(包括从 AddToken 返回)都重新读一遍。
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      loadTokenPrefs(w.chainId, w.account).then((p) => {
        if (!cancelled) setPrefsState({ scope: JSON.stringify([w.chainId, w.account]), value: p });
      });
      return () => {
        cancelled = true;
      };
    }, [w.chainId, w.account])
  );

  // 打开 App 亮一下当前用的是哪个节点、多快,10 秒后自动收起——不强求
  // 用户非得手动点一下才会消失,点击(切节点)本身也依然会立刻关掉它。
  useEffect(() => {
    const timer = setTimeout(() => setShowNodeTip(false), 10000);
    return () => clearTimeout(timer);
  }, []);

  // 稳定引用传给行组件——每次 render 现造闭包会让 TokenRow 的 memo 白做
  const openToken = useCallback((tk: TokenBalance) => nav.navigate('TokenDetail', { token: tk }), [nav]);

  const goTool = (key: string) => {
    if (key === 'receive') setPickFor('receive');
    else if (key === 'send') setPickFor('send');
    else if (key === 'permission') nav.navigate('Permission');
    else if (key === 'resource') nav.navigate('Resource');
  };

  const loading = w.status === 'loading';
  const { refreshing, onRefresh } = useManualRefresh(w.status, w.refresh);
  const permissionBadges = useWalletPermissionBadges(w.currentWallet ? [w.currentWallet] : [], w.client, !walletSheet);
  const authPerms = w.currentWallet ? permissionBadges[w.currentWallet.id] ?? [] : [];
  // 冷启动/切账户这段空档,tokens 还是空的但上次有留快照的话,先拿快照垫一下,
  // 真实数据一到就自动让位;断网时继续保留快照,不碰签名/广播流程。
  const usingCache = w.tokens.length === 0 && !!w.cachedTokens;
  const rawTokens = usingCache ? w.cachedTokens! : w.tokens;

  // 首页实际展示的列表 = 持有的代币(系统代币强制常显,其余按用户在「添加代币」页
  // 手动设置的隐藏偏好过滤)+ 用户从「热门代币」手动加到首页、目前还没真实持有的
  // 0 余额占位——这里只影响这个"看一眼"的展示页,签名/广播流程一律用 w.tokens 原始数据。
  // memo 化让 FlatList 拿到的 data 引用在无关状态(复制提示、弹层开关…)变化时
  // 保持不变,行组件的 React.memo 才能真正跳过重渲染。
  const systemTokenId = `${w.client.config.systemToken}:${w.client.config.symbol}`;
  const displayTokens = useMemo(() => {
    const heldTokenIds = new Set(rawTokens.map((t) => `${t.contract}:${t.symbol}`));
    const visibleHeld = rawTokens.filter((t) => {
      const id = `${t.contract}:${t.symbol}`;
      return id === systemTokenId || !tokenPrefs.hidden.includes(id);
    });
    const addedExtra: TokenBalance[] = tokenPrefs.added
      .filter((id) => !heldTokenIds.has(id) && !tokenPrefs.hidden.includes(id))
      .map((id) => {
        const [contract, symbol] = id.split(':');
        return { symbol, contract, amount: 0, precision: 4, raw: `0 ${symbol}` };
      });
    return [...visibleHeld, ...addedExtra];
  }, [rawTokens, tokenPrefs, systemTokenId]);

  const total = useMemo(
    () => displayTokens.reduce((s, t) => s + t.amount * priceIn(w.prices, t.contract, t.symbol), 0),
    [displayTokens, w.prices]
  );

  const mask = (s: string) => (hidden ? '****' : s);

  return (
    <View style={styles.root}>
      {/* 顶部条 */}
      <View style={[styles.topBar, { height: 48 + insets.top, paddingTop: insets.top }]}>
        <TouchableOpacity hitSlop={8} style={styles.topLeftBtn} onPress={() => setWalletSheet(true)}>
          <Ionicons name="menu" size={24} color={colors.text} />
        </TouchableOpacity>

        <Pressable
          style={styles.nodeWrap}
          hitSlop={10}
          onPress={() => {
            setShowNodeTip(false);
            nav.navigate('Node');
          }}
        >
          <View style={[styles.nodeDot, { backgroundColor: nodeColor(w.status, w.latencyMs) }]} />
          {showNodeTip ? (
            <View style={styles.nodeTip}>
              <View style={styles.nodeTipArrow} />
              <Text style={styles.nodeTipTxt}>
                {w.status === 'ready' ? `${w.node.name} · ${w.latencyMs}ms` : t('wallet.tapSwitchNode')}
              </Text>
            </View>
          ) : null}
        </Pressable>

        <View style={{ flex: 1 }} />

        <TouchableOpacity hitSlop={6} style={styles.topIcon} onPress={() => nav.navigate('Search')}>
          <Ionicons name="search-outline" size={23} color={colors.text} />
        </TouchableOpacity>
        {/* 导入钱包入口已收回:钱包列表(WalletListSheet)顶部的 + 号已经能进「导入钱包」,
            这里再放一个纯属重复,还挤占顶栏空间——见 2026-08-22 反馈。 */}
        <TouchableOpacity hitSlop={6} style={styles.topIcon} onPress={() => nav.navigate('Scan', {})}>
          <Ionicons name="scan-outline" size={23} color={colors.text} />
        </TouchableOpacity>
      </View>

      {(() => {
        // 头部(余额卡 + 错误提示 + 操作按钮 + 资产/授权分栏)两栏共用,
        // 抽成一份局部变量而不是拆成独立组件——里面一堆闭包状态(hidden/copied/
        // showNodeTip 等)拆出去反而要多传一堆 props,不值当。
        const header = (
          <>
        {/* 蓝色余额卡 */}
        <View style={styles.blueCard}>
          <View style={styles.blueTop}>
            <Pressable
              style={styles.acctRow}
              onPress={async () => {
                // 必须真的写进剪贴板——之前只弹"已复制"却什么都没复制,
                // 用户拿着剪贴板里残留的旧内容去粘贴,是很危险的误导
                await Clipboard.setStringAsync(w.account).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              <Text style={styles.acctName}>{w.account}</Text>
              <Ionicons name="copy-outline" size={12} color="rgba(255,255,255,0.9)" />
              {copied ? <Text style={styles.copiedTxt}>{t('wallet.copied')}</Text> : null}
            </Pressable>

            {/* 不放红点——那种"常亮的假提醒"点进去也没有任何新东西,只会让人
                学会忽略红点,真有需要提醒的事时反而没人看了 */}
            <TouchableOpacity style={styles.dotsBtn} hitSlop={8} onPress={() => nav.navigate('WalletDetail')}>
              <Feather name="more-horizontal" size={18} color="#fff" />
            </TouchableOpacity>
          </View>

          <View style={styles.balRow}>
            {loading && !w.resources && !usingCache ? (
              <ActivityIndicator color="#fff" style={{ marginVertical: 6 }} />
            ) : (
              <Text style={styles.balance}>{mask(fmtUSD(total))}</Text>
            )}
            <TouchableOpacity onPress={() => setHidden((h) => !h)} hitSlop={8}>
              <Ionicons
                name={hidden ? 'eye-off-outline' : 'eye-outline'}
                size={15}
                color="rgba(255,255,255,0.92)"
              />
            </TouchableOpacity>
          </View>

          {/* 只读标识 + 权限 + 网络 */}
          <View style={styles.tagRow}>
            {w.readOnly ? (
              <View style={styles.tag}>
                <Ionicons name="eye-outline" size={10} color="#fff" />
                <Text style={styles.tagTxt}>{t('wallet.readOnly')}</Text>
              </View>
            ) : null}
            {/* 这把钥匙实际控制的权限(active/owner)——只读账户没有对应的钥匙,自然没有这个标。
                按当前公钥查链上权限，导入时保存的旧标识不能证明现在仍有权限 */}
            {!w.readOnly && authPerms.length ? (
              <View style={styles.tag}>
                <Ionicons name="key-outline" size={10} color="#fff" />
                <Text style={styles.tagTxt}>{authPerms.join(' / ')}</Text>
              </View>
            ) : null}
            <View style={styles.tag}>
              <Text style={styles.tagTxt}>
                {w.client.config.name}
                {w.client.config.testnet ? ` · ${t('wallet.testnet')}` : ''}
              </Text>
            </View>
            {/* 正在用上次的快照垫场,明确标出来,别让人当成实时余额 */}
            {usingCache ? (
              <View style={styles.tag}>
                <Ionicons name="time-outline" size={10} color="#fff" />
                <Text style={styles.tagTxt}>
                  {t('wallet.cacheBalanceRefreshing', { age: cacheAgeLabel(w.cachedAt, t) })}
                </Text>
              </View>
            ) : null}
          </View>

          <Text style={styles.watermark}>A</Text>
        </View>

        {/* 错误提示 */}
        {w.status === 'error' ? (
          <TouchableOpacity style={styles.errBox} onPress={() => w.refresh()} activeOpacity={0.7}>
            <Ionicons name="alert-circle-outline" size={17} color="#F0644E" />
            <Text style={styles.errTxt} numberOfLines={2}>
              {w.error} —— {t('wallet.retryHint')}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* 动作按钮 */}
        <View style={styles.actionRow}>
          {ACTIONS.map((a) => (
            <TouchableOpacity
              key={a.key}
              style={styles.actionBtn}
              activeOpacity={0.6}
              onPress={() => (a.key === 'more' ? setToolsSheet(true) : goTool(a.key))}
            >
              <MaterialCommunityIcons name={a.icon} size={19} color={colors.text} />
              <Text style={styles.actionLabel}>{t(a.labelKey)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 资产/授权分栏——"授权"复用 PermissionScreen 那份已授权应用数据,
            点某一项直接跳详情页,省得非得先进「更多工具」才能看 */}
        <View style={styles.assetsHead}>
          <View style={styles.assetTabRow}>
            <TouchableOpacity hitSlop={6} onPress={() => setAssetTab('tokens')}>
              <Text style={[styles.assetTabTxt, assetTab === 'tokens' && styles.assetTabTxtActive]}>
                {t('wallet.assets')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity hitSlop={6} onPress={() => setAssetTab('permissions')}>
              <Text style={[styles.assetTabTxt, assetTab === 'permissions' && styles.assetTabTxtActive]}>
                {t('wallet.assetsTabAuthorized')}
              </Text>
            </TouchableOpacity>
          </View>
          {assetTab === 'tokens' ? (
            <TouchableOpacity hitSlop={8} onPress={() => nav.navigate('AddToken')}>
              <Ionicons name="add-circle-outline" size={24} color={colors.text} />
            </TouchableOpacity>
          ) : null}
        </View>

          </>
        );

        if (assetTab === 'permissions') {
          return (
            <FlatList
              data={authorizedApps ?? []}
              keyExtractor={(a) => permissionKey(a)}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: 24 }}
              refreshControl={
                <RefreshControl refreshing={authorizedPulled} onRefresh={onAuthorizedPull} tintColor="#2A7FFF" />
              }
              renderItem={({ item: app }) => (
                <AuthorizedAppRow
                  app={app}
                  t={t}
                  onPress={() => nav.navigate('PermissionDetail', { permissionKey: permissionKey(app) })}
                />
              )}
              ListEmptyComponent={
                authorizedLoading ? (
                  <ActivityIndicator color="#2A7FFF" style={{ marginTop: 40 }} />
                ) : (
                  <Text style={styles.empty}>{authorizedErr ?? t('permission.noAuthorized')}</Text>
                )
              }
              ListHeaderComponent={header}
            />
          );
        }

        return (
          <FlatList
            data={displayTokens}
            keyExtractor={(tk) => `${tk.contract}-${tk.symbol}`}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 24 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2A7FFF" />}
            // 虚拟化参数:账户可能持有上百个代币,全量渲染会明显掉帧
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={9}
            removeClippedSubviews
            renderItem={({ item: tk }) => (
              <TokenRow token={tk} hidden={hidden} prices={w.prices} t={t} onPress={openToken} />
            )}
            ListEmptyComponent={
              w.status === 'ready' ? <Text style={styles.empty}>{t('wallet.noTokens')}</Text> : null
            }
            ListHeaderComponent={header}
          />
        );
      })()}

      {/* 已连接 DApp 入口气泡——参考 TP:有持久会话就露出来,点进去是
          Connection Manager 列表。位置故意比 DappOverlayHost 那颗"最小化
          DApp"悬浮球高出一截(那颗是贴着 insets.bottom+74 的全局悬浮层,
          这颗是这个页面自己范围内的,两者算的不是同一个坐标系)——两颗气泡
          都可能同时出现,叠在一起会互相挡住,不能共用一个位置。 */}
      {linkSessionCount > 0 ? (
        <TouchableOpacity
          style={styles.linkBubble}
          activeOpacity={0.85}
          onPress={() => nav.navigate('LinkSessions')}
        >
          <MaterialCommunityIcons name="link-variant" size={22} color="#fff" />
        </TouchableOpacity>
      ) : null}

      <WalletListSheet visible={walletSheet} onClose={() => setWalletSheet(false)} />
      <ToolsSheet visible={toolsSheet} onClose={() => setToolsSheet(false)} onPick={goTool} />
      <TokenPickerSheet
        visible={pickFor !== null}
        onClose={() => setPickFor(null)}
        onPick={(t) => {
          if (pickFor === 'send') nav.navigate('Send', { token: t });
          else if (pickFor === 'receive') nav.navigate('Receive', { token: t });
          setPickFor(null);
        }}
      />
    </View>
  );
}

function cacheAgeLabel(at: number | null, t: (key: TranslationKey, vars?: Record<string, string | number>) => string) {
  if (!at) return t('wallet.cacheBefore');
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return t('wallet.cacheJustNow');
  if (s < 3600) return t('wallet.cacheMinutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('wallet.cacheHoursAgo', { n: Math.floor(s / 3600) });
  return t('wallet.cacheDaysAgo', { n: Math.floor(s / 86400) });
}

function nodeColor(status: string, ms: number) {
  if (status === 'error') return '#EF4444';
  if (status !== 'ready') return '#C7CBD4';
  return ms < 500 ? '#22C55E' : ms < 1000 ? '#F5A623' : '#EF4444';
}

// memo:资产行数可能上百,首页任何一个无关小状态(复制提示、节点气泡、弹层开关)
// 变化都不该带着整列资产行重渲染一遍
const TokenRow = React.memo(function TokenRow({
  token,
  hidden,
  prices,
  t,
  onPress,
}: {
  token: TokenBalance;
  hidden: boolean;
  prices: PriceSnapshot | null;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  onPress: (token: TokenBalance) => void;
}) {
  const price = priceIn(prices, token.contract, token.symbol);
  const value = token.amount * price;
  const fake = impersonates(token.symbol, token.contract);
  return (
    <TouchableOpacity style={styles.tokenRow} activeOpacity={0.6} onPress={() => onPress(token)}>
      <TokenBadge symbol={token.symbol} color={tokenColor(token.symbol)} size={44} contract={token.contract} />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.tokenSym}>{token.symbol}</Text>
          {fake ? (
            <View style={styles.fakeTag}>
              <Ionicons name="warning" size={10} color="#B45309" />
              <Text style={styles.fakeTxt}>{t('wallet.unofficial')}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.tokenPrice, fake && { color: '#B45309' }]} numberOfLines={1}>
          {fake
            ? t('wallet.officialTokenNote', { contract: token.contract, symbol: fake })
            : price > 0
            ? fmtUSD(price)
            : token.contract}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={styles.tokenAmount}>{hidden ? '****' : fmtAmount(token.amount, token.precision)}</Text>
        <Text style={styles.tokenValue}>{hidden ? '****' : price > 0 ? fmtUSD(value) : '—'}</Text>
      </View>
    </TouchableOpacity>
  );
});

// "授权"分栏的行——展示应用类型(如 Telegram Mini App)+ 权限名本身
// (paylimit 那个自定义 permission,如 xxxx.tg),跟 PermissionScreen 卡片
// 的字段一致,点了直接跳详情页
const AuthorizedAppRow = React.memo(function AuthorizedAppRow({
  app,
  t,
  onPress,
}: {
  app: AuthorizedApp;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.tokenRow} activeOpacity={0.6} onPress={onPress}>
      <View style={styles.permBadge}>
        <Ionicons name="shield-checkmark-outline" size={20} color={colors.brand} />
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text style={styles.tokenSym}>{permissionDisplayAppType(app, t)}</Text>
        <Text style={styles.tokenPrice} numberOfLines={1}>{app.permission}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </TouchableOpacity>
  );
});

const CARD_BLUE = '#2A7FFF';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  // 顶部安全区在带刘海/Dynamic Island 的 iPhone 上并不固定为 24。
  // 高度和 padding 必须用同一个 insets.top，否则余额卡会压住顶栏按钮。
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg },
  topLeftBtn: { paddingRight: 12 },
  nodeWrap: { flexDirection: 'row', alignItems: 'center' },
  nodeDot: { width: 9, height: 9, borderRadius: 5 },
  nodeTip: { marginLeft: 8, backgroundColor: '#6B7280', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 5 },
  nodeTipArrow: {
    position: 'absolute',
    left: -4,
    top: 9,
    width: 8,
    height: 8,
    backgroundColor: '#6B7280',
    transform: [{ rotate: '45deg' }],
  },
  nodeTipTxt: { color: '#fff', fontSize: 12 },
  topIcon: { paddingLeft: 16 },

  blueCard: {
    backgroundColor: CARD_BLUE,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm - 2,
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingTop: 12,
    paddingBottom: 13,
    overflow: 'hidden',
  },
  blueTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  acctRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  acctName: { color: '#fff', fontSize: 13.5, fontWeight: '600' },
  copiedTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 11, marginLeft: 2 },
  dotsBtn: { padding: 2 },
  balRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, minHeight: 30 },
  balance: { color: '#fff', fontSize: 23, fontWeight: '700', letterSpacing: -0.5 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 7 },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  tagTxt: { color: '#fff', fontSize: 10 },
  watermark: {
    position: 'absolute',
    right: 14,
    bottom: 10,
    fontSize: 22,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.12)',
  },

  errBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF0EE',
    marginHorizontal: spacing.lg,
    marginTop: 10,
    borderRadius: 8,
    padding: 12,
  },
  errTxt: { flex: 1, color: '#F0644E', fontSize: 13 },

  actionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: spacing.lg, marginTop: 8 },
  actionBtn: {
    flex: 1,
    height: 58,
    backgroundColor: '#F4F4F6',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  actionLabel: { fontSize: 11, color: colors.text, fontWeight: '500' },

  assetsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginTop: 18,
    marginBottom: 4,
  },
  assetTabRow: { flexDirection: 'row', gap: 18 },
  assetTabTxt: { fontSize: 16, fontWeight: '600', color: colors.textFaint },
  assetTabTxtActive: { color: colors.text },

  tokenRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 12 },
  permBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#F4F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenSym: { fontSize: 15.5, fontWeight: '500', color: colors.text },
  tokenPrice: { fontSize: 12.5, color: colors.textSub, marginTop: 3 },
  tokenAmount: { fontSize: 15.5, fontWeight: '500', color: colors.text },
  tokenValue: { fontSize: 12.5, color: colors.textSub, marginTop: 3 },

  fakeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#FEF3C7',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  fakeTxt: { fontSize: 10, color: '#B45309', fontWeight: '600' },
  empty: { textAlign: 'center', color: colors.textFaint, fontSize: 14, paddingVertical: 40 },

  linkBubble: {
    position: 'absolute',
    right: 16,
    bottom: 82,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1E88FF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
