import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, Alert, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useSigningGuard } from '../chain/useSigningGuard';
import { useWallet } from '../chain/WalletContext';
import { TokenBalance } from '../chain/client';
import { fmtAmount, sanitizeAmountInput } from '../chain/format';
import TokenPickerSheet from '../components/TokenPickerSheet';
import SelectWalletSheet from '../components/SelectWalletSheet';
import ConfirmTxSheet from '../components/ConfirmTxSheet';
import { accountNameError, isValidAccountName } from '../chain/account';
import { ActionSpec, Signer, buildTransfer, transact } from '../chain/transact';
import { recordRecentRecipient } from '../chain/recentRecipients';
import { useResourceRepair } from '../components/ResourceRepairSheet';
import { signingPermission } from '../crypto/vault';
import { biometricSigner, passkeySigner, passwordSigner } from '../chain/signers';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';
const isAccount = isValidAccountName;

export default function SendScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, 'Send'>>();

  const w = useWallet();
  const { t } = useI18n();
  const [token, setToken] = useState<TokenBalance>(
    route.params?.token ?? w.tokens[0] ?? { symbol: w.client.config.symbol, contract: w.client.config.systemToken, amount: 0, precision: 4, raw: '' }
  );
  const scanned = route.params?.scanned;
  const [to, setTo] = useState(scanned?.account ?? '');
  const [amount, setAmount] = useState(scanned?.amount ? sanitizeAmountInput(scanned.amount) : '');
  const [memo, setMemo] = useState(scanned?.memo ?? '');

  // 扫码返回后回填收款方 / 金额 / Memo
  React.useEffect(() => {
    if (!scanned) return;
    setTo(scanned.account);
    if (scanned.amount) setAmount(sanitizeAmountInput(scanned.amount));
    if (scanned.memo) setMemo(scanned.memo);
    // TP ScanProtocol 这类结构化码带了 symbol/contract,能在本机余额里找到
    // 匹配的代币就顺手切过去——不然明明码里写的是别的代币,页面却还留在
    // 上一次选的那个上,金额栏跟代币对不上。找不到(比如收款方要的代币本机
    // 没有余额)就不动,金额/收款方依然回填,只是代币选择留给用户自己弄清楚。
    if (scanned.symbol && scanned.contract) {
      const match = w.tokens.find((t) => t.symbol === scanned.symbol && t.contract === scanned.contract);
      if (match) setToken(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned]);
  const [tokenSheet, setTokenSheet] = useState(false);
  const [walletSheet, setWalletSheet] = useState(false);
  const [confirm, setConfirm] = useState<ActionSpec[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  // 广播因资源不够失败时的一键修复弹窗;用户不修就把失败原因回填到确认弹窗上
  const repair = useResourceRepair(w, { onCancel: setTxErr });

  // 选中的 token 可能是进页面时的快照(路由参数/刚转完账)——余额校验和
  // 「全部」按钮必须以刷新后的实时数据为准,不然会放行超出实际余额的金额,
  // 或者转完一笔再点「全部」还是旧余额。找不到实时行(余额已清零)按 0 算。
  const liveToken = w.tokens.find((tk) => tk.contract === token.contract && tk.symbol === token.symbol) ?? {
    ...token,
    amount: w.status === 'ready' ? 0 : token.amount,
  };
  const amt = parseFloat(amount) || 0;
  const ok = amt > 0 && amt <= liveToken.amount && isAccount(to);
  const wallet = w.currentWallet;
  const isPasskey = wallet?.source === 'passkey';
  // 本机密钥(明文私钥/助记词或 passkey)均可在任意网络签名广播,含主网
  const canSign = !!wallet;
  // 按这条钱包记录导入时标记的权限走,不再一律硬编码 active——
  // 用户在钱包列表里选中的是哪张卡(active/owner),这里签的就是哪个权限
  const permission = signingPermission(wallet);
  const signingGuard = useSigningGuard(JSON.stringify([wallet?.id, wallet?.publicKey, w.chainId,
    w.node.url, w.account, permission]), confirm, () => setConfirm(null));

  /** 第一步:本地构建交易,展示实际上链内容 */
  const review = () => {
    setTxErr(null);
    try {
      const action = buildTransfer({
        contract: token.contract,
        from: w.account,
        to,
        amount: amt,
        symbol: token.symbol,
        precision: token.precision,
        memo,
      });
      setConfirm([action]);
      repair.prepare(permission);
    } catch (e: any) {
      Alert.alert(t('send.buildFailedTitle'), e?.message ?? t('send.unknownError'));
    }
  };

  /** 第三步:拿到签名者后的共同流程 —— 密码、生物识别、passkey 三条路都走这里 */
  const broadcast = async (getSigner: () => Promise<Signer>) => {
    if (!confirm || !wallet) return;
    const attempt = signingGuard.begin();
    if (!attempt) return;
    setBusy(true);
    setTxErr(null);
    let signer: Signer | null = null;
    try {
      signer = await getSigner();
      if (!attempt.isCurrent()) return;
      const res = await transact({ chainId: w.chainId, node: w.node, actor: w.account, signer, permission, actions: confirm, isCurrent: attempt.isCurrent });
      setConfirm(null);
      // 「选择钱包 → 最近」只列用户在这里亲手转过的收款方,见 recentRecipients.ts。
      // 记录失败不影响已经上链的转账,静默忽略
      recordRecentRecipient(w.chainId, to).catch(() => {});
      // 转完就把表单清空:留着上一笔的收款方和金额,再点一次「确认」就是原样重转一笔,
      // 很容易误操作;代币选择保留,连续给不同人转同一个币不用重选
      setTo('');
      setAmount('');
      setMemo('');
      Alert.alert(t('send.txBroadcastTitle'), `TxID\n${res.txId}`, [
        { text: t('send.viewExplorer'), onPress: () => Linking.openURL(res.explorerUrl) },
        { text: t('send.done'), onPress: () => w.refresh() },
      ]);
    } catch (e: any) {
      // 资源不够(CPU/NET、RAM):弹一键修复,复用刚拿到手的 signer,不再让用户认证一遍
      if (attempt.isCurrent() && !repair.offer(e, signer, permission)) setTxErr(e?.message ?? t('send.signOrBroadcastFailed'));
    } finally {
      attempt.finish();
      setBusy(false);
    }
  };

  const submit = (password: string) =>
    broadcast(passwordSigner(wallet!, password));
  const submitBiometric = () =>
    broadcast(biometricSigner(wallet!));
  const submitPasskey = () =>
    broadcast(passkeySigner(wallet!));

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* 头部 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={styles.side}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('send.title')}</Text>
        <View style={styles.side} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* 收款方 */}
        <View style={styles.labelRow}>
          <Text style={styles.label}>{t('send.recipient')}</Text>
          <TouchableOpacity style={styles.labelAction} onPress={() => setWalletSheet(true)}>
            <Text style={styles.labelActionTxt}>{t('send.selectWallet')}</Text>
            <Ionicons name="chevron-forward" size={15} color={BLUE} />
          </TouchableOpacity>
        </View>
        <View style={styles.card}>
          <View style={styles.inputRow}>
            <TextInput
              value={to}
              onChangeText={(v) => setTo(v.toLowerCase())}
              placeholder={t('send.recipientPlaceholder')}
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              autoCapitalize="none"
              maxLength={12}
            />
            <TouchableOpacity hitSlop={8} onPress={() => nav.navigate('Scan', { returnTo: 'Send' })}>
              <Ionicons name="scan-outline" size={23} color={colors.text} />
            </TouchableOpacity>
          </View>
          {to.length > 0 && !isAccount(to) ? (
            <Text style={styles.err}>{accountNameError(to) ?? t('send.invalidAccount')}</Text>
          ) : null}
        </View>

        {/* 数量 */}
        <View style={styles.labelRow}>
          <Text style={styles.label}>{t('send.amount')}</Text>
          <TouchableOpacity style={styles.labelAction} onPress={() => setTokenSheet(true)}>
            <Text style={styles.tokenTxt}>{token.symbol}</Text>
            <Ionicons name="chevron-forward" size={15} color={colors.textSub} />
          </TouchableOpacity>
        </View>
        <View style={styles.card}>
          <View style={styles.inputRow}>
            <TextInput
              value={amount}
              onChangeText={(v) => setAmount(sanitizeAmountInput(v))}
              placeholder={t('send.amountPlaceholder')}
              placeholderTextColor={colors.textFaint}
              keyboardType="decimal-pad"
              style={styles.input}
            />
            <TouchableOpacity style={styles.allBtn} onPress={() => setAmount(String(liveToken.amount))}>
              <Text style={styles.allTxt}>{t('send.all')}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.divider} />
          <View style={styles.balRow}>
            <Text style={styles.balK}>{t('send.balance')}</Text>
            <Text style={styles.balV}>
              {fmtAmount(liveToken.amount, liveToken.precision)} {liveToken.symbol}
            </Text>
          </View>
        </View>

        {/* Memo */}
        <View style={styles.card}>
          <Text style={styles.memoLabel}>Memo</Text>
          <TextInput
            value={memo}
            onChangeText={setMemo}
            placeholder={t('send.memoPlaceholder')}
            placeholderTextColor={colors.textFaint}
            style={styles.memoInput}
            autoCapitalize="none"
          />
        </View>
      </ScrollView>

      {/* 底部确认 */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={[styles.cta, (!ok || !canSign) && styles.ctaOff]}
          disabled={!ok || !canSign}
          activeOpacity={0.85}
          onPress={review}
        >
          <Text style={styles.ctaTxt}>{t('send.confirm')}</Text>
        </TouchableOpacity>
        <Text style={styles.demoNote}>
          {!wallet
            ? t('send.readOnlyHint')
            : isPasskey
            ? t('send.passkeyBroadcastHint', { chain: w.client.config.name })
            : t('send.broadcastHint', { chain: w.client.config.name })}
        </Text>
      </View>

      <ConfirmTxSheet
        visible={confirm !== null}
        onClose={() => setConfirm(null)}
        actions={confirm ?? []}
        chainName={w.client.config.name}
        testnet={w.client.config.testnet}
        actor={w.account}
        permission={permission}
        busy={busy}
        error={txErr}
        walletId={wallet?.id}
        passkey={isPasskey}
        onConfirm={submit}
        onConfirmBiometric={submitBiometric}
        onConfirmPasskey={submitPasskey}
      />
      {repair.element}
      <TokenPickerSheet visible={tokenSheet} onClose={() => setTokenSheet(false)} onPick={setToken} />
      <SelectWalletSheet
        visible={walletSheet}
        onClose={() => setWalletSheet(false)}
        onPick={setTo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 48 },
  side: { width: 44, alignItems: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },

  scroll: { paddingHorizontal: spacing.md, paddingBottom: 20 },

  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: 14,
    marginBottom: 8,
  },
  label: { fontSize: 16, color: colors.text },
  labelAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  labelActionTxt: { fontSize: 15.5, color: BLUE },
  tokenTxt: { fontSize: 15.5, color: colors.textSub },

  card: { backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 16, marginBottom: 4 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 60 },
  input: { flex: 1, fontSize: 16, color: colors.text, padding: 0, outlineStyle: 'none' as any },
  err: { color: '#F04438', fontSize: 12.5, paddingBottom: 12 },

  allBtn: { borderWidth: 1, borderColor: BLUE, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 5 },
  allTxt: { color: BLUE, fontSize: 14.5 },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: '#E9EBEF' },
  balRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 56 },
  balK: { fontSize: 15.5, color: colors.text },
  balV: { fontSize: 15.5, color: colors.text },

  memoLabel: { fontSize: 15.5, color: colors.text, marginTop: 18 },
  memoInput: {
    fontSize: 16,
    color: colors.text,
    paddingVertical: 12,
    paddingBottom: 20,
    padding: 0,
    outlineStyle: 'none' as any,
  },


  footer: { paddingHorizontal: spacing.md, paddingTop: 10, gap: 12, alignItems: 'center' },
  cta: {
    alignSelf: 'stretch',
    height: 52,
    borderRadius: 26,
    backgroundColor: BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaOff: { backgroundColor: '#A9C9F5' },
  ctaTxt: { color: '#fff', fontSize: 17, fontWeight: '500' },
  timedTxt: { color: BLUE, fontSize: 15 },
  demoNote: { color: colors.textFaint, fontSize: 11 },
});
