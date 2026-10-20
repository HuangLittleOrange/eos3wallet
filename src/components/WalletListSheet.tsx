import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Pressable,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { PublicKey } from '@wharfkit/antelope';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import BottomSheet from './BottomSheet';
import { NetworkIcon } from './NetworkSelector';
import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { useWalletPermissionBadges } from '../chain/useWalletPermissionBadges';
import { CHAINS, DEFAULT_CHAIN } from '../chain/config';
import { useNetworkVisibility } from '../chain/networkVisibility';
import { fmtUSD } from '../chain/format';
import { priceIn } from '../chain/prices';
import { navigationRef } from '../navigation/navigationRef';
import { useDappSession } from '../dapp/DappSessionContext';
import type { StoredWallet } from '../crypto/vault';
import { useI18n, TranslationKey } from '../i18n';

const BLUE = '#3032FF';

const OVERLAY_IN_MS = 220;
const OVERLAY_OUT_MS = 180;
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);

/** 添加方式和管理菜单叠在同一个 Modal 内，保留底下的钱包列表，避免嵌套原生 Modal。 */
function AddPanelOverlay({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const backdrop = useSharedValue(0);
  const translateY = useSharedValue(24);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdrop.value = 0;
      translateY.value = 24;
      backdrop.value = withTiming(1, { duration: OVERLAY_IN_MS, easing: EASE_OUT });
      translateY.value = withTiming(0, { duration: OVERLAY_IN_MS, easing: EASE_OUT });
    } else {
      backdrop.value = withTiming(0, { duration: OVERLAY_OUT_MS, easing: EASE_IN });
      translateY.value = withTiming(24, { duration: OVERLAY_OUT_MS, easing: EASE_IN }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const cardStyle = useAnimatedStyle(() => ({ opacity: backdrop.value, transform: [{ translateY: translateY.value }] }));

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.overlayScrim, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.overlayCard, cardStyle]} pointerEvents="box-none">
        {children}
      </Animated.View>
    </View>
  );
}

/** PUB_K1_... → 旧版 EOS... 前缀,查账户接口和大部分区块浏览器只认这个格式的展示习惯 */
const toLegacyKey = (pub: string) => {
  try {
    return PublicKey.from(pub).toLegacyString();
  } catch {
    return pub;
  }
};
const truncKey = (s: string, head = 7, tail = 7) =>
  s.length > head + tail + 3 ? `${s.slice(0, head)}...${s.slice(-tail)}` : s;

/** 本机钱包来源的展示文案 */
const sourceLabel = (s: StoredWallet['source'] | 'adhoc', t: (key: TranslationKey) => string) => {
  switch (s) {
    case 'mnemonic':
      return t('walletList.mnemonic');
    case 'privatekey':
      return t('walletList.privateKey');
    case 'passkey':
      return 'Passkey';
    case 'watch':
      return t('walletList.watchLabel');
    default:
      // 当前正在看的账户不在本机钱包索引里 —— 临时浏览,没有保存
      return t('walletList.browsingUnsaved');
  }
};

/**
 * 权限徽标——owner 能改掉账户的任何权限(含 active 自己),风险和 active
 * 完全不是一个量级,所以单独给它一个醒目的琥珀色,不能和 active 用一样的灰。
 * active 卡片(蓝底)和普通卡片(灰底)背景不同,徽标配色也分两套,
 * 保证不管选没选中都看得清、不会糊在底色里。
 */
function PermPill({ perm, onActiveCard }: { perm: string; onActiveCard: boolean }) {
  const isOwner = perm === 'owner';
  const style = onActiveCard
    ? isOwner
      ? { bg: colors.gold, fg: '#4A2E00' }
      : { bg: 'rgba(255,255,255,0.22)', fg: 'rgba(255,255,255,0.95)' }
    : isOwner
    ? { bg: '#FEF3C7', fg: '#B45309' }
    : { bg: '#E6EAFB', fg: BLUE };
  return (
    <View style={[styles.permPill, { backgroundColor: style.bg }]}>
      {isOwner ? <Ionicons name="key" size={9} color={style.fg} style={{ marginRight: 2 }} /> : null}
      <Text style={[styles.permPillTxt, { color: style.fg }]}>{perm}</Text>
    </View>
  );
}

/**
 * 观察钱包徽标——参考 TP:账户名旁边一个描边小标签,跟资产页顶部大卡片上
 * 的「Read-only」标是同一个状态(本机没有这把钥匙,签不了名),只是这里
 * 换成列表卡片配的小尺寸描边样式,不用大卡片那种实心背景,不然一排卡片
 * 里太抢眼。描边而不是实心背景,也是不想跟旁边 PermPill(owner/active,
 * 有实际权限的钥匙)在视觉分量上抢——那个才是这张卡"能干什么"的重点,
 * 这个只是个附加说明。
 */
function WatchPill({ label, onActiveCard }: { label: string; onActiveCard: boolean }) {
  const color = onActiveCard ? 'rgba(255,255,255,0.9)' : colors.textSub;
  return (
    <View style={[styles.watchPill, { borderColor: color }]}>
      <Text style={[styles.watchPillTxt, { color }]}>{label}</Text>
    </View>
  );
}

export default function WalletListSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const w = useWallet();
  const { t } = useI18n();
  const { minimize } = useDappSession();
  const { enabled: visibleNetworks } = useNetworkVisibility();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  // 子菜单留在当前 Modal；网络设置关闭列表后进入独立页面。
  const [panel, setPanel] = useState<'list' | 'method' | 'manage'>('list');
  // 整个钱包列表关掉后,下次重新打开应该回到列表面板,不该停留在上次
  // 打开到一半的子面板上
  useEffect(() => {
    if (!visible) { setPanel('list'); setSearching(false); setQuery(''); }
  }, [visible]);
  useEffect(() => { setQuery(''); }, [w.chainId]);
  const goPanel = () => setPanel('method');
  /** 子面板(添加方式)自己的关闭动作——退回列表面板,不整个收起 */
  const closePanel = () => panel === 'manage' ? onClose() : setPanel('list');
  /** 整个 Modal 唯一的 onClose:停在子面板时先退回列表,列表本身再点一次才真正关掉 */
  const handleSheetClose = () => (panel === 'list' ? onClose() : closePanel());

  // DApp 宿主不在导航树中，用根导航跳转，并最小化 DApp 以显示目标页面。
  const leaveSheet = (navigate: () => void) => {
    setPanel('list');
    onClose();
    minimize();
    if (navigationRef.isReady()) navigate();
  };
  const goCreate = () => leaveSheet(() => navigationRef.navigate('CreateWalletMethod'));
  const goImport = () => leaveSheet(() => navigationRef.navigate('Import'));
  const goSelectNetwork = () => leaveSheet(() => navigationRef.navigate('Networks', { addWallet: true }));
  const goNetworkSettings = () => leaveSheet(() => navigationRef.navigate('Networks', { manageVisibility: true }));
  const goManageWallets = () => leaveSheet(() => navigationRef.navigate('ManageWallet'));

  const total = w.tokens.reduce((s, t) => s + t.amount * priceIn(w.prices, t.contract, t.symbol), 0);

  // 本机已保存的钱包,按最近创建/导入在前,只显示添加时选的是当前这条链的——
  // 账户名是链内资源,同一把钥匙在主网和测试网底下可能对应完全不相干的两个
  // 账户,不能因为公私钥一样就在别的链下也当作"你的账户"列出来。没有 chainId
  // 的是这个字段上线前存的旧数据,按主网处理(那时候还没有多链)。
  // 当前正在看的账户如果不在这份索引里(比如刚用「观察」输入了个陌生账户名),
  // 补一条临时项,保证它也在列表里可见,不会因为"没保存过"就从列表里消失。
  const walletList: {
    id: string;
    account: string;
    source: StoredWallet['source'] | 'adhoc';
    authPermissions?: string[];
    publicKey?: string;
  }[] = [
    ...[...w.wallets]
      .filter((x) => (x.chainId ?? DEFAULT_CHAIN) === w.chainId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((x) => ({ id: x.id, account: x.account, source: x.source, authPermissions: x.authPermissions, publicKey: x.publicKey })),
  ];
  if (w.hasAccount && !walletList.some((x) => x.account === w.account)) {
    walletList.unshift({ id: '__adhoc__', account: w.account, source: 'adhoc' });
  }

  const livePermissions = useWalletPermissionBadges(walletList, w.client, visible);
  const permsFor = (x: (typeof walletList)[number]): string[] => livePermissions[x.id] ?? [];
  const filteredWallets = walletList.filter(wallet => !query.trim() ||
    [wallet.account, wallet.publicKey ?? ''].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));

  /**
   * 点已保存的钱包卡片 —— 直接切过去,不需要先删掉再重新导入。
   * 同一账户可能有好几张卡(比如 active、owner 分开导入的两把钥匙),
   * 不能只按账户名判断"已经是这个了就不用切"——要切到具体是哪一张卡
   * (哪一把钥匙),所以已保存的钱包按 id 走 switchWallet(),
   * 只有临时的"观察中"占位项(id === '__adhoc__')才退回按账户名切换。
   */
  const switchToWallet = (id: string, acct: string) => {
    if (id === '__adhoc__') {
      if (acct === w.account) {
        onClose();
        return;
      }
      w.setAccount(acct);
    } else {
      if (id === w.currentWallet?.id) {
        onClose();
        return;
      }
      w.switchWallet(id);
    }
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={handleSheetClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
        <View style={styles.head}>
          <TouchableOpacity accessibilityLabel={t('walletList.search')} style={styles.headSide}
            onPress={() => { setSearching(value => !value); setQuery(''); }}>
            <Ionicons name="search-outline" size={23} color={colors.text} />
          </TouchableOpacity>
          {searching ? <TextInput autoFocus value={query} onChangeText={setQuery} placeholder={t('walletList.search')}
            accessibilityLabel={t('walletList.search')} autoCapitalize="none" autoCorrect={false} style={styles.searchInput} />
            : <Text style={styles.headTitle}>{t('walletList.title')}</Text>}
          <TouchableOpacity accessibilityLabel={t('walletList.close')} style={[styles.headSide, { alignItems: 'flex-end' }]} onPress={onClose}>
            <Ionicons name="close-outline" size={24} color="#555555" />
          </TouchableOpacity>
        </View>
        <View style={styles.headLine} />

        <View style={styles.body}>
          <View style={styles.rail}>
            <ScrollView showsVerticalScrollIndicator={false}>
              {Object.values(CHAINS).filter(network => visibleNetworks.includes(network.id)).map(network => <TouchableOpacity key={network.id}
                accessibilityRole="button" accessibilityLabel={`${network.name} · ${t(network.testnet ? 'manageWallet.testnet' : 'manageWallet.mainnet')}`}
                accessibilityState={{ selected: network.id === w.chainId }}
                style={[styles.railItem, network.id === w.chainId && styles.railItemActive]}
                onPress={() => w.setChain(network.id)}>
                <NetworkIcon networkId={network.id} />
              </TouchableOpacity>)}
              <TouchableOpacity accessibilityLabel={t('manageWallet.manageNetwork')} style={styles.railItem} onPress={goNetworkSettings}>
                <View style={styles.railAdd}><Ionicons name="add" size={29} color="#B7BCC4" /></View>
              </TouchableOpacity>
            </ScrollView>
            <TouchableOpacity accessibilityLabel={t('walletList.manage')} style={styles.railManage} onPress={() => setPanel('manage')}>
              <Ionicons name="grid-outline" size={24} color="#2980FF" />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.right} showsVerticalScrollIndicator={false}>
            <View style={styles.netRow}>
              <Text numberOfLines={1} style={[styles.netName, CHAINS[w.chainId].testnet && styles.testnetName]}>
                {CHAINS[w.chainId].name} · {t(CHAINS[w.chainId].testnet ? 'manageWallet.testnet' : 'manageWallet.mainnet')}
              </Text>
              <TouchableOpacity accessibilityLabel={t('walletList.selectAddMethod')} style={styles.addWallet} onPress={goPanel}>
                <Ionicons name="add-circle-outline" size={21} color={colors.text} />
              </TouchableOpacity>
            </View>

            {/* 本机所有钱包 —— 点哪个切到哪个,不用先删了再重新导入。
                同账户可能有好几张卡(active/owner 分开导入),高亮的必须是具体
                正被当作签名钥匙用的那一张(按 id 精确匹配 currentWallet),
                不能只看账户名相不相等,不然会把同账户的另一把钥匙也一起点亮。 */}
            {filteredWallets.map((x) => {
              const active = x.id === '__adhoc__' ? x.account === w.account : x.id === w.currentWallet?.id;
              const perms = permsFor(x);
              // Both saved watch wallets and temporary browsing accounts have no local signing key.
              const isWatch = x.source === 'adhoc' || x.source === 'watch';
              return (
                <TouchableOpacity
                  key={x.id}
                  style={[styles.walletCard, active ? styles.walletCardOn : styles.walletCardOff]}
                  activeOpacity={0.85}
                  onPress={() => switchToWallet(x.id, x.account)}
                >
                  {/* minWidth: 0 是关键——flex:1 默认的最小宽度是内容本身的宽度,
                      不设成 0 的话,右边余额一长,这栏的文字(来源标签这种英文长句)
                      就会不肯让步,直接怼到余额上面去,而不是老老实实截断。 */}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    {/* 名字旁边这个复制图标真的接了剪贴板(不是之前那种点了也没反应的
                        假装饰)——点它只复制账户名,不会连带触发外层卡片的切换钱包 */}
                    <View style={styles.walletTop}>
                      <TouchableOpacity
                        style={styles.walletNameRow}
                        activeOpacity={0.6}
                        hitSlop={6}
                        onPress={async () => {
                          await Clipboard.setStringAsync(x.account).catch(() => {});
                          setCopiedId(x.id);
                          setTimeout(() => setCopiedId((v) => (v === x.id ? null : v)), 1400);
                        }}
                      >
                        <Text style={[styles.walletName, !active && styles.walletNameOff]} numberOfLines={1}>
                          {x.account}
                        </Text>
                        <Ionicons
                          name="copy-outline"
                          size={12}
                          color={active ? 'rgba(255,255,255,0.85)' : colors.textFaint}
                        />
                      </TouchableOpacity>
                      {/* 放在复制这个 TouchableOpacity 外面——不然点徽标也会触发复制,
                          于情理不合(徽标不是名字的一部分) */}
                      {isWatch ? <WatchPill label={t('walletList.watchLabel')} onActiveCard={active} /> : null}
                    </View>
                    {/* 第二行:有公钥就显示旧版 EOS... 格式的截断公钥(和 TP 一致);
                        没有公钥(观察中/旧数据缺字段)才退回显示来源文案兜底 */}
                    <Text
                      style={[styles.walletKey, !active && styles.walletKeyOff]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {copiedId === x.id
                        ? t('wallet.copied')
                        : x.publicKey
                        ? truncKey(toLegacyKey(x.publicKey))
                        : sourceLabel(x.source, t)}
                    </Text>
                    {perms.length ? (
                      <View style={styles.walletPermRow}>
                        {perms.map((p) => (
                          <PermPill key={p} perm={p} onActiveCard={active} />
                        ))}
                      </View>
                    ) : null}
                  </View>
                  <View style={styles.walletCardRight}>
                    {active ? <Ionicons name="checkmark" size={22} color="#fff" /> : null}
                    {active ? (
                      w.status === 'loading' ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.walletBal} numberOfLines={1}>
                          {fmtUSD(total)}
                        </Text>
                      )
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            {query.trim() && !filteredWallets.length ? <Text style={styles.emptyText}>{t('walletList.noResults')}</Text> : null}
          </ScrollView>
        </View>
      </View>

      {/* 列表卡片一直挂着不动,「添加方式」是叠在它上面的浮层——
          见 AddPanelOverlay 顶上的注释 */}
      <AddPanelOverlay visible={panel !== 'list'} onClose={closePanel}>
        {/* 选择添加方式:创建钱包 / 导入钱包 */}
        <View style={[styles.methodWrap, panel === 'manage' && styles.manageWrap, { paddingBottom: insets.bottom + 12 }]}>
          {panel === 'manage' ? <View style={styles.manageHead}>
            <Text style={styles.manageTitle}>{t('walletList.manage')}</Text>
            <TouchableOpacity accessibilityLabel={t('walletList.close')} style={styles.manageCloseIcon} onPress={closePanel}>
              <Ionicons name="close-outline" size={20} color="#B7BCC4" />
            </TouchableOpacity>
          </View> : null}
          <View style={styles.methodCard}>
            {panel !== 'manage' ? <><View style={styles.methodHead}>
              <View style={{ width: 24 }} />
              <Text style={styles.methodTitle}>{t('walletList.selectAddMethod')}</Text>
              <TouchableOpacity hitSlop={8} onPress={closePanel}>
                <Ionicons name="close" size={20} color={colors.textFaint} />
              </TouchableOpacity>
            </View>
            <View style={styles.methodLine} /></> : null}
            <TouchableOpacity style={[styles.methodRow, panel === 'manage' && styles.manageRow]} activeOpacity={0.6} onPress={panel === 'manage' ? goManageWallets : goCreate}>
              <Text style={styles.methodRowTxt}>{t(panel === 'manage' ? 'manageWallet.title' : 'walletList.createWallet')}</Text>
            </TouchableOpacity>
            <View style={styles.methodLine} />
            {/* Passkey 登录已收进「创建钱包」页,那里和邮箱注册这类 passkey 相关的
                入口放在一起更好找,这个二选一的小菜单也不用堆三行 */}
            <TouchableOpacity style={[styles.methodRow, panel === 'manage' && styles.manageRow]} activeOpacity={0.6} onPress={panel === 'manage' ? goSelectNetwork : goImport}>
              <Text style={styles.methodRowTxt}>{t(panel === 'manage' ? 'walletList.addWallet' : 'walletList.importWallet')}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={[styles.methodClose, panel === 'manage' && styles.manageRow]} activeOpacity={0.6} onPress={closePanel}>
            <Text style={[styles.methodCloseTxt, panel === 'manage' && styles.manageCloseText]}>{t('walletList.close')}</Text>
          </TouchableOpacity>
        </View>
      </AddPanelOverlay>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 12, borderTopRightRadius: 12, height: '66%', overflow: 'hidden' },

  head: { flexDirection: 'row', alignItems: 'center', height: 48, paddingHorizontal: 16 },
  headSide: { width: 32, height: 44, justifyContent: 'center' },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '400', color: colors.text },
  searchInput: { flex: 1, height: 40, marginHorizontal: 8, fontSize: 15, color: colors.text },
  headLine: { height: StyleSheet.hairlineWidth, backgroundColor: '#E6E8EC' },

  body: { flex: 1, flexDirection: 'row' },
  rail: { width: 64, backgroundColor: '#F3F4F7' },
  railItem: { height: 64, alignItems: 'center', justifyContent: 'center' },
  railItemActive: { backgroundColor: '#fff' },
  railAdd: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#E6E8EC', alignItems: 'center', justifyContent: 'center' },
  railManage: { height: 54, backgroundColor: '#fff', borderTopLeftRadius: 9, borderTopRightRadius: 9, alignItems: 'center', justifyContent: 'center' },

  right: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 16 },
  netRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  netName: { flex: 1, fontSize: 16, color: colors.text },
  testnetName: { color: '#A15C00' },
  addWallet: { width: 28, height: 44, alignItems: 'flex-end', justifyContent: 'center' },
  emptyText: { fontSize: 13, color: colors.textSub, textAlign: 'center', marginTop: 28 },

  walletCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 10,
    minHeight: 58,
    marginBottom: 8,
  },
  walletCardOn: { backgroundColor: BLUE },
  walletCardOff: { backgroundColor: '#F2F3F5' },
  walletTop: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  walletNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  walletName: { color: '#fff', fontSize: 14.5, fontWeight: '600', flexShrink: 1 },
  walletNameOff: { color: colors.text },
  walletPermRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },
  walletKey: { color: 'rgba(255,255,255,0.75)', fontSize: 11.5, marginTop: 3 },
  walletKeyOff: { color: colors.textSub },
  // 和左边隔开一道 marginLeft,再兜底一个 minWidth——不管左边那栏截没截断,
  // 余额这一列都不会被文字怼到贴边甚至压到一起。
  walletCardRight: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    alignSelf: 'stretch',
    marginLeft: 10,
    minWidth: 30,
    maxWidth: '38%',
  },
  walletBal: { color: '#fff', fontSize: 13, fontWeight: '600' },
  permPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    flexShrink: 0,
  },
  permPillTxt: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.2 },
  watchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    borderWidth: 1,
    flexShrink: 0,
  },
  watchPillTxt: { fontSize: 10, fontWeight: '600' },

  // AddPanelOverlay:遮罩只压暗列表卡片露出的那部分背景,浮卡贴底——用
  // justifyContent 推到底部,而不是给 methodWrap 自己定位,这样 methodWrap
  // 原来那份 padding/gap 布局不用跟着改
  overlayScrim: { backgroundColor: 'rgba(0,0,0,0.35)' },
  overlayCard: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  methodWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: 10 },
  manageWrap: { backgroundColor: '#F3F4F7', borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  manageHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40 },
  manageTitle: { fontSize: 16, fontWeight: '400', color: '#333333' },
  manageCloseIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#E6E8EC', justifyContent: 'center', alignItems: 'center' },
  manageRow: { height: 58 },
  manageCloseText: { fontWeight: '400' },
  methodCard: { backgroundColor: colors.white, borderRadius: 14, overflow: 'hidden' },
  methodHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, paddingHorizontal: 16 },
  methodTitle: { fontSize: 15.5, fontWeight: '600', color: colors.textSub },
  methodLine: { height: StyleSheet.hairlineWidth, backgroundColor: '#E6E8EC' },
  methodRow: { height: 54, alignItems: 'center', justifyContent: 'center' },
  methodRowTxt: { fontSize: 17, color: colors.text },

  methodClose: { backgroundColor: colors.white, borderRadius: 14, height: 54, alignItems: 'center', justifyContent: 'center' },
  methodCloseTxt: { fontSize: 17, color: colors.text, fontWeight: '600' },
});
