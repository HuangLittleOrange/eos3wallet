import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { LOCALES, useI18n } from '../i18n';

const BLUE = '#1E88FF';

/**
 * 选中某一行只是改本地待选状态,点了顶部「保存」才真正 setLocale() 生效并退出——
 * 参考截图里 TP 的交互(点一下打勾会跳,但要点 Save 才真正切换语言),不是选中
 * 即生效,避免手滑碰到一行就把整个 App 语言切走。
 */
export default function LanguageScreen() {
  const nav = useNavigation();
  const { locale, setLocale, t } = useI18n();
  const [pending, setPending] = useState(locale);

  const save = () => {
    setLocale(pending);
    nav.goBack();
  };

  return (
    <View style={styles.root}>
      <PageHeader
        title={t('language.title')}
        right={
          <TouchableOpacity hitSlop={8} onPress={save}>
            <Text style={styles.saveTxt}>{t('language.save')}</Text>
          </TouchableOpacity>
        }
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        {LOCALES.map((l, i) => (
          <TouchableOpacity
            key={l.id}
            style={styles.row}
            activeOpacity={0.6}
            onPress={() => setPending(l.id)}
          >
            <Text style={styles.rowLabel}>{l.label}</Text>
            {pending === l.id ? <Ionicons name="checkmark" size={20} color={BLUE} /> : null}
            {i < LOCALES.length - 1 ? <View style={styles.sep} /> : null}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  saveTxt: { fontSize: 15.5, color: BLUE, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    height: 54,
  },
  rowLabel: { fontSize: 16, color: colors.text },
  sep: {
    position: 'absolute',
    left: spacing.lg,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#EBECEF',
  },
});
