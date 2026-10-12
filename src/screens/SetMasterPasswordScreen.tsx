import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import MasterPasswordCard from '../components/MasterPasswordCard';
import { addBackHandler } from '../components/ModalHost';
import { biometricAvailable, enableBiometric, setMasterPassword } from '../crypto/vault';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

/**
 * 独立的"设置主密码"页 —— 参考 TP:只在本机第一次需要密码的钱包动作
 * (创建/导入助记词或私钥)之前出现一次,由 ImportScreen(入口列表)和
 * CreateAccountPayScreen 在各自的网关里用 nav.navigate 跳过来,设置成功后
 * nav.goBack() 回到原页面。设置过之后,这两个页面的网关都不会再跳过来,
 * 不会反复要求设置。
 *
 * 注意「返回」箭头不能只 goBack() 一层:网关页(ImportScreen /
 * CreateAccountPayScreen)的 useFocusEffect 每次重新获得焦点都会再查一遍
 * hasMasterPassword,没设置的话会立刻把你又导航回这里 —— 用户会感觉"返回
 * 按钮点了没反应"。所以取消/返回要连着网关页一起跳过,pop(2) 直接回到
 * 网关页之前的那一屏。
 */
export default function SetMasterPasswordScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const active = useRef(true);
  const busyRef = useRef(false);
  const saved = useRef(false);
  const finished = useRef(false);
  const enabling = useRef(false);
  const biometricPassword = useRef('');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      biometricPassword.current = '';
    };
  }, []);

  const finish = useCallback(() => {
    biometricPassword.current = '';
    if (!active.current || finished.current) return;
    finished.current = true;
    setPwd('');
    setPwd2('');
    nav.goBack();
  }, [nav]);

  const ready = pwd.length >= 8 && pwd === pwd2;

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    if (saved.current) {
      finish();
      return;
    }
    // 正常应该总有「网关页」这一层在下面(见上面的注释),但留个兜底,
    // 万一将来多一个只隔一层就直接跳过来的入口,不至于 pop 过头崩掉。
    if (nav.getState().index >= 2) nav.pop(2);
    else nav.goBack();
  }, [nav, finish]);

  // 安卓实体/手势返回键不走 PageHeader 的 onBack,而是走导航库默认的
  // goBack() —— 同样会被网关页弹回来,这里单独拦截,行为对齐取消按钮。
  useFocusEffect(
    useCallback(() => {
      const sub = addBackHandler(() => {
        cancel();
        return true;
      });
      return () => sub.remove();
    }, [cancel])
  );

  const confirm = async () => {
    if (!ready || busyRef.current || saved.current || finished.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await setMasterPassword(pwd);
    } catch (e: any) {
      busyRef.current = false;
      if (active.current) {
        setErr(e?.message ?? t('setMasterPwd.setFailed'));
        setBusy(false);
      }
      return;
    }
    if (!active.current) return;
    saved.current = true;
    biometricPassword.current = pwd;
    setPwd('');
    setPwd2('');

    // Optional setup must never turn a successfully saved master password into a failure.
    const available = await biometricAvailable().catch(() => ({ ok: false }));
    if (!active.current) return;
    setBusy(false);
    if (!available.ok) {
      finish();
      return;
    }
    Alert.alert(
      t('setMasterPwd.biometricTitle'),
      t('setMasterPwd.biometricBody'),
      [
        { text: t('setMasterPwd.biometricLater'), style: 'cancel', onPress: finish },
        {
          text: t('security.enableAction'),
          onPress: async () => {
            if (enabling.current || finished.current || !active.current) return;
            enabling.current = true;
            setBusy(true);
            try {
              await enableBiometric(biometricPassword.current);
            } catch (error: any) {
              const message = String(error?.message ?? '');
              if (active.current && !/cancel/i.test(message) && message !== t('vaultError.cancelled')) {
                Alert.alert(t('security.enableFailed'), t('setMasterPwd.biometricFailed'));
              }
            } finally {
              finish();
            }
          },
        },
      ],
      { cancelable: true, onDismiss: () => { if (!enabling.current) finish(); } }
    );
  };

  return (
    <View style={styles.root}>
      <PageHeader title={t('setMasterPwd.title')} onBack={cancel} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <View style={styles.introCard}>
          <Ionicons name="shield-checkmark" size={20} color="#12A566" />
          <Text style={styles.introTxt}>{t('setMasterPwd.intro')}</Text>
        </View>

        <MasterPasswordCard hasPwd={false} pwd={pwd} onChangePwd={setPwd} pwd2={pwd2} onChangePwd2={setPwd2} />

        {err ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={17} color="#F0644E" />
            <Text style={styles.errBoxTxt}>{err}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.submit, (!ready || busy) && styles.submitOff]}
          disabled={!ready || busy}
          activeOpacity={0.85}
          onPress={confirm}
        >
          {busy ? (
            // 密钥派生要跑两轮 PBKDF2(saveSecret 内部写完还要读回校验一遍),
            // 200,000 次迭代在真机上大概几百毫秒,但在模拟器这类软件模拟 CPU
            // 上可能要跑好几秒 —— 光一个转圈图标容易让人以为卡住了,配一行字
            <View style={styles.busyRow}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.submitTxt}>{t(saved.current ? 'security.biometricUnlock' : 'importSecret.generatingKey')}</Text>
            </View>
          ) : (
            <Text style={styles.submitTxt}>{t('send.confirm')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  introCard: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#E8F7EF',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  introTxt: { flex: 1, fontSize: 13, color: colors.textSub, lineHeight: 19 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginBottom: 12 },
  errBoxTxt: { flex: 1, fontSize: 13, color: '#F0644E', lineHeight: 19 },

  submit: { backgroundColor: BLUE, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  submitOff: { backgroundColor: '#A9C9F5' },
  submitTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
