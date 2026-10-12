import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import { useWalletSession } from '../chain/WalletContext';
import { addWallet, newWalletId } from '../crypto/vault';
import { googleOAuthStartUrl, platformPasskeyRegisterOptions, platformPasskeyRegisterVerify } from '../passkey/eos3Api';
import { createPasskey, PasskeyCancelledError } from '../passkey/nativePasskey';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';
// 跳系统浏览器走 Google 登录后要回到 App 的地址 —— 对应 app.json 里的 "scheme": "aurorawallet"
const OAUTH_RETURN_URL = 'aurorawallet://passkey-create';

/**
 * Google 一键开户(Passkey)—— 参考 eos3.app 项目自己的开户方案:
 * Google 登录建立会话 → 现场注册一把 Passkey → 后端(理想情况下)顺手把链上账户建好。
 *
 * 后端那边"注册顺手建账户"这部分还在补(见项目里的实现记录),这里按约定好的
 * 接口形状对接;如果 wallet.eosAccount 暂时还是空的,不会假装成功,会提示去
 * 「Passkey 登录」里重试,不让用户卡在一个不明确的中间态。
 *
 * 另外 OAuth 跳系统浏览器建立的会话 Cookie 能不能被这里的 fetch() 读到,
 * 只有真机测试才知道——如果验证/开户请求报"未登录"一类的错误,大概率就是
 * 这层 Cookie 没共享上,需要后端改成把一次性 token 拼进跳转地址里再显式带上。
 */
export default function PasskeyCreateScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const w = useWalletSession();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      setStep(t('passkeyCreate.openingGoogle'));
      const result = await WebBrowser.openAuthSessionAsync(googleOAuthStartUrl(OAUTH_RETURN_URL), OAUTH_RETURN_URL);
      if (result.type !== 'success') {
        // 用户自己关掉了浏览器,静默返回,不算错误
        return;
      }

      setStep(t('passkeyCreate.registeringPasskey'));
      const options = await platformPasskeyRegisterOptions();
      const attestation = await createPasskey(options);

      setStep(t('passkeyCreate.creatingAccount'));
      const res = await platformPasskeyRegisterVerify(attestation);

      if (!res.hasWallet || !res.wallet.eosAccount) {
        Alert.alert(t('passkeyCreate.pendingTitle'), t('passkeyCreate.pendingBody'));
        return;
      }

      await addWallet({
        id: newWalletId(),
        account: res.wallet.eosAccount,
        publicKey: res.wallet.chainPublicKey,
        credentialIdHex: res.wallet.credentialIdHex,
        createdAt: Date.now(),
        source: 'passkey',
        chainId: w.chainId,
      });
      await w.reloadWallets();
      w.setAccount(res.wallet.eosAccount);

      // 新增钱包会让 RootNavigator 切换到“有钱包”栈。先重置到主页，
      // 不依赖 Alert 关闭时仍可能已经失效的旧导航对象。
      nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      Alert.alert(t('passkeyCreate.successTitle'), t('passkeyCreate.successBody', { account: res.wallet.eosAccount }));
    } catch (e: any) {
      if (e instanceof PasskeyCancelledError) return;
      setErr(e?.message ?? t('passkeyCreate.createFailed'));
    } finally {
      setBusy(false);
      setStep('');
    }
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t('passkeyCreate.title')} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={styles.iconWrap}>
          <Ionicons name="logo-google" size={48} color={BLUE} />
        </View>

        <Text style={styles.title}>{t('passkeyCreate.heroTitle')}</Text>
        <Text style={styles.desc}>{t('passkeyCreate.heroDesc')}</Text>

        <View style={styles.noteCard}>
          <Ionicons name="information-circle-outline" size={18} color={colors.textSub} />
          <Text style={styles.noteTxt}>{t('passkeyCreate.noteText')}</Text>
        </View>

        {err ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color="#F0644E" />
            <Text style={styles.errBoxTxt}>{err}</Text>
          </View>
        ) : null}

        <TouchableOpacity style={[styles.submit, busy && styles.submitOff]} disabled={busy} activeOpacity={0.85} onPress={start}>
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.submitTxt}>{step || t('passkeyCreate.processing')}</Text>
            </View>
          ) : (
            <Text style={styles.submitTxt}>{t('passkeyCreate.submit')}</Text>
          )}
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

  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  submit: { backgroundColor: BLUE, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  submitOff: { opacity: 0.6 },
  submitTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
