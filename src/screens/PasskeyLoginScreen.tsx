import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWalletSession } from '../chain/WalletContext';
import { addWallet, newWalletId } from '../crypto/vault';
import { platformPasskeyAuthOptions, platformPasskeyAuthVerify } from '../passkey/eos3Api';
import { getPasskey, PasskeyCancelledError } from '../passkey/nativePasskey';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

export default function PasskeyLoginScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const w = useWalletSession();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setErr(null);
    try {
      const options = await platformPasskeyAuthOptions();
      const assertion = await getPasskey(options);
      const result = await platformPasskeyAuthVerify(assertion);

      if (!result.hasWallet || !result.wallet.eosAccount) {
        throw new Error(t('passkeyLogin.noWalletLinked'));
      }

      await addWallet({
        id: newWalletId(),
        account: result.wallet.eosAccount,
        publicKey: result.wallet.chainPublicKey,
        credentialIdHex: result.wallet.credentialIdHex,
        createdAt: Date.now(),
        source: 'passkey',
        chainId: w.chainId,
      });
      await w.reloadWallets();
      w.setAccount(result.wallet.eosAccount);

      // reloadWallets() 会令 RootNavigator 从“无钱包”栈重挂为“有钱包”栈。
      // 不能把跳首页留给 Alert 的按钮回调：那时回调可能仍指向旧栈，
      // 用户就会看到“登录成功”却仍停在本页。先重置栈，再在首页上方显示提示。
      nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      Alert.alert(t('passkeyLogin.loginSuccessTitle'), t('passkeyLogin.loginSuccessBody', { account: result.wallet.eosAccount }));
    } catch (e: any) {
      if (e instanceof PasskeyCancelledError) {
        // 用户自己取消的,不算错误,静默返回
        return;
      }
      setErr(e?.message ?? t('passkeyLogin.loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t('passkeyLogin.title')} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={styles.iconWrap}>
          <Ionicons name="finger-print" size={56} color={BLUE} />
        </View>

        <Text style={styles.title}>{t('passkeyLogin.heroTitle')}</Text>
        <Text style={styles.desc}>{t('passkeyLogin.heroDesc')}</Text>

        <View style={styles.noteCard}>
          <Ionicons name="information-circle-outline" size={18} color={colors.textSub} />
          <Text style={styles.noteTxt}>{t('passkeyLogin.noteText')}</Text>
        </View>

        {err ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color="#F0644E" />
            <Text style={styles.errBoxTxt}>{err}</Text>
          </View>
        ) : null}

        <TouchableOpacity style={[styles.submit, busy && styles.submitOff]} disabled={busy} activeOpacity={0.85} onPress={login}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitTxt}>{t('passkeyLogin.submit')}</Text>}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  iconWrap: { alignItems: 'center', marginTop: 12, marginBottom: 20 },

  title: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 12 },
  desc: { fontSize: 13.5, color: colors.textSub, lineHeight: 21, textAlign: 'center', marginBottom: 16 },

  noteCard: { flexDirection: 'row', gap: 8, backgroundColor: colors.white, borderRadius: 10, padding: 14, marginBottom: 16 },
  noteTxt: { flex: 1, fontSize: 12.5, color: colors.textSub, lineHeight: 19 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginBottom: 12 },
  errBoxTxt: { flex: 1, fontSize: 13, color: '#F0644E', lineHeight: 19 },

  submit: { backgroundColor: BLUE, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  submitOff: { opacity: 0.6 },
  submitTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
