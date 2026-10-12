import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { CHAINS } from '../chain/config';
import { fmtDateTime } from '../chain/format';
import { LinkSession, listLinkSessions, revokeLinkSession } from '../dapp/linkSessions';
import { useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * 单个 Link 会话的详情——参考 TP 的连接详情页(状态 + 选择钱包 + 连接网络 +
 * 断开连接按钮)。跟 PermissionScreen/PermissionDetailScreen 分工一致:
 * 列表页(LinkSessionsScreen)只展示 + 进详情,真正"断开"这个动作放这里。
 *
 * 这里的"断开"是纯本地操作——删掉本机这份清单里的一条记录就完事,不像
 * PermissionDetailScreen 那个 revoke 需要上链交易(那是链上的 paylimit
 * 权限,这个只是本机的一份"认不认这个发送方"白名单),不需要签名/广播,
 * 也就不需要 ConfirmTxSheet 那一套。
 */
export default function LinkSessionDetailScreen() {
  const nav = useNavigation<Nav>();
  const route = useRoute<RouteProp<RootStackParamList, 'LinkSessionDetail'>>();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [session, setSession] = useState<LinkSession | null | undefined>(undefined);

  const load = useCallback(() => {
    listLinkSessions().then((list) => setSession(list.find((s) => s.requestKey === route.params.requestKey) ?? null));
  }, [route.params.requestKey]);

  useFocusEffect(load);

  // 断开之后这条记录已经不存在了,详情页留在原地没有意义——自动退回列表页
  if (session === null) {
    nav.goBack();
    return null;
  }
  if (!session) return <View style={styles.root} />;

  const chainName = CHAINS[session.chainId]?.name ?? session.chainId;

  const disconnect = () => {
    Alert.alert(t('linkSessions.revokeTitle'), t('linkSessions.revokeBody', { name: session.name || t('linkSessions.unnamedApp') }), [
      { text: t('dappTabs.cancel'), style: 'cancel' },
      {
        text: t('linkSessions.revoke'),
        style: 'destructive',
        onPress: async () => {
          await revokeLinkSession(session.requestKey);
          nav.goBack();
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t('linkSessions.detailTitle')} />

      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <MaterialCommunityIcons name="link-variant" size={30} color="#1E88FF" />
        </View>
        <Text style={styles.heroName}>{session.name || t('linkSessions.unnamedApp')}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('linkSessions.statusLabel')}</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.statusDot} />
            <Text style={styles.rowMain}>{t('linkSessions.connected')}</Text>
            <Text style={styles.rowSub}>{fmtDateTime(session.createdAt)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('linkSessions.accountLabel')}</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowMain}>{session.account}</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('linkSessions.networkLabel')}</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowMain}>{chainName}</Text>
          </View>
        </View>
      </View>

      <View style={{ flex: 1 }} />

      <TouchableOpacity
        style={[styles.disconnectBtn, { marginBottom: insets.bottom + spacing.lg }]}
        activeOpacity={0.85}
        onPress={disconnect}
      >
        <Ionicons name="unlink-outline" size={18} color="#fff" />
        <Text style={styles.disconnectTxt}>{t('linkSessions.revoke')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  hero: { alignItems: 'center', paddingVertical: 24 },
  heroIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EAF1FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroName: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 12, textAlign: 'center', paddingHorizontal: 32 },

  section: { paddingHorizontal: spacing.lg, marginBottom: 16 },
  sectionLabel: { fontSize: 12.5, color: colors.textFaint, marginBottom: 6, marginLeft: 4 },
  card: { backgroundColor: colors.white, borderRadius: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 52, paddingHorizontal: 14 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#12A566' },
  rowMain: { flex: 1, fontSize: 15, color: colors.text, fontWeight: '600' },
  rowSub: { fontSize: 12.5, color: colors.textFaint },

  disconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#F0644E',
    marginHorizontal: spacing.lg,
  },
  disconnectTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
