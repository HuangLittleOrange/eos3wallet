import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sensitiveInputProps } from '../components/sensitiveInputProps';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert, AppState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import CenterDialog from '../components/CenterDialog';
import { useWalletSession } from '../chain/WalletContext';
import { biometricEnabled, loadSecret, loadSecretWithBiometric, removeWallet } from '../crypto/vault';
import { useScreenCaptureGuard } from '../components/useScreenCaptureGuard';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';
import { SecretClipboard } from '../crypto/secretClipboard';
import { shouldInvalidateBackground } from '../crypto/systemAuthentication';

type Nav = NativeStackNavigationProp<RootStackParamList>;
const BLUE = '#1E88FF';

// 钱包详情页 —— 对齐 TP:地址卡 + 导出私钥 + 底部删除钱包
// 资源管理 / 权限 已在钱包首页的工具区提供入口(见 WalletScreen.goTool),这里不再重复
export default function WalletDetailScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<Nav>();
  // 只读会话半边(链/账户/钱包/操作函数),不订阅余额/行情等实时数据——
  // 本页一个实时字段都不用,跟着每轮 refresh 的分批落位陪跑纯属浪费
  const w = useWalletSession();
  const { t } = useI18n();
  const wallet = w.currentWallet;
  const isPasskey = wallet?.source === 'passkey';

  const [copied, setCopied] = useState<'name' | 'addr' | null>(null);
  // 必须真的写进剪贴板——之前只显示"已复制"却什么都没复制,用户会拿着
  // 剪贴板里残留的旧内容当成账户名/公钥去粘贴
  const copy = async (which: 'name' | 'addr') => {
    const text = which === 'name' ? w.account : wallet?.publicKey;
    if (!text) return;
    await Clipboard.setStringAsync(text).catch(() => {});
    setCopied(which);
    setTimeout(() => setCopied(null), 1400);
  };

  const [bioOn, setBioOn] = useState(false);
  useFocusEffect(useCallback(() => {
    let alive = true;
    setBioOn(false);
    if (wallet && wallet.source !== 'watch' && !isPasskey) biometricEnabled().then((v) => alive && setBioOn(v));
    return () => {
      alive = false;
    };
  }, [wallet, isPasskey]));

  // ---------- 导出私钥 ----------
  const [exportStep, setExportStep] = useState<'closed' | 'password' | 'reveal'>('closed');
  // 导出流程期间禁截屏——「最近任务」缩略图、恶意应用录屏都能把明文私钥带走
  const protectedScreen = useScreenCaptureGuard(exportStep !== 'closed', 'wallet-export');
  const exportGeneration = useRef(0);
  const exportOpen = useRef(false);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const revealedRef = useRef(secret);
  revealedRef.current = secret;
  const secretClipboard = useRef<SecretClipboard | null>(null);
  if (!secretClipboard.current) secretClipboard.current = new SecretClipboard(Clipboard);

  // 复制后不限时;退出导出或进入后台时只清理我们写入的那份内容,
  // 不会误删用户后来复制的其他内容。
  const writeSecretClipboard = async () => {
    if (!secret || !exportOpen.current || revealedRef.current !== secret || AppState.currentState !== 'active') return;
    const justCopied = secret;
    const generation = exportGeneration.current;
    const copied = await secretClipboard.current!.copy(justCopied, () =>
      generation === exportGeneration.current && exportOpen.current &&
      revealedRef.current === justCopied && AppState.currentState === 'active');
    if (!copied) return;
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 1400);
  };

  const openExport = () => {
    if (!wallet || wallet.source === 'watch') {
      Alert.alert(t('walletDetail.cannotExportTitle'), t('walletDetail.cannotExportWatchOnly'));
      return;
    }
    if (isPasskey) {
      Alert.alert(t('walletDetail.cannotExportTitle'), t('walletDetail.cannotExportPasskey'));
      return;
    }
    exportGeneration.current++;
    exportOpen.current = true;
    setPwd('');
    setErr(null);
    setExportStep('password');
  };

  const revealWithPassword = async () => {
    if (!wallet || !protectedScreen || busy) return;
    const generation = exportGeneration.current;
    setBusy(true);
    setErr(null);
    try {
      const revealed = await loadSecret(wallet.id, pwd);
      if (!exportOpen.current || generation !== exportGeneration.current || AppState.currentState !== 'active') return;
      setSecret(revealed);
      setPwd('');
      setExportStep('reveal');
    } catch (e: any) {
      setErr(e?.message ?? t('walletDetail.unlockFailed'));
    } finally {
      setBusy(false);
    }
  };

  const revealWithBiometric = async () => {
    if (!wallet || !protectedScreen || busy) return;
    const generation = exportGeneration.current;
    setBusy(true);
    setErr(null);
    try {
      const revealed = await loadSecretWithBiometric(wallet.id);
      if (!exportOpen.current || generation !== exportGeneration.current || AppState.currentState !== 'active') return;
      setSecret(revealed);
      setPwd('');
      setExportStep('reveal');
    } catch (e: any) {
      setErr(e?.message ?? t('walletDetail.verifyFailed'));
    } finally {
      setBusy(false);
    }
  };

  // 对齐 TokenPocket:开了生物识别的话,弹窗一出现就直接拉起系统认证框,
  // 不用用户自己再点一次「使用生物识别」——密码框还在,识别取消/失败了
  // 直接用密码就行,不是要点两次才能走生物识别这条路。
  useEffect(() => {
    if (exportStep === 'password' && bioOn && protectedScreen) revealWithBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportStep, protectedScreen]);

  const closeExport = () => {
    exportGeneration.current++;
    exportOpen.current = false;
    revealedRef.current = null;
    void secretClipboard.current?.clear();
    setExportStep('closed');
    setSecret(null);
    setSecretCopied(false);
    setPwd('');
    setErr(null);
  };

  useFocusEffect(useCallback(() => () => { closeExport(); }, [wallet?.id]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && (revealedRef.current !== null || shouldInvalidateBackground())) closeExport();
    });
    return () => sub.remove();
  }, []);

  // ---------- 删除钱包 ----------
  const [deleting, setDeleting] = useState(false);

  const doDelete = async () => {
    if (!wallet) return;
    setDeleting(true);
    try {
      await removeWallet(wallet.id);
      await w.reloadWallets();
      // reloadWallets 会选择剩余钱包,没有账户时资产标签页显示创建/导入引导。
      nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    } catch (e: any) {
      Alert.alert(t('walletDetail.deleteFailedTitle'), e?.message ?? t('send.unknownError'));
    } finally {
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (!wallet) return;
    Alert.alert(
      t('walletDetail.deleteWalletTitle'),
      t('walletDetail.deleteWalletBody', { account: wallet.account }),
      [
        { text: t('walletDetail.cancel'), style: 'cancel' },
        { text: t('walletDetail.confirmDelete'), style: 'destructive', onPress: doDelete },
      ]
    );
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t('walletDetail.title')} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
      >
        {/* 账户 + 地址 */}
        <View style={styles.card}>
          <TouchableOpacity style={styles.acctRow} activeOpacity={0.6} onPress={() => copy('name')}>
            <View style={styles.avatar}>
              <Text style={styles.avatarTxt}>A</Text>
            </View>
            <Text style={styles.acctName} numberOfLines={1}>
              {w.account}
            </Text>
            <Ionicons name="copy-outline" size={15} color={colors.textFaint} />
            {copied === 'name' ? <Text style={styles.copiedTxt}>{t('walletDetail.copied')}</Text> : null}
          </TouchableOpacity>

          <Text style={styles.addrLabel}>{t('walletDetail.addressLabel')}</Text>
          <TouchableOpacity style={styles.addrBox} activeOpacity={0.6} onPress={() => copy('addr')}>
            <Text style={styles.addrTxt} selectable numberOfLines={2}>
              {wallet?.publicKey ?? t('walletDetail.watchOnlyNoKey')}
            </Text>
            {wallet ? <Ionicons name="copy-outline" size={16} color={colors.textFaint} /> : null}
          </TouchableOpacity>
          {copied === 'addr' ? <Text style={styles.copiedHint}>{t('walletDetail.addressCopied')}</Text> : null}
        </View>

        {/* 导出私钥 */}
        <TouchableOpacity style={styles.card} activeOpacity={0.6} onPress={openExport}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>{t('walletDetail.exportKey')}</Text>
            {!wallet || isPasskey ? (
              <Text style={styles.rowSub}>{!wallet ? t('walletDetail.watchOnlyNa') : t('walletDetail.protectedByPasskey')}</Text>
            ) : null}
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.advanced}
          activeOpacity={0.6}
          onPress={() => Alert.alert(t('walletDetail.comingSoonTitle'), t('walletDetail.comingSoonBody'))}
        >
          <Text style={styles.advancedTxt}>{t('walletDetail.advancedMode')}</Text>
          <Ionicons name="chevron-forward" size={15} color={colors.textFaint} />
        </TouchableOpacity>

        <View style={{ flex: 1, minHeight: 40 }} />

        {wallet ? (
          <TouchableOpacity
            style={[styles.deleteBtn, deleting && styles.deleteBtnOff]}
            activeOpacity={0.85}
            disabled={deleting}
            onPress={confirmDelete}
          >
            {deleting ? <ActivityIndicator color="#fff" /> : <Text style={styles.deleteTxt}>{t('walletDetail.deleteWallet')}</Text>}
          </TouchableOpacity>
        ) : (
          <Text style={styles.readOnlyNote}>{t('walletDetail.watchOnlyDeleteNote')}</Text>
        )}
      </ScrollView>

      {/* 导出私钥:先验证密码/生物识别 */}
      <CenterDialog
        visible={exportStep === 'password'}
        onClose={() => (busy ? undefined : closeExport())}
        closeOnBackdrop={!busy}
        padding={spacing.xl}
      >
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>{t('walletDetail.verifyToExport')}</Text>
          <Text style={styles.dialogDesc}>{t('walletDetail.exportWarning')}</Text>
          {!protectedScreen ? <Text style={styles.dialogErr}>{t('walletDetail.screenProtectionFailed')}</Text> : null}

          {bioOn ? (
            <TouchableOpacity style={styles.bioBtn} activeOpacity={0.7} disabled={busy || !protectedScreen} onPress={revealWithBiometric}>
              <Ionicons name="finger-print" size={20} color={BLUE} />
              <Text style={styles.bioTxt}>{t('walletDetail.useBiometric')}</Text>
            </TouchableOpacity>
          ) : null}

          <TextInput
            value={pwd}
            onChangeText={setPwd}
            placeholder={bioOn ? t('walletDetail.orEnterPassword') : t('walletDetail.enterPassword')}
            placeholderTextColor={colors.textFaint}
            style={styles.dialogInput}
            secureTextEntry
            {...sensitiveInputProps}
            editable={!busy}
          />
          {err ? <Text style={styles.dialogErr}>{err}</Text> : null}

          <View style={styles.dialogBtns}>
            <TouchableOpacity style={[styles.dialogBtn, styles.dialogCancel]} onPress={closeExport} disabled={busy}>
              <Text style={styles.dialogCancelTxt}>{t('walletDetail.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.dialogBtn, styles.dialogOk, (busy || pwd.length < 8) && styles.dialogOff]}
              onPress={revealWithPassword}
              disabled={busy || !protectedScreen || pwd.length < 8}
            >
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.dialogOkTxt}>{t('walletDetail.verify')}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </CenterDialog>

      {/* 导出私钥:明文展示 */}
      <CenterDialog visible={exportStep === 'reveal' && protectedScreen} onClose={closeExport} padding={spacing.xl}>
        <View style={styles.dialog}>
          <View style={styles.warnRow}>
            <Ionicons name="warning" size={18} color="#B45309" />
            <Text style={styles.dialogTitle}>{t('walletDetail.privateKey')}</Text>
          </View>
          <Text style={styles.dialogDesc}>{t('walletDetail.revealWarning')}</Text>
          <View style={styles.secretBox}>
            <Text style={styles.secretTxt}>
              {secret}
            </Text>
            <TouchableOpacity style={styles.secretCopyBtn} activeOpacity={0.6} onPress={() => Alert.alert(t('walletDetail.copySecret'), t('walletDetail.clipboardWarning'), [
                { text: t('walletDetail.cancel'), style: 'cancel' },
                { text: t('walletDetail.copySecret'), onPress: writeSecretClipboard },
              ])}>
              <Ionicons name={secretCopied ? 'checkmark' : 'copy-outline'} size={14} color="#7C4A03" />
              <Text style={styles.secretCopyTxt}>
                {secretCopied ? t('walletDetail.copied') : t('walletDetail.copySecret')}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.secretCopyHint}>{t('walletDetail.secretCopyHint')}</Text>
          <TouchableOpacity style={[styles.dialogBtn, styles.dialogOk, { marginTop: 4 }]} onPress={closeExport}>
            <Text style={styles.dialogOkTxt}>{t('walletDetail.copiedAndClose')}</Text>
          </TouchableOpacity>
        </View>
      </CenterDialog>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },
  scroll: { padding: spacing.md, flexGrow: 1 },

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 12 },

  acctRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },
  acctName: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.text },
  copiedTxt: { fontSize: 12, color: colors.textFaint },

  addrLabel: { fontSize: 12.5, color: colors.textFaint, marginTop: 16, marginBottom: 6 },
  addrBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#F5F6F8',
    borderRadius: 8,
    padding: 12,
  },
  addrTxt: { flex: 1, fontSize: 12.5, color: colors.textSub, lineHeight: 18 },
  copiedHint: { fontSize: 12, color: colors.textFaint, marginTop: 6 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  rowLabel: { fontSize: 16, color: colors.text, flex: 1 },
  rowSub: { fontSize: 13, color: colors.textFaint },

  advanced: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, paddingRight: 4, marginBottom: 8 },
  advancedTxt: { fontSize: 13.5, color: colors.textSub },

  deleteBtn: { backgroundColor: '#F0644E', height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  deleteBtnOff: { opacity: 0.6 },
  deleteTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
  readOnlyNote: { textAlign: 'center', fontSize: 12.5, color: colors.textFaint },

  dialog: { backgroundColor: colors.white, borderRadius: 14, padding: 20, width: '100%', gap: 10 },
  dialogTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  dialogDesc: { fontSize: 13, color: colors.textSub, lineHeight: 19 },
  dialogInput: {
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    height: 46,
    paddingHorizontal: 14,
    fontSize: 15.5,
    color: colors.text,
    outlineStyle: 'none' as any,
  },
  dialogErr: { fontSize: 12.5, color: '#F0644E' },
  dialogBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },
  dialogBtn: { flex: 1, height: 46, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dialogCancel: { backgroundColor: '#F2F3F5' },
  dialogCancelTxt: { fontSize: 15.5, color: colors.text },
  dialogOk: { backgroundColor: BLUE },
  dialogOff: { backgroundColor: '#A9C9F5' },
  dialogOkTxt: { fontSize: 15.5, color: '#fff', fontWeight: '600' },

  bioBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: BLUE,
    borderRadius: 8,
    height: 46,
  },
  bioTxt: { color: BLUE, fontSize: 15, fontWeight: '600' },

  warnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  secretBox: { backgroundColor: '#FEF3C7', borderRadius: 8, padding: 14 },
  secretTxt: { fontSize: 13.5, color: '#7C4A03', lineHeight: 20 },
  secretCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-end', marginTop: 10 },
  secretCopyTxt: { fontSize: 12.5, color: '#7C4A03', fontWeight: '600' },
  secretCopyHint: { fontSize: 11.5, color: colors.textFaint },
});
