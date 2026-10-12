import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Linking,
  Alert,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWallet } from '../chain/WalletContext';
import { useManualRefresh } from '../chain/useManualRefresh';
import { fmtTime } from '../chain/format';
import { explorerTx } from '../chain/transact';
import { ChainAction } from '../chain/client';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';
const PAGE_SIZE = 30;

export default function TxRecordScreen() {
  const insets = useSafeAreaInsets();
  const w = useWallet();
  const { t } = useI18n();
  const { refreshing, onRefresh } = useManualRefresh(w.status, w.refresh);
  const FILTERS = [t('txRecord.filterAll'), t('txRecord.filterIn'), t('txRecord.filterOut')];
  const [filter, setFilter] = useState(0);

  // WalletContext 的 w.actions 只是第一页(30 条),翻页拿到的更早记录接着往这
  // 累加。w.actions 每次 refresh() 都会换成一个新数组引用——账户/链切换或
  // 下拉刷新时都要跟着清空重来,不然会把上一个账户翻的旧页残留在这。
  const [extra, setExtra] = useState<ChainAction[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const skipRef = useRef(0);

  useEffect(() => {
    setExtra([]);
    setHasMore(true);
    skipRef.current = w.actions.length;
  }, [w.actions]);

  const all = useMemo(() => [...w.actions, ...extra], [w.actions, extra]);

  const loadMore = async () => {
    if (loadingMore || !hasMore || w.status === 'loading' || !w.historyNode) return;
    setLoadingMore(true);
    try {
      const page = await w.client.getActions(w.account, { limit: PAGE_SIZE, skip: skipRef.current });
      skipRef.current += page.actions.length;
      setHasMore(page.hasMore);
      if (page.actions.length) setExtra((prev) => [...prev, ...page.actions]);
    } catch {
      // 翻页失败不打断已经在看的列表,静默放弃这一页——用户没往下滑到底不会注意到,
      // 再滑一次会自然重试
    } finally {
      setLoadingMore(false);
    }
  };

  const list = useMemo(
    () =>
      all.filter((a) =>
        filter === 0 ? true : filter === 1 ? a.direction === 'in' : a.direction === 'out'
      ),
    [all, filter]
  );

  const open = (tx: ChainAction) => {
    const url = explorerTx(w.chainId, tx.id);
    Alert.alert(t('txRecord.detailsTitle'), t('txRecord.detailsBody', { txId: tx.id }), [
      // 这个按钮之前没有 onPress,点了什么都不会发生——用户以为交易号已经在
      // 剪贴板里了,粘贴出去的却是残留的旧内容
      { text: t('txRecord.copyTxId'), onPress: () => Clipboard.setStringAsync(tx.id).catch(() => {}) },
      { text: t('txRecord.viewOnExplorer'), onPress: () => Linking.openURL(url) },
      { text: t('txRecord.close'), style: 'cancel' },
    ]);
  };

  const noHistory = !w.historyNode;

  return (
    <View style={styles.root}>
      <PageHeader title={t('txRecord.title')} />

      <View style={styles.filterRow}>
        {FILTERS.map((f, i) => (
          <TouchableOpacity key={f} onPress={() => setFilter(i)} style={styles.filterItem}>
            <Text style={[styles.filterTxt, filter === i && styles.filterTxtActive]}>{f}</Text>
            {filter === i ? <View style={styles.filterLine} /> : null}
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        <Text style={styles.count}>{t('txRecord.count', { count: list.length })}</Text>
      </View>

      <FlatList
        data={list}
        keyExtractor={(tx) => `${tx.id}-${tx.seq}`}
        contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BLUE} />}
        initialNumToRender={15}
        windowSize={9}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <View style={styles.center}>
            <MaterialCommunityIcons name="file-document-outline" size={52} color="#D6D9E0" />
            <Text style={styles.emptyTxt}>
              {noHistory ? t('txRecord.noHistoryApi') : t('txRecord.noRecords')}
            </Text>
            {noHistory ? (
              <Text style={styles.emptySub}>{t('txRecord.noHistoryApiSub')}</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const isIn = item.direction === 'in';
          const counterparty = isIn ? item.from : item.to;
          return (
            <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => open(item)}>
              <View style={[styles.icon, { backgroundColor: isIn ? '#E8F7EF' : '#E7F0FF' }]}>
                <MaterialCommunityIcons
                  name={isIn ? 'arrow-bottom-left' : 'arrow-top-right'}
                  size={20}
                  color={isIn ? '#12A566' : BLUE}
                />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.type}>{isIn ? t('txRecord.filterIn') : t('txRecord.filterOut')}</Text>
                  <Text style={styles.contract}>@{item.contract}</Text>
                </View>
                <Text style={styles.party} numberOfLines={1}>
                  {isIn ? t('txRecord.from') : t('txRecord.to')} {counterparty}
                </Text>
                {item.memo ? (
                  <Text style={styles.memo} numberOfLines={1}>
                    Memo: {item.memo}
                  </Text>
                ) : null}
                <Text style={styles.time}>{fmtTime(item.time)}</Text>
              </View>
              <Text style={[styles.amt, { color: isIn ? '#12A566' : colors.text }]}>
                {isIn ? '+' : '-'}
                {item.quantity}
              </Text>
            </TouchableOpacity>
          );
        }}
        ListFooterComponent={
          list.length ? (
            loadingMore ? (
              <ActivityIndicator style={styles.footerLoading} color={colors.textFaint} size="small" />
            ) : (
              /* 交易记录来自历史节点(Hyperion),不是 RPC 节点——来源标注要写对 */
              <Text style={styles.footer}>{t('txRecord.dataSource', { node: w.historyNode.name })}</Text>
            )
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    gap: 26,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EEF0F3',
  },
  filterItem: { alignItems: 'center', paddingVertical: 10 },
  filterTxt: { fontSize: 15.5, color: colors.textFaint },
  filterTxtActive: { color: colors.text, fontWeight: '700' },
  filterLine: { height: 3, width: 22, borderRadius: 2, backgroundColor: colors.text, marginTop: 5 },
  count: { fontSize: 12.5, color: colors.textFaint },

  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 14 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  type: { fontSize: 15.5, fontWeight: '500', color: colors.text },
  contract: { fontSize: 11.5, color: colors.textFaint },
  party: { fontSize: 13, color: colors.textSub, marginTop: 3 },
  memo: { fontSize: 12, color: '#B45309', marginTop: 3 },
  time: { fontSize: 12, color: colors.textFaint, marginTop: 3 },
  amt: { fontSize: 14.5, fontWeight: '600', marginLeft: 8 },

  center: { alignItems: 'center', paddingVertical: 80, gap: 12, paddingHorizontal: 40 },
  emptyTxt: { fontSize: 15, color: colors.text },
  emptySub: { fontSize: 13, color: colors.textSub, textAlign: 'center', lineHeight: 20 },
  footer: { textAlign: 'center', fontSize: 11.5, color: colors.textFaint, marginTop: 16 },
  footerLoading: { marginTop: 16 },
});
