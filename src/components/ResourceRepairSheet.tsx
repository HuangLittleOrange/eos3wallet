import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { colors, spacing } from '../theme';
import type { ChainClient } from '../chain/client';
import type { ChainId, NodeInfo } from '../chain/config';
import type { RamPurchaseQuote } from '../chain/ramPricing';
import { sanitizeAmountInput } from '../chain/format';
import { estimateTransfersForPayment, type PowerupMarket } from '../chain/powerupPricing';
import {
  POWERUP_TOPUP_DEFAULT,
  RAM_TOPUP_BYTES,
  buildPowerupTopUp,
  buildRamTopUp,
  exceedsBalance,
  formatPayment,
  sumAssets,
} from '../chain/resourceRepair';
import { CpuNetExhaustedError, RamExhaustedError, SponsorFeeChangedError, toBroadcastError, friendlyChainErrorMessage } from '../chain/sponsor';
import { getResourceRepairMarket, refreshResourceRepairFee } from '../chain/resourceRepairQuote';
import { getCachedSponsorFee } from '../chain/sponsorFeeCache';
import { sponsoredTransact, transact, type Signer } from '../chain/transact';
import { useI18n } from '../i18n';
import { useSigningGuard } from '../chain/useSigningGuard';
import { shouldInvalidateBackground } from '../crypto/systemAuthentication';

const BLUE = '#1E88FF';

type RepairKind = 'cpuNet' | 'ram';

type RepairRequest = {
  context: string;
  kind: RepairKind;
  /** 刚才那笔失败的交易已经拿到手的签名者——复用它,不再让用户认证一遍 */
  signer: Signer;
  permission: string;
  /** 失败原因的可读文案;用户不修就关掉弹窗时回填到原来的确认弹窗上 */
  message: string;
};

type RepairWallet = {
  currentWallet?: { id: string } | null;
  chainId: ChainId;
  node: NodeInfo;
  account: string;
  client: ChainClient;
};

/**
 * 「签名广播失败 → 一键买资源」弹窗。所有会签名广播的页面都挂一份(见
 * useResourceRepair):broadcast 的 catch 里把错误交给 offer(),是资源类错误
 * 就弹这个,让用户当场买好资源;买完提示"回到确认弹窗再点一次"——不替用户
 * 自动重发原交易。
 *
 * CPU/NET:用户自己出钱买 PowerUp,金额可改,默认 0.01;这笔交易走 Sponsor 代付
 *          (用户没 CPU 发不出去),另收一笔代付费,两者合计显示为"资源费用"。
 *          余额付不起合计就直接说,不给按钮。
 * RAM:    买 1KB,直接广播,不收服务费。若缺 CPU/NET,展示两笔的费用,
 *          用户确认后先买 PowerUp,再自动直连买 RAM,不重发原交易。
 */
export function useResourceRepair(w: RepairWallet, opts: { onCancel?: (message: string) => void } = {}) {
  const [request, setRequest] = useState<RepairRequest | null>(null);
  const context = JSON.stringify([w.currentWallet?.id, w.chainId, w.node.url, w.account]);
  useEffect(() => { setRequest(null); }, [context]);
  useEffect(() => {
    const timer = request ? setTimeout(() => setRequest(null), 60_000) : undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && shouldInvalidateBackground()) setRequest(null);
    });
    return () => { if (timer) clearTimeout(timer); subscription.remove(); };
  }, [request]);

  const offer = useCallback((err: unknown, signer: Signer | null | undefined, permission: string): boolean => {
    if (!signer) return false;
    const error = toBroadcastError(err);
    const message = error.message;
    if (error instanceof RamExhaustedError) {
      setRequest({ kind: 'ram', signer, permission, message, context });
      return true;
    }
    if (error instanceof CpuNetExhaustedError) {
      setRequest({ kind: 'cpuNet', signer, permission, message, context });
      return true;
    }
    return false;
  }, [context]);

  const prepare = useCallback((permission: string) => {
    // 确认交易时后台预取,不拦截正常签名,失败时弹窗仍可重新请求。
    getResourceRepairMarket(w.client).catch(() => {});
    refreshResourceRepairFee(w.client, w.account, permission).catch(() => {});
  }, [w.client, w.account]);

  const onCancel = opts.onCancel;
  const dismiss = useCallback(
    (repaired: boolean) => {
      setRequest((current) => {
        if (current && !repaired) onCancel?.(current.message);
        return null;
      });
    },
    [onCancel]
  );

  const element = <ResourceRepairSheet request={request?.context === context ? request : null} onDismiss={dismiss} w={w} />;
  return { offer, prepare, element };
}

function ResourceRepairSheet({
  request,
  onDismiss,
  w,
}: {
  request: RepairRequest | null;
  onDismiss: (repaired: boolean) => void;
  w: RepairWallet;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const cfg = w.client.config;
  const signingGuard = useSigningGuard(JSON.stringify([w.currentWallet?.id, w.chainId,
    w.node.url, w.account, request?.permission]), request);

  const [kind, setKind] = useState<RepairKind>('cpuNet');
  const [amount, setAmount] = useState(POWERUP_TOPUP_DEFAULT);
  const [market, setMarket] = useState<PowerupMarket | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  /** Sponsor 报的代付费;null = 还没问到,'' = 免费 */
  const [fee, setFee] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [ramQuote, setRamQuote] = useState<RamPurchaseQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [powerupTxId, setPowerupTxId] = useState<string | null>(null);
  const needsRam = request?.kind === 'ram';

  // 每次打开重置界面,报价由下方的预取缓存加载,输入恢复默认预算。
  useEffect(() => {
    if (!request) return;
    setKind(request.kind);
    setAmount(POWERUP_TOPUP_DEFAULT);
    setMarket(null);
    setBalance(null);
    setFee(null);
    setRamQuote(null);
    setErr(null);
    setNotice(null);
    setPowerupTxId(null);
  }, [request]);

  // RAM 报价和余额加载失败时保留弹窗,展示重试,费用未就绪前不能购买。
  useEffect(() => {
    if (!request) return;
    let alive = true;
    // 余额从 get_currency_balance 拿——get_account 的 core_liquid_balance 在
    // Vaulta 上不认 core.vaulta 的 A,不能用
    const balanceRequest = w.client.getBalance(cfg.systemToken, w.account, cfg.symbol)
      .then((rows) => { if (alive) setBalance(rows[0]?.raw ?? formatPayment(0, cfg.symbol, cfg.precision)); });
    const ramRequest = needsRam ? w.client.getRamQuote(RAM_TOPUP_BYTES).then((quote) => {
      if (alive) setRamQuote(quote);
    }) : Promise.resolve();
    Promise.all([balanceRequest, ramRequest]).catch((e) => { if (alive) setErr(friendlyChainErrorMessage(e)); });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, quoteAttempt]);

  // 每日代付费独立于市场曲线。已有缓存立即显示,过期时后台刷新;
  // 交易只在用户点击充值时构建,并核对用户在此看到的代付费。
  useEffect(() => {
    if (!request || kind !== 'cpuNet') {
      setQuoting(false);
      return;
    }
    let alive = true;
    setQuoting(true);
    (async () => {
      try {
        const loadFee = async () => {
          const cached = await getCachedSponsorFee(w.chainId);
          const refresh = refreshResourceRepairFee(w.client, w.account, request.permission);
          if (cached) {
            if (alive) setFee(cached.fee);
            refresh.then((snapshot) => {
              if (!alive) return;
              setFee(snapshot.fee);
              if (snapshot.fee !== cached.fee) setNotice(t('repair.feeChanged'));
            }).catch(() => {});
          } else {
            const snapshot = await refresh;
            if (alive) setFee(snapshot.fee);
          }
        };
        await Promise.all([
          getResourceRepairMarket(w.client).then((m) => { if (alive) setMarket(m); }),
          loadFee(),
        ]);
      } catch (e: any) {
        if (alive) setErr(friendlyChainErrorMessage(e));
      } finally {
        if (alive) setQuoting(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, kind, quoteAttempt]);

  const payment = parseFloat(amount) || 0;
  const transfers = market && payment > 0 ? estimateTransfersForPayment(market, payment, cfg.precision) : null;
  const powerupCost = payment > 0 ? formatPayment(payment, cfg.symbol, cfg.precision) : null;
  const ramCost = ramQuote?.total ?? null;
  const powerupTotal = powerupCost && fee !== null ? (fee ? sumAssets(powerupCost, fee) : powerupCost) : null;
  const total = kind === 'ram' ? ramCost : needsRam
    ? (powerupTotal && ramCost ? sumAssets(powerupTotal, ramCost) : null) : powerupTotal;
  const insufficient = total !== null && exceedsBalance(total, balance);
  const canBuyPowerup = !busy && !quoting && !!market && (transfers ?? 0) > 0 && total !== null && balance !== null && !insufficient;
  const canBuyRam = !busy && ramCost !== null && balance !== null && !insufficient;

  const purchaseRam = async (isCurrent: () => boolean) => {
    if (!request || !isCurrent()) return;
    // RAM 始终直连广播,不走 Sponsor,没有钱包服务费。
    const res = await transact({
      chainId: w.chainId, node: w.node, actor: w.account,
      signer: request.signer, permission: request.permission,
      actions: [buildRamTopUp({ actor: w.account, contract: cfg.resourceContract })],
      isCurrent,
    });
    if (!isCurrent()) return;
    onDismiss(true);
    Alert.alert(t('repair.ramDoneTitle'), t('repair.ramDoneBody', { txId: res.txId }));
  };

  const buyPowerup = async () => {
    if (!request || !market || !canBuyPowerup) return;
    const attempt = signingGuard.begin();
    if (!attempt) return;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const { action } = buildPowerupTopUp({
        market,
        payment,
        actor: w.account,
        contract: cfg.resourceContract,
        symbol: cfg.symbol,
        precision: cfg.precision,
      });
      const res = await sponsoredTransact({
        chainId: w.chainId,
        node: w.node,
        actor: w.account,
        signer: request.signer,
        permission: request.permission,
        actions: [action],
        approvedFee: fee || undefined,
        isCurrent: attempt.isCurrent,
      });
      if (!attempt.isCurrent()) return;
      if (needsRam) {
        // 先记录已购买的 PowerUp。后续失败只重试 RAM,不再购买 PowerUp。
        setPowerupTxId(res.txId);
        setKind('ram');
        setNotice(t('repair.powerupReadyForRam', { txId: res.txId }));
        // 先前余额已包含两笔预算;刷新仅用于失败后继续购买时的余额校验。
        w.client.getBalance(cfg.systemToken, w.account, cfg.symbol).then((rows) => {
          if (attempt.isCurrent()) setBalance(rows[0]?.raw ?? formatPayment(0, cfg.symbol, cfg.precision));
        }).catch(() => {});
        await purchaseRam(attempt.isCurrent);
        return;
      }
      onDismiss(true);
      Alert.alert(t('repair.powerupDoneTitle'), t('repair.powerupDoneBody', { days: market.powerupDays, txId: res.txId }));
    } catch (e: any) {
      if (!attempt.isCurrent()) return;
      if (e instanceof SponsorFeeChangedError) {
        setFee(e.fee);
        setNotice(t('repair.feeChanged'));
      } else {
        setErr(friendlyChainErrorMessage(e));
      }
    } finally {
      attempt.finish();
      setBusy(false);
    }
  };

  const buyRam = async () => {
    if (!request || !canBuyRam) return;
    const attempt = signingGuard.begin();
    if (!attempt) return;
    setBusy(true);
    setErr(null);
    if (!powerupTxId) setNotice(null);
    try {
      await purchaseRam(attempt.isCurrent);
    } catch (e: any) {
      if (!attempt.isCurrent()) return;
      if (e instanceof CpuNetExhaustedError && !powerupTxId) {
        // 新增 PowerUp 支出必须先展示完整费用并让用户确认。
        setKind('cpuNet');
        setNotice(t('repair.cpuNetForRam'));
      } else {
        setErr(friendlyChainErrorMessage(e));
      }
    } finally {
      attempt.finish();
      setBusy(false);
    }
  };

  const visible = request !== null;
  const close = () => (busy ? undefined : onDismiss(false));

  return (
    <BottomSheet visible={visible} onClose={close} closeOnBackdrop={!busy}>
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.head}>
          <View style={{ width: 30 }} />
          <Text style={styles.headTitle}>{kind === 'ram' ? t('repair.ramTitle') : t('repair.cpuNetTitle')}</Text>
          <TouchableOpacity hitSlop={8} onPress={close} disabled={busy} style={{ width: 30, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={24} color={busy ? colors.textFaint : colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
          <Text style={styles.body}>{kind === 'ram' ? t('repair.ramBody') : needsRam ? t('repair.powerupThenRamBody') : t('repair.cpuNetBody')}</Text>

          {notice ? (
            <View style={styles.noticeBox}>
              <Ionicons name="information-circle-outline" size={16} color="#7C6A00" />
              <Text style={styles.noticeTxt}>{notice}</Text>
            </View>
          ) : null}

          {kind === 'cpuNet' ? (
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.k}>{t('repair.amountLabel')}</Text>
                <View style={styles.amountBox}>
                  <TextInput
                    value={amount}
                    onChangeText={(v) => setAmount(sanitizeAmountInput(v))}
                    keyboardType="decimal-pad"
                    editable={!busy}
                    style={styles.amountInput}
                  />
                  <Text style={styles.sym}>{cfg.symbol}</Text>
                </View>
              </View>
              <Text style={styles.estimate}>
                {quoting && !market
                  ? t('repair.quoting')
                  : !market
                    ? t('resource.powerupMarketUnavailable')
                    : transfers && transfers > 0
                      ? t('resource.powerupUsage', { days: market.powerupDays })
                      : t('resource.estimateTooSmall')}
              </Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.totalK}>{t('repair.totalLine')}</Text>
              <Text style={styles.totalV}>{total ?? t('repair.quoting')}</Text>
            </View>
          </View>

          {needsRam ? <Text style={styles.body}>{t('repair.ramPricingHint')}</Text> : null}
          {insufficient ? (
            <View style={styles.errBox}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.red} />
              <Text style={styles.errTxt}>{t('repair.insufficientBalance', { balance: balance ?? '', total: total ?? '' })}</Text>
            </View>
          ) : null}

          {err ? (
            <View style={styles.errBox}>
              <Ionicons name="alert-circle-outline" size={16} color={colors.red} />
              <Text style={styles.errTxt}>{err}</Text>
            </View>
          ) : null}

          {err && (balance === null || (needsRam && ramCost === null) || (kind === 'cpuNet' && (!market || fee === null))) && !quoting ? (
            <TouchableOpacity onPress={() => { setErr(null); setQuoteAttempt((n) => n + 1); }}>
              <Text style={styles.headTitle}>{t('wallet.retryHint')}</Text>
            </TouchableOpacity>
          ) : null}

          {kind === 'cpuNet' ? (
            <TouchableOpacity style={[styles.cta, !canBuyPowerup && styles.ctaOff]} disabled={!canBuyPowerup} onPress={buyPowerup} activeOpacity={0.85}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>{needsRam ? t('repair.buyPowerupThenRam') : t('repair.buyPowerup')}</Text>}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.cta, !canBuyRam && styles.ctaOff]} disabled={!canBuyRam} onPress={buyRam} activeOpacity={0.85}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaTxt}>{t('repair.buyRam')}</Text>}
            </TouchableOpacity>
          )}
        </ScrollView>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    maxHeight: '90%',
    backgroundColor: '#F2F3F5',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: spacing.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', height: 56 },
  headTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },
  body: { fontSize: 13.5, lineHeight: 20, color: colors.textSub, marginBottom: 12 },

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, gap: 14 },
  k: { fontSize: 13.5, color: colors.textSub },
  totalK: { fontSize: 14, color: colors.text, fontWeight: '600' },
  totalV: { fontSize: 15, color: colors.text, fontWeight: '800' },
  amountBox: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F2F3F5', borderRadius: 8, paddingHorizontal: 10, height: 40 },
  amountInput: { minWidth: 90, textAlign: 'right', fontSize: 16, fontWeight: '700', color: colors.text, padding: 0 },
  sym: { fontSize: 13, color: colors.textSub, fontWeight: '600' },
  estimate: { fontSize: 12.5, color: colors.textSub, marginTop: 4 },

  noticeBox: { flexDirection: 'row', gap: 7, backgroundColor: '#FEF9E7', borderRadius: 8, padding: 12, marginBottom: 10 },
  noticeTxt: { flex: 1, fontSize: 13, color: '#7C6A00', fontWeight: '600', lineHeight: 19 },
  errBox: { flexDirection: 'row', gap: 8, backgroundColor: '#FEF0EE', borderRadius: 8, padding: 12, marginBottom: 10 },
  errTxt: { flex: 1, fontSize: 13, color: colors.red, lineHeight: 19 },

  cta: { height: 52, borderRadius: 26, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  ctaOff: { backgroundColor: '#A9C9F5' },
  ctaTxt: { color: '#fff', fontSize: 16.5, fontWeight: '600' },
});
