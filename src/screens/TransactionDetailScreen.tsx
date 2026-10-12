import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing } from '../theme';
import { useWalletSession } from '../chain/WalletContext';
import { explorerTx } from '../chain/transact';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';

const GREEN = '#12A566';
const BLUE = '#1E88FF';

/** 中间省略,保留头尾——账户名一般够短不用截,交易哈希/区块高度这类长字符串才需要 */
const truncMid = (s: string, head = 10, tail = 8) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}...${s.slice(-tail)}` : s;

/**
 * 交易详情页——参考 TP:状态图标 + 大字金额,From/To/哈希/区块高度/时间一张卡,
 * 哈希那行带一个指向区块浏览器的二维码,方便用另一台设备扫码查看。
 *
 * TP 原版在底部放了 VaultaScan/eosflare/EOS Authority/Bloks 四个浏览器图标,
 * 这里只接了 eoseyes.com——链接规则(裸域名是主网,jungle4.eoseyes.com 是测试网,
 * /tx/{hash}、/account/{name} 两条路径)是直接在 eoseyes.com 上实测出来的,
 * 不是猜的。explorerTx() 是这个项目里全程唯一的浏览器链接来源,没有为了凑数去接
 * 没验证过 URL 规则的第三方站点,宁可少放几个也不放死链接。
 */
export default function TransactionDetailScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'TransactionDetail'>>();
  const { tx, token } = route.params;
  const w = useWalletSession();
  const { t } = useI18n();
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const isIn = tx.direction === 'in';
  const isOut = tx.direction === 'out';
  const statusTitle = isIn
    ? t('txDetail.receivedSuccess')
    : isOut
    ? t('txDetail.sentSuccess')
    : t('txDetail.completed');
  const amountColor = isIn ? GREEN : colors.text;
  const amountTxt = `${isIn ? '+' : isOut ? '-' : ''}${tx.quantity ?? `0 ${token.symbol}`}`;

  const explorerUrl = explorerTx(w.chainId, tx.id);

  const copy = async (field: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1400);
  };

  const Row = ({ label, value, field, mono }: { label: string; value: string; field: string; mono?: boolean }) => (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValueWrap}>
        <Text style={[styles.rowValue, mono && styles.rowValueMono]} numberOfLines={1}>
          {truncMid(value)}
        </Text>
        <TouchableOpacity hitSlop={8} onPress={() => copy(field, value)}>
          <Ionicons
            name={copiedField === field ? 'checkmark' : 'copy-outline'}
            size={15}
            color={copiedField === field ? GREEN : colors.textFaint}
          />
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={styles.side}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('txDetail.title')}</Text>
        <View style={styles.side} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.statusWrap}>
          <View style={styles.checkCircle}>
            <Ionicons name="checkmark" size={30} color="#fff" />
          </View>
          <Text style={styles.statusTitle}>{statusTitle}</Text>
          <Text style={[styles.amount, { color: amountColor }]}>{amountTxt}</Text>
        </View>

        <View style={styles.card}>
          {tx.from ? <Row label={t('txDetail.from')} value={tx.from} field="from" /> : null}
          {tx.to ? <Row label={t('txDetail.to')} value={tx.to} field="to" /> : null}
          {tx.memo ? <Row label={t('txDetail.memo')} value={tx.memo} field="memo" /> : null}

          <View style={styles.divider} />

          <View style={styles.hashRow}>
            <View style={{ flex: 1 }}>
              <Row label={t('txDetail.txHash')} value={tx.id} field="hash" mono />
              {tx.blockNum ? (
                <Row label={t('txDetail.blockNumber')} value={String(tx.blockNum)} field="block" />
              ) : null}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{t('txDetail.time')}</Text>
                <Text style={styles.rowValue}>{tx.time.replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '')}</Text>
              </View>
            </View>
            <View style={styles.qrWrap}>
              <QRCode value={explorerUrl} size={72} color="#3A3A3A" backgroundColor="#fff" />
              <Text style={styles.qrLabel}>{t('txDetail.queryUrl')}</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity style={styles.explorerBtn} activeOpacity={0.7} onPress={() => Linking.openURL(explorerUrl)}>
          <Ionicons name="compass-outline" size={17} color={BLUE} />
          <Text style={styles.explorerTxt}>{t('txRecord.viewOnExplorer')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 48 },
  side: { width: 44, alignItems: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: colors.text },

  statusWrap: { alignItems: 'center', paddingVertical: 26, gap: 8 },
  checkCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  statusTitle: { fontSize: 15, color: GREEN, fontWeight: '600' },
  amount: { fontSize: 26, fontWeight: '800' },

  card: { backgroundColor: '#F5F6F8', marginHorizontal: spacing.lg, borderRadius: 12, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, gap: 10 },
  rowLabel: { fontSize: 13, color: colors.textSub, flexShrink: 0 },
  rowValueWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rowValue: { fontSize: 14, color: colors.text, flexShrink: 1, textAlign: 'right' },
  rowValueMono: { fontSize: 13 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E3E6EB', marginVertical: 6 },

  hashRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  qrWrap: { alignItems: 'center', gap: 4, paddingTop: 8 },
  qrLabel: { fontSize: 10.5, color: colors.textFaint },

  explorerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 20,
    paddingVertical: 12,
  },
  explorerTxt: { fontSize: 14, color: BLUE, fontWeight: '600' },
});
