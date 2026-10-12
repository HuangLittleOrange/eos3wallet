import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, shadow, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWallet } from '../chain/WalletContext';
import {
  AuthorizedApp,
  AuthorizedAppAsset,
  fetchAuthorizedApps,
  permissionDisplayAppType,
  permissionDisplayDevice,
  permissionKey,
  remainingAmount,
  todayRemainingAmount,
} from '../chain/permissions';
import { useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * "已授权应用"是 eos3.app 的 paylimit 合约那套机制 —— 给某个 Bot/DApp 一个受限
 * 权限(自定义 permission,而不是完整的 active),配单笔/每日/总预算上限。这个
 * 页面现在只是"列表页"(卡片样式,点进去看详情),真正的撤销/重置/改额度/
 * 加代币这些管理动作都挪到 PermissionDetailScreen 去做了。不做"新建授权"
 * (那是更大的一块,让 eostp 自己的 DApp 浏览器也走这套机制,这次先不做)。
 *
 * 下面那段普通 EOS 权限(owner/active/其它自定义 key)列表还留着 —— 那是
 * 链上原生权限结构的只读展示,跟这套 paylimit 机制是两回事,已经在的功能不动。
 */
export default function PermissionScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const w = useWallet();
  const { t } = useI18n();
  const perms = w.resources?.permissions ?? [];

  const [authorized, setAuthorized] = useState<AuthorizedApp[] | null>(null);
  const [authorizedErr, setAuthorizedErr] = useState<string | null>(null);
  const [loadingAuthorized, setLoadingAuthorized] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoadingAuthorized(true);
    setAuthorizedErr(null);
    fetchAuthorizedApps(w.account)
      .then((overview) => alive && setAuthorized(overview.permissions.filter((p) => p.managedByPayLimit)))
      .catch((e: any) => alive && setAuthorizedErr(e?.message ?? t('permission.queryFailed')))
      .finally(() => alive && setLoadingAuthorized(false));
    return () => {
      alive = false;
    };
  }, [w.account, t]);

  // 普通权限列表里,已经在"已授权应用"里展示过的权限名就不重复列了
  const managedNames = new Set((authorized ?? []).map((a) => a.permission));
  const otherPerms = perms.filter((p) => !managedNames.has(p.name));

  return (
    <View style={styles.root}>
      <PageHeader title={t('permission.title')} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
      >
        {/* 已授权应用(paylimit 受限权限)—— 卡片列表,点进去看详情/管理 */}
        <Text style={styles.sectionTitle}>{t('permission.authorizedApps')}</Text>
        <View style={styles.noteCard}>
          <Ionicons name="shield-checkmark-outline" size={16} color={colors.textSub} />
          <Text style={styles.noteTxt}>{t('permission.authorizedNote')}</Text>
        </View>

        {loadingAuthorized ? (
          <View style={styles.center}>
            <ActivityIndicator color="#1E88FF" />
          </View>
        ) : authorizedErr ? (
          <Text style={styles.empty}>{authorizedErr}</Text>
        ) : !authorized || authorized.length === 0 ? (
          <Text style={styles.empty}>{t('permission.noAuthorized')}</Text>
        ) : (
          authorized.map((app) => {
            const appType = permissionDisplayAppType(app, t);
            const deviceName = permissionDisplayDevice(app);
            const summaryAsset = pickSummaryAsset(app.assets);
            return (
              <TouchableOpacity
                key={permissionKey(app)}
                style={[styles.card, shadow.soft]}
                activeOpacity={0.7}
                onPress={() => nav.navigate('PermissionDetail', { permissionKey: permissionKey(app) })}
              >
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{appType}</Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                </View>
                <Text style={styles.cardBot}>{app.permission}</Text>
                <View style={styles.cardMeta}>
                  <Text style={styles.cardMetaTxt}>{deviceName ?? t('permission.unknownDevice')}</Text>
                  <Text style={styles.cardMetaTxt}>{t('permission.authorizedAssetCount', { count: app.assets.length })}</Text>
                </View>
                {summaryAsset ? (
                  <View style={styles.limits}>
                    <Text style={styles.limitAsset}>{summaryAsset.symbol}</Text>
                    <View style={styles.limitGrid}>
                      <View style={styles.limitCell}>
                        <Text style={styles.limitLabel}>{t('permission.todayRemainingLabel')}</Text>
                        <Text style={styles.limitValue}>{todayRemainingAmount(summaryAsset)}</Text>
                      </View>
                      <View style={styles.limitCell}>
                        <Text style={styles.limitLabel}>{t('permission.remainingTotalLimit')}</Text>
                        <Text style={styles.limitValue}>
                          {remainingAmount(summaryAsset.totalBudget, summaryAsset.totalSpent, summaryAsset.symbol, summaryAsset.precision)}
                        </Text>
                      </View>
                    </View>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })
        )}

        {/* 普通链上权限(owner/active/其它自定义 key)—— 只读展示 */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>{t('permission.accountPermissions')}</Text>
        <View style={styles.noteCard}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textSub} />
          <Text style={styles.noteTxt}>{t('permission.chainNote', { chain: w.client.config.name })}</Text>
        </View>

        {w.status === 'loading' && !perms.length ? (
          <View style={styles.center}>
            <ActivityIndicator color="#1E88FF" />
          </View>
        ) : otherPerms.length === 0 ? (
          <Text style={styles.empty}>{t('permission.noAccountPermInfo')}</Text>
        ) : (
          otherPerms.map((p) => (
            <View key={p.name} style={styles.card}>
              <View style={styles.head}>
                <Text style={styles.name}>{p.name}</Text>
                <Text style={styles.parent}>{t('permission.parentPermission', { parent: p.parent || '—' })}</Text>
              </View>
              <View style={styles.sep} />
              {p.keys.length === 0 ? (
                <Text style={styles.keyEmpty}>{t('permission.noPublicKey')}</Text>
              ) : (
                p.keys.map((k) => (
                  <Text key={k} style={styles.key} selectable numberOfLines={1}>
                    {k}
                  </Text>
                ))
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

/** 卡片摘要只展示一个代币的额度——优先展示 A(主币),没有就取第一个 */
function pickSummaryAsset(assets: AuthorizedAppAsset[]): AuthorizedAppAsset | undefined {
  if (assets.length === 0) return undefined;
  return [...assets].sort((left, right) => {
    if (left.symbol === 'A' && right.symbol !== 'A') return -1;
    if (right.symbol === 'A' && left.symbol !== 'A') return 1;
    return left.symbol.localeCompare(right.symbol);
  })[0];
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },
  scroll: { padding: spacing.md },

  sectionTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 10 },
  noteCard: { flexDirection: 'row', gap: 8, backgroundColor: colors.white, borderRadius: 10, padding: 14, marginBottom: 14 },
  noteTxt: { flex: 1, fontSize: 12.5, color: colors.textSub, lineHeight: 19 },

  center: { paddingVertical: 40, alignItems: 'center' },
  empty: { textAlign: 'center', color: colors.textFaint, fontSize: 14, paddingVertical: 24 },

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  name: { fontSize: 16, fontWeight: '700', color: colors.text },
  parent: { fontSize: 12.5, color: colors.textFaint },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginVertical: 10 },
  key: { fontSize: 12.5, color: colors.textSub, marginTop: 4 },
  keyEmpty: { fontSize: 12.5, color: colors.textFaint },

  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  cardBot: { fontSize: 13, color: colors.textSub, marginTop: 3 },
  cardMeta: { flexDirection: 'row', gap: 10, marginTop: 6 },
  cardMetaTxt: { fontSize: 12, color: colors.textFaint },

  limits: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10 },
  limitAsset: { fontSize: 12.5, fontWeight: '600', color: colors.text },
  limitGrid: { flexDirection: 'row', gap: 16, marginTop: 6 },
  limitCell: { flex: 1 },
  limitLabel: { fontSize: 11.5, color: colors.textSub },
  limitValue: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 2 },
});
