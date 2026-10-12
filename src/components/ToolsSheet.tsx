import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import { useI18n } from '../i18n';

const W = Dimensions.get('window').width;

type Tool = { key: string; label: string; icon: string };

export default function ToolsSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (key: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  // 转账/收款/资源首页已经有快捷入口了,这里不重复放。权限管理换到这里来。
  const QUICK: Tool[] = [{ key: 'permission', label: t('wallet.permission'), icon: 'shield-key-outline' }];

  const renderGrid = (items: Tool[]) => (
    <View style={styles.grid}>
      {items.map((t) => (
        <TouchableOpacity
          key={t.key}
          style={styles.tool}
          activeOpacity={0.6}
          onPress={() => {
            onClose();
            onPick(t.key);
          }}
        >
          <MaterialCommunityIcons name={t.icon as any} size={24} color={colors.text} />
          <Text style={styles.toolTxt} numberOfLines={1}>
            {t.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{t('tools.title')}</Text>
          <TouchableOpacity hitSlop={8} onPress={onClose} style={{ width: 30, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
          {renderGrid(QUICK)}
        </ScrollView>
      </View>
    </BottomSheet>
  );
}

const GAP = 10;
const ITEM = (W - spacing.lg * 2 - GAP * 3) / 4;

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '76%',
    paddingHorizontal: spacing.lg,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 56 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '600', color: colors.text },

  section: { fontSize: 17, color: colors.text, marginTop: 22, marginBottom: 12 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  tool: {
    width: ITEM,
    height: 78,
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 4,
  },
  toolTxt: { fontSize: 12, color: colors.text },
});
