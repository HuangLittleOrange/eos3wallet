import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  Share,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import QRCode from 'react-native-qrcode-svg';
import { Ionicons, Feather } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';

import BottomSheet from '../components/BottomSheet';
import CenterDialog from '../components/CenterDialog';
import { colors, spacing, BRAND_NAME } from '../theme';
import { useWallet } from '../chain/WalletContext';
import { priceIn } from '../chain/prices';
import { sanitizeAmountInput } from '../chain/format';
import { useI18n } from '../i18n';
import { saveImageToGallery } from './receiveSave';

export default function ReceiveScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  const w = useWallet();
  const { t } = useI18n();
  const account = { name: w.account };
  const [copied, setCopied] = useState(false);

  // ---------- 设置金额 / 备注 ----------
  // 金额、备注都是空字符串 = 都没设置,二维码只编码账户名——扫码软件、别的
  // 钱包都认得,不用任何协议包装。只要设了其中一项,就升级成参考 TokenPocket
  // 收款码字段设计的结构化 JSON(见 https://help.tokenpocket.pro/developer-cn/scan-protocol)。
  // 这只是"参考格式",不是要跟 TP 互认——本机生成的码只需要本机的 ScanScreen
  // 扫得出来,所以在它的基础上加了 TP 那份原始设计里没有的 memo 字段(充值
  // 交易所之类的场景很常用得到,不能没有)。
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [amountModal, setAmountModal] = useState(false);
  const [amountDraft, setAmountDraft] = useState('');
  const [memoDraft, setMemoDraft] = useState('');

  const sym = w.client.config.symbol;
  const usdPrice = priceIn(w.prices, w.client.config.systemToken, sym);
  const amountNum = parseFloat(amount) || 0;
  const qrValue =
    amount || memo
      ? JSON.stringify({
          protocol: 'ScanProtocol',
          blockchain: 'EOS',
          action: 'transfer',
          address: account.name,
          amount: amount || undefined,
          memo: memo || undefined,
          symbol: sym,
          contract: w.client.config.systemToken,
          precision: w.client.config.precision,
        })
      : account.name;

  const openAmountModal = () => {
    setAmountDraft(amount);
    setMemoDraft(memo);
    setAmountModal(true);
  };
  const confirmAmount = () => {
    setAmount(sanitizeAmountInput(amountDraft));
    setMemo(memoDraft.trim());
    setAmountModal(false);
  };

  // ---------- 分享二维码卡片 ----------
  const cardRef = useRef<View>(null);
  const [shareModal, setShareModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  /** 把卡片截成一张本地 PNG,分享和保存两条路都要用 */
  const captureCard = () => captureRef(cardRef, { format: 'png', quality: 0.92 });

  const doShare = async () => {
    setBusy(true);
    try {
      const uri = await captureCard();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: t('receive.shareDialogTitle') });
      } else {
        // 极少数设备没有分享面板(部分 Web/精简 ROM)—— 退回纯文本分享,
        // 好歹把账户名传出去,而不是干脆报错卡死这条路
        await Share.share({ message: account.name });
      }
    } catch (e: any) {
      if (e?.message && !/user did not share|cancel/i.test(String(e.message))) {
        Alert.alert(t('receive.shareFailedTitle'), e?.message ?? t('send.unknownError'));
      }
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const uri = await captureCard();
      // 相册权限请求 + 实际保存都在这里面——原生走 expo-media-library,web 端
      // 走浏览器下载,两条实现分别在 receiveSave.ts / receiveSave.web.ts。
      const result = await saveImageToGallery(uri);
      if (!result.ok) {
        if (result.reason === 'denied') {
          Alert.alert(
            t('receive.galleryPermissionTitle'),
            result.canAskAgain ? t('receive.galleryPermissionBody') : t('receive.galleryPermissionDeniedBody')
          );
        } else {
          Alert.alert(t('receive.saveFailedTitle'), result.message ?? t('send.unknownError'));
        }
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e: any) {
      Alert.alert(t('receive.saveFailedTitle'), e?.message ?? t('send.unknownError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <LinearGradient colors={['#4FB0FF', '#1E7BFF']} start={{ x: 0, y: 0 }} end={{ x: 0.6, y: 1 }} style={styles.root}>
      {/* 头部 */}
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={styles.side}>
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>{t('receive.title')}</Text>
        <View style={styles.side} />
      </View>

      {/* 白卡 */}
      <View style={styles.card}>
        <View style={styles.qrWrap}>
          <QRCode value={qrValue} size={216} color="#3A3A3A" backgroundColor="#fff" />
          <View style={styles.qrBadge}>
            <Text style={styles.qrBadgeTxt}>A</Text>
          </View>
        </View>

        {/* 设了金额/备注才显示对应的标签——各带一个可以直接清掉的叉号,不用重新打开弹窗改成空 */}
        {amount || memo ? (
          <View style={styles.amountRow}>
            {amount ? (
              <View style={styles.amountPill}>
                <Text style={styles.amountTxt}>
                  {amount} {sym}
                </Text>
                <TouchableOpacity hitSlop={8} onPress={() => setAmount('')}>
                  <Ionicons name="close-circle" size={16} color={colors.textFaint} />
                </TouchableOpacity>
              </View>
            ) : null}
            {amount && usdPrice > 0 ? <Text style={styles.amountUsd}>≈ ${(amountNum * usdPrice).toFixed(4)}</Text> : null}
            {memo ? (
              <View style={styles.amountPill}>
                <Text style={styles.amountTxt} numberOfLines={1}>
                  {t('receive.memoLabel', { memo })}
                </Text>
                <TouchableOpacity hitSlop={8} onPress={() => setMemo('')}>
                  <Ionicons name="close-circle" size={16} color={colors.textFaint} />
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.receiver}>
          <Text style={styles.receiverLabel}>{t('receive.account')}</Text>
          <Text style={styles.receiverName} selectable>
            {account.name}
          </Text>
        </View>

        <View style={styles.actions}>
          <Action icon="share" label={t('receive.share')} onPress={() => setShareModal(true)} />
          <View style={styles.vline} />
          <Action
            icon="copy"
            label={copied ? t('wallet.copied') : t('receive.copy')}
            onPress={async () => {
              await Clipboard.setStringAsync(account.name);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          />
          <View style={styles.vline} />
          <Action icon="edit-2" label={amount || memo ? t('receive.editAmount') : t('receive.setAmount')} onPress={openAmountModal} />
        </View>
      </View>

      <Text style={styles.brand}>{BRAND_NAME}</Text>

      {/* 设置金额 */}
      <CenterDialog visible={amountModal} onClose={() => setAmountModal(false)} padding={0}>
        <View style={styles.dialogCard}>
          <Text style={styles.dialogTitle}>{t('receive.setAmount')}</Text>
          <TextInput
            value={amountDraft}
            onChangeText={(v) => setAmountDraft(sanitizeAmountInput(v))}
            placeholder="0.0"
            placeholderTextColor={colors.textFaint}
            keyboardType="decimal-pad"
            style={styles.dialogInput}
            autoFocus
          />
          <TextInput
            value={memoDraft}
            onChangeText={setMemoDraft}
            placeholder="Memo"
            placeholderTextColor={colors.textFaint}
            style={[styles.dialogInput, styles.dialogMemoInput]}
            autoCapitalize="none"
          />
          <View style={styles.dialogLine} />
          <View style={styles.dialogBtns}>
            <TouchableOpacity style={styles.dialogBtn} onPress={() => setAmountModal(false)}>
              <Text style={styles.dialogCancelTxt}>{t('send.cancel')}</Text>
            </TouchableOpacity>
            <View style={styles.dialogVline} />
            <TouchableOpacity style={styles.dialogBtn} onPress={confirmAmount}>
              <Text style={styles.dialogConfirmTxt}>{t('send.confirm')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </CenterDialog>

      {/* 分享二维码卡片 —— 截的是下面这张卡,不含警示条/操作按钮这些交互元素 */}
      <BottomSheet visible={shareModal} onClose={() => setShareModal(false)} closeOnBackdrop={!busy} backdropColor="rgba(0,0,0,0.5)">
          <View style={[styles.shareSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.shareHead}>
              <View style={{ width: 30 }} />
              <Text style={styles.shareTitle}>{t('receive.qrTitle')}</Text>
              <TouchableOpacity hitSlop={8} onPress={() => setShareModal(false)} disabled={busy} style={{ width: 30, alignItems: 'flex-end' }}>
                <Ionicons name="close" size={22} color={busy ? colors.textFaint : colors.text} />
              </TouchableOpacity>
            </View>

            <View ref={cardRef} collapsable={false} style={styles.shareCard}>
              <View style={styles.qrWrap}>
                <QRCode value={qrValue} size={200} color="#3A3A3A" backgroundColor="#fff" />
                <View style={styles.qrBadge}>
                  <Text style={styles.qrBadgeTxt}>A</Text>
                </View>
              </View>
              {amount ? (
                <Text style={styles.shareAmount}>
                  {amount} {sym}
                </Text>
              ) : null}
              {memo ? <Text style={styles.shareMemo}>{t('receive.memoLabel', { memo })}</Text> : null}
              <View style={styles.receiver}>
                <Text style={styles.receiverLabel}>{t('receive.account')}</Text>
                <Text style={styles.receiverName}>{account.name}</Text>
              </View>
              <Text style={styles.shareBrand}>{BRAND_NAME}</Text>
            </View>

            <View style={styles.shareBtnRow}>
              <TouchableOpacity style={[styles.shareBtn, styles.shareBtnOutline]} onPress={doSave} disabled={busy} activeOpacity={0.8}>
                {busy ? (
                  <ActivityIndicator color="#1E88FF" size="small" />
                ) : (
                  <Text style={styles.shareBtnOutlineTxt}>{saved ? t('receive.saved') : t('receive.saveImage')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.shareBtn} onPress={doShare} disabled={busy} activeOpacity={0.8}>
                {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.shareBtnTxt}>{t('receive.share')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
      </BottomSheet>
    </LinearGradient>
  );
}

function Action({ icon, label, onPress }: { icon: any; label: string; onPress?: () => void }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} activeOpacity={0.6}>
      <Feather name={icon} size={19} color={colors.text} />
      <Text style={styles.actionTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 10 },
  side: { width: 44, alignItems: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: '#fff' },

  card: {
    backgroundColor: '#fff',
    marginHorizontal: spacing.lg,
    marginTop: 8,
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
  },

  qrWrap: { marginTop: 4, alignItems: 'center', justifyContent: 'center' },
  qrBadge: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1E88FF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#fff',
  },
  qrBadgeTxt: { color: '#fff', fontSize: 18, fontWeight: '800' },

  amountRow: { alignItems: 'center', marginTop: 14, gap: 4 },
  amountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F2F3F5',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  amountTxt: { fontSize: 15, fontWeight: '700', color: colors.text },
  amountUsd: { fontSize: 12.5, color: colors.textFaint },

  receiver: {
    alignSelf: 'stretch',
    backgroundColor: '#F5F6F8',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 26,
  },
  receiverLabel: { fontSize: 14.5, color: colors.textFaint },
  receiverName: { fontSize: 17, color: colors.text, marginTop: 6 },

  actions: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', marginTop: 18 },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 8 },
  actionTxt: { fontSize: 15, color: colors.text },
  vline: { width: StyleSheet.hairlineWidth, height: 20, backgroundColor: '#DFE2E8' },

  brand: {
    marginTop: 'auto',
    marginBottom: 24,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.45)',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 2,
  },

  // 设置金额弹窗
  dialogCard: { width: 280, backgroundColor: colors.white, borderRadius: 14, overflow: 'hidden' },
  dialogTitle: { fontSize: 16.5, fontWeight: '700', color: colors.text, textAlign: 'center', paddingTop: 18, paddingBottom: 4 },
  dialogInput: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 16,
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    height: 44,
    paddingHorizontal: 14,
    fontSize: 16,
    color: colors.text,
    textAlign: 'center',
    outlineStyle: 'none' as any,
  },
  dialogMemoInput: { marginTop: 0, textAlign: 'left', fontSize: 14 },
  dialogLine: { height: StyleSheet.hairlineWidth, backgroundColor: '#E6E8EC' },
  dialogBtns: { flexDirection: 'row', height: 48 },
  dialogBtn: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dialogVline: { width: StyleSheet.hairlineWidth, backgroundColor: '#E6E8EC' },
  dialogCancelTxt: { fontSize: 16, color: '#F0644E' },
  dialogConfirmTxt: { fontSize: 16, color: '#1E88FF', fontWeight: '600' },

  // 分享二维码卡片
  shareSheet: { backgroundColor: '#F2F3F5', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: spacing.md },
  shareHead: { flexDirection: 'row', alignItems: 'center', height: 52 },
  shareTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: colors.text },
  shareCard: { backgroundColor: colors.white, borderRadius: 14, padding: 20, alignItems: 'center', marginTop: 4 },
  shareAmount: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 12 },
  shareMemo: { fontSize: 13, color: colors.textSub, marginTop: 4 },
  shareBrand: { marginTop: 16, fontSize: 13, fontWeight: '800', letterSpacing: 1.5, color: colors.textFaint },

  shareBtnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  shareBtn: { flex: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E88FF' },
  shareBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '600' },
  shareBtnOutline: { backgroundColor: colors.white, borderWidth: 1.5, borderColor: '#1E88FF' },
  shareBtnOutlineTxt: { color: '#1E88FF', fontSize: 15.5, fontWeight: '600' },
});
