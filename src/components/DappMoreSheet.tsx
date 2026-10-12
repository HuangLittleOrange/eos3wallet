import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import { useI18n } from '../i18n';

type Tool = {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  active?: boolean;
};

/**
 * DApp 浏览器右上角「更多」弹层 —— 对齐 TP 的功能面板:
 * 顶部是当前网站信息,中间一排工具宫格,底部是切换账户入口。
 */
export default function DappMoreSheet({
  visible,
  onClose,
  host,
  siteName,
  favorited,
  account,
  activeKey,
  onAction,
  onSwitchAccount,
}: {
  visible: boolean;
  onClose: () => void;
  host: string;
  /** 页面 <title>,拿不到时退回域名 */
  siteName?: string;
  favorited: boolean;
  account: string;
  /** 当前账户的链上公钥,截断后当地址副标题展示 */
  activeKey?: string;
  onAction: (key: string) => void;
  onSwitchAccount: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  const TOOLS: Tool[] = [
    { key: 'copy', label: t('dappMore.copyLink'), icon: 'link-variant' },
    { key: 'openBrowser', label: t('dappMore.openInBrowser'), icon: 'compass-outline' },
    { key: 'share', label: t('dappMore.share'), icon: 'share-variant-outline' },
    { key: 'favorite', label: favorited ? t('dappMore.unfavorite') : t('dappMore.favorite'), icon: favorited ? 'star' : 'star-outline', active: favorited },
    { key: 'details', label: t('dappMore.details'), icon: 'file-document-outline' },
    { key: 'translate', label: t('dappMore.translate'), icon: 'translate' },
    { key: 'clearCache', label: t('dappMore.clearCache'), icon: 'broom' },
  ];

  const act = (key: string) => {
    onClose();
    onAction(key);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} backdropColor="rgba(0,0,0,0.4)">
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.grabber} />

        <View style={styles.head}>
          <View style={styles.hostIcon}>
            <Ionicons name="globe-outline" size={20} color={colors.textSub} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.hostName} numberOfLines={1}>
              {siteName || host}
            </Text>
            <Text style={styles.hostSub} numberOfLines={1}>
              {t('dappMore.providedBy', { host })}
            </Text>
          </View>
          <TouchableOpacity hitSlop={8} style={styles.closeBtn} onPress={onClose}>
            <Ionicons name="close" size={18} color={colors.textSub} />
          </TouchableOpacity>
        </View>

        <View style={styles.grid}>
          {TOOLS.map((tool) => (
            <TouchableOpacity key={tool.key} style={styles.cell} activeOpacity={0.6} onPress={() => act(tool.key)}>
              <View style={[styles.cellIcon, tool.active && styles.cellIconActive]}>
                <MaterialCommunityIcons name={tool.icon} size={19} color={tool.active ? '#1E88FF' : colors.text} />
              </View>
              <Text style={styles.cellLabel} numberOfLines={2}>
                {tool.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.sectionLabel}>{t('dappMore.switchAccount')}</Text>
        <TouchableOpacity
          style={styles.acctRow}
          activeOpacity={0.6}
          onPress={() => {
            onClose();
            onSwitchAccount();
          }}
        >
          <View style={styles.acctAvatar}>
            <MaterialCommunityIcons name="wallet-outline" size={16} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.acctName} numberOfLines={1}>
              {account}
            </Text>
            {activeKey ? (
              <Text style={styles.acctKey} numberOfLines={1}>
                {activeKey.length > 18 ? `${activeKey.slice(0, 9)}...${activeKey.slice(-6)}` : activeKey}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const CELL_W = '20%';

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 10,
    paddingHorizontal: spacing.lg,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#E2E5EA', alignSelf: 'center', marginBottom: 14 },

  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  hostIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#F2F3F5', alignItems: 'center', justifyContent: 'center' },
  hostName: { fontSize: 16, fontWeight: '700', color: colors.text },
  hostSub: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
  closeBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#F2F3F5',
    alignItems: 'center',
    justifyContent: 'center',
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  cell: { width: CELL_W, alignItems: 'center', paddingVertical: 10 },
  cellIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#F5F6F8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellIconActive: { backgroundColor: '#EAF1FF' },
  cellLabel: { fontSize: 10.5, color: colors.text, marginTop: 6, textAlign: 'center', lineHeight: 13 },

  sectionLabel: { fontSize: 12.5, color: colors.textFaint, marginTop: 8, marginBottom: 8 },
  acctRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#F7F8FB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  acctAvatar: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#3B47D6', alignItems: 'center', justifyContent: 'center' },
  acctName: { fontSize: 14.5, color: colors.text, fontWeight: '500' },
  acctKey: { fontSize: 11.5, color: colors.textFaint, marginTop: 2 },
});
