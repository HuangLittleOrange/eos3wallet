import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, shadow, spacing } from '../theme';
import PageHeader from '../components/PageHeader';
import ConfirmTxSheet from '../components/ConfirmTxSheet';
import AssetEditSheet from '../components/AssetEditSheet';
import { useWalletSession } from '../chain/WalletContext';
import { ActionSpec, Signer } from '../chain/transact';
import { BindAuthorizationInfo, PayLimitAssetConfig, PreparedBindAuthorization, buildBindAuthorization, prepareBindAuthorization, signAndCompleteBindAuthorization } from '../chain/bindAuthorize';
import { displayBindLimit, normalizeBindAssets } from '../chain/bindIntent';
import {
  AuthorizedAppAsset,
  LimitDraft,
  amountFromInput,
  editableAsset,
  fullAssetKey,
  initialDraft,
  sameAsset,
} from '../chain/permissions';
import { biometricSigner, passkeySigner, passwordSigner } from '../chain/signers';
import { useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/RootNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type EditingState = { asset: AuthorizedAppAsset; draft: LimitDraft };

function toAssetConfig(asset: AuthorizedAppAsset): PayLimitAssetConfig {
  return {
    tokenContract: asset.tokenContract,
    symbol: asset.symbol,
    precision: asset.precision,
    perTxLimit: asset.dailyLimit,
    dailyLimit: asset.dailyLimit,
    totalBudget: asset.totalBudget,
  };
}

/**
 * 第三方 App(比如 Telegram Bot)发来的授权请求审核页——通过 Universal Link
 * `https://eos3.app/tgbind?bindId=...` 拉起(见 RootNavigator 的 linking 配置)。
 * 跟 PermissionDetailScreen 管理"已有权限"不同,这里是"从无到有新建一个受限
 * 权限",数据/签名走 chain/bindAuthorize.ts,不是 chain/permissions.ts。
 */
export default function BindAuthorizeScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const route = useRoute<RouteProp<RootStackParamList, 'BindAuthorize'>>();
  // 只读会话半边(链/账户/钱包/操作函数),不订阅余额/行情等实时数据——
  // 本页一个实时字段都不用,跟着每轮 refresh 的分批落位陪跑纯属浪费
  const w = useWalletSession();
  const { t } = useI18n();
  const wallet = w.currentWallet;
  const isPasskey = wallet?.source === 'passkey';
  const canSign = !!wallet;
  const bindId = route.params.bindId;

  const [info, setInfo] = useState<BindAuthorizationInfo | null>(null);
  const [assets, setAssets] = useState<AuthorizedAppAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ plan: PreparedBindAuthorization; context: string } | null>(null);
  const context = JSON.stringify([bindId, w.chainId, w.account, w.node.url, wallet?.id]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!canSign) {
      setLoading(false);
      return;
    }
    let alive = true;
    setInfo(null);
    setConfirmed(null);
    setConfirmOpen(false);
    setLoading(true);
    setLoadErr(null);
    buildBindAuthorization({ bindId, eosAccount: w.account })
      .then((built) => {
        if (!alive) return;
        setInfo(built);
        setAssets(normalizeBindAssets(built.assetLimits).map(editableAsset));
      })
      .catch((e: any) => alive && setLoadErr(e?.message ?? t('bindAuthorize.failed')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindId, w.account, w.chainId, w.node.url, wallet?.id, canSign]);

  const openEdit = (asset: AuthorizedAppAsset) => {
    setTxErr(null);
    setEditing({ asset, draft: initialDraft(asset) });
  };

  const onChangeDraft = (field: keyof LimitDraft, value: string) => {
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, [field]: value } } : current));
  };

  const onSaveFromSheet = () => {
    if (!editing) return;
    const daily = amountFromInput(editing.draft.dailyLimit, editing.asset.symbol, editing.asset.precision);
    const total = amountFromInput(editing.draft.totalBudget, editing.asset.symbol, editing.asset.precision);
    if (daily === null || total === null) {
      Alert.alert(t('permission.invalidAmount'));
      return;
    }
    const updated: AuthorizedAppAsset = { ...editing.asset, dailyLimit: daily, totalBudget: total };
    setAssets((current) => current.map((a) => (sameAsset(a, updated) ? updated : a)));
    setEditing(null);
  };

  const removeAsset = (asset: AuthorizedAppAsset) => {
    setAssets((current) => current.filter((a) => !sameAsset(a, asset)));
    setEditing(null);
  };

  const confirmSummaryAction = (): ActionSpec => {
    const plan = confirmed!.plan;
    const appLabel = plan.build.projectName || plan.build.botUsername || t('bindAuthorize.unknownApp');
    const data: Record<string, string> = { [t('permission.app')]: appLabel };
    plan.intent.assetLimits.forEach((asset) => {
      data[`${t('permission.token')} · ${asset.symbol} @${asset.tokenContract}`] =
        `${t('permission.dailyLimitLabel')} ${displayBindLimit(asset.dailyLimit, t('permission.unlimited'))} / ${t('permission.totalBudgetLabel')} ${displayBindLimit(asset.totalBudget, t('permission.unlimited'))}`;
    });
    data[t('permission.note')] = t('bindAuthorize.scope');
    return { account: t('bindAuthorize.manage'), name: t('bindAuthorize.actionName'), data };
  };

  const openConfirm = async () => {
    if (!info || submitting.current) return;
    if (assets.length === 0) {
      Alert.alert(t('bindAuthorize.atLeastOneAsset'));
      return;
    }
    setBusy(true);
    submitting.current = true;
    setTxErr(null);
    const requestContext = context;
    const assetLimits = assets.map(toAssetConfig);
    try {
      const fresh = await buildBindAuthorization({ bindId, eosAccount: w.account, assetLimits });
      const plan = await prepareBindAuthorization({
        bindId, eosAccount: w.account, chain: w.chainId, node: w.node,
        build: fresh, preview: info, assetLimits,
      });
      if (!mounted.current || contextRef.current !== requestContext) return;
      setConfirmed({ plan, context: requestContext });
      setConfirmOpen(true);
    } catch (e: any) {
      Alert.alert(t('bindAuthorize.failed'), e?.message ?? undefined);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const runConfirm = async (getSigner: () => Promise<Signer>) => {
    if (!wallet || !confirmed || submitting.current) return;
    const current = confirmed;
    submitting.current = true;
    setBusy(true);
    setTxErr(null);
    try {
      await signAndCompleteBindAuthorization({
        plan: current.plan, getSigner,
        isCurrent: () => mounted.current && contextRef.current === current.context,
      });
      setConfirmOpen(false);
      setConfirmed(null);
      Alert.alert(t('bindAuthorize.submitted'), t('bindAuthorize.granted'), [
        { text: t('permission.ok'), onPress: () => nav.navigate('Permission') },
      ]);
    } catch (e: any) {
      setTxErr(e?.message ?? t('permission.actionFailed'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const submit = (password: string) =>
    runConfirm(passwordSigner(wallet!, password));
  const submitBiometric = () =>
    runConfirm(biometricSigner(wallet!));
  const submitPasskey = () =>
    runConfirm(passkeySigner(wallet!));

  if (!canSign) {
    return (
      <View style={styles.root}>
        <PageHeader title={t('bindAuthorize.title')} />
        <Text style={styles.emptyTxt}>{t('bindAuthorize.noWallet')}</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.root}>
        <PageHeader title={t('bindAuthorize.title')} />
        <View style={styles.center}>
          <ActivityIndicator color="#1E88FF" />
          <Text style={styles.loadingTxt}>{t('bindAuthorize.loading')}</Text>
        </View>
      </View>
    );
  }

  if (loadErr || !info) {
    return (
      <View style={styles.root}>
        <PageHeader title={t('bindAuthorize.title')} />
        <Text style={styles.emptyTxt}>{loadErr ?? t('bindAuthorize.notFound')}</Text>
      </View>
    );
  }

  const appLabel = info.projectName || info.botUsername || t('bindAuthorize.unknownApp');

  return (
    <View style={styles.root}>
      <PageHeader title={t('bindAuthorize.title')} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.card, shadow.soft]}>
          <Text style={styles.appType}>{appLabel}</Text>
          <Text style={styles.instructions}>{t('bindAuthorize.instructions', { appName: appLabel })}</Text>
          {info.projectDescription ? <Text style={styles.desc}>{info.projectDescription}</Text> : null}
        </View>

        <Text style={styles.sectionTitle}>{t('bindAuthorize.assetsSection')}</Text>
        {assets.length === 0 ? (
          <View style={[styles.card, shadow.soft]}>
            <Text style={styles.emptyTxt}>{t('bindAuthorize.noAssets')}</Text>
          </View>
        ) : (
          assets.map((asset) => (
            <View style={[styles.card, shadow.soft]} key={fullAssetKey(asset)}>
              <View style={styles.assetHead}>
                <Text style={styles.assetSym}>{asset.symbol} @{asset.tokenContract}</Text>
                <View style={styles.assetHeadActions}>
                  <TouchableOpacity style={[styles.editBtn, busy && styles.disabled]} disabled={busy} onPress={() => openEdit(asset)}>
                    <Ionicons name="pencil-outline" size={13} color={colors.brand} />
                    <Text style={styles.editTxt}>{t('permission.editLabel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.editBtn, busy && styles.disabled]} disabled={busy} onPress={() => removeAsset(asset)}>
                    <Ionicons name="close-outline" size={15} color={colors.red} />
                    <Text style={[styles.editTxt, { color: colors.red }]}>{t('bindAuthorize.removeAsset')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.metricGrid}>
                <View style={styles.metricCell}>
                  <Text style={styles.metricLabel}>{t('permission.dailyLimitLabel')}</Text>
                  <Text style={styles.metricValue}>{displayBindLimit(asset.dailyLimit, t('permission.unlimited'))}</Text>
                </View>
                <View style={styles.metricCell}>
                  <Text style={styles.metricLabel}>{t('permission.totalBudgetLabel')}</Text>
                  <Text style={styles.metricValue}>{displayBindLimit(asset.totalBudget, t('permission.unlimited'))}</Text>
                </View>
              </View>
            </View>
          ))
        )}

        <TouchableOpacity style={[styles.confirmBtn, busy && styles.disabled]} disabled={busy} activeOpacity={0.8} onPress={() => void openConfirm()}>
          {busy && !confirmOpen ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Ionicons name="shield-checkmark-outline" size={17} color="#fff" />
              <Text style={styles.confirmTxt}>{t('bindAuthorize.confirmButton')}</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>

      <AssetEditSheet
        visible={editing !== null}
        isNewAsset={false}
        asset={editing?.asset ?? null}
        draft={editing?.draft ?? { dailyLimit: '', totalBudget: '' }}
        selectableAssets={[]}
        busy={busy}
        onChangeDraft={onChangeDraft}
        onSelectAsset={() => {}}
        onSave={onSaveFromSheet}
        onClose={() => setEditing(null)}
      />

      <ConfirmTxSheet
        visible={confirmOpen && confirmed !== null && confirmed.context === context}
        onClose={() => {
          if (submitting.current) return;
          setConfirmOpen(false);
          setConfirmed(null);
          setTxErr(null);
        }}
        actions={confirmOpen && confirmed ? [confirmSummaryAction()] : []}
        chainName={w.client.config.name}
        testnet={w.client.config.testnet}
        actor={w.account}
        busy={busy}
        error={txErr}
        walletId={wallet?.id}
        passkey={isPasskey}
        onConfirm={submit}
        onConfirmBiometric={submitBiometric}
        onConfirmPasskey={submitPasskey}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: 12 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingTxt: { fontSize: 13, color: colors.textFaint },
  emptyTxt: { textAlign: 'center', color: colors.textFaint, fontSize: 14, paddingVertical: 24 },

  card: { borderRadius: 12, backgroundColor: colors.card, padding: 14 },
  appType: { fontSize: 17, fontWeight: '700', color: colors.text },
  instructions: { fontSize: 13, color: colors.textSub, marginTop: 6, lineHeight: 19 },
  desc: { fontSize: 12.5, color: colors.textSub, marginTop: 8, lineHeight: 18 },

  sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 6 },
  assetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assetSym: { fontSize: 15.5, fontWeight: '600', color: colors.text },
  assetHeadActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  editTxt: { fontSize: 13, color: colors.brand, fontWeight: '600' },

  metricGrid: { flexDirection: 'row', gap: 16, marginTop: 10 },
  metricCell: { flex: 1 },
  metricLabel: { fontSize: 11.5, color: colors.textSub },
  metricValue: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 2 },

  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.brand,
    marginTop: 4,
  },
  confirmTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
