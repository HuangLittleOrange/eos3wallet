import React, { useRef, useState } from 'react';
import { Alert, View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Name } from '@wharfkit/antelope';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWalletSession } from '../chain/WalletContext';
import { legacyLabel } from '../chain/config';
import { addWallet, newWalletId } from '../crypto/vault';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

const canonicalAccount = (s: string) => {
  const trimmed = s.trim();
  if (!/^[a-z1-5.]{1,12}$/.test(trimmed)) return '';
  // Antelope ignores trailing dots; an all-dot name is the zero/empty name.
  return String(Name.from(trimmed));
};

/** 观察钱包 —— 只读, 不涉及任何密钥/主密码, 拆自原 ImportScreen 的 watch 分支 */
export default function ImportWatchScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const w = useWalletSession();
  const { t } = useI18n();
  const [accountName, setAccountName] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const account = canonicalAccount(accountName);
  const ready = !!account && !saving;

  const watchOnly = async () => {
    if (!account || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // 会话只记当前账户；观察钱包也必须写入索引，切换后才能继续保留。
      // 仅保存账户元数据，不创建私钥或主密码；重复导入由 addWallet 合并。
      await addWallet({ id: newWalletId(), account, chainId: w.chainId,
        publicKey: '', source: 'watch', createdAt: Date.now() });
      await w.reloadWallets();
      w.setAccount(account);
      // 导入完成后移除表单，避免返回键再次进入已完成的流程。
      nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    } catch (e: any) {
      Alert.alert(t('importSecret.saveFailed'), e?.message ?? t('send.unknownError'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t('importWatch.title')} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={styles.netCard}>
          <View style={styles.netDot} />
          <Text style={styles.netTxt}>
            {w.client.config.name} · {legacyLabel(w.chainId)}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>{t('importWatch.accountLabel')}</Text>
          <TextInput
            value={accountName}
            onChangeText={(v) => setAccountName(v.toLowerCase())}
            placeholder={t('importWatch.accountPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCapitalize="none"
            editable={!saving}
            maxLength={12}
          />
          <Text style={styles.hint}>{t('importWatch.hint')}</Text>
        </View>

        <TouchableOpacity
          style={[styles.submit, !ready && styles.submitOff]}
          disabled={!ready}
          activeOpacity={0.85}
          onPress={watchOnly}
        >
          <Text style={styles.submitTxt}>{t('importWatch.submit')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  netCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.white,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    marginBottom: spacing.lg,
  },
  netDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#12A566' },
  netTxt: { fontSize: 13.5, fontWeight: '700', color: colors.text },

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 12 },
  label: { fontSize: 14.5, color: colors.textSub, fontWeight: '600' },
  input: { fontSize: 15.5, color: colors.text, padding: 0, marginTop: 12, outlineStyle: 'none' as any },
  hint: { fontSize: 12, color: colors.textFaint, marginTop: 12, lineHeight: 18 },

  submit: { backgroundColor: BLUE, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  submitOff: { backgroundColor: '#A9C9F5' },
  submitTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
