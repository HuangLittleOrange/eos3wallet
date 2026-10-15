import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ChainClient } from '../chain/client';
import type { ActionSpec } from '../chain/transact';
import { buildRexCancel, buildRexDeposit, buildRexSell, buildRexUnlock, buildRexWithdraw } from '../chain/resourceActions';
import { readRexBalances, rexAssetUnits, rexOperationError, type RexBalances, type RexOperation } from '../chain/rex';
import { useI18n } from '../i18n';
import { colors } from '../theme';

const modes = ['buy', 'unlock', 'sell', 'withdraw'] as const;
export default function RexOperations({ client, account, refreshKey, canSign, busy, onReview }: {
  client: ChainClient; account: string; refreshKey: number; canSign: boolean; busy: boolean;
  onReview: (actions: ActionSpec[], notice: string) => void;
}) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<RexBalances | null>(null);
  const [loading, setLoading] = useState(true), [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false), [error, setError] = useState('');
  const [mode, setMode] = useState<RexOperation>('buy'), [amount, setAmount] = useState('');
  const generation = useRef(0), inFlight = useRef(false);
  const identity = useRef({ client, account }); identity.current = { client, account };
  const current = (id: number) => generation.current === id && identity.current.client === client && identity.current.account === account;
  const load = useCallback(async () => {
    const id = ++generation.current; setLoading(true); setFailed(false); setError('');
    try { const result = await readRexBalances(client, account); if (generation.current === id) setState(result); }
    catch { if (generation.current === id) setFailed(true); }
    finally { if (generation.current === id) setLoading(false); }
  }, [client, account]);
  useEffect(() => { setState(null); setAmount(''); setPreparing(false); void load(); return () => { generation.current++; }; }, [load, refreshKey]);
  const value = mode === 'sell' ? state?.available.split(' ')[0] ?? '' : amount;
  const invalid = state ? rexOperationError(mode, value, state) : t('rex.loadFailed');
  const locked = busy || preparing || loading || failed;
  const prepare = async (operation = mode) => {
    if (!state || locked || !canSign || inFlight.current || rexOperationError(operation, value, state)) return;
    const id = generation.current; inFlight.current = true; setPreparing(true); setError('');
    try {
      // Recheck live balances before showing any confirmation. Never silently
      // substitute a changed sell-all quantity for the one shown on the page.
      const fresh = await readRexBalances(client, account);
      if (!current(id)) return;
      setState(fresh);
      const problem = rexOperationError(operation, value, fresh);
      if (problem) throw new Error(problem);
      const opts = { contract: client.config.resourceContract, owner: account };
      const actions = operation === 'buy' ? buildRexDeposit({ ...opts, amount: value, symbol: 'A', precision: 4 })
        : operation === 'unlock' ? buildRexUnlock({ ...opts, rexAmount: value })
        : operation === 'sell' ? buildRexSell({ ...opts, rexAmount: value })
        : operation === 'withdraw' ? buildRexWithdraw({ ...opts, amount: value, symbol: 'A', precision: 4 })
        : buildRexCancel(account);
      const notice = t(`rex.hint.${operation}`) + (operation === 'buy' && fresh.autoSell && rexAssetUnits(fresh.available, 'REX') > 0n ? '\n' + t('rex.autoSell', { amount: fresh.available }) : '');
      if (current(id)) onReview(actions, notice);
    } catch (e: any) { if (current(id)) setError(e?.message ?? t('rex.loadFailed')); }
    finally { inFlight.current = false; if (current(id)) setPreparing(false); }
  };
  const cap = mode === 'buy' ? state?.liquid : mode === 'unlock' ? state?.savings : mode === 'sell' ? state?.available : state?.fund;
  return <View style={styles.wrap}>
    <View style={styles.card}>
      <View style={styles.row}><Text style={styles.title}>REX</Text><TouchableOpacity accessibilityRole="button" accessibilityLabel={t('rex.refresh')} disabled={busy || preparing || loading} onPress={() => void load()} style={styles.refresh}><Text style={styles.link}>{t('rex.refresh')}</Text></TouchableOpacity></View>
      {loading ? <ActivityIndicator /> : null}
      {failed ? <Text accessibilityRole="alert" style={styles.error}>{t('rex.loadFailed')}</Text> : null}
      {(['total', 'savings', 'available', 'fund'] as const).map((key) => <View key={key} style={styles.row}><Text style={styles.muted}>{t(`rex.${key}`)}</Text><Text selectable style={styles.metric}>{state?.[key] ?? '—'}</Text></View>)}
      {state ? <Text style={styles.hint}>{t('rex.policy', { days: state.maturityDays })}</Text> : null}
      {state?.maturities.map((bucket) => <Text key={bucket.at} selectable style={styles.hint}>{new Date(bucket.at).toLocaleString(locale)} · {bucket.quantity}</Text>)}
      {state?.order?.open ? <><Text style={styles.hint}>{t('rex.pending')}</Text><TouchableOpacity accessibilityRole="button" disabled={locked || !canSign} onPress={() => void prepare('cancel')} style={styles.refresh}><Text style={styles.link}>{t('rex.cancel')}</Text></TouchableOpacity></> : null}
    </View>
    <View style={styles.card}>
      <View style={styles.tabs}>{modes.map((op) => <TouchableOpacity key={op} accessibilityRole="tab" accessibilityState={{ selected: mode === op }} disabled={busy || preparing} style={[styles.tab, mode === op && styles.selected]} onPress={() => { setMode(op); setAmount(''); setError(''); }}><Text style={[styles.muted, mode === op && styles.active]}>{t(`rex.${op}`)}</Text></TouchableOpacity>)}</View>
      <Text style={styles.muted}>{t('resource.balance', { balance: cap ?? '—' })}</Text>
      {mode === 'sell' ? <Text selectable style={styles.title}>{state?.available ?? '—'} · {t('rex.allMatured')}</Text> : <View style={styles.inputRow}><Text style={styles.muted}>{t('send.amount')}</Text><TextInput accessibilityLabel={t('rex.amountLabel', { unit: mode === 'unlock' ? 'REX' : 'A' })} style={styles.input} keyboardType="decimal-pad" maxLength={80} value={amount} editable={!busy && !preparing} onChangeText={setAmount} placeholder={t('resource.amountPlaceholder', { unit: mode === 'unlock' ? 'REX' : 'A' })} placeholderTextColor={colors.textFaint} /><Text style={styles.muted}>{mode === 'unlock' ? 'REX' : 'A'}</Text></View>}
      {value && invalid ? <Text accessibilityRole="alert" style={styles.error}>{invalid}</Text> : null}
      <Text style={styles.hint}>{t(`rex.hint.${mode}`)}</Text>
      {mode === 'buy' && state?.autoSell && state.available !== '0.0000 REX' ? <Text style={styles.hint}>{t('rex.autoSell', { amount: state.available })}</Text> : null}
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('rex.review')} disabled={locked || !canSign || !!invalid} style={[styles.cta, (locked || !canSign || !!invalid) && styles.disabled]} onPress={() => void prepare()}><Text style={styles.ctaText}>{preparing ? t('rex.preparing') : t('rex.review')}</Text></TouchableOpacity>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!canSign ? <Text style={styles.hint}>{t('resource.readOnlyHint')}</Text> : null}
    </View>
  </View>;
}
const styles = StyleSheet.create({
  wrap: { gap: 12 }, card: { backgroundColor: colors.white, borderRadius: 10, padding: 16, gap: 12 }, row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }, title: { fontSize: 16, fontWeight: '700', color: colors.text }, muted: { color: colors.textSub, fontSize: 13, flexShrink: 1 }, metric: { color: colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' }, hint: { color: colors.textSub, fontSize: 13, lineHeight: 19 }, error: { color: '#C0392B', fontSize: 13, lineHeight: 19 }, refresh: { minHeight: 44, justifyContent: 'center' }, link: { color: '#1E88FF', fontSize: 14 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 }, tab: { minWidth: '40%', flexGrow: 1, minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: '#F2F3F5' }, selected: { backgroundColor: '#E5F0FF' }, active: { color: '#1E88FF', fontWeight: '600' }, inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F3F5', paddingHorizontal: 12, borderRadius: 8, gap: 8 }, input: { flex: 1, minWidth: 0, minHeight: 52, textAlign: 'right', color: colors.text, fontSize: 15 }, cta: { minHeight: 52, borderRadius: 10, backgroundColor: '#1E88FF', alignItems: 'center', justifyContent: 'center' }, disabled: { backgroundColor: '#A9C9F5' }, ctaText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
