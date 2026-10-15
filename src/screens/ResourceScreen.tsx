import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { useSigningGuard } from '../chain/useSigningGuard';
import { useWallet } from '../chain/WalletContext';
import { useManualRefresh } from '../chain/useManualRefresh';
import { assetValue, fmtBytes, fmtUs } from '../chain/format';
import { PowerupMarket } from '../chain/client';
import { estimateTransfersForPayment, fracForResourceUnits, perTransferResourceWeights } from '../chain/powerupPricing';
import { accountNameError, isValidAccountName } from '../chain/account';
import ConfirmTxSheet from '../components/ConfirmTxSheet';
import RexOperations from '../components/RexOperations';
import { ActionSpec, Signer, transact } from '../chain/transact';
import { useResourceRepair } from '../components/ResourceRepairSheet';
import {
  buildBuyRam, buildDelegate, buildPowerUp, buildRamTransfer, buildSellRam, buildUndelegate,
} from '../chain/resourceActions';
import { signingPermission } from '../crypto/vault';
import { biometricSigner, passkeySigner, passwordSigner } from '../chain/signers';
import { useI18n, TranslationKey } from '../i18n';

const TABS = ['CPU/NET', 'RAM', 'REX'];
const BLUE = '#1E88FF';
const BAR_BLUE = '#8FB8FB';

export default function ResourceScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation();
  const w = useWallet();
  const { t } = useI18n();
  const { refreshing, onRefresh } = useManualRefresh(w.status, w.refresh);

  const [tab, setTab] = useState(0);
  const [mode, setMode] = useState(0);
  const [cpuIn, setCpuIn] = useState('');
  const [netIn, setNetIn] = useState('');
  const [ramIn, setRamIn] = useState('');
  const [confirm, setConfirm] = useState<ActionSpec[] | null>(null);
  const [confirmNotice, setConfirmNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const repair = useResourceRepair(w, { onCancel: setTxErr });

  // PowerUp 代充给其他账户——关闭时 receiver 就是自己,跟改动前的行为一致
  const [payToOther, setPayToOther] = useState(false);
  const [receiverIn, setReceiverIn] = useState('');

  // RAM「代买给其他账户」(买的时候用)和「转移」(把已有的 RAM 挪给别人)
  // 共用同一个收款账户输入框——两者互斥,同一时间 RAM 小档只会处在其中一种
  // 模式下,不会撞在一起
  const [ramBuyForOther, setRamBuyForOther] = useState(false);
  const [ramReceiverIn, setRamReceiverIn] = useState('');

  // PowerUp 定价曲线用来按预算分配购买权重。max_payment 限制实际支付金额;
  // 没有市场数据时无法构建按预算购买的请求。
  const [powerup, setPowerup] = useState<PowerupMarket | null>(null);
  useEffect(() => {
    let cancelled = false;
    w.client
      .getPowerupState()
      .then((s) => { if (!cancelled) setPowerup(s); })
      .catch(() => { if (!cancelled) setPowerup(null); });
    return () => {
      cancelled = true;
    };
  }, [w.client]);

  const r = w.resources;
  const sym = w.client.config.symbol;
  // Vaulta 主网上 delegatebw/buyram/powerup/REX 这几个资源 action 要打给
  // core.vaulta(不是 eosio)——它把 eosio 系统合约这套 action 镜像了一份,
  // 自己收 A、内部桥接兑换成 EOS 再转发给真正的 eosio 系统 action。
  const resourceContract = w.client.config.resourceContract;
  // r.coreBalance 来自 get_account 的 core_liquid_balance 字段,这个字段是
  // nodeos 查 eosio.token 算出来的,不认 core.vaulta——Vaulta 主网上账户的
  // A 余额全在 core.vaulta,这个字段永远是 "0.0000 EOS",不能用。改从已经
  // 查对了的 w.tokens(首页余额同一份数据)里按系统代币的 contract+symbol 找。
  const systemTokenBalance = w.tokens.find(
    (t) => t.contract === w.client.config.systemToken && t.symbol === w.client.config.symbol
  );
  const liquid = systemTokenBalance?.amount ?? 0;
  const wallet = w.currentWallet;
  const isPasskey = wallet?.source === 'passkey';
  // 本机密钥(明文私钥/助记词或 passkey)均可在任意网络签名广播,含主网
  const canSign = !!wallet;
  // 按当前选中的这条钱包记录标记的权限走,不再一律硬编码 active
  const permission = signingPermission(wallet);
  const signingGuard = useSigningGuard(JSON.stringify([wallet?.id, wallet?.publicKey, w.chainId,
    w.node.url, w.account, permission]), confirm, () => setConfirm(null));
  const prec = w.client.config.precision;

  // CPU/NET 按样本比例分配购买权重。estimatedTransfers 是内部组合单位,
  // 实际可完成的转账次数取决于交易消耗和网络负载,界面不展示这个值。
  const powerupPay = parseFloat(cpuIn) || 0;
  const transferWeights = useMemo(() => (powerup ? perTransferResourceWeights(powerup) : null), [powerup]);
  const estimatedTransfers = useMemo(
    () => (powerup ? estimateTransfersForPayment(powerup, powerupPay, prec) : null),
    [powerup, powerupPay, prec]
  );

  // RAM 买卖栏——买填的是花费金额(sym),卖填的是字节数(KB),两边单位不一样,
  // 输入完不换算一下用户根本不知道到底买/卖到多少,参照 TP 加一行实时估算
  const ramAmt = parseFloat(ramIn) || 0;
  const ramEstimateKb = mode === 0 && w.ramPricePerKb > 0 ? ramAmt / w.ramPricePerKb : 0;
  const ramEstimateProceeds = mode === 1 ? ramAmt * w.ramPricePerKb : 0;

  const receiverValid = !payToOther || isValidAccountName(receiverIn);
  // RAM 小档:0=买 1=卖 2=转移。卖不需要收款账户;买只在勾了「代买」时需要;
  // 转移本身就是冲着另一个账户去的,始终需要
  const ramReceiverValid =
    mode === 1 || (mode === 0 ? !ramBuyForOther || isValidAccountName(ramReceiverIn) : isValidAccountName(ramReceiverIn));

  /** PowerUp/抵押/赎回之间切换——代充开关和收款账户只对 PowerUp 有意义,离开就清空 */
  const setPowerupMode = (m: number) => {
    setMode(m);
    if (m !== 0) {
      setPayToOther(false);
      setReceiverIn('');
    }
  };

  /** RAM 买/卖/转移之间切换——代买开关和收款账户跟着小档清空,避免带着上一档的账户名切过去 */
  const setRamOpMode = (m: number) => {
    setMode(m);
    setRamBuyForOther(false);
    setRamReceiverIn('');
  };

  /** 构建资源操作交易并进入确认 */
  const review = (kind: string) => {
    setTxErr(null);
    setConfirmNotice(undefined);
    try {
      const num = (v: string) => parseFloat(v) || 0;
      let acts: ActionSpec[];
      if (kind === 'powerup') {
        // 按预算求得的组合单位反推出 CPU/NET 购买比例。
        const pay = num(cpuIn);
        if (!powerup || !transferWeights) throw new Error(t('resource.powerupMarketUnavailable'));
        const n = estimatedTransfers ?? 0;
        if (n <= 0) throw new Error(t('resource.estimateTooSmall'));
        const receiver = payToOther ? receiverIn.trim().toLowerCase() : w.account;
        acts = [buildPowerUp({
          contract: resourceContract, payer: w.account, receiver,
          cpuFrac: fracForResourceUnits(n * transferWeights.cpuWeight, powerup.cpu.weight),
          netFrac: fracForResourceUnits(n * transferWeights.netWeight, powerup.net.weight),
          maxPayment: pay, symbol: sym, precision: prec, days: powerup.powerupDays,
        })];
      } else if (kind === 'stake') {
        acts = [buildDelegate({ contract: resourceContract, from: w.account, receiver: w.account, cpu: num(cpuIn), net: num(netIn), symbol: sym, precision: prec })];
      } else if (kind === 'unstake') {
        acts = [buildUndelegate({ contract: resourceContract, from: w.account, receiver: w.account, cpu: num(cpuIn), net: num(netIn), symbol: sym, precision: prec })];
      } else if (kind === 'buyram') {
        const receiver = ramBuyForOther ? ramReceiverIn.trim().toLowerCase() : w.account;
        acts = [buildBuyRam({ contract: resourceContract, payer: w.account, receiver, quantity: num(ramIn), symbol: sym, precision: prec })];
      } else if (kind === 'sellram') {
        acts = [buildSellRam({ contract: resourceContract, account: w.account, bytes: num(ramIn) * 1024 })];
      } else if (kind === 'ramtransfer') {
        acts = [buildRamTransfer({ contract: resourceContract, from: w.account, to: ramReceiverIn.trim().toLowerCase(), bytes: num(ramIn) * 1024 })];
      } else {
        throw new Error(t('send.unknownError'));
      }
      setConfirm(acts);
    } catch (e: any) {
      Alert.alert(t('send.buildFailedTitle'), e?.message ?? t('send.unknownError'));
    }
  };

  /** 拿到签名者后的共同流程 —— 密码、生物识别、passkey 三条路都走这里 */
  const broadcast = async (getSigner: () => Promise<Signer>) => {
    if (!confirm || !wallet) return;
    const attempt = signingGuard.begin();
    if (!attempt) return;
    setBusy(true); setTxErr(null);
    let signer: Signer | null = null;
    try {
      signer = await getSigner();
      if (!attempt.isCurrent()) return;
      const res = await transact({ chainId: w.chainId, node: w.node, actor: w.account, signer, permission, actions: confirm, isCurrent: attempt.isCurrent });
      setConfirm(null);
      Alert.alert(t('send.txBroadcastTitle'), `TxID\n${res.txId}`, [
        { text: t('send.viewExplorer'), onPress: () => Linking.openURL(res.explorerUrl) },
        { text: t('send.done'), onPress: () => w.refresh() },
      ]);
    } catch (e: any) {
      if (attempt.isCurrent() && !repair.offer(e, signer, permission)) setTxErr(e?.message ?? t('send.signOrBroadcastFailed'));
    } finally {
      attempt.finish(); setBusy(false); }
  };

  const submit = (password: string) =>
    broadcast(passwordSigner(wallet!, password));
  const submitBiometric = () =>
    broadcast(biometricSigner(wallet!));
  const submitPasskey = () =>
    broadcast(passkeySigner(wallet!));

  return (
    <View style={styles.root}>
      <View style={{ height: insets.top, backgroundColor: colors.white }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        {TABS.map((t, i) => (
          <TouchableOpacity
            key={t}
            onPress={() => {
              if (i === tab) return;
              setTab(i);
              // mode 是三个大 tab 共用的一份状态:CPU/NET 有 3 个小档,RAM/REX 只有
              // 2 个——带着 mode=2 切过去会两个小档都不高亮、提交还走错分支;
              // 输入框内容也是上一个 tab 语义下的数字,一并清掉
              setMode(0);
              setCpuIn('');
              setNetIn('');
              setRamIn('');
              setPayToOther(false);
              setReceiverIn('');
              setRamBuyForOther(false);
              setRamReceiverIn('');
            }}
            style={styles.headerTab}
          >
            <Text style={[styles.headerTabTxt, tab === i && styles.headerTabTxtActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BLUE} />}
      >
        {!r ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={BLUE} />
            <Text style={styles.loadingTxt}>
              {w.status === 'error' ? w.error : t('resource.loadingResources')}
            </Text>
          </View>
        ) : tab === 0 ? (
          <>
            <OpCard
              tabs={['PowerUp', t('resource.stake'), t('resource.unstake')]}
              mode={mode}
              setMode={setPowerupMode}
              balance={t('resource.balance', { balance: `${liquid.toFixed(4)} ${sym}` })}
              rows={
                mode === 0
                  ? [{ label: t('resource.maxPay'), value: cpuIn, onChange: setCpuIn, unit: sym }]
                  : [
                      { label: 'CPU', value: cpuIn, onChange: setCpuIn },
                      { label: 'NET', value: netIn, onChange: setNetIn },
                    ]
              }
              cta={mode === 0 ? t('resource.rentDays') : mode === 1 ? t('resource.stake') : t('resource.unstake')}
              canSign={canSign}
              extraDisabled={mode === 0 && !receiverValid}
              beforeRows={
                mode === 0 ? (
                  <View style={styles.beforeRowsWrap}>
                    <TouchableOpacity
                      style={styles.payForOtherRow}
                      activeOpacity={0.7}
                      onPress={() => setPayToOther((v) => !v)}
                    >
                      <Ionicons
                        name={payToOther ? 'checkbox' : 'square-outline'}
                        size={19}
                        color={payToOther ? BLUE : colors.textFaint}
                      />
                      <Text style={styles.payForOtherTxt}>{t('resource.payForOther')}</Text>
                    </TouchableOpacity>
                    {payToOther ? (
                      <View style={styles.inputRow}>
                        <TextInput
                          value={receiverIn}
                          onChangeText={(v) => setReceiverIn(v.toLowerCase())}
                          placeholder={t('resource.receiverPlaceholder')}
                          placeholderTextColor={colors.textFaint}
                          style={styles.input}
                          autoCapitalize="none"
                          maxLength={12}
                        />
                      </View>
                    ) : null}
                    {payToOther && receiverIn.length > 0 && !isValidAccountName(receiverIn) ? (
                      <Text style={styles.receiverErr}>{accountNameError(receiverIn) ?? t('send.invalidAccount')}</Text>
                    ) : null}
                  </View>
                ) : undefined
              }
              afterRows={
                mode === 0 && powerupPay > 0 && powerup ? (
                  <Text style={styles.estimateTxt}>
                    {estimatedTransfers && estimatedTransfers > 0
                      ? t('resource.powerupUsage', { days: powerup.powerupDays })
                      : t('resource.estimateTooSmall')}
                  </Text>
                ) : undefined
              }
              hint={
                mode === 0
                  ? t('resource.powerUpHint')
                  : mode === 1
                  ? t('resource.stakeHint')
                  : t('resource.unstakeHint')
              }
              onSubmit={() => review(mode === 0 ? 'powerup' : mode === 1 ? 'stake' : 'unstake')}
              t={t}
            />

            <View style={styles.card}>
              <ResBlock
                name="CPU"
                price={t('resource.staked', { amount: assetValue(r.selfStakedCpu).toFixed(4), symbol: sym })}
                remainTxt={resText(r.cpu, fmtUs, t)}
                p={r.cpu.unlimited ? 100 : 100 - r.cpu.pct}
                total={r.selfStakedCpu}
                self={t('resource.used', { value: fmtUs(r.cpu.used) })}
                other={usageText(r.cpu, t)}
                t={t}
              />
              <View style={styles.hr} />
              <ResBlock
                name="NET"
                price={t('resource.staked', { amount: assetValue(r.selfStakedNet).toFixed(4), symbol: sym })}
                remainTxt={resText(r.net, fmtBytes, t)}
                p={r.net.unlimited ? 100 : 100 - r.net.pct}
                total={r.selfStakedNet}
                self={t('resource.used', { value: fmtBytes(r.net.used) })}
                other={usageText(r.net, t)}
                t={t}
              />
              <View style={styles.refundRow}>
                <Text style={styles.refundK}>{t('resource.refunding')}</Text>
                <Text style={styles.refundV}>{r.refunding}</Text>
              </View>
            </View>
          </>
        ) : tab === 1 ? (
          <>
            <View style={styles.card}>
              <ResBlock
                name="RAM"
                price={t('resource.marketPrice', { price: w.ramPricePerKb.toFixed(4), symbol: sym })}
                remainTxt={resText(r.ram, fmtBytes, t)}
                p={r.ram.unlimited ? 100 : 100 - r.ram.pct}
                total={fmtBytes(r.ram.max)}
                self={t('resource.used', { value: fmtBytes(r.ram.used) })}
                other={usageText(r.ram, t)}
                t={t}
              />
            </View>
            <OpCard
              tabs={[t('resource.buy'), t('resource.sell'), t('resource.transfer')]}
              mode={mode}
              setMode={setRamOpMode}
              balance={
                // 买是花代币、卖/转移是出 RAM 字节——这两类模式下"余额"指的根本
                // 不是同一个东西,一直显示代币余额的话,卖/转移的时候用户根本
                // 看不出自己有多少 RAM 能动,得跟着 mode 切
                mode === 0
                  ? t('resource.balance', { balance: `${liquid.toFixed(4)} ${sym}` })
                  : t('resource.balance', { balance: `${(r.ram.available / 1024).toFixed(2)} KB` })
              }
              rows={[{ label: 'RAM', value: ramIn, onChange: setRamIn, unit: mode === 0 ? sym : 'KB' }]}
              cta={mode === 0 ? t('resource.buyRam') : mode === 1 ? t('resource.sellRam') : t('resource.transferRam')}
              canSign={canSign}
              extraDisabled={!ramReceiverValid}
              beforeRows={
                mode === 0 ? (
                  <View style={styles.beforeRowsWrap}>
                    <TouchableOpacity
                      style={styles.payForOtherRow}
                      activeOpacity={0.7}
                      onPress={() => setRamBuyForOther((v) => !v)}
                    >
                      <Ionicons
                        name={ramBuyForOther ? 'checkbox' : 'square-outline'}
                        size={19}
                        color={ramBuyForOther ? BLUE : colors.textFaint}
                      />
                      <Text style={styles.payForOtherTxt}>{t('resource.buyForOther')}</Text>
                    </TouchableOpacity>
                    {ramBuyForOther ? (
                      <View style={styles.inputRow}>
                        <TextInput
                          value={ramReceiverIn}
                          onChangeText={(v) => setRamReceiverIn(v.toLowerCase())}
                          placeholder={t('resource.receiverPlaceholder')}
                          placeholderTextColor={colors.textFaint}
                          style={styles.input}
                          autoCapitalize="none"
                          maxLength={12}
                        />
                      </View>
                    ) : null}
                    {ramBuyForOther && ramReceiverIn.length > 0 && !isValidAccountName(ramReceiverIn) ? (
                      <Text style={styles.receiverErr}>{accountNameError(ramReceiverIn) ?? t('send.invalidAccount')}</Text>
                    ) : null}
                  </View>
                ) : mode === 2 ? (
                  <View style={styles.beforeRowsWrap}>
                    <View style={styles.inputRow}>
                      <TextInput
                        value={ramReceiverIn}
                        onChangeText={(v) => setRamReceiverIn(v.toLowerCase())}
                        placeholder={t('resource.receiverPlaceholder')}
                        placeholderTextColor={colors.textFaint}
                        style={styles.input}
                        autoCapitalize="none"
                        maxLength={12}
                      />
                    </View>
                    {ramReceiverIn.length > 0 && !isValidAccountName(ramReceiverIn) ? (
                      <Text style={styles.receiverErr}>{accountNameError(ramReceiverIn) ?? t('send.invalidAccount')}</Text>
                    ) : null}
                  </View>
                ) : undefined
              }
              afterRows={
                mode !== 2 && ramAmt > 0 && w.ramPricePerKb > 0 ? (
                  <Text style={styles.estimateTxt}>
                    {mode === 0
                      ? t('resource.estimatedRamBuy', { kb: ramEstimateKb.toFixed(2) })
                      : t('resource.estimatedRamSell', { amount: ramEstimateProceeds.toFixed(4), symbol: sym })}
                  </Text>
                ) : undefined
              }
              hint={
                mode === 0
                  ? t('resource.buyRamHint', { price: w.ramPricePerKb.toFixed(4), symbol: sym })
                  : mode === 1
                  ? t('resource.sellRamHint')
                  : t('resource.transferHint')
              }
              onSubmit={() => review(mode === 0 ? 'buyram' : mode === 1 ? 'sellram' : 'ramtransfer')}
              t={t}
            />
          </>
        ) : (
          <RexOperations key={`${wallet?.id}/${wallet?.publicKey}/${w.chainId}/${w.node.url}/${w.account}/${permission}`}
            client={w.client} account={w.account} refreshKey={w.headBlock} canSign={canSign} busy={busy}
            onReview={(actions, notice) => { setTxErr(null); setConfirmNotice(notice); setConfirm(actions); }} />
        )}

        <Text style={styles.demoNote}>
          {t('resource.dataSource', { node: w.node.name, block: w.headBlock.toLocaleString('en-US') })}
        </Text>
      </ScrollView>

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
        notice={confirmNotice}
        walletId={wallet?.id}
        passkey={isPasskey}
        onConfirm={submit}
        onConfirmBiometric={submitBiometric}
        onConfirmPasskey={submitPasskey}
      />
      {repair.element}
    </View>
  );
}

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** 进度条内文案 —— 处理不受限与未抵押两种边界 */
function resText(u: { available: number; max: number; unlimited: boolean; unallocated: boolean }, f: (n: number) => string, t: T) {
  if (u.unlimited) return t('resource.unlimited');
  if (u.unallocated) return t('resource.unallocated');
  return t('resource.remaining', { available: f(u.available), max: f(u.max) });
}

function usageText(u: { pct: number; unlimited: boolean; unallocated: boolean }, t: T) {
  if (u.unlimited) return t('resource.unlimitedShort');
  if (u.unallocated) return t('resource.unallocatedShort');
  return t('resource.usagePct', { pct: u.pct.toFixed(1) });
}

function ResBlock({
  name,
  price,
  remainTxt,
  p,
  total,
  self,
  other,
  t,
}: {
  name: string;
  price: string;
  remainTxt: string;
  p: number;
  total: string;
  self: string;
  other: string;
  t: T;
}) {
  return (
    <View>
      <View style={styles.resHead}>
        <Text style={styles.resName}>{name}</Text>
        <Text style={styles.resPrice}>{price}</Text>
      </View>
      <View style={styles.pill}>
        <View style={[styles.pillFill, { width: `${Math.max(Math.min(p, 100), 3)}%` }]} />
        <Text style={styles.pillTxt}>{remainTxt}</Text>
      </View>
      <View style={styles.resFoot}>
        <View>
          <Text style={styles.resFootK}>{t('resource.totalStaked')}</Text>
          <Text style={styles.resFootV}>{total}</Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 5 }}>
          <Text style={styles.resFootSub}>{self}</Text>
          <Text style={styles.resFootSub}>{other}</Text>
        </View>
      </View>
    </View>
  );
}

function OpCard({
  tabs,
  mode,
  setMode,
  balance,
  rows,
  cta,
  canSign,
  hint,
  onSubmit,
  t,
  beforeRows,
  afterRows,
  extraDisabled,
}: {
  tabs: [string, string] | string[];
  mode: number;
  setMode: (n: number) => void;
  balance: string;
  rows: { label: string; value: string; onChange: (v: string) => void; unit?: string }[];
  cta: string;
  canSign: boolean;
  hint?: string;
  onSubmit: () => void;
  t: T;
  /** 渲染在金额输入行之前的额外内容——目前只有 PowerUp 的「代充给其他账户」用 */
  beforeRows?: React.ReactNode;
  /** 渲染在金额输入行之后、提示文案之前——目前只有 PowerUp 的笔数估算用 */
  afterRows?: React.ReactNode;
  /** 金额之外还有一项没通过校验(比如代充的收款账户格式不对),一并挡住提交按钮 */
  extraDisabled?: boolean;
}) {
  const filled = rows.some((r) => (parseFloat(r.value) || 0) > 0);
  const enabled = canSign && filled && !extraDisabled;
  return (
    <View style={styles.opCard}>
      <View style={styles.opTabs}>
        {tabs.map((m, i) => (
          <TouchableOpacity
            key={m}
            onPress={() => setMode(i)}
            style={[styles.opTab, mode === i ? styles.opTabActive : styles.opTabIdle]}
          >
            <Text style={[styles.opTabTxt, mode === i && styles.opTabTxtActive]}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.opBody}>
        <Text style={styles.opBal}>{balance}</Text>
        {beforeRows}
        {rows.map((r) => (
          <View key={r.label} style={styles.inputRow}>
            <Text style={styles.inputLabel}>{r.label}</Text>
            <TextInput
              value={r.value}
              onChangeText={r.onChange}
              placeholder={t('resource.amountPlaceholder', { unit: r.unit ?? t('send.amount') })}
              placeholderTextColor={colors.textFaint}
              keyboardType="decimal-pad"
              style={styles.input}
            />
          </View>
        ))}
        {afterRows}
        {hint ? <Text style={styles.opHint}>{hint}</Text> : null}
        <TouchableOpacity
          style={[styles.cta, !enabled && styles.ctaOff]}
          disabled={!enabled}
          activeOpacity={0.85}
          onPress={onSubmit}
        >
          <Text style={styles.ctaTxt}>{cta}</Text>
        </TouchableOpacity>
        {!canSign ? <Text style={styles.opHint}>{t('resource.readOnlyHint')}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F2F3F5' },

  header: { flexDirection: 'row', alignItems: 'center', height: 50, paddingHorizontal: 6, backgroundColor: colors.white },
  back: { paddingHorizontal: 8 },
  headerTab: { paddingHorizontal: 14, paddingVertical: 6 },
  headerTabTxt: { fontSize: 19, color: colors.textFaint, fontWeight: '600' },
  headerTabTxtActive: { color: colors.text, fontWeight: '800' },

  scroll: { padding: spacing.md, paddingBottom: 36, gap: 12 },

  card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, overflow: 'hidden' },

  loadingBox: { backgroundColor: colors.white, borderRadius: 10, padding: 40, alignItems: 'center', gap: 14 },
  loadingTxt: { fontSize: 13.5, color: colors.textSub, textAlign: 'center' },


  resHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  resName: { fontSize: 17, fontWeight: '800', color: colors.text },
  resPrice: { fontSize: 12.5, color: colors.textSub },

  pill: { height: 38, borderRadius: 19, backgroundColor: '#EDEFF3', marginTop: 14, justifyContent: 'center', overflow: 'hidden' },
  pillFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: BAR_BLUE, borderRadius: 19 },
  pillTxt: { textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: '500' },

  resFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  resFootK: { fontSize: 14.5, color: colors.text },
  resFootV: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 4 },
  resFootSub: { fontSize: 13.5, color: colors.textSub },

  hr: { height: StyleSheet.hairlineWidth, backgroundColor: '#E6E8EC', marginVertical: 18 },
  refundRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  refundK: { fontSize: 14.5, color: colors.textSub },
  refundV: { fontSize: 14.5, color: colors.text, fontWeight: '600' },

  opCard: { backgroundColor: colors.white, borderRadius: 10, overflow: 'hidden' },
  opTabs: { flexDirection: 'row' },
  opTab: { flex: 1, height: 52, alignItems: 'center', justifyContent: 'center' },
  opTabIdle: { backgroundColor: '#EDEFF3' },
  opTabActive: { backgroundColor: colors.white },
  opTabTxt: { fontSize: 16, color: colors.textSub },
  opTabTxtActive: { color: colors.text, fontWeight: '600' },
  opBody: { padding: 16, gap: 12 },
  opBal: { fontSize: 14, color: colors.textSub },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F2F3F5',
    borderRadius: 8,
    height: 56,
    paddingHorizontal: 16,
  },
  inputLabel: { fontSize: 16, color: colors.text },
  input: { flex: 1, textAlign: 'right', fontSize: 15.5, color: colors.text, padding: 0, outlineStyle: 'none' as any },

  beforeRowsWrap: { gap: 10 },
  payForOtherRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  payForOtherTxt: { fontSize: 14, color: colors.text },
  receiverErr: { fontSize: 12, color: '#F0644E', marginTop: -4 },
  estimateTxt: { fontSize: 13, color: BLUE, fontWeight: '600' },

  opHint: { fontSize: 12, color: colors.textFaint, lineHeight: 18 },

  cta: { height: 50, borderRadius: 8, backgroundColor: BLUE, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ctaOff: { backgroundColor: '#C7CAD1' },
  ctaTxt: { color: '#fff', fontSize: 15, fontWeight: '600' },

  demoNote: { textAlign: 'center', color: colors.textFaint, fontSize: 11, marginTop: 4, lineHeight: 17 },
});
