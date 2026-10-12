import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, NativeSyntheticEvent, NativeScrollEvent, Image, RefreshControl, ActivityIndicator, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useOpenDapp } from '../dapp/useOpenDapp';
import { useDappSession } from '../dapp/DappSessionContext';
import DappRiskSheet from '../components/DappRiskSheet';
import {
  DappFavorite,
  DappHistoryItem,
  clearDappHistory,
  listDappFavorites,
  listDappHistory,
  removeDappFavorite,
  toggleDappFavorite,
} from '../dapp/dappGate';
import { useI18n } from '../i18n';
import { useFocusedAppContent } from '../content/useFocusedAppContent';
import { localizedText, visibleItems } from '../content/types';

const BANNER_AUTOPLAY_MS = 4000;
const GRID_GAP = 10;
const emptyDappBrowser = require('../../assets/illustrations/empty-dapp-browser.png');

export default function DiscoverScreen() {
  const { width: W } = useWindowDimensions();
  const gridItemWidth = Math.max(1, (W - spacing.lg * 2 - GRID_GAP * 4) / 5);
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { open, pending, cancel, confirm } = useOpenDapp();
  const { session, minimized } = useDappSession();
  const { t, locale } = useI18n();
  const [tab, setTab] = useState(0);
  const { content, projects, loading, refreshing, error, source, refresh } = useFocusedAppContent(tab === 0);

  const TABS = [t('discover.tabTrending'), t('discover.tabBrowser'), t('discover.tabFavorites')];

  const BANNERS = useMemo(() => visibleItems(content.banners).map((banner) => ({
    ...banner,
    title: localizedText(banner.title, locale),
    lines: banner.lines.map((line) => localizedText(line, locale)),
  })), [content.banners, locale]);
  const DAPPS = useMemo(() => visibleItems(projects).filter((project) => project.featured).map((project) => ({
    ...project,
    name: project.translations?.[locale]?.name || project.name,
    color: project.color || '#1E88FF',
    letter: project.letter || (project.translations?.[locale]?.name || project.name).slice(0, 1),
  })), [projects, locale]);
  const PROMOS = useMemo(() => visibleItems(content.promos), [content.promos]);
  const EARN = useMemo(() => visibleItems(content.earnItems).map((item) => ({
    ...item,
    name: localizedText(item.title, locale),
    desc: localizedText(item.description, locale),
  })), [content.earnItems, locale]);
  const earnTitle = localizedText(content.earnTitle, locale);
  const earnDescription = localizedText(content.earnDescription, locale);
  // 卡片内容改变时重启轮播，即使数量没有变化。
  const bannerRevision = JSON.stringify(BANNERS);

  const [bannerIndex, setBannerIndex] = useState(0);
  const [history, setHistory] = useState<DappHistoryItem[]>([]);
  const [favorites, setFavorites] = useState<DappFavorite[]>([]);
  const bannerScrollRef = useRef<ScrollView>(null);
  const bannerIndexRef = useRef(0);
  const tabScrollRef = useRef<ScrollView>(null);
  const tabIndexRef = useRef(0);

  useFocusEffect(
    useCallback(() => {
      listDappHistory().then(setHistory);
      listDappFavorites().then(setFavorites);
    }, [])
  );

  // 浮层状态变化不触发页面聚焦，需单独刷新标签信息。
  useEffect(() => {
    listDappHistory().then(setHistory);
  }, [session, minimized]);

  useEffect(() => {
    bannerIndexRef.current = 0;
    setBannerIndex(0);
    bannerScrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [bannerRevision]);

  useEffect(() => {
    bannerScrollRef.current?.scrollTo({ x: bannerIndexRef.current * W, animated: false });
    tabScrollRef.current?.scrollTo({ x: tabIndexRef.current * W, animated: false });
  }, [W]);

  useFocusEffect(
    useCallback(() => {
      const count = BANNERS.length;
      if (count < 2) return;
      const timer = setInterval(() => {
        const next = (bannerIndexRef.current + 1) % count;
        bannerIndexRef.current = next;
        setBannerIndex(next);
        bannerScrollRef.current?.scrollTo({ x: next * W, animated: true });
      }, BANNER_AUTOPLAY_MS);
      return () => clearInterval(timer);
    }, [BANNERS.length, bannerRevision, W])
  );

  const onBannerScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.max(0, Math.min(BANNERS.length - 1, Math.round(e.nativeEvent.contentOffset.x / W)));
    bannerIndexRef.current = idx;
    setBannerIndex(idx);
  };

  const goToTab = (i: number) => {
    tabIndexRef.current = i;
    setTab(i);
    tabScrollRef.current?.scrollTo({ x: i * W, animated: true });
  };

  const onTabPageScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.max(0, Math.min(TABS.length - 1, Math.round(e.nativeEvent.contentOffset.x / W)));
    tabIndexRef.current = idx;
    setTab(idx);
  };

  const isFavorited = (url: string) => favorites.some((f) => f.url === url);

  const longPressFavorite = async (url: string, name: string) => {
    const nowOn = await toggleDappFavorite(url, name);
    setFavorites(await listDappFavorites());
    Alert.alert(nowOn ? t('discover.favorited') : t('discover.unfavorited'), name);
  };

  const removeFavorite = async (url: string) => {
    await removeDappFavorite(url);
    setFavorites(await listDappFavorites());
  };

  const clearHistory = async () => {
    await clearDappHistory();
    setHistory([]);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <TouchableOpacity style={styles.searchTap} activeOpacity={0.7} onPress={() => nav.navigate('Search')}>
            <Ionicons name="search" size={19} color={colors.textSub} />
            <Text style={styles.searchPlaceholder}>{t('discover.searchPlaceholder')}</Text>
          </TouchableOpacity>
          <TouchableOpacity hitSlop={6} onPress={() => nav.navigate('Scan', {})}>
            <Ionicons name="scan-outline" size={19} color={colors.textSub} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity hitSlop={6} style={styles.tabsBtn} onPress={() => nav.navigate('DappTabs')}>
          {history.length ? (
            <Text style={styles.tabsCount} numberOfLines={1}>
              {history.length > 99 ? '99+' : history.length}
            </Text>
          ) : (
            <Ionicons name="add" size={22} color={colors.text} />
          )}
        </TouchableOpacity>
      </View>

      {BANNERS.length > 0 ? <View>
        <ScrollView
          ref={bannerScrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={BANNERS.length > 1}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onBannerScrollEnd}
          scrollEventThrottle={16}
        >
          {BANNERS.map((b) => (
            <TouchableOpacity key={b.id} style={{ width: W }} activeOpacity={0.8} disabled={!b.url} onPress={() => b.url && open(b.url)}>
              <LinearGradient colors={b.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.banner}>
                {b.imageUrl ? <Image source={{ uri: b.imageUrl }} style={styles.bannerImage} resizeMode="cover" /> : null}
                <Text style={styles.bannerTitle} numberOfLines={2}>{b.title}</Text>
                {b.lines.map((line, i) => (
                  <Text key={i} style={styles.bannerLine} numberOfLines={1}>
                    {line}
                  </Text>
                ))}
              </LinearGradient>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {BANNERS.length > 1 ? <View style={styles.dots} pointerEvents="none">
          {BANNERS.map((b, i) => (
            <View key={b.id} style={[styles.dot, i === bannerIndex && styles.dotActive]} />
          ))}
        </View> : null}
      </View> : null}

      <View style={styles.tabRow}>
        {TABS.map((label, i) => (
          <TouchableOpacity key={label} onPress={() => goToTab(i)}>
            <Text style={[styles.tabTxt, tab === i && styles.tabTxtActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        ref={tabScrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onTabPageScrollEnd}
        scrollEventThrottle={16}
        style={{ flex: 1 }}
      >
        <View style={{ width: W }}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 28 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} />}
          >
            {loading ? (
              <View style={styles.contentStatus}>
                <ActivityIndicator size="small" color={colors.textSub} />
                <Text style={styles.statusText}>{t('content.loading')}</Text>
              </View>
            ) : null}
            {error ? (
              <View style={styles.contentStatus}>
                <Text style={styles.statusText}>
                  {t('content.refreshFailed')}{source === 'cache' ? ` · ${t('content.cached')}` : ''}
                </Text>
                <TouchableOpacity disabled={refreshing} onPress={() => { void refresh(); }}>
                  <Text style={styles.retryText}>{t('content.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : source === 'cache' ? <Text style={styles.cacheText}>{t('content.cached')}</Text> : null}
            <View style={styles.grid}>
              {DAPPS.map((d) => (
                <TouchableOpacity
                  key={d.id}
                  style={[styles.gridItem, { width: gridItemWidth }]}
                  activeOpacity={0.6}
                  onPress={() => open(d.appUrl)}
                  onLongPress={() => longPressFavorite(d.appUrl, d.name)}
                >
                  <View style={[styles.appIcon, { width: Math.max(1, gridItemWidth - 6), height: Math.max(1, gridItemWidth - 6), backgroundColor: d.color }]}>
                    {d.iconUrl ? (
                      <Image source={{ uri: d.iconUrl }} style={styles.projectImage} resizeMode="cover" />
                    ) : (
                      <Text style={[styles.appLetter, ['#fff', '#ffffff'].includes(d.color.toLowerCase()) && { color: colors.text }]}>
                        {d.letter}
                      </Text>
                    )}
                    {isFavorited(d.appUrl) ? (
                      <View style={styles.favBadge}>
                        <Ionicons name="star" size={10} color="#fff" />
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.appName} numberOfLines={2}>
                    {d.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {DAPPS.length === 0 && !loading ? (
              <View style={styles.emptyCatalog}><Text style={styles.emptyTxt}>{t('content.emptyDapps')}</Text></View>
            ) : null}

            {PROMOS.length > 0 ? <View style={styles.miniRow}>
              {PROMOS.map((promo) => (
                <TouchableOpacity
                  key={promo.id}
                  style={[{ width: Math.max(1, (W - spacing.lg * 2 - 10) / 2) }, PROMOS.length === 1 && { width: '100%' }]}
                  activeOpacity={0.8}
                  disabled={!promo.url}
                  onPress={() => promo.url && open(promo.url)}
                >
                  <LinearGradient colors={promo.colors} style={styles.miniBanner}>
                    {promo.imageUrl ? <Image source={{ uri: promo.imageUrl }} style={styles.bannerImage} resizeMode="cover" /> : null}
                    <Text style={styles.miniTxt}>{localizedText(promo.title, locale)}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              ))}
            </View> : null}

            {earnTitle ? <View style={styles.earnHead}><Text style={styles.earnTitle}>{earnTitle}</Text></View> : null}
            {earnDescription ? <Text style={styles.earnDesc}>{earnDescription}</Text> : null}

            {EARN.map((e) => (
              <TouchableOpacity key={e.id} style={styles.earnRow} activeOpacity={0.6} disabled={!e.url} onPress={() => e.url && open(e.url)}>
                <View style={[styles.earnIcon, { backgroundColor: e.color }]}>
                  {e.imageUrl ? <Image source={{ uri: e.imageUrl }} style={styles.earnImage} resizeMode="cover" /> : <Text style={styles.earnIconTxt}>{e.name.slice(0, 1)}</Text>}
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <Text style={styles.earnName}>{e.name}</Text>
                    {e.hot ? (
                      <View style={styles.hotTag}>
                        <Text style={styles.hotTagTxt}>HOT</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.earnSub} numberOfLines={1}>
                    {e.desc}
                  </Text>
                </View>
                <View style={styles.earnThumb}>
                  <MaterialCommunityIcons name="trending-up" size={18} color={e.color} />
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        <View style={{ width: W }}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 28 }}>
            <View style={styles.listSection}>
              {history.length ? (
                <>
                  <View style={styles.listHead}>
                    <Text style={styles.listHeadTxt}>{t('discover.recentVisits')}</Text>
                    <TouchableOpacity hitSlop={8} onPress={clearHistory}>
                      <Ionicons name="trash-outline" size={17} color={colors.textFaint} />
                    </TouchableOpacity>
                  </View>
                  {history.map((h) => (
                    <TouchableOpacity key={h.url} style={styles.listRow} activeOpacity={0.6} onPress={() => open(h.url)}>
                      <View style={styles.listIcon}>
                        <Ionicons name="globe-outline" size={18} color={colors.textSub} />
                      </View>
                      <Text style={styles.listUrl} numberOfLines={1}>
                        {h.url.replace(/^https?:\/\//, '')}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                    </TouchableOpacity>
                  ))}
                </>
              ) : (
                <View style={styles.emptyBlock}>
                  <Image source={emptyDappBrowser} style={styles.emptyImage} resizeMode="contain" />
                  <Text style={styles.emptyTxt}>{t('discover.noHistory')}</Text>
                  <Text style={styles.emptySub}>{t('discover.noHistorySub')}</Text>
                </View>
              )}
            </View>
          </ScrollView>
        </View>

        <View style={{ width: W }}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 28 }}>
            <View style={styles.listSection}>
              {favorites.length ? (
                favorites.map((f) => (
                  <TouchableOpacity key={f.url} style={styles.listRow} activeOpacity={0.6} onPress={() => open(f.url)}>
                    <View style={styles.listIcon}>
                      <Text style={styles.listIconTxt}>{f.name.slice(0, 1)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listName} numberOfLines={1}>
                        {f.name}
                      </Text>
                      <Text style={styles.listUrl} numberOfLines={1}>
                        {f.url.replace(/^https?:\/\//, '')}
                      </Text>
                    </View>
                    <TouchableOpacity hitSlop={8} onPress={() => removeFavorite(f.url)}>
                      <Ionicons name="star" size={20} color="#F5A623" />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))
              ) : (
                <View style={styles.emptyBlock}>
                  <Image source={emptyDappBrowser} style={styles.emptyImage} resizeMode="contain" />
                  <Text style={styles.emptyTxt}>{t('discover.noFavorites')}</Text>
                  <Text style={styles.emptySub}>{t('discover.noFavoritesSub')}</Text>
                </View>
              )}
            </View>
          </ScrollView>
        </View>
      </ScrollView>

      <DappRiskSheet visible={pending !== null} url={pending ?? ''} onCancel={cancel} onContinue={confirm} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: spacing.lg, paddingVertical: 8 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#F2F3F5',
    height: 42,
    borderRadius: 21,
    paddingHorizontal: 16,
  },
  searchTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  searchPlaceholder: { flex: 1, fontSize: 15, color: colors.textFaint },
  tabsBtn: {
    width: 38,
    height: 38,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  tabsCount: { fontSize: 13, fontWeight: '700', color: colors.text },

  banner: {
    marginHorizontal: spacing.lg,
    borderRadius: 12,
    padding: 18,
    minHeight: 132,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  bannerImage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: 0.35 },
  bannerTitle: { color: '#fff', fontSize: 21, fontWeight: '800', marginBottom: 10 },
  bannerLine: { color: 'rgba(255,255,255,0.88)', fontSize: 13.5, lineHeight: 21 },
  dots: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 14,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotActive: { backgroundColor: '#fff', width: 14 },

  tabRow: { flexDirection: 'row', gap: 26, paddingHorizontal: spacing.lg, marginTop: 20, marginBottom: 14 },
  tabTxt: { fontSize: 19, color: colors.textFaint, fontWeight: '600' },
  tabTxtActive: { color: colors.text, fontWeight: '800' },

  contentStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing.lg, paddingVertical: 10 },
  statusText: { flex: 1, fontSize: 12.5, color: colors.textSub },
  retryText: { fontSize: 13, color: '#1E88FF', fontWeight: '600' },
  cacheText: { fontSize: 12, color: colors.textFaint, paddingHorizontal: spacing.lg, marginBottom: 10 },
  emptyCatalog: { alignItems: 'center', paddingVertical: 24 },
  projectImage: { width: '100%', height: '100%', borderRadius: 14 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.lg,
    gap: GRID_GAP,
  },
  gridItem: { alignItems: 'center', marginBottom: 14 },
  appIcon: {
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  appLetter: { color: '#fff', fontSize: 19, fontWeight: '800' },
  appName: { fontSize: 12, color: colors.text, textAlign: 'center', marginTop: 7, lineHeight: 16 },
  favBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#F5A623',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.white,
  },

  listSection: { paddingHorizontal: spacing.lg, marginTop: 8 },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  listHeadTxt: { fontSize: 13, color: colors.textFaint },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#F7F8FB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  listIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#E7EBF2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  listIconTxt: { color: colors.textSub, fontSize: 14, fontWeight: '700' },
  listName: { fontSize: 15, color: colors.text, fontWeight: '500' },
  listUrl: { flex: 1, fontSize: 13, color: colors.textSub },

  emptyBlock: { alignItems: 'center', paddingVertical: 60, gap: 6 },
  emptyImage: { width: 124, height: 90 },
  emptyTxt: { fontSize: 14.5, color: colors.textFaint, marginTop: 6 },
  emptySub: { fontSize: 12.5, color: colors.textFaint },

  miniRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: spacing.lg, marginTop: 6 },
  miniBanner: { minHeight: 86, borderRadius: 10, padding: 13, justifyContent: 'center', overflow: 'hidden' },
  miniTxt: { color: '#fff', fontSize: 15, fontWeight: '800', lineHeight: 21 },

  earnHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginTop: 24,
  },
  earnTitle: { fontSize: 19, fontWeight: '800', color: colors.text },
  earnDesc: { paddingHorizontal: spacing.lg, fontSize: 13.5, color: colors.textSub, marginTop: 8, lineHeight: 20 },

  earnRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 12 },
  earnIcon: { width: 48, height: 48, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  earnImage: { width: 48, height: 48, borderRadius: 11 },
  earnIconTxt: { color: '#fff', fontSize: 20, fontWeight: '800' },
  earnName: { fontSize: 15.5, color: colors.text, fontWeight: '500' },
  hotTag: { borderWidth: 1, borderColor: '#1E88FF', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  hotTagTxt: { color: '#1E88FF', fontSize: 10, fontWeight: '700' },
  earnSub: { fontSize: 13, color: colors.textSub, marginTop: 4 },
  earnThumb: { width: 44, height: 44, borderRadius: 9, backgroundColor: '#F2F5FA', alignItems: 'center', justifyContent: 'center' },
});
