import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, FlatList, Alert, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { DappHistoryItem, clearDappHistory, listDappHistory, removeDappHistoryItem } from '../dapp/dappGate';
import { useDappSession } from '../dapp/DappSessionContext';
import { useI18n } from '../i18n';

const W = Dimensions.get('window').width;
const GAP = 12;
const COLS = 2;
const CARD_W = (W - spacing.lg * 2 - GAP) / COLS;

/**
 * 标签页管理 —— 对齐 TP 的多标签面板(顶部计数、卡片网格、
 * 底部「清空全部 / 新建 / 完成」)。
 *
 * 复用「最近打开」历史当标签列表,点开都是重新加载 —— 包括正好命中
 * 当前最小化悬浮球的那一个(最小化本身不保活,退到后台就把 WebView
 * 销毁了,见 DappOverlayHost)。预览区没有做成 TP 那种实时页面缩略图,
 * 那需要同时挂着每个标签的 WebView 才行,不划算,用图标占位。
 */
export default function DappTabsScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { session, minimized, openDapp } = useDappSession();
  const { t } = useI18n();
  const [tabs, setTabs] = useState<DappHistoryItem[]>([]);

  useFocusEffect(
    useCallback(() => {
      listDappHistory().then(setTabs);
    }, [])
  );

  const minimizedUrl = minimized ? session?.url : undefined;

  const openTab = (url: string) => {
    openDapp(url);
    nav.goBack();
  };

  // 新建标签不该替用户直接决定去哪个网站,而是打开输入网址/搜索 DApp 的页面,
  // 跟发现页的搜索入口是同一个 Search 屏,先退回上一页再跳,不然会在
  // 标签管理页上叠一层
  const newTab = () => {
    nav.goBack();
    nav.navigate('Search');
  };

  const closeTab = async (url: string) => {
    await removeDappHistoryItem(url);
    setTabs(await listDappHistory());
  };

  const clearAll = () => {
    if (!tabs.length) return;
    Alert.alert(t('dappTabs.clearAllTitle'), t('dappTabs.clearAllBody'), [
      { text: t('dappTabs.cancel'), style: 'cancel' },
      {
        text: t('dappTabs.clear'),
        style: 'destructive',
        onPress: async () => {
          await clearDappHistory();
          setTabs([]);
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <PageHeader title={tabs.length ? t('dappTabs.titleWithCount', { count: tabs.length }) : t('dappTabs.title')} />

      <FlatList
        data={tabs}
        key={COLS}
        numColumns={COLS}
        keyExtractor={(tb) => tb.url}
        columnWrapperStyle={{ gap: GAP }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 24, gap: GAP, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MaterialCommunityIcons name="tab-plus" size={44} color="#D6D9E0" />
            <Text style={styles.emptyTxt}>{t('dappTabs.empty')}</Text>
            <TouchableOpacity style={styles.newBtn} activeOpacity={0.85} onPress={newTab}>
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={styles.newBtnTxt}>{t('dappTabs.newTab')}</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => {
          const isMinimized = item.url === minimizedUrl;
          const host = item.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          const title = item.title || host;
          return (
            <View style={styles.cardWrap}>
              <TouchableOpacity style={styles.card} activeOpacity={0.7} onPress={() => openTab(item.url)}>
                <View style={styles.cardHead}>
                  <View style={styles.favicon}>
                    <Ionicons name="globe-outline" size={14} color={colors.textSub} />
                  </View>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {title}
                  </Text>
                </View>
                <View style={styles.preview}>
                  {item.thumbnail ? (
                    <Image source={{ uri: item.thumbnail }} style={styles.previewImg} resizeMode="cover" />
                  ) : (
                    <>
                      <Ionicons name="globe-outline" size={30} color="#DCE0E6" />
                      <Text style={styles.previewUrl} numberOfLines={1}>
                        {host}
                      </Text>
                    </>
                  )}
                </View>
                {isMinimized ? (
                  <View style={styles.liveTag}>
                    <View style={styles.liveDot} />
                    <Text style={styles.liveTxt}>{t('dappTabs.minimized')}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
              <TouchableOpacity style={styles.closeBtn} hitSlop={8} onPress={() => closeTab(item.url)}>
                <Ionicons name="close" size={15} color={colors.textSub} />
              </TouchableOpacity>
            </View>
          );
        }}
      />

      {/* 底部工具栏 —— 对齐 TP:清空全部 / 新建 / 完成 */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
        <TouchableOpacity hitSlop={8} onPress={clearAll} disabled={!tabs.length}>
          <Text style={[styles.footerTxt, !tabs.length && styles.footerTxtOff]}>{t('dappTabs.clearAll')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.footerAdd} activeOpacity={0.85} onPress={newTab}>
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity hitSlop={8} onPress={() => nav.goBack()}>
          <Text style={styles.footerTxt}>{t('dappTabs.done')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  cardWrap: { width: CARD_W, marginBottom: GAP + 16 },
  card: {
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 12,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  favicon: { width: 22, height: 22, borderRadius: 6, backgroundColor: '#F2F3F5', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { flex: 1, fontSize: 12.5, color: colors.text, fontWeight: '500' },
  preview: {
    height: 110,
    borderRadius: 8,
    backgroundColor: '#F7F8FB',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    overflow: 'hidden',
  },
  previewImg: { width: '100%', height: '100%' },
  previewUrl: { fontSize: 11, color: colors.textFaint, maxWidth: '90%' },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#12A566' },
  liveTxt: { fontSize: 11, color: '#12A566', fontWeight: '600' },

  closeBtn: {
    alignSelf: 'center',
    marginTop: -14,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#1A1D26',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 80 },
  emptyTxt: { fontSize: 14.5, color: colors.textFaint },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1E88FF',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 10,
    marginTop: 6,
  },
  newBtnTxt: { color: '#fff', fontSize: 14.5, fontWeight: '600' },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E6E8EC',
    backgroundColor: colors.white,
  },
  footerTxt: { fontSize: 15, color: colors.textSub },
  footerTxtOff: { color: colors.textFaint },
  footerAdd: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#1E88FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
