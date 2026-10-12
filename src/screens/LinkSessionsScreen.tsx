import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { fmtDateTime } from '../chain/format';
import { LinkSession, listLinkSessions } from '../dapp/linkSessions';
import { useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * 已经建立过 Anchor Link 持久会话的 dApp 列表——参考 TP 的"连接管理"页:
 * 列表只负责展示 + 进详情,断开连接这个动作挪到详情页去做(见
 * LinkSessionDetailScreen),跟 PermissionScreen/PermissionDetailScreen 那一对
 * 是同一个分工。底部常驻"扫描新连接",对应 TP 列表页那颗同位置的按钮——
 * 复用已有的扫码页,ESR 类型的二维码本来就会走确认签名弹窗那套流程。
 */
export default function LinkSessionsScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<LinkSession[] | null>(null);

  const load = useCallback(() => {
    listLinkSessions().then((list) => setSessions([...list].sort((a, b) => b.createdAt - a.createdAt)));
  }, []);

  useFocusEffect(load);

  return (
    <View style={styles.root}>
      <PageHeader title={t('linkSessions.title')} />
      {sessions && sessions.length === 0 ? (
        <View style={styles.empty}>
          <MaterialCommunityIcons name="link-variant-off" size={40} color={colors.textFaint} />
          <Text style={styles.emptyTxt}>{t('linkSessions.empty')}</Text>
        </View>
      ) : (
        <FlatList
          data={sessions ?? []}
          keyExtractor={(s) => s.requestKey}
          contentContainerStyle={{ padding: spacing.lg, gap: 10 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.7}
              onPress={() => nav.navigate('LinkSessionDetail', { requestKey: item.requestKey })}
            >
              <View style={styles.cardIcon}>
                <MaterialCommunityIcons name="link-variant" size={20} color="#1E88FF" />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name || t('linkSessions.unnamedApp')}
                </Text>
                <View style={styles.metaRow}>
                  <View style={styles.dot} />
                  <Text style={styles.meta} numberOfLines={1}>
                    {t('linkSessions.metaLine', { account: item.account, time: fmtDateTime(item.createdAt) })}
                  </Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          )}
        />
      )}

      <View style={[styles.scanBar, { paddingBottom: insets.bottom + spacing.lg }]}>
        <TouchableOpacity style={styles.scanBtn} activeOpacity={0.85} onPress={() => nav.navigate('Scan')}>
          <Ionicons name="scan-outline" size={19} color="#fff" />
          <Text style={styles.scanBtnTxt}>{t('linkSessions.scanNew')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40 },
  emptyTxt: { fontSize: 13.5, color: colors.textFaint, textAlign: 'center', lineHeight: 20 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: 12,
    padding: 14,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#EAF1FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 15.5, fontWeight: '600', color: colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#12A566' },
  meta: { flex: 1, fontSize: 12.5, color: colors.textFaint },

  scanBar: { padding: spacing.lg, paddingTop: 0 },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#1E88FF',
  },
  scanBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
