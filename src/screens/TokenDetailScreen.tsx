import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Switch,
  TextInput,
  Linking,
  ListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing } from '../theme';
import BottomSheet from '../components/BottomSheet';
import { useWallet } from '../chain/WalletContext';
import { useManualRefresh } from '../chain/useManualRefresh';
import { ChainAction } from '../chain/client';
import { assetValue, fmtAmount, fmtTime, fmtUSD, tokenColor } from '../chain/format';
import { priceIn } from '../chain/prices';
import { explorerAccount } from '../chain/transact';
import TokenBadge from '../components/TokenBadge';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';
import { useHistoryPagination } from '../chain/useHistoryPagination';

const BLUE = '#0085FF';
const GREEN = '#00C289';

const truncMid = (s: string, head = 5, tail = 4) =>
  s.length > head + tail + 3 ? `${s.slice(0, head)}...${s.slice(-tail)}` : s;

/** 行间分隔线——线本身缩进 52(避开图标),白底跟着卡片切片一起铺满 */
function TxSeparator() {
  return (
    <View style={styles.txItemWrap}>
      <View style={styles.txSep} />
    </View>
  );
}

export default function TokenDetailScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, 'TokenDetail'>>();
  const w = useWallet();
  // 路由参数里的 token 是进入这页那一刻的快照——下拉刷新/转账完成后余额已经
  // 变了,页面却还显示旧数字。改成每次 render 都从实时的 w.tokens 里按
  // 合约+符号找当前值。完整列表已返回但没有该币时按零算,不能复活旧余额。
  const routeToken = route.params.token;
  const token =
    w.tokens.find((tk) => tk.contract === routeToken.contract && tk.symbol === routeToken.symbol) ??
    (w.tokens.length ? { ...routeToken, amount: 0 }
      : w.cachedTokens?.find(tk => tk.contract === routeToken.contract && tk.symbol === routeToken.symbol) ?? { ...routeToken, amount: 0 });
  const { t } = useI18n();
  const { refreshing, onRefresh } = useManualRefresh(w.status, w.refresh);

  const FILTERS = [t('tokenDetail.filterAll'), t('tokenDetail.filterIn'), t('tokenDetail.filterOut')];
  const [filter, setFilter] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copiedTx, setCopiedTx] = useState<string | null>(null);
  const [copiedContract, setCopiedContract] = useState(false);

  // 代币信息弹窗(点击右上角 (i) 打开)
  const [infoModal, setInfoModal] = useState(false);

  // ---------- 小额过滤(参考 TP 的「记录筛选」)----------
  const [filterModal, setFilterModal] = useState(false);
  const [smallAmountOn, setSmallAmountOn] = useState(false);
  const [smallAmountThreshold, setSmallAmountThreshold] = useState('0.5');
  // 弹窗里正在编辑、还没点「确认」的草稿值——避免每敲一个字符就影响列表
  const [draftOn, setDraftOn] = useState(smallAmountOn);
  const [draftThreshold, setDraftThreshold] = useState(smallAmountThreshold);
  const openFilterModal = () => {
    setDraftOn(smallAmountOn);
    setDraftThreshold(smallAmountThreshold);
    setFilterModal(true);
  };
  const confirmFilter = () => {
    setSmallAmountOn(draftOn);
    setSmallAmountThreshold(draftThreshold);
    setFilterModal(false);
  };

  const isNative = token.contract === w.client.config.systemToken;
  const price = priceIn(w.prices, token.contract, token.symbol);
  const value = token.amount * price;

  const { all: allActions, loadingMore, loadMore } = useHistoryPagination(w.client, w.account, w.actions, w.actionsLoading);

  // 只显示该代币的转账记录
  const list = useMemo(() => {
    const threshold = parseFloat(smallAmountThreshold) || 0;
    return allActions
      .filter((a) => a.contract === token.contract)
      .filter((a) => (a.quantity ?? '').includes(token.symbol))
      .filter((a) => (filter === 0 ? true : filter === 1 ? a.direction === 'in' : a.direction === 'out'))
      .filter((a) => {
        if (!smallAmountOn || a.direction !== 'in') return true;
        const amt = parseFloat(a.quantity ?? '0');
        const usd = amt * price;
        return usd >= threshold || price === 0;
      });
  }, [allActions, token, filter, smallAmountOn, smallAmountThreshold, price]);

  const r = w.resources;

  const renderTx = ({ item: tx, index }: ListRenderItemInfo<ChainAction>) => {
    const isIn = tx.direction === 'in';
    const counterparty = (isIn ? tx.from : tx.to) ?? '';
    const txKey = `${tx.id}-${tx.seq}`;
    const isCopied = copiedTx === txKey;
    return (
      <View
        style={[
          styles.txItemWrap,
          index === 0 && styles.txItemFirst,
          index === list.length - 1 && styles.txItemLast,
        ]}
      >
        <TouchableOpacity
          style={styles.txRow}
          activeOpacity={0.6}
          onPress={() => nav.navigate('TransactionDetail', { tx, token })}
        >
          <View style={[styles.txIcon, { backgroundColor: isIn ? BLUE : GREEN }]}>
            <MaterialCommunityIcons
              name={isIn ? 'arrow-bottom-left' : 'arrow-top-right'}
              size={20}
              color="#FFFFFF"
            />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={styles.txNameRow}>
              <Text style={styles.txName} numberOfLines={1}>
                {truncMid(counterparty)}
              </Text>
              <TouchableOpacity
                hitSlop={8}
                onPress={async (e) => {
                  e.stopPropagation?.();
                  if (counterparty) {
                    await Clipboard.setStringAsync(counterparty);
                    setCopiedTx(txKey);
                    setTimeout(() => setCopiedTx(null), 1400);
                  }
                }}
              >
                <Ionicons
                  name={isCopied ? 'checkmark' : 'copy-outline'}
                  size={13}
                  color={isCopied ? GREEN : colors.textFaint}
                />
              </TouchableOpacity>
            </View>
            <Text style={styles.txType}>{isIn ? t('tokenDetail.filterIn') : t('tokenDetail.filterOut')}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.txAmt, { color: isIn ? BLUE : GREEN }]}>
              {isIn ? '+' : '-'}
              {tx.quantity}
            </Text>
            <Text style={styles.txTime}>{fmtTime(tx.time)}</Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* 顶部导航栏: 左返回、中标题、右信息(i)图标 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={styles.side}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{token.symbol}</Text>
        <View style={styles.side}>
          <TouchableOpacity hitSlop={8} onPress={() => setInfoModal(true)}>
            <Ionicons name="information-circle-outline" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      {/* 记录列表用 FlatList 而不是 ScrollView+map——翻页能积累到几百条,
          全量 map 每条都常驻渲染树,翻得越多越卡;FlatList 只渲染可视区。
          原来的白色圆角卡片改成"首行封顶、末行封底"的切片式,视觉不变
          (原卡片 0.03 透明度的阴影肉眼不可见,顺势去掉)。 */}
      <FlatList
        data={list}
        keyExtractor={(tx) => `${tx.id}-${tx.seq}`}
        renderItem={renderTx}
        ItemSeparatorComponent={TxSeparator}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 110 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BLUE} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListHeaderComponent={
          <>
            {w.actionsFailed ? <Text style={styles.emptyTxt}>{t('content.refreshFailed')}</Text> : null}
            {/* 余额行 */}
            <View style={styles.balRow}>
              <TokenBadge symbol={token.symbol} color={tokenColor(token.symbol)} size={52} contract={token.contract} />
              <TouchableOpacity
                style={styles.balSymRow}
                activeOpacity={0.6}
                onPress={async () => {
                  await Clipboard.setStringAsync(token.symbol);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                <Text style={styles.balSym}>{token.symbol}</Text>
                <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? GREEN : colors.textFaint} />
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.balAmt}>{fmtAmount(token.amount, token.precision)}</Text>
                <Text style={styles.balFiat}>{price > 0 ? `≈ ${fmtUSD(value)}` : token.contract}</Text>
              </View>
            </View>

            {/* 筛选选项卡 (全部 / 转入 / 转出 + 漏斗筛选按钮) */}
            <View style={styles.filterRow}>
              {FILTERS.map((f, i) => (
                <TouchableOpacity key={f} onPress={() => setFilter(i)} style={styles.filterItem}>
                  <Text style={[styles.filterTxt, filter === i && styles.filterTxtActive]}>{f}</Text>
                  {filter === i ? <View style={styles.filterLine} /> : null}
                </TouchableOpacity>
              ))}
              <View style={{ flex: 1 }} />
              <TouchableOpacity hitSlop={8} onPress={openFilterModal}>
                <MaterialCommunityIcons
                  name={smallAmountOn ? 'filter-check' : 'filter-variant'}
                  size={22}
                  color={smallAmountOn ? BLUE : colors.text}
                />
              </TouchableOpacity>
            </View>
          </>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {w.actionsLoading ? <ActivityIndicator color={BLUE} /> : <>
            <MaterialCommunityIcons name="file-document-outline" size={48} color="#D6D9E0" />
            <Text style={styles.emptyTxt}>
              {!w.historyNode || w.actionsFailed ? t('tokenDetail.noHistoryApi') : t('tokenDetail.noRecords')}
            </Text>
            </>}
          </View>
        }
        ListFooterComponent={
          <>
            {loadingMore ? (
              <ActivityIndicator style={styles.loadMoreIndicator} color={colors.textFaint} size="small" />
            ) : null}
            {w.historyNode ? (
              <TouchableOpacity
                style={styles.explorerHint}
                activeOpacity={0.6}
                onPress={() => Linking.openURL(explorerAccount(w.chainId, w.account))}
              >
                <Text style={styles.explorerHintTxt}>{t('tokenDetail.checkExplorerPrompt')} </Text>
                <Text style={styles.explorerHintLink}>{t('tokenDetail.checkExplorer')}</Text>
              </TouchableOpacity>
            ) : null}
          </>
        }
      />

      {/* 底部操作栏: 转账(Transfer) + 收款(Receive)——闪兑(Swap) 暂不做,先去掉 */}
      <View style={[styles.actionBar, { paddingBottom: insets.bottom + 10 }]}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.actionSend]}
          activeOpacity={0.85}
          onPress={() => nav.navigate('Send', { token })}
        >
          <Ionicons name="swap-horizontal" size={18} color="#FFFFFF" style={styles.actionBtnIcon} />
          <Text style={styles.actionBtnTxt}>{t('tokenDetail.transfer')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.actionReceive]}
          activeOpacity={0.85}
          onPress={() => nav.navigate('Receive', { token })}
        >
          <Ionicons name="arrow-down" size={18} color="#FFFFFF" style={styles.actionBtnIcon} />
          <Text style={styles.actionBtnTxt}>{t('tokenDetail.receive')}</Text>
        </TouchableOpacity>
      </View>

      {/* 代币信息弹窗 */}
      <BottomSheet visible={infoModal} onClose={() => setInfoModal(false)}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHead}>
            <View style={{ width: 24 }} />
            <Text style={styles.sheetTitle}>{t('tokenDetail.tokenInfo')}</Text>
            <TouchableOpacity hitSlop={8} onPress={() => setInfoModal(false)}>
              <Ionicons name="close" size={22} color={colors.textFaint} />
            </TouchableOpacity>
          </View>

          <View style={styles.infoModalBadgeRow}>
            <TokenBadge symbol={token.symbol} color={tokenColor(token.symbol)} size={48} contract={token.contract} />
            <View style={{ marginLeft: 12 }}>
              <Text style={styles.infoModalSymbol}>{token.symbol}</Text>
              <Text style={styles.infoModalContract} numberOfLines={1}>
                {token.contract}
              </Text>
            </View>
          </View>

          <View style={styles.infoModalCard}>
            <View style={styles.infoModalRow}>
              <Text style={styles.infoK}>{t('tokenDetail.symbol')}</Text>
              <Text style={styles.infoV}>{token.symbol}</Text>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoModalRow}>
              <Text style={styles.infoK}>{t('tokenDetail.contract')}</Text>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                activeOpacity={0.6}
                onPress={async () => {
                  await Clipboard.setStringAsync(token.contract);
                  setCopiedContract(true);
                  setTimeout(() => setCopiedContract(false), 1400);
                }}
              >
                <Text style={styles.infoV}>{token.contract}</Text>
                <Ionicons
                  name={copiedContract ? 'checkmark' : 'copy-outline'}
                  size={14}
                  color={copiedContract ? GREEN : colors.textFaint}
                />
              </TouchableOpacity>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoModalRow}>
              <Text style={styles.infoK}>{t('tokenDetail.precision')}</Text>
              <Text style={styles.infoV}>{token.precision}</Text>
            </View>

            {isNative && r ? (
              <>
                <View style={styles.infoDivider} />
                <View style={styles.infoModalRow}>
                  <Text style={styles.infoK}>{t('tokenDetail.staked')}</Text>
                  <Text style={styles.infoV}>
                    {`${(assetValue(r.selfStakedCpu) + assetValue(r.selfStakedNet)).toFixed(4)} ${token.symbol}`}
                  </Text>
                </View>
                <View style={styles.infoDivider} />
                <View style={styles.infoModalRow}>
                  <Text style={styles.infoK}>{t('resource.refunding')}</Text>
                  <Text style={styles.infoV}>{r.refunding}</Text>
                </View>
                <View style={styles.infoDivider} />
                <View style={styles.infoModalRow}>
                  <Text style={styles.infoK}>{t('tokenDetail.available')}</Text>
                  <Text style={styles.infoV}>
                    {`${fmtAmount(token.amount, token.precision)} ${token.symbol}`}
                  </Text>
                </View>
              </>
            ) : null}
          </View>

          <TouchableOpacity
            style={styles.explorerBtn}
            activeOpacity={0.85}
            onPress={() => {
              setInfoModal(false);
              Linking.openURL(explorerAccount(w.chainId, token.contract));
            }}
          >
            <Ionicons name="open-outline" size={17} color={BLUE} style={{ marginRight: 6 }} />
            <Text style={styles.explorerBtnTxt}>{t('tokenDetail.viewOnExplorer')}</Text>
          </TouchableOpacity>
        </View>
      </BottomSheet>

      {/* 记录筛选弹窗 */}
      <BottomSheet visible={filterModal} onClose={() => setFilterModal(false)}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHead}>
            <View style={{ width: 24 }} />
            <Text style={styles.sheetTitle}>{t('tokenDetail.historyFilter')}</Text>
            <TouchableOpacity hitSlop={8} onPress={() => setFilterModal(false)}>
              <Ionicons name="close" size={22} color={colors.textFaint} />
            </TouchableOpacity>
          </View>

          <Text style={styles.sheetSection}>{t('tokenDetail.quickFilter')}</Text>
          <Text style={styles.sheetSectionDesc}>{t('tokenDetail.quickFilterDesc')}</Text>

          <View style={styles.filterCard}>
            <View style={styles.filterCardHead}>
              <Text style={styles.filterCardTitle}>{t('tokenDetail.smallAmountFilter')}</Text>
              <Switch value={draftOn} onValueChange={setDraftOn} trackColor={{ true: BLUE }} />
            </View>
            <Text style={styles.filterCardDesc}>{t('tokenDetail.smallAmountFilterDesc')}</Text>
            <View style={styles.thresholdBox}>
              <Text style={styles.thresholdPrefix}>$</Text>
              <TextInput
                value={draftThreshold}
                onChangeText={setDraftThreshold}
                keyboardType="decimal-pad"
                style={styles.thresholdInput}
                editable={draftOn}
              />
            </View>
          </View>

          <TouchableOpacity style={styles.confirmBtn} activeOpacity={0.85} onPress={confirmFilter}>
            <Text style={styles.confirmTxt}>{t('tokenDetail.confirm')}</Text>
          </TouchableOpacity>
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F8F9FA' },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 48, backgroundColor: '#F8F9FA' },
  side: { width: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },

  balRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: 18 },
  balSymRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 14 },
  balSym: { fontSize: 22, fontWeight: '700', color: colors.text },
  balAmt: { fontSize: 24, fontWeight: '700', color: colors.text },
  balFiat: { fontSize: 13, color: colors.textSub, marginTop: 4 },

  filterRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, marginTop: 10, marginBottom: 8, gap: 26 },
  filterItem: { alignItems: 'center', paddingVertical: 6 },
  filterTxt: { fontSize: 16, color: colors.textFaint },
  filterTxtActive: { color: colors.text, fontWeight: '700' },
  filterLine: { height: 3, width: 22, borderRadius: 2, backgroundColor: colors.text, marginTop: 5 },

  // FlatList 的"切片式"卡片:每行自带白底和左右边距,首行封顶、末行封底,
  // 拼起来和原来的整块圆角卡片视觉一致(见列表处注释)
  txItemWrap: { backgroundColor: colors.white, marginHorizontal: spacing.lg, paddingHorizontal: 16 },
  txItemFirst: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 4, marginTop: 6 },
  txItemLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, paddingBottom: 4 },
  txSep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 52 },
  txRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  txIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  txNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  txName: { fontSize: 15, fontWeight: '500', color: colors.text, flexShrink: 1 },
  txType: { fontSize: 12.5, color: colors.textSub, marginTop: 3 },
  txAmt: { fontSize: 15, fontWeight: '600' },
  txTime: { fontSize: 11.5, color: colors.textFaint, marginTop: 4 },

  explorerHint: { flexDirection: 'row', justifyContent: 'center', paddingVertical: 20 },
  explorerHintTxt: { fontSize: 12.5, color: colors.textFaint },
  explorerHintLink: { fontSize: 12.5, color: BLUE, fontWeight: '600' },

  empty: { alignItems: 'center', paddingVertical: 60, gap: 12, paddingHorizontal: 40 },
  emptyTxt: { fontSize: 13.5, color: colors.textSub, textAlign: 'center' },
  loadMoreIndicator: { marginTop: 14 },

  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
    backgroundColor: colors.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EEF0F3',
  },
  actionBtn: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionSend: { backgroundColor: GREEN },
  actionReceive: { backgroundColor: BLUE },
  actionBtnIcon: { marginRight: 6 },
  actionBtnTxt: { color: '#FFFFFF', fontSize: 15.5, fontWeight: '600' },

  // 不要 position: 'absolute' 贴底——BottomSheet 自己会把面板推到底部,
  // 绝对定位反而让它量不出面板高度,滑入动画退回成"从一整屏外滑上来"
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 10,
    paddingHorizontal: spacing.lg,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 48 },
  sheetTitle: { fontSize: 16.5, fontWeight: '700', color: colors.text },
  sheetSection: { fontSize: 13.5, fontWeight: '600', color: colors.text, marginTop: 10 },
  sheetSectionDesc: { fontSize: 12, color: colors.textFaint, marginTop: 4, lineHeight: 17 },

  infoModalBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EEF0F3',
  },
  infoModalSymbol: { fontSize: 18, fontWeight: '700', color: colors.text },
  infoModalContract: { fontSize: 13, color: colors.textSub, marginTop: 2 },

  infoModalCard: {
    backgroundColor: '#F5F6F8',
    borderRadius: 12,
    paddingHorizontal: 16,
    marginTop: 14,
  },
  infoModalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 48 },
  infoK: { fontSize: 14.5, color: colors.textSub },
  infoV: { fontSize: 14.5, color: colors.text, fontWeight: '500' },
  infoDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E3E6EB' },

  explorerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: BLUE,
    marginTop: 18,
    marginBottom: 4,
  },
  explorerBtnTxt: { color: BLUE, fontSize: 15, fontWeight: '600' },

  filterCard: { backgroundColor: '#F5F6F8', borderRadius: 12, padding: 16, marginTop: 14 },
  filterCardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filterCardTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  filterCardDesc: { fontSize: 12, color: colors.textFaint, marginTop: 8, lineHeight: 17 },
  thresholdBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.white,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 44,
    marginTop: 12,
  },
  thresholdPrefix: { fontSize: 15, color: colors.textSub },
  thresholdInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0, outlineStyle: 'none' as any },

  confirmBtn: { backgroundColor: BLUE, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  confirmTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
