import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import PasswordDialog from '../components/PasswordDialog';
import { useWalletSession } from '../chain/WalletContext';
import {
  assertPendingDeviceChain,
  DEVICE_KEY_AUTH_RETURN_URL,
  createPendingDeviceKey,
  deviceKeyAuthorizeUrl,
  discardPendingDeviceKey,
  findAccountsForDeviceKey,
  importPendingDeviceKey,
} from '../chain/deviceKey';
import { hasMasterPassword, loadPendingDeviceKey, updatePendingDeviceKeyLabel, WrongPasswordError, type PendingDeviceKey } from '../crypto/vault';
import { useI18n } from '../i18n';
import { AnchorWebCancelled, connectAnchorWeb, type AnchorWebSession } from '../chain/anchorWeb';
import { prepareAnchorDeviceImport, submitAnchorDeviceImport, type DeviceKeyReview } from '../chain/anchorDeviceImport';

const BLUE = '#1E88FF';

/**
 * 已有 Passkey 账户导入：选择 eos3.app 或直接通过 Anchor 网页授权这台手机。
 * 本机密钥先加密保存为待授权记录,网页授权后按公钥查链并导入。
 */
export default function DeviceKeyImportScreen({ route }: { route?: { params?: { provider?: 'anchor' } } }) {
  const viaAnchor = route?.params?.provider === 'anchor';
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const w = useWalletSession();
  const { t } = useI18n();

  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const recoveredRef = useRef(false);
  const [pending, setPending] = useState<PendingDeviceKey | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [anchorReview, setAnchorReview] = useState<DeviceKeyReview | null>(null);
  const [anchorAccount, setAnchorAccount] = useState('');
  const anchorSessionRef = useRef<AnchorWebSession | null>(null);
  const anchorAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    mountedRef.current = true;
    loadPendingDeviceKey().then((value) => { if (alive) setPending(value); })
      .catch((error) => { if (alive) setHint(error?.message ?? t('signupError.pendingReadFailed')); });
    return () => { alive = false; mountedRef.current = false; };
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      hasMasterPassword()
        .then((has) => {
          if (alive && !has) nav.navigate('SetMasterPassword');
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, [nav])
  );

  const generate = async (password: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const generated = await createPendingDeviceKey(password, w.chainId);
      recoveredRef.current = true;
      setPending(generated);
      setAsking(false);
    } catch (e: any) {
      setErr(e instanceof WrongPasswordError ? e.message : e?.message ?? t('deviceKey.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openWeb = async () => {
    if (!pending || busyRef.current || editingName) return;
    busyRef.current = true;
    setBusy(true);
    setHint(null);
    try {
      assertPendingDeviceChain(pending, w.chainId);
      if (w.chainId !== 'vaulta') throw new Error(t('deviceKey.webMainnetOnly'));
      const result = await WebBrowser.openAuthSessionAsync(
        deviceKeyAuthorizeUrl(pending, undefined, DEVICE_KEY_AUTH_RETURN_URL),
        DEVICE_KEY_AUTH_RETURN_URL
      );
      // The callback only resumes the flow; chain state decides what can be imported.
      busyRef.current = false;
      if (result.type === 'success' || result.type === 'cancel' || result.type === 'dismiss') {
        await check(result.type !== 'success', result.type === 'success' ? 5 : 1);
      }
    } catch (error: any) {
      setHint(error?.message ?? t('deviceKey.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const checkContext = `${w.chainId}/${w.node?.url}/${pending?.id}/${viaAnchor}`;
  const checkContextRef = useRef(checkContext);
  checkContextRef.current = checkContext;

  useEffect(() => {
    setAnchorReview(null);
    setAnchorAccount('');
    anchorSessionRef.current = null;
    return () => { anchorAbortRef.current?.abort(); };
  }, [checkContext]);

  const openAnchor = async () => {
    if (!pending || busyRef.current || editingName) return;
    busyRef.current = true;
    setBusy(true);
    setHint(null);
    const controller = new AbortController();
    anchorAbortRef.current = controller;
    const isCurrent = () => mountedRef.current && checkContextRef.current === checkContext && !controller.signal.aborted;
    const finishImport = async (account: string) => {
      // Callback account names and relay responses alone never import a wallet.
      await importPendingDeviceKey(pending, account, w.chainId, w.node);
      if (!isCurrent()) return;
      await w.reloadWallets();
      if (!isCurrent()) return;
      w.setAccount(account);
      nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      Alert.alert(t('deviceKeyImport.successTitle'), t('deviceKeyImport.successBody', { account }));
    };
    try {
      assertPendingDeviceChain(pending, w.chainId);
      if (w.chainId !== 'vaulta') throw new Error(t('anchorImport.mainnetOnly'));
      if (anchorReview && anchorSessionRef.current) {
        const session = anchorSessionRef.current;
        await submitAnchorDeviceImport(session, anchorReview, controller.signal);
        if (!isCurrent()) return;
        setAnchorReview(null);
        await finishImport(session.account);
      } else {
        setAnchorAccount('');
        const session = await connectAnchorWeb(controller.signal);
        if (!isCurrent()) return;
        const review = await prepareAnchorDeviceImport(session, pending, w.node, w.chainId);
        if (!isCurrent()) return;
        anchorSessionRef.current = session;
        setAnchorAccount(session.account);
        if (!review) await finishImport(session.account);
        else setAnchorReview(review);
      }
    } catch (error: any) {
      if (!isCurrent()) return;
      setAnchorReview(null);
      setAnchorAccount('');
      anchorSessionRef.current = null;
      setHint(error instanceof AnchorWebCancelled ? t('anchorImport.cancelled') : error?.message ?? t('deviceKey.failed'));
    } finally {
      if (anchorAbortRef.current === controller) anchorAbortRef.current = null;
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };


  const check = async (silent = false, attempts = 1) => {
    if (!pending || busyRef.current || editingName || checkContextRef.current !== checkContext) return;
    busyRef.current = true;
    setBusy(true);
    setHint(null);
    try {
      assertPendingDeviceChain(pending, w.chainId);
      const context = checkContext;
      const isCurrent = () => mountedRef.current && checkContextRef.current === context;
      let account = '';
      // Callback arrival can precede the public RPC/indexer catching up. Retry
      // automatically, while never treating callback parameters as chain proof.
      for (let attempt = 0; attempt < attempts; attempt++) {
        const accounts = await findAccountsForDeviceKey(w.node, w.historyNode, pending);
        if (!isCurrent()) return;
        if (accounts.length) {
          try {
            await importPendingDeviceKey(pending, accounts[0], w.chainId, w.node);
            if (!isCurrent()) return;
            account = accounts[0];
            break;
          } catch (error: any) {
            if (error?.message !== t('deviceKeyImport.notYet')) throw error;
          }
        }
        if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 1500));
        if (!isCurrent()) return;
      }
      if (!account) {
        if (!silent) setHint(t('deviceKeyImport.notYet'));
        return;
      }
      // 同一把公钥被多个账户授权极少见;真遇到就按链上返回顺序取第一个,其余账户
      // 用户可以再走一遍私钥导入(私钥就在本机)
      await w.reloadWallets();
      w.setAccount(account);
      nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      Alert.alert(t('deviceKeyImport.successTitle'), t('deviceKeyImport.successBody', { account }));
    } catch (e: any) {
      setHint(e?.message ?? t('deviceKey.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const discard = () => {
    if (!pending || busyRef.current || editingName) return;
    Alert.alert(t('deviceKey.discard'), t('deviceKeyImport.discardBody'), [
      { text: t('walletDetail.cancel'), style: 'cancel' },
      {
        text: t('deviceKey.discard'),
        style: 'destructive',
        onPress: async () => {
          if (busyRef.current) return;
          busyRef.current = true;
          setBusy(true);
          try {
            await discardPendingDeviceKey(pending, w.node, w.chainId);
            setPending(null);
            setHint(null);
          } catch (error: any) {
            setHint(error?.message ?? t('deviceKey.failed'));
          } finally {
            busyRef.current = false;
            setBusy(false);
          }
        },
      },
    ]);
  };

  useEffect(() => {
    if (!pending || recoveredRef.current) return;
    recoveredRef.current = true;
    // Also recover after a cold-start callback or an interrupted web authorization.
    void check(true);
  }, [pending]);

  const editName = () => {
    if (!pending || busyRef.current) return;
    setAnchorReview(null);
    setAnchorAccount('');
    anchorSessionRef.current = null;
    setNameDraft(pending.label);
    setHint(null);
    setEditingName(true);
  };

  const cancelName = () => {
    if (busyRef.current) return;
    setEditingName(false);
    setNameDraft('');
    setHint(null);
  };

  const saveName = async () => {
    if (!pending || busyRef.current || !nameDraft.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setHint(null);
    try {
      const updated = await updatePendingDeviceKeyLabel(pending, nameDraft);
      setPending(updated);
      setEditingName(false);
      setNameDraft('');
    } catch (error: any) {
      setHint(error?.message ?? t('deviceKey.failed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t(viaAnchor ? 'import.viaAnchor' : 'import.viaEos3')} onBack={() => {
        if (nav.canGoBack()) nav.goBack();
        else nav.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      }} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={styles.iconWrap}>
          <Ionicons name="phone-portrait-outline" size={48} color={BLUE} />
        </View>
        <Text style={styles.title}>{t('deviceKeyImport.heroTitle')}</Text>
        <Text style={styles.desc}>{t(viaAnchor ? 'anchorImport.heroDesc' : 'deviceKeyImport.heroDesc')}</Text>
        <Text style={styles.accountHint}>{t(viaAnchor ? 'anchorImport.accountHint' : 'deviceKeyImport.accountHint')}</Text>

        <View style={styles.steps}>
          <Text style={[styles.step, !pending && styles.stepActive]}>{t('deviceKey.stepGenerate')}</Text>
          <Text style={[styles.step, pending && styles.stepActive]}>{t(viaAnchor ? 'anchorImport.stepAuthorize' : 'deviceKey.stepAuthorize')}</Text>
          <Text style={styles.step}>{t('deviceKey.stepCheck')}</Text>
        </View>

        {pending ? (
          <View style={styles.keyCard}>
            <Text style={styles.keyLabel}>{t('deviceKey.deviceLabel')}</Text>
            <View style={styles.nameRow}>
              {editingName ? (
                <>
                  <TextInput
                    style={styles.nameInput}
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    accessibilityLabel={t('deviceKey.deviceLabel')}
                    maxLength={40}
                    autoFocus
                    autoCorrect={false}
                    autoCapitalize="none"
                    editable={!busy}
                    returnKeyType="done"
                    onSubmitEditing={() => void saveName()}
                  />
                  <TouchableOpacity
                    style={styles.nameAction}
                    accessibilityRole="button"
                    accessibilityLabel={t('language.save')}
                    disabled={busy || !nameDraft.trim()}
                    onPress={() => void saveName()}
                  >
                    {busy ? <ActivityIndicator color={BLUE} /> : <Ionicons name="checkmark-outline" size={22} color={!nameDraft.trim() ? colors.textFaint : BLUE} />}
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.nameAction} accessibilityRole="button" accessibilityLabel={t('send.cancel')} disabled={busy} onPress={cancelName}>
                    <Ionicons name="close-outline" size={22} color={colors.textSub} />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.keyValue}>{pending.label}</Text>
                  <TouchableOpacity style={styles.nameAction} accessibilityRole="button" accessibilityLabel={t('deviceKey.editName')} disabled={busy} onPress={editName}>
                    <Ionicons name="pencil-outline" size={19} color={busy ? colors.textFaint : BLUE} />
                  </TouchableOpacity>
                </>
              )}
            </View>
            {editingName ? <Text style={styles.nameWarning}>{t('deviceKey.nameReuseWarning')}</Text> : null}
            <Text style={[styles.keyLabel, { marginTop: 10 }]}>{t('deviceKey.publicKey')}</Text>
            <Text style={styles.keyMono} selectable>
              {pending.publicKey}
            </Text>
          </View>
        ) : null}

        {viaAnchor && anchorAccount ? (
          <View style={styles.keyCard}>
            <Text style={styles.keyLabel}>{t('anchorImport.account')}</Text>
            <Text style={styles.keyMono}>{anchorAccount}</Text>
            {anchorReview ? <Text style={styles.openHint}>{t('anchorImport.reviewHint')}</Text> : null}
          </View>
        ) : null}

        {hint ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color="#F0644E" />
            <Text style={styles.errBoxTxt} selectable>{hint}</Text>
          </View>
        ) : null}

        {pending === undefined ? (
          <>
            {hint ? (
              <TouchableOpacity style={styles.secondary} onPress={() => {
                setHint(null);
                loadPendingDeviceKey().then(setPending)
                  .catch((error) => setHint(error?.message ?? t('signupError.pendingReadFailed')));
              }}>
                <Text style={styles.secondaryTxt}>{t('onboarding.retry')}</Text>
              </TouchableOpacity>
            ) : <ActivityIndicator color={BLUE} />}
          </>
        ) : !pending ? (
          <TouchableOpacity style={[styles.submit, busy && styles.submitOff]} disabled={busy} activeOpacity={0.85} onPress={() => setAsking(true)}>
            <Text style={styles.submitTxt}>{t('deviceKey.generate')}</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity style={[styles.submit, (busy || editingName || w.chainId !== 'vaulta') && styles.submitOff]} disabled={busy || editingName || w.chainId !== 'vaulta'} activeOpacity={0.85} onPress={viaAnchor ? openAnchor : openWeb}>
              <Text style={styles.submitTxt}>{t(viaAnchor ? (anchorReview ? 'anchorImport.confirm' : 'anchorImport.openWeb') : 'deviceKey.openWeb')}</Text>
            </TouchableOpacity>
            <Text style={styles.openHint}>{t(w.chainId === 'vaulta' ? (viaAnchor ? 'anchorImport.openWebHint' : 'deviceKeyImport.openWebHint') : (viaAnchor ? 'anchorImport.mainnetOnly' : 'deviceKey.webMainnetOnly'))}</Text>
            <TouchableOpacity style={[styles.secondary, (busy || editingName) && styles.submitOff]} disabled={busy || editingName} activeOpacity={0.85} onPress={() => void check()}>
              {busy ? <ActivityIndicator color={BLUE} /> : <Text style={styles.secondaryTxt}>{t('deviceKey.check')}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkBtn} disabled={busy || editingName} activeOpacity={0.7} onPress={discard}>
              <Text style={styles.linkTxt}>{t('deviceKey.discard')}</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      <PasswordDialog
        visible={asking}
        title={t('deviceKey.passwordTitle')}
        busy={busy}
        error={err}
        onClose={() => {
          setAsking(false);
          setErr(null);
        }}
        onSubmit={generate}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  iconWrap: { alignItems: 'center', marginTop: 12, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, textAlign: 'center', marginBottom: 10 },
  desc: { fontSize: 14, color: colors.textSub, lineHeight: 21, textAlign: 'center', marginBottom: 18 },
  accountHint: { fontSize: 12.5, color: colors.textSub, lineHeight: 19, marginBottom: 18 },
  steps: { backgroundColor: colors.card, borderRadius: 8, padding: 14, marginBottom: 14, gap: 8 },
  step: { fontSize: 13.5, color: colors.textSub },
  stepActive: { color: colors.text, fontWeight: '600' },
  keyCard: { backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 14 },
  keyLabel: { fontSize: 12, color: colors.textSub, marginBottom: 4 },
  keyValue: { flex: 1, minWidth: 0, fontSize: 14.5, color: colors.text, fontWeight: '600' },
  nameRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 4 },
  nameAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  nameInput: { flex: 1, minWidth: 0, height: 44, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.line, borderRadius: 8, color: colors.text, fontSize: 14.5 },
  nameWarning: { color: colors.textSub, fontSize: 12, lineHeight: 18, marginTop: 4 },
  keyMono: { fontSize: 12.5, color: colors.text, lineHeight: 18, fontFamily: 'monospace' },
  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EC', borderRadius: 8, padding: 12, marginBottom: 14 },
  errBoxTxt: { flex: 1, fontSize: 13, color: '#F0644E', lineHeight: 19 },
  submit: { height: 52, borderRadius: 26, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center' },
  submitOff: { opacity: 0.6 },
  submitTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  openHint: { fontSize: 12.5, color: colors.textSub, lineHeight: 18, textAlign: 'center', marginTop: 10, marginBottom: 14 },
  secondary: { height: 52, borderRadius: 26, borderWidth: 1.5, borderColor: BLUE, alignItems: 'center', justifyContent: 'center' },
  secondaryTxt: { color: BLUE, fontSize: 16, fontWeight: '700' },
  linkBtn: { alignItems: 'center', paddingVertical: 16 },
  linkTxt: { fontSize: 14, color: colors.textSub },
});
