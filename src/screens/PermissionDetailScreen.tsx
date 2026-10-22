import { useSigningGuard } from '../chain/useSigningGuard';
import React, { useEffect, useState } from 'react';
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
import { ActionSpec, Signer, transact } from '../chain/transact';
import { useResourceRepair } from '../components/ResourceRepairSheet';
import {
  AuthorizedApp,
  AuthorizedAppAsset,
  LimitDraft,
  PayLimitAssetConfig,
  amountFromInput,
  amountOrUnlimited,
  buildRemoveAssetActions,
  buildResetUsageActions,
  buildRevokeActions,
  buildSaveAssetActions,
  editableAsset,
  formatCreatedAt,
  initialDraft,
  permissionDisplayAppType,
  permissionDisplayBot,
  permissionDisplayDevice,
  permissionKey,
  remainingAmount,
  selectableAssetCatalog,
  todayRemainingAmount,
  verifyManagedApp,
} from '../chain/permissions';
import { biometricSigner, passkeySigner, passwordSigner } from '../chain/signers';
import { signingPermission } from '../crypto/vault';
import { useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useAuthorizedApps } from '../chain/useAuthorizedApps';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type EditingState = { asset: AuthorizedAppAsset; draft: LimitDraft; isNew: boolean };

type PendingAction =
  | { kind: 'revoke' }
  | { kind: 'reset'; asset: AuthorizedAppAsset }
  | { kind: 'save'; asset: AuthorizedAppAsset; draft: LimitDraft; isNew: boolean }
  | { kind: 'removeAsset'; asset: AuthorizedAppAsset };

/**
 * 单个已授权应用的详情页——从 PermissionScreen 的卡片列表点进来。这里才是真正
 * 能改额度/加代币/删代币的地方,PermissionScreen 那边现在只负责展示列表。
 *
 * 数据不通过导航参数传整个对象(route params 应该保持可序列化),而是拿到
 * permissionKey 后复用概览缓存,过期时后台更新;管理操作前仍强制重新查询。
 */
export default function PermissionDetailScreen() {
  const nav = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const route = useRoute<RouteProp<RootStackParamList, 'PermissionDetail'>>();
  // 只读会话半边(链/账户/钱包/操作函数),不订阅余额/行情等实时数据——
  // 本页一个实时字段都不用,跟着每轮 refresh 的分批落位陪跑纯属浪费
  const w = useWalletSession();
  const { locale, t } = useI18n();
  const wallet = w.currentWallet;
  const isPasskey = wallet?.source === 'passkey';
  const canSign = !!wallet;

  const overview = useAuthorizedApps(w.chainId, w.account);
  const authorized = overview.data?.permissions.filter(app => app.managedByPayLimit);
  const assetCatalog = overview.data?.assetCatalog ?? [];
  const loading = !!w.account && overview.data === undefined && !overview.error;
  const loadErr = overview.error?.message;
  const load = () => { void overview.refresh().catch(() => {}); };

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  /** pending 对应的真实链上 action——确认弹窗展示的、签名的都是这一份 */
  const [confirm, setConfirm] = useState<ActionSpec[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const repair = useResourceRepair(w, { onCancel: setTxErr });
  // paylimit 的管理 action 全是 require_auth(owner@active),声明的授权必须恰好是
  // active;只导入了 owner 钥匙的钱包做不了,进弹窗前就拦下来说清楚
  const permission = signingPermission(wallet);
  const signingGuard = useSigningGuard(JSON.stringify([wallet?.id, wallet?.publicKey, w.chainId,
    w.node.url, w.account, permission]), confirm, () => setConfirm(null));

  const app = authorized?.find((candidate) => permissionKey(candidate) === route.params.permissionKey) ?? null;

  /** 所有管理操作的统一入口:先过权限门槛,再进确认流程 */
  const startPending = (action: PendingAction) => {
    setTxErr(null);
    if (permission !== 'active') {
      Alert.alert(t('permission.actionFailed'), t('permission.activeRequired', { permission }));
      return;
    }
    setPending(action);
  };

  // pending 一确定就把它翻成真实的链上 action。撤销要先从链上查这个权限
  // linkauth 了哪些 action,所以整个过程是异步的,弹层等 action 拼好了再出现。
  useEffect(() => {
    if (!pending || !app) {
      setConfirm(null);
      return;
    }
    let alive = true;
    setConfirm(null);
    (async () => {
      try {
        // Cached rows are for browsing only. Resolve the exact permission again before building management actions.
        const fresh = await overview.refresh();
        if (!alive) return;
        const current = fresh?.permissions.find(candidate => permissionKey(candidate) === route.params.permissionKey && candidate.managedByPayLimit);
        if (!current) throw new Error(t('permission.noAuthorized'));
        // The list is remote metadata; prove this exact permission/bot pair
        // exists on chain before building a transaction that targets it.
        await verifyManagedApp({ chainId: w.chainId, account: w.account, app: current });
        if (!alive) return;
        const actions = await buildPendingActions(pending, current);
        if (alive) setConfirm(actions);
      } catch (e: any) {
        if (!alive) return;
        setPending(null);
        Alert.alert(t('permission.actionFailed'), e?.message ?? t('permission.actionFailed'));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, w.account, w.chainId, w.node.url, wallet?.id]);

  const buildPendingActions = async (action: PendingAction, current: AuthorizedApp): Promise<ActionSpec[]> => {
    const account = w.account;
    if (action.kind === 'revoke') {
      const linkedActions = await w.client.getLinkedActions(account, current.permission);
      return buildRevokeActions({ account, app: current, linkedActions });
    }
    if (action.kind === 'reset') return buildResetUsageActions({ account, app: current, asset: action.asset });
    if (action.kind === 'removeAsset') return buildRemoveAssetActions({ account, app: current, asset: action.asset });
    return buildSaveAssetActions({ account, app: current, asset: action.asset, draft: action.draft });
  };

  const openEdit = (asset: AuthorizedAppAsset) => {
    setTxErr(null);
    setEditing({ asset, draft: initialDraft(asset), isNew: false });
  };

  const openAdd = () => {
    if (!app) return;
    const candidates = selectableAssetCatalog(assetCatalog, app.assets);
    const first = candidates[0];
    if (!first) {
      Alert.alert(t('permission.noAssetsToAdd'));
      return;
    }
    setTxErr(null);
    setEditing({ asset: editableAsset(first), draft: { dailyLimit: '', totalBudget: '' }, isNew: true });
  };

  const onSelectAsset = (candidate: PayLimitAssetConfig) => {
    setEditing({ asset: editableAsset(candidate), draft: { dailyLimit: '', totalBudget: '' }, isNew: true });
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
    setEditing(null);
    startPending({ kind: 'save', asset: editing.asset, draft: editing.draft, isNew: editing.isNew });
  };

  /** 拿到签名者后的共同流程——密码、生物识别、passkey 三条路都走这里 */
  const broadcast = async (getSigner: () => Promise<Signer>) => {
    if (!pending || !confirm || !wallet || !app) return;
    const attempt = signingGuard.begin();
    if (!attempt) return;
    setBusy(true);
    setTxErr(null);
    let signer: Signer | null = null;
    try {
      signer = await getSigner();
      if (!attempt.isCurrent()) return;
      await transact({ chainId: w.chainId, node: w.node, actor: w.account, signer, permission, actions: confirm, isCurrent: attempt.isCurrent });
      const kind = pending.kind;
      const isNew = pending.kind === 'save' && pending.isNew;
      setPending(null);
      if (kind === 'revoke') {
        Alert.alert(t('permission.submitted'), t('permission.revoked'), [{ text: t('permission.ok'), onPress: () => nav.goBack() }]);
        return;
      }
      const message =
        kind === 'reset'
          ? t('permission.usageReset')
          : kind === 'removeAsset'
            ? t('permission.assetDeleted')
            : isNew
              ? t('permission.assetAdded')
              : t('permission.limitsSaved');
      Alert.alert(t('permission.submitted'), message, [{ text: t('permission.ok'), onPress: () => load() }]);
    } catch (e: any) {
      // 资源不够(CPU/NET、RAM):弹一键修复,复用刚拿到手的 signer,不再让用户认证一遍
      if (attempt.isCurrent() && !repair.offer(e, signer, permission)) setTxErr(e?.message ?? t('permission.actionFailed'));
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

  if (loading && !authorized) {
    return (
      <View style={styles.root}>
        <PageHeader title={t('permission.authorizationOverview')} />
        <View style={styles.center}>
          <ActivityIndicator color="#1E88FF" />
        </View>
      </View>
    );
  }

  if (!app) {
    return (
      <View style={styles.root}>
        <PageHeader title={t('permission.authorizationOverview')} />
        <TouchableOpacity onPress={load}><Text style={styles.emptyTxt}>{loadErr ?? t('permission.noAuthorized')} · {t('content.retry')}</Text></TouchableOpacity>
      </View>
    );
  }

  const botLabel = permissionDisplayBot(app);
  const infoRows: Array<[string, string]> = [
    [t('permission.botUsernameLabel'), botLabel ?? '-'],
    [t('permission.permissionName'), app.permission],
    [t('permission.deviceNameLabel'), permissionDisplayDevice(app) ?? t('permission.unknownDevice')],
    [t('permission.projectNameLabel'), app.projectName ?? '-'],
    [t('permission.projectDescriptionLabel'), app.projectDescription ?? '-'],
    [t('permission.createdAtLabel'), formatCreatedAt(app.createdAt) ?? t('permission.unknownValue')],
  ];

  const selectableAssets = editing?.isNew ? selectableAssetCatalog(assetCatalog, app.assets) : [];

  return (
    <View style={styles.root}>
      <PageHeader title={t('permission.authorizationOverview')} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {loadErr ? <TouchableOpacity onPress={load}><Text style={styles.emptyTxt}>{loadErr} · {t('content.retry')}</Text></TouchableOpacity> : null}
        <View style={[styles.card, shadow.soft]}>
          <View style={styles.appHead}>
            <View style={styles.appHeadCopy}>
              <Text style={styles.appType}>{permissionDisplayAppType(app, t)}</Text>
              <Text style={styles.botLabel}>{app.permission}</Text>
            </View>
            {canSign ? (
              <TouchableOpacity
                style={[styles.deleteBtn, busy && styles.disabled]}
                disabled={busy}
                onPress={() => startPending({ kind: 'revoke' })}
              >
                <Ionicons name="trash-outline" size={14} color={colors.red} />
                <Text style={styles.deleteTxt}>{t('permission.revoke')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.infoGrid}>
            {infoRows.map(([label, value]) => (
              <View style={styles.infoRow} key={label}>
                <Text style={styles.infoLabel}>{label}</Text>
                <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
              </View>
            ))}
          </View>
          <View style={styles.notice}>
            <Ionicons name="shield-checkmark-outline" size={15} color={colors.brand} />
            <Text style={styles.noticeTxt}>{t('permission.authorizedNote')}</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>{t('permission.authorizedTokensSection')}</Text>
        {app.assets.length === 0 ? (
          <View style={[styles.card, shadow.soft]}>
            <Text style={styles.emptyTxt}>{t('permission.noAssetLimit')}</Text>
          </View>
        ) : (
          app.assets.map((asset) => (
            <View style={[styles.card, shadow.soft]} key={`${asset.tokenContract}:${asset.symbol}`}>
              <View style={styles.assetHead}>
                <Text style={styles.assetSym}>{asset.symbol}</Text>
                {canSign ? (
                  <TouchableOpacity style={[styles.editBtn, busy && styles.disabled]} disabled={busy} onPress={() => openEdit(asset)}>
                    <Ionicons name="pencil-outline" size={13} color={colors.brand} />
                    <Text style={styles.editTxt}>{t('permission.editLabel')}</Text>
                    <Ionicons name="chevron-forward" size={13} color={colors.brand} />
                  </TouchableOpacity>
                ) : null}
              </View>
              <View style={styles.metricGrid}>
                <View style={styles.metricCell}>
                  <Text style={styles.metricLabel}>{t('permission.todayRemainingLabel')}</Text>
                  <Text style={styles.metricValue}>{todayRemainingAmount(asset)}</Text>
                </View>
                <View style={styles.metricCell}>
                  <Text style={styles.metricLabel}>{t('permission.dailyLimitLabel')}</Text>
                  <Text style={styles.metricValue}>{amountOrUnlimited(asset.dailyLimit, asset.symbol, asset.precision)}</Text>
                </View>
                <View style={styles.metricCell}>
                  <Text style={styles.metricLabel}>{t('permission.remainingTotalLimit')}</Text>
                  <Text style={styles.metricValue}>{remainingAmount(asset.totalBudget, asset.totalSpent, asset.symbol, asset.precision)}</Text>
                </View>
                <View style={styles.metricCell}>
                  <Text style={styles.metricLabel}>{t('permission.totalBudgetLabel')}</Text>
                  <Text style={styles.metricValue}>{amountOrUnlimited(asset.totalBudget, asset.symbol, asset.precision)}</Text>
                </View>
              </View>
              {canSign ? (
                <View style={styles.assetActions}>
                  <TouchableOpacity
                    style={[styles.assetActionBtn, busy && styles.disabled]}
                    disabled={busy}
                    onPress={() => startPending({ kind: 'reset', asset })}
                  >
                    <Ionicons name="refresh-outline" size={14} color={colors.textSub} />
                    <Text style={styles.assetActionTxt}>{t('permission.resetUsed')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.assetActionBtn, busy && styles.disabled]}
                    disabled={busy}
                    onPress={() => startPending({ kind: 'removeAsset', asset })}
                  >
                    <Ionicons name="trash-outline" size={14} color={colors.red} />
                    <Text style={[styles.assetActionTxt, { color: colors.red }]}>{t('permission.deleteAssetLabel')}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))
        )}

        {canSign ? (
          <TouchableOpacity style={[styles.addBtn, busy && styles.disabled]} disabled={busy} activeOpacity={0.8} onPress={openAdd}>
            <Ionicons name="add" size={17} color="#fff" />
            <Text style={styles.addTxt}>{t('permission.addAuthorizedAsset')}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      <AssetEditSheet
        visible={editing !== null}
        isNewAsset={!!editing?.isNew}
        asset={editing?.asset ?? null}
        draft={editing?.draft ?? { dailyLimit: '', totalBudget: '' }}
        selectableAssets={selectableAssets}
        busy={busy}
        onChangeDraft={onChangeDraft}
        onSelectAsset={onSelectAsset}
        onSave={onSaveFromSheet}
        onClose={() => setEditing(null)}
      />

      <ConfirmTxSheet
        visible={confirm !== null}
        onClose={() => {
          setPending(null);
          setTxErr(null);
        }}
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: 12 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyTxt: { textAlign: 'center', color: colors.textFaint, fontSize: 14, paddingVertical: 24 },

  card: { borderRadius: 12, backgroundColor: colors.card, padding: 14 },
  appHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  appHeadCopy: { flex: 1, minWidth: 0 },
  appType: { fontSize: 17, fontWeight: '700', color: colors.text },
  botLabel: { fontSize: 13, color: colors.textSub, marginTop: 3 },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#FAD4D0',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  deleteTxt: { fontSize: 12, color: colors.red, fontWeight: '600' },

  infoGrid: { marginTop: 12, gap: 8 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  infoLabel: { fontSize: 13, color: colors.textSub },
  infoValue: { flex: 1, fontSize: 13, color: colors.text, fontWeight: '500', textAlign: 'right' },

  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, borderRadius: 8, padding: 10, backgroundColor: colors.cardAlt },
  noticeTxt: { flex: 1, fontSize: 12, color: colors.textSub, lineHeight: 17 },

  sectionTitle: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 6 },
  assetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  assetSym: { fontSize: 15.5, fontWeight: '600', color: colors.text },
  editBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  editTxt: { fontSize: 13, color: colors.brand, fontWeight: '600' },

  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, rowGap: 10 },
  metricCell: { width: '50%' },
  metricLabel: { fontSize: 11.5, color: colors.textSub },
  metricValue: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 2 },

  assetActions: { flexDirection: 'row', gap: 20, marginTop: 12, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10 },
  assetActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  assetActionTxt: { fontSize: 13, color: colors.textSub, fontWeight: '500' },

  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.brand,
    marginTop: 4,
  },
  addTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
