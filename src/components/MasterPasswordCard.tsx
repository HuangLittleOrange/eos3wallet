import React from 'react';
import { View, Text, StyleSheet, TextInput } from 'react-native';

import { colors } from '../theme';
import { useI18n } from '../i18n';

/**
 * 主密码卡片 —— 纯受控展示。
 *
 * hasPwd=false(设置态)只在 SetMasterPasswordScreen 用到 —— 那是唯一一个
 * "本机还没设置过主密码"时才会被导航到的独立页面,能到这个分支说明确定
 * 还没设过,不需要再查一遍。
 *
 * hasPwd=true(验证态)给 ImportSecretScreen/CreateAccountPayScreen 这类"业务页"
 * 用 —— 这两个页面能进来,说明入口处的 useFocusEffect 网关已经确认过主密码
 * 存在,这里只负责"每次现场验证一遍",不缓存,不需要再判断状态。
 */
type Props = {
  hasPwd: boolean;
  pwd: string;
  onChangePwd: (s: string) => void;
  /** 仅 hasPwd === false(首次设置)时用到 */
  pwd2?: string;
  onChangePwd2?: (s: string) => void;
};

export default function MasterPasswordCard({ hasPwd, pwd, onChangePwd, pwd2 = '', onChangePwd2 }: Props) {
  const { t } = useI18n();
  if (!hasPwd) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>{t('masterPwdCard.setTitle')}</Text>
        <TextInput
          value={pwd}
          onChangeText={onChangePwd}
          placeholder={t('masterPwdCard.minLength')}
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          secureTextEntry
          autoCapitalize="none"
        />
        <View style={styles.sep} />
        <TextInput
          value={pwd2}
          onChangeText={onChangePwd2}
          placeholder={t('masterPwdCard.retype')}
          placeholderTextColor={colors.textFaint}
          style={[styles.input, { marginTop: 12 }]}
          secureTextEntry
          autoCapitalize="none"
        />
        {pwd2.length > 0 && pwd !== pwd2 ? <Text style={styles.err}>{t('masterPwdCard.mismatch')}</Text> : null}
        <Text style={styles.hint}>{t('masterPwdCard.setHint')}</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{t('masterPwdCard.title')}</Text>
      <TextInput
        value={pwd}
        onChangeText={onChangePwd}
        placeholder={t('masterPwdCard.enterPlaceholder')}
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        secureTextEntry
        autoCapitalize="none"
      />
      <Text style={styles.hint}>{t('masterPwdCard.verifyHint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 12 },
  label: { fontSize: 14.5, color: colors.textSub, fontWeight: '600' },
  input: { fontSize: 15.5, color: colors.text, padding: 0, marginTop: 12, outlineStyle: 'none' as any },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3', marginTop: 12 },
  hint: { fontSize: 12, color: colors.textFaint, marginTop: 12, lineHeight: 18 },
  err: { fontSize: 12.5, color: '#F04438', marginTop: 10 },
});
