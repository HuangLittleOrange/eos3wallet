import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

import { colors, spacing, BRAND_NAME } from '../theme';
import { useI18n } from '../i18n';
import { useFocusedAppContent } from '../content/useFocusedAppContent';
import { localizedText, visibleItems } from '../content/types';
import AppUpdateSheet from '../components/AppUpdateSheet';
import { AppRelease, AppUpdateError, canCheckUpdates, checkForUpdate, currentAppVersion } from '../update/appUpdate';

type Item = {
  icon: string;
  /** 默认 MaterialCommunityIcons;品牌图标(如 Telegram)MCI 没有,走 FontAwesome */
  lib?: 'mc' | 'fa';
  id?: string;
  label?: string;
  labelKey?: 'me.security' | 'me.language' | 'me.checkUpdate';
  route?: string;
  url?: string;
  /** 点了不跳页、原地做事的行(目前只有检查更新) */
  action?: 'checkUpdate';
};

// 分组结构对齐 TP:灰底 + 多张白卡,卡内行以细分隔线分开
const GROUPS: Item[][] = [
  [
    { icon: 'shield-plus-outline', labelKey: 'me.security', route: 'Security' },
  ],
  [
    { icon: 'translate', labelKey: 'me.language', route: 'Language' },
    // Android 可下载安装包；iOS 打开后台配置的安装或商店页面。
    ...(canCheckUpdates ? [{ icon: 'cellphone-arrow-down', labelKey: 'me.checkUpdate', action: 'checkUpdate' } as Item] : []),
  ],
];

export default function MeScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { t, locale } = useI18n();
  const { content } = useFocusedAppContent();
  // 条款页面尚未上线，暂时隐藏入口，远程内容和旧缓存也不能重新显示它。
  const links: Item[] = visibleItems(content.links).filter((link) => link.id !== 'terms').map((link) => ({
    id: link.id,
    icon: link.id === 'telegram' ? 'telegram' : link.id === 'support' ? 'lifebuoy' : 'open-in-new',
    lib: link.id === 'telegram' ? 'fa' : 'mc',
    label: localizedText(link.title, locale),
    url: link.url,
  }));
  const groups = links.length ? [...GROUPS, links] : GROUPS;
  const [checking, setChecking] = useState(false);
  const [release, setRelease] = useState<AppRelease | null>(null);

  const checkUpdate = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const found = await checkForUpdate();
      if (found) setRelease(found);
      else Alert.alert(t('update.upToDateTitle'), t('update.upToDateBody', { version: currentAppVersion() }));
    } catch (e) {
      Alert.alert(
        t('update.checkFailedTitle'),
        e instanceof AppUpdateError && e.code === 'insecure-url' ? t('update.insecureUrl') : t('update.checkFailedBody')
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* 消息中心整体暂不上线(产品决定):这里不放铃铛入口。相应地,底部 Tab
          上的未读红点也一并隐藏(见 RootNavigator)——没有入口就没人能把红点
          "看掉",挂着只会误导。恢复上线时把两处一起打开即可。 */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('me.title')}</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {groups.map((group, gi) => (
          <View key={gi} style={styles.card}>
            {group.map((it, idx) => (
              <TouchableOpacity
                key={it.id ?? it.labelKey}
                style={styles.row}
                activeOpacity={0.6}
                onPress={() => {
                  if (it.action === 'checkUpdate') checkUpdate();
                  else if (it.url) Linking.openURL(it.url);
                  else if (it.route) nav.navigate(it.route as never);
                }}
              >
                {it.lib === 'fa' ? (
                  <FontAwesome name={it.icon as any} size={22} color={colors.text} />
                ) : (
                  <MaterialCommunityIcons name={it.icon as any} size={22} color={colors.text} />
                )}
                <Text style={styles.rowLabel} numberOfLines={2}>{it.label ?? (it.labelKey ? t(it.labelKey) : '')}</Text>
                {it.action === 'checkUpdate' ? (
                  checking ? (
                    <ActivityIndicator size="small" color={colors.textSub} />
                  ) : (
                    <Text style={styles.rowValue}>v{currentAppVersion()}</Text>
                  )
                ) : null}
                <Ionicons name={it.url ? 'open-outline' : 'chevron-forward'} size={18} color={colors.textFaint} />
                {idx < group.length - 1 ? <View style={styles.sep} /> : null}
              </TouchableOpacity>
            ))}
          </View>
        ))}
        <Text style={styles.version}>
          {BRAND_NAME} v{currentAppVersion()}
        </Text>
      </ScrollView>

      <AppUpdateSheet release={release} onClose={() => setRelease(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingHorizontal: spacing.lg,
  },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600', color: colors.text },

  scroll: { padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: 32, gap: 12 },

  card: { backgroundColor: colors.white, borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 56,
    gap: 14,
  },
  rowLabel: { flex: 1, fontSize: 15.5, color: colors.text },
  rowValue: { fontSize: 14, color: colors.textSub },
  sep: {
    position: 'absolute',
    left: 52,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#EBECEF',
  },

  version: { textAlign: 'center', color: colors.textFaint, fontSize: 12, marginTop: 8 },
});
