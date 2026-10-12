import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { TokenBalance } from '../chain/client';
import { fmtUSD, fmtAmount, tokenColor } from '../chain/format';
import { priceIn } from '../chain/prices';
import TokenBadge from '../components/TokenBadge';
import { useI18n } from '../i18n';

export default function TokenPickerSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (t: TokenBalance) => void;
}) {
  const insets = useSafeAreaInsets();
  const w = useWallet();
  const { t } = useI18n();
  const tokens = w.tokens;
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    if (!q.trim()) return tokens;
    const s = q.trim().toLowerCase();
    return tokens.filter((t) => t.symbol.toLowerCase().includes(s) || t.contract.includes(s));
  }, [q, tokens]);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{t('tokenPicker.title')}</Text>
          <TouchableOpacity hitSlop={8} onPress={onClose} style={{ width: 30, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color={colors.textSub} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('tokenPicker.searchPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
            autoCapitalize="none"
          />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
          {list.map((t, i) => (
            <View key={`${t.contract}-${t.symbol}`}>
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.6}
                onPress={() => {
                  onClose();
                  onPick(t);
                }}
              >
                <TokenBadge symbol={t.symbol} color={tokenColor(t.symbol)} size={44} contract={t.contract} />
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <Text style={styles.sym}>{t.symbol}</Text>
                  <Text style={styles.price}>{priceIn(w.prices, t.contract, t.symbol) > 0 ? fmtUSD(priceIn(w.prices, t.contract, t.symbol)) : t.contract}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.amt}>{fmtAmount(t.amount, t.precision)}</Text>
                  <Text style={styles.fiat}>{priceIn(w.prices, t.contract, t.symbol) > 0 ? `≈ ${fmtUSD(t.amount * priceIn(w.prices, t.contract, t.symbol))}` : '—'}</Text>
                </View>
              </TouchableOpacity>
              <View style={styles.sep} />
            </View>
          ))}
          {list.length === 0 ? <Text style={styles.empty}>{t('tokenPicker.noMatch')}</Text> : null}
        </ScrollView>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    height: '62%',
    paddingHorizontal: spacing.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 58 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600', color: colors.text },

  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#F2F3F5',
    height: 48,
    borderRadius: 8,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  searchInput: { flex: 1, fontSize: 15.5, color: colors.text, padding: 0, outlineStyle: 'none' as any },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginLeft: 58 },
  sym: { fontSize: 16.5, color: colors.text },
  price: { fontSize: 13, color: colors.textSub, marginTop: 4 },
  amt: { fontSize: 16.5, color: colors.text },
  fiat: { fontSize: 13, color: colors.textSub, marginTop: 4 },

  empty: { textAlign: 'center', color: colors.textFaint, paddingVertical: 50, fontSize: 14 },
});
