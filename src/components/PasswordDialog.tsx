import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import CenterDialog from './CenterDialog';
import { colors } from '../theme';
import { useI18n } from '../i18n';

/**
 * 主密码确认弹窗 —— 参考 TP:需要密码的动作不把输入框摊在整页上,而是点了主按钮
 * 之后弹一个小对话框当场输一次,确认完就消失。
 *
 * 样式沿用 ConfirmTxSheet 里那个签名密码弹窗(同一套视觉),但这个是独立组件,
 * 给"不涉及交易签名、只是要解锁/校验一次密码"的场景用。
 *
 * 密码只活在这个组件的内部 state 里,关闭时立刻清空,不回传给宿主页面保存。
 */
export default function PasswordDialog({
  visible,
  title,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const { t } = useI18n();
  const [pwd, setPwd] = useState('');

  // 每次关闭都把密码丢掉,不要让它跨着两次打开留在内存里
  useEffect(() => {
    if (!visible) setPwd('');
  }, [visible]);

  const ready = pwd.length >= 8 && !busy;
  const close = () => {
    if (busy) return;
    onClose();
  };

  return (
    <CenterDialog visible={visible} onClose={close} closeOnBackdrop={!busy} backdropColor="rgba(0,0,0,0.5)">
      <View style={styles.dialog}>
        <View style={styles.head}>
          <TouchableOpacity hitSlop={8} disabled={busy} onPress={close}>
            <Ionicons name="close" size={20} color={busy ? colors.textFaint : colors.textSub} />
          </TouchableOpacity>
          <Text style={styles.title}>{title}</Text>
          <View style={{ width: 20 }} />
        </View>

        <TextInput
          value={pwd}
          onChangeText={setPwd}
          placeholder={t('masterPwdCard.enterPlaceholder')}
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          secureTextEntry
          autoCapitalize="none"
          editable={!busy}
          autoFocus
          onSubmitEditing={() => ready && onSubmit(pwd)}
        />

        {error ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={16} color="#F0644E" />
            <Text style={styles.errTxt}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.cta, !ready && styles.ctaOff]}
          disabled={!ready}
          onPress={() => onSubmit(pwd)}
          activeOpacity={0.85}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>{t('confirmTx.confirm')}</Text>}
        </TouchableOpacity>
      </View>
    </CenterDialog>
  );
}

const styles = StyleSheet.create({
  dialog: { width: '100%', maxWidth: 320, backgroundColor: colors.white, borderRadius: 16, padding: 20 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { fontSize: 16.5, fontWeight: '700', color: colors.text },
  input: {
    backgroundColor: '#F5F7FA',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    color: colors.text,
    marginBottom: 14,
  },
  errBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    backgroundColor: '#FEF0EE',
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
  },
  errTxt: { flex: 1, fontSize: 12.5, color: '#F0644E', lineHeight: 18 },
  cta: { backgroundColor: '#1E88FF', height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.45 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
