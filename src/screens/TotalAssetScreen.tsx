import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { fmtUSD, fmtAmount, tokenColor, impersonates } from '../chain/format';
import { priceIn } from '../chain/prices';
import PageHeader from '../components/PageHeader';
import TokenBadge from '../components/TokenBadge';
import { useI18n } from '../i18n';

export default function TotalAssetScreen() {
  const insets = useSafeAreaInsets();
  const w = useWallet();
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);
  const [q, setQ] = useState('');

  const tokens = w.tokens.length ? w.tokens : (w.cachedTokens ?? []);
  const total = tokens.reduce((s, tk) => s + tk.amount * priceIn(w.prices, tk.contract, tk.symbol), 0);
  const list = useMemo(() => {
    if (!q.trim()) return tokens;
    const s = q.trim().toLowerCase();
    return tokens.filter((tk) => tk.symbol.toLowerCase().includes(s) || tk.contract.includes(s));
  }, [tokens, q]);

  const mask = (s: string) => (hidden ? '******' : s);

  return (
    <View style={styles.root}>
      <PageHeader title={t('totalAsset.title')} />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
        {!w.tokens.length && tokens.length ? <Text style={{ color: colors.textSub, fontSize: 12, padding: spacing.lg }}>{t('content.cached')}</Text> : null}
        {/* 蓝色总览卡 */}
        <View style={styles.blueCard}>
          <View style={styles.blueTop}>
            <Text style={styles.blueLabel}>{t('totalAsset.totalValue')}</Text>
            <TouchableOpacity onPress={() => setHidden((h) => !h)} hitSlop={10}>
              <Ionicons name={hidden ? 'eye-off-outline' : 'eye-outline'} size={19} color="#fff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.blueValue}>{mask(fmtUSD(total))}</Text>
          <View style={styles.blueFoot}>
            <View style={styles.netTag}>
              <View style={styles.netDot} />
              <Text style={styles.netTxt}>{w.client.config.name}</Text>
            </View>
            <Text style={styles.acctTxt}>{w.account}</Text>
          </View>
        </View>

        {/* 搜索 */}
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color={colors.textSub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('totalAsset.searchPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
          />
        </View>

        {/* 资产列表 */}
        {list.length ? (
          <View style={styles.listCard}>
            {list.map((tk, i) => (
              <View key={`${tk.contract}-${tk.symbol}`}>
                {i > 0 ? <View style={styles.sep} /> : null}
                <View style={styles.row}>
                  <TokenBadge symbol={tk.symbol} color={tokenColor(tk.symbol)} size={42} contract={tk.contract} />
                  <View style={{ flex: 1, marginLeft: 13 }}>
                    <Text style={styles.sym}>{tk.symbol}</Text>
                    <Text style={styles.contract}>{tk.contract}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.amt}>{mask(fmtAmount(tk.amount, tk.precision))}</Text>
                    <Text style={styles.fiat}>{mask(priceIn(w.prices, tk.contract, tk.symbol) > 0 ? fmtUSD(tk.amount * priceIn(w.prices, tk.contract, tk.symbol)) : '—')}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.empty}>
            <Ionicons name="albums-outline" size={54} color="#DCDFE5" />
            <Text style={styles.emptyTxt}>{t('totalAsset.noMatch')}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  blueCard: {
    backgroundColor: '#2A7FFF',
    marginHorizontal: spacing.md,
    borderRadius: 10,
    padding: 20,
    minHeight: 150,
    justifyContent: 'center',
  },
  blueTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  blueLabel: { color: 'rgba(255,255,255,0.88)', fontSize: 14 },
  blueValue: { color: '#fff', fontSize: 34, fontWeight: '800', marginTop: 10, letterSpacing: -0.5 },
  blueFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  netTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  netDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#7CF5B0' },
  netTxt: { color: '#fff', fontSize: 12 },
  acctTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 13.5 },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    marginHorizontal: spacing.md,
    marginTop: 12,
    height: 52,
    borderRadius: 10,
    paddingHorizontal: 18,
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.text, padding: 0, outlineStyle: 'none' as any },

  listCard: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.md,
    marginTop: 12,
    borderRadius: 10,
    paddingHorizontal: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 55 },
  sym: { fontSize: 16, color: colors.text },
  contract: { fontSize: 12.5, color: colors.textFaint, marginTop: 3 },
  amt: { fontSize: 16, color: colors.text },
  fiat: { fontSize: 12.5, color: colors.textSub, marginTop: 3 },

  empty: { alignItems: 'center', paddingVertical: 90, gap: 14 },
  emptyTxt: { fontSize: 14, color: colors.textFaint },
});
