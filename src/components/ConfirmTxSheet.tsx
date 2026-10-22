import React, { useEffect, useState } from 'react';
import { sensitiveInputProps } from './sensitiveInputProps';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import CenterDialog from './CenterDialog';
import { safeDisplayText } from './displayText';
import { colors, spacing } from '../theme';
import { ActionSpec } from '../chain/transact';
import { friendlyChainErrorMessage } from '../chain/sponsor';
import { biometricEnabled } from '../crypto/vault';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

/** Action data is attacker-controlled; never let invisible controls reorder it. */
function displayDataValue(value: unknown, empty: string): string {
  if (value === '') return empty;
  if (typeof value === 'object' && value !== null) return safeDisplayText(JSON.stringify(value, null, 2));
  return safeDisplayText(String(value));
}

/**
 * 交易确认弹层。
 * 签名前必须让用户看清「实际要上链的内容」而不是界面上的输入值 ——
 * 两者不一致正是钓鱼攻击的入口。
 */
export default function ConfirmTxSheet({
  visible,
  onClose,
  actions,
  chainName,
  testnet,
  actor,
  permission,
  busy,
  error,
  walletId,
  passkey,
  external,
  origin,
  callbackOrigin,
  message,
  notice,
  onConfirm,
  onConfirmBiometric,
  onConfirmPasskey,
}: {
  visible: boolean;
  onClose: () => void;
  actions: ActionSpec[];
  chainName: string;
  testnet: boolean;
  actor: string;
  /** 实际用来签这笔交易的权限名——不写默认按 'active' 显示,和过去的默认行为一致 */
  permission?: string;
  busy: boolean;
  error: string | null;
  /** 当前账户存在本机密钥时才提供设备级生物识别解锁。 */
  walletId?: string;
  /** passkey 钱包:没有本机密码/生物识别可解,签名靠现场发起一次系统 passkey 认证 */
  passkey?: boolean;
  /** Observation accounts sign on a separate device and have no local password. */
  external?: boolean;
  /** 请求来源(dApp 页面的 host)——让用户知道是谁在要这个签名,不传就不显示 */
  origin?: string;
  callbackOrigin?: string;
  /**
   * 只签一段文本(DApp 登录验证)时传原文。传了就不是在确认一笔交易,标题、
   * 内容区、授权行都要跟着换——把一段文本套用交易详情的壳去展示,用户会
   * 以为自己在签一笔转账。
   */
  message?: string | null;
  /** Operation-specific meaning of the exact actions below. */
  notice?: string;
  onConfirm: (password: string) => void;
  onConfirmBiometric?: () => void;
  onConfirmPasskey?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  // 广播中锁住所有签名入口(生物识别快捷键、passkey/普通签名按钮、密码校验)
  const locked = busy;
  const errorMessage = error ? friendlyChainErrorMessage(error) : null;
  const authorizations = [...new Set(actions.flatMap((action) =>
    (action.authorization ?? [{ actor, permission: permission ?? 'active' }]).map((auth) => `${auth.actor}@${auth.permission}`)))];
  const usesOwner = permission === 'owner' || authorizations.some((auth) => auth.endsWith('@owner'));
  const [pwd, setPwd] = useState('');
  const [bio, setBio] = useState(false);
  // 参照 TokenPocket 的两步交互:先看清交易详情、点确认,密码校验单独弹一层——
  // 不能把密码框和一堆交易明细堆在同一屏,容易让人在没看清内容的情况下就顺手把密码打了。
  const [pwdModal, setPwdModal] = useState(false);
  /** 关掉密码校验层就把已输入的密码清空——不管是点了叉号还是点了背景 */
  const closePwdModal = () => {
    setPwdModal(false);
    setPwd('');
  };

  useEffect(() => {
    let alive = true;
    setBio(false);
    if (visible && walletId && !passkey && !external) {
      biometricEnabled().then((v) => alive && setBio(v));
    }
    if (!visible) {
      setPwdModal(false);
      setPwd('');
    }
    return () => {
      alive = false;
    };
  }, [visible, walletId, passkey, external]);

  // 主按钮的签名入口:开了生物识别就走生物识别,没开就直接弹密码——不管哪种,
  // 都必须是用户点了主按钮才触发,不能一开弹层就自己弹系统认证框
  // (那样交易详情等于形同虚设,用户没看内容手指一按就转出去了)。
  const startSigning = () => {
    if (external) {
      onConfirm('');
    } else if (bio && onConfirmBiometric) {
      onConfirmBiometric();
    } else {
      setPwdModal(true);
    }
  };

  // Cancellation, invalidated credentials, and timeouts all retain password fallback.
  useEffect(() => {
    if (visible && [t('vaultError.cancelled'), t('vaultError.biometricFailed'),
      t('vaultError.credentialNotFound'), t('vaultError.timeout'), t('vaultError.wrongPassword')].includes(error ?? '')) {
      setPwdModal(true);
    }
  }, [visible, error, t]);

  return (
    <>
    <BottomSheet visible={visible} onClose={onClose} closeOnBackdrop={!busy}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{message == null ? t('confirmTx.title') : t('confirmTx.messageTitle')}</Text>
          <TouchableOpacity hitSlop={8} onPress={onClose} disabled={busy} style={{ width: 30, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={24} color={busy ? colors.textFaint : colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 12 }}>

          {testnet ? (
            <View style={[styles.netBar, styles.netTest]}>
              <Text style={styles.netTxt}>{chainName} · {t('wallet.testnet')}</Text>
            </View>
          ) : null}

          {/* 是谁在要这个签名——注入通道/iframe 里的第三方内容都能发起请求,
              不把来源亮出来,用户没法区分"主站要的"还是"页面里嵌的广告要的" */}
          {origin ? (
            <View style={styles.authRow}>
              <Text style={styles.authK}>{t('confirmTx.origin')}</Text>
              <Text style={[styles.authV, { flex: 1, textAlign: 'right' }]} selectable>
                {origin}
              </Text>
            </View>
          ) : null}
          {callbackOrigin ? (
            <View style={styles.authRow}>
              <Text style={styles.authK}>{t('confirmTx.signatureRecipient')}</Text>
              <Text style={[styles.authV, { flex: 1, textAlign: 'right' }]} selectable>{callbackOrigin}</Text>
            </View>
          ) : null}

          {/* 只签文本:展示原文,提醒签名可能用于第三方授权。 */}
          {message != null ? (
            <View style={styles.actionCard}>
              <View style={styles.actionHead}>
                <Text style={styles.actionName}>{t('confirmTx.messageLabel')}</Text>
              </View>
              <Text style={styles.messageBody} selectable>
                {safeDisplayText(message)}
              </Text>
            </View>
          ) : null}
          {message != null ? (
            <View style={styles.sponsorBar}>
              <Ionicons name="information-circle-outline" size={15} color={colors.textSub} />
              <Text style={styles.sponsorTxt}>{t('confirmTx.messageHint')}</Text>
            </View>
          ) : null}

          {/* 逐条展示实际上链内容 */}
          {notice ? <View style={styles.sponsorBar}><Text style={styles.sponsorTxt}>{notice}</Text></View> : null}
          {actions.map((a, i) => (
            <View key={i} style={styles.actionCard}>
              <View style={styles.actionHead}>
                <Text style={styles.actionName}>{a.name}</Text>
                <Text style={styles.actionContract}>@{a.account}</Text>
              </View>
              {Object.entries(a.data).map(([k, v]) => (
                <View key={k} style={styles.kvRow}>
                  <Text style={styles.kvK}>{k}</Text>
                  <Text style={styles.kvV} selectable>
                    {displayDataValue(v, t('confirmTx.emptyValue'))}
                  </Text>
                </View>
              ))}
              {a.authorization?.map((auth, j) => (
                <View key={`auth-${j}`} style={styles.kvRow}>
                  <Text style={styles.kvK}>{t('confirmTx.authorization')}</Text>
                  <Text style={[styles.kvV, auth.permission === 'owner' && styles.authVOwner]} selectable>{auth.actor}@{auth.permission}</Text>
                </View>
              ))}
            </View>
          ))}

          {/* owner 权限能改掉账户的任何权限(含 active 自己),一旦被冒用后果
              比 active 严重得多——不能和 active 用同样的展示,得让用户一眼看出
              "这笔要用最高权限签",不是走个过场。 */}
          <View style={[styles.authRow, usesOwner && styles.authRowOwner]}>
            <Text style={styles.authK}>{t('confirmTx.authorization')}</Text>
            <Text style={[styles.authV, usesOwner && styles.authVOwner]}>
              {authorizations.length ? authorizations.join('\n') : `${actor}@${permission ?? 'active'}`}
            </Text>
          </View>
          {usesOwner ? (
            <View style={[styles.sponsorBar, styles.ramWarnBar]}>
              <Ionicons name="warning-outline" size={15} color="#B45309" />
              <Text style={[styles.sponsorTxt, styles.ramWarnTxt]}>{t('confirmTx.ownerWarn')}</Text>
            </View>
          ) : null}

          {/* passkey 钱包:提示会现场发起系统认证,没有密码/生物识别可选 */}
          {passkey ? (
            <View style={styles.pwdCard}>
              <Text style={styles.pwdLabel}>{t('confirmTx.passkeyControlled')}</Text>
              <Text style={styles.passkeyHint}>{t('confirmTx.passkeyHint')}</Text>
            </View>
          ) : null}

          {/* 非密码路径(生物识别/passkey)的失败提示留在这一屏;密码路径的失败提示
              在下面那层密码校验弹窗里,不然弹窗一盖住,这里的提示用户根本看不见 */}
          {error && !pwdModal ? (
            <View style={styles.errBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#F0644E" />
              <Text style={styles.errTxt}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>

        {passkey ? (
          <TouchableOpacity
            style={[styles.cta, locked && styles.ctaOff]}
            disabled={locked}
            onPress={onConfirmPasskey}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>{t('confirmTx.signWithPasskey')}</Text>}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.cta, locked && styles.ctaOff]}
            disabled={locked}
            onPress={startSigning}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>{t(external ? 'coldSigning.title' : 'confirmTx.submit')}</Text>}
          </TouchableOpacity>
        )}
      </View>
    </BottomSheet>

      {/* 密码校验——参照 TokenPocket:点了上面的确认之后,再单独弹这一层输入密码,
          不和交易详情挤在同一屏 */}
      <CenterDialog
        visible={pwdModal}
        onClose={() => (busy ? undefined : closePwdModal())}
        closeOnBackdrop={!busy}
        backdropColor="rgba(0,0,0,0.5)"
      >
        <View style={styles.pwdDialog}>
          <View style={styles.pwdDialogHead}>
            <TouchableOpacity hitSlop={8} disabled={busy} onPress={closePwdModal}>
              <Ionicons name="close" size={20} color={busy ? colors.textFaint : colors.textSub} />
            </TouchableOpacity>
            <Text style={styles.pwdDialogTitle}>{t('confirmTx.verifyPassword')}</Text>
            <View style={{ width: 20 }} />
          </View>
          <TextInput
            value={pwd}
            onChangeText={setPwd}
            placeholder={t('confirmTx.verifyPasswordPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.pwdDialogInput}
            secureTextEntry
            {...sensitiveInputProps}
            editable={!busy}
            autoFocus
            onSubmitEditing={() => (pwd.length >= 8 && !locked ? onConfirm(pwd) : undefined)}
          />
          {error ? (
            <View style={[styles.errBox, { marginTop: 0, marginBottom: 14 }]}>
              <Ionicons name="alert-circle-outline" size={16} color="#F0644E" />
              <Text style={styles.errTxt}>{errorMessage}</Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={[styles.cta, { marginTop: 0 }, (locked || pwd.length < 8) && styles.ctaOff]}
            disabled={locked || pwd.length < 8}
            onPress={() => onConfirm(pwd)}
            activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>{t('confirmTx.confirm')}</Text>}
          </TouchableOpacity>
        </View>
      </CenterDialog>
    </>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: '#F2F3F5',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '86%',
    paddingHorizontal: spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 56 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },

  netBar: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 8, padding: 12, marginBottom: 12 },
  netTest: { backgroundColor: '#E0F2FE' },
  netTxt: { fontSize: 13.5, fontWeight: '600' },

  sponsorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#FEF9E7',
  },
  sponsorTxt: { flex: 1, fontSize: 13, fontWeight: '600', color: '#7C6A00' },
  ramWarnBar: { backgroundColor: '#FEF3C7' },
  ramWarnTxt: { color: '#B45309' },

  actionCard: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 10 },
  actionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 12 },
  actionName: { fontSize: 17, fontWeight: '800', color: colors.text },
  actionContract: { fontSize: 13, color: colors.textSub },
  kvRow: { flexDirection: 'row', paddingVertical: 7, gap: 14 },
  kvK: { width: 76, fontSize: 13.5, color: colors.textSub },
  kvV: { flex: 1, fontSize: 13.5, color: colors.text, textAlign: 'right' },

  authRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.white,
    borderRadius: 10,
    padding: 16,
    marginBottom: 10,
  },
  authK: { fontSize: 13.5, color: colors.textSub },
  authV: { fontSize: 13.5, color: colors.text, fontWeight: '600' },
  authRowOwner: { backgroundColor: '#FEF3C7' },
  authVOwner: { color: '#B45309' },

  pwdCard: { backgroundColor: colors.white, borderRadius: 10, padding: 16 },
  pwdLabel: { fontSize: 13.5, color: colors.textSub, marginBottom: 10 },
  passkeyHint: { fontSize: 13, color: colors.text, lineHeight: 19 },
  messageBody: { fontSize: 14, color: colors.text, lineHeight: 21, paddingHorizontal: 14, paddingBottom: 14 },

  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginTop: 10 },
  errTxt: { flex: 1, fontSize: 13, color: '#F0644E', lineHeight: 19 },

  cta: { height: 52, borderRadius: 26, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  ctaOff: { backgroundColor: '#A9C9F5' },
  ctaTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },

  // 密码校验弹层——盖在交易详情那层上面,居中的一张小卡片,和 TokenPocket
  // 「确认交易 → 再弹密码框」的两步交互对齐
  pwdDialog: { width: '100%', maxWidth: 320, backgroundColor: colors.white, borderRadius: 16, padding: 20 },
  pwdDialogHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  pwdDialogTitle: { fontSize: 16.5, fontWeight: '700', color: colors.text },
  pwdDialogInput: {
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    height: 46,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.text,
    marginBottom: 18,
    outlineStyle: 'none' as any,
  },
});
