import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  Switch,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import CenterDialog from '../components/CenterDialog';
import { useWalletSession } from '../chain/WalletContext';
import {
  biometricAvailable,
  biometricEnabled,
  disableBiometric,
  enableBiometric,
  hasMasterPassword,
  WrongPasswordError,
} from '../crypto/vault';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

export default function SecurityScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const w = useWalletSession();
  const { t } = useI18n();
  const wallet = w.currentWallet;
  // Backup information stays account-specific; unlocking is a device setting.
  const isPasskey = wallet?.source === 'passkey';
  const hasLocalKey = wallet?.source === 'privatekey' || wallet?.source === 'mnemonic';

  const [bioOn, setBioOn] = useState(false);
  const [bioAvail, setBioAvail] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [masterSet, setMasterSet] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const busyRef = useRef(false);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setLoadError(null);
    setBioAvail(null);
    setMasterSet(null);
    Promise.all([biometricAvailable(), biometricEnabled(), hasMasterPassword()])
      .then(([available, enabled, master]) => {
        if (!alive) return;
        setBioAvail(available);
        setBioOn(enabled);
        setMasterSet(master);
      }).catch((error) => {
        if (alive) setLoadError(error?.message ?? t('security.enableFailed'));
      });
    return () => { alive = false; };
  }, [t, refreshVersion]));

  // Native disabled switches need a separate tap target to explain prerequisites.
  const explainDisabled = () => {
    if (busy || masterSet === null || bioAvail === null) return;
    if (!masterSet) {
      Alert.alert(t('security.cannotEnableTitle'), t('security.masterPasswordRequired'), [
        { text: t('send.cancel'), style: 'cancel' },
        { text: t('masterPwdCard.setTitle'), onPress: () => nav.navigate('SetMasterPassword') },
      ]);
    } else if (!bioAvail?.ok) {
      Alert.alert(
        t('security.cannotEnableTitle'),
        bioAvail?.reason === 'no-hardware' ? t('security.noHardwareBody') : t('security.notEnrolledBody')
      );
    }
  };

  const onToggle = async (next: boolean) => {
    if (busyRef.current) return;
    if (!next) {
      busyRef.current = true;
      setBusy(true);
      try {
        await disableBiometric();
        setBioOn(false);
      } catch (error: any) {
        setBioOn(await biometricEnabled());
        Alert.alert(t('security.cannotEnableTitle'), error?.message ?? t('security.enableFailed'));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return;
    }
    setPwd('');
    setErr(null);
    setAsking(true);
  };

  const confirmEnable = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await enableBiometric(pwd);
      setBioOn(true);
      setAsking(false);
      setPwd('');
    } catch (e: any) {
      setErr(e instanceof WrongPasswordError ? t('security.passwordWrong') : e?.message ?? t('security.enableFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const bioSubtitle = bioAvail === null || masterSet === null
    ? t('security.detecting')
    : bioOn
    ? t('security.enabled')
    : !masterSet
    ? t('security.masterPasswordRequired')
    : !bioAvail.ok
    ? bioAvail.reason === 'no-hardware'
      ? t('security.deviceUnsupported')
      : t('security.notEnrolled')
    : t('security.disabled');

  const bioDisabled = busy || !bioAvail || masterSet === null || (!bioOn && (!bioAvail.ok || !masterSet));

  return (
    <View style={styles.root}>
      <PageHeader title={t('security.title')} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
      >
        {loadError ? (
          <View style={styles.noteRow}>
            <Text style={styles.note} selectable>{loadError}</Text>
            <TouchableOpacity onPress={() => setRefreshVersion((value) => value + 1)}>
              <Text style={{ color: BLUE }}>{t('onboarding.retry')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {/* 解锁方式 */}
        <View style={styles.card}>
          <View style={[styles.row, bioDisabled && styles.rowDisabled]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t('security.biometricUnlock')}</Text>
              <Text style={styles.sub}>{bioSubtitle}</Text>
              <Text style={styles.sub}>{t('security.biometricShared')}</Text>
            </View>
            <View>
              <Switch
                value={bioOn}
                onValueChange={onToggle}
                disabled={bioDisabled}
                trackColor={{ false: '#D8DBE2', true: BLUE }}
                thumbColor="#fff"
              />
              {/* 开关原生 disabled 时不接收触摸,单靠上面那行小字容易被当成
                  没反应/卡住——盖一层透明触摸区,点一下就说清楚原因 */}
              {bioDisabled && <Pressable style={StyleSheet.absoluteFill} onPress={explainDisabled} />}
            </View>
          </View>
          <View style={styles.sep} />
          <View style={styles.noteRow}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textSub} />
            <Text style={styles.note}>{t('security.biometricNote')}</Text>
          </View>
        </View>

        {/* 密钥与备份 */}
        <View style={styles.card}>
          <Row
            label={t('security.walletPassword')}
            value={masterSet === null ? t('security.detecting') : masterSet ? t('security.passwordSet') : t('security.passwordNotSet')}
          />
          <View style={styles.sep} />
          <Row
            label={t('security.mnemonicOrKeyBackup')}
            value={isPasskey ? t('security.noLocalKey') : hasLocalKey ? t('security.exportable') : t('security.noKey')}
          />
        </View>

        <View style={{ flex: 1 }} />
      </ScrollView>

      {/* 开启生物识别需先验证密码 */}
      <CenterDialog
        visible={asking}
        onClose={() => { if (!busy) { setAsking(false); setPwd(''); } }}
        closeOnBackdrop={!busy}
        padding={spacing.xl}
      >
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>{t('security.verifyPasswordTitle')}</Text>
          <Text style={styles.dialogDesc}>{t('security.verifyPasswordDesc')}</Text>
          <TextInput
            value={pwd}
            onChangeText={setPwd}
            placeholder={t('security.currentPasswordPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.dialogInput}
            secureTextEntry
            autoCapitalize="none"
            autoFocus
            editable={!busy}
          />
          {err ? <Text style={styles.dialogErr}>{err}</Text> : null}
          {busy ? <Text style={styles.dialogVerifying}>{t('security.verifyingPassword')}</Text> : null}
          <View style={styles.dialogBtns}>
            <TouchableOpacity
              style={[styles.dialogBtn, styles.dialogCancel]}
              onPress={() => { setAsking(false); setPwd(''); }}
              disabled={busy}
            >
              <Text style={styles.dialogCancelTxt}>{t('send.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.dialogBtn, styles.dialogOk, (busy || pwd.length < 8) && styles.dialogOff]}
              onPress={confirmEnable}
              disabled={busy || pwd.length < 8}
            >
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.dialogOkTxt}>{t('security.enableAction')}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </CenterDialog>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },
  scroll: { padding: spacing.md, gap: 12, flexGrow: 1 },

  card: { backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 18 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 62, gap: 12, paddingVertical: 10 },
  rowDisabled: { opacity: 0.45 },
  label: { flex: 1, fontSize: 16, color: colors.text },
  sub: { fontSize: 12.5, color: colors.textFaint, marginTop: 4 },
  value: { fontSize: 14.5, color: colors.textSub, maxWidth: 180 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#EEF0F3' },

  noteRow: { flexDirection: 'row', gap: 8, paddingVertical: 14 },
  note: { flex: 1, fontSize: 12.5, color: colors.textSub, lineHeight: 19 },

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
    marginTop: 4,
    outlineStyle: 'none' as any,
  },
  dialogErr: { fontSize: 12.5, color: '#F0644E' },
  dialogVerifying: { fontSize: 12.5, color: colors.textFaint },
  dialogBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },
  dialogBtn: { flex: 1, height: 46, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dialogCancel: { backgroundColor: '#F2F3F5' },
  dialogCancelTxt: { fontSize: 15.5, color: colors.text },
  dialogOk: { backgroundColor: BLUE },
  dialogOff: { backgroundColor: '#A9C9F5' },
  dialogOkTxt: { fontSize: 15.5, color: '#fff', fontWeight: '600' },
});
