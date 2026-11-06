import React, { useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import PageHeader from '../components/PageHeader';
import { addCustomNetwork, NetworkValidationError } from '../chain/customNetworks';
import { setNetworkVisible } from '../chain/networkVisibility';
import { useI18n, type TranslationKey } from '../i18n';
import { colors } from '../theme';

export default function AddNetworkScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [rpcUrl, setRpcUrl] = useState('');
  const [hash, setHash] = useState('');
  const [symbol, setSymbol] = useState('');
  const [testnet, setTestnet] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [backupRpcUrl, setBackupRpcUrl] = useState('');
  const [precision, setPrecision] = useState('4');
  const [systemToken, setSystemToken] = useState('eosio.token');
  const [resourceContract, setResourceContract] = useState('eosio');
  const [historyUrl, setHistoryUrl] = useState('');
  const [explorerUrl, setExplorerUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const busy = useRef(false);
  const submit = async () => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError(null);
    try {
      const network = await addCustomNetwork({ name, rpcUrl, chainIdHash: hash, symbol, testnet, backupRpcUrl,
        precision: /^\d{1,2}$/.test(precision) ? Number(precision) : NaN,
        systemToken, resourceContract, historyUrl, explorerUrl });
      // Saving a valid network must not be reported as failed if only visibility storage fails.
      try { await setNetworkVisible(network.id, true); }
      catch { Alert.alert(t('network.settingsError')); }
      nav.goBack();
    } catch (failure) { setError(failure instanceof NetworkValidationError ? failure.key : 'network.saveFailed'); }
    finally { busy.current = false; setSaving(false); }
  };
  const field = (key: TranslationKey, value: string, onChangeText: (value: string) => void, placeholder: string, numeric = false) =>
    <View style={styles.field}>
      <Text style={styles.label}>{t(key)}</Text>
      <TextInput accessibilityLabel={t(key)} value={value} onChangeText={onChangeText} placeholder={placeholder}
        placeholderTextColor="#A3A9B3" style={styles.input} editable={!saving} autoCapitalize="none" autoCorrect={false}
        keyboardType={numeric ? 'number-pad' : key.toLowerCase().includes('url') ? 'url' : 'default'}
        maxLength={key === 'network.chainId' ? 64 : 2048} />
    </View>;
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <PageHeader title={t('network.addCustom')} onBack={() => { if (!saving) nav.goBack(); }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.typeRow}><View style={styles.typeIcon}><Ionicons name="globe-outline" size={24} color="#2980FF" /></View>
        <View style={{ flex: 1 }}><Text style={styles.typeTitle}>EOSIO</Text><Text style={styles.hint}>{t('network.compatible')}</Text></View>
      </View>
      {field('network.name', name, setName, t('network.namePlaceholder'))}
      {field('network.rpcUrl', rpcUrl, setRpcUrl, 'https://')}
      {field('network.chainId', hash, setHash, t('network.chainIdPlaceholder'))}
      {field('network.symbol', symbol, value => setSymbol(value.toUpperCase()), 'EOS')}
      <View style={styles.switchRow}><Text style={styles.label}>{t('manageWallet.testnet')}</Text>
        <Switch accessibilityLabel={t('manageWallet.testnet')} value={testnet} onValueChange={setTestnet} disabled={saving}
          trackColor={{ false: '#E2E5EB', true: '#2980FF' }} />
      </View>
      <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: advanced }} style={styles.advanced} disabled={saving} onPress={() => setAdvanced(!advanced)}>
        <Text style={styles.link}>{t('network.advanced')}</Text><Ionicons name={advanced ? 'chevron-up' : 'chevron-down'} size={18} color="#2980FF" />
      </TouchableOpacity>
      <Text style={styles.hint}>{t('network.backupHint')}</Text>
      {advanced ? <>
        {field('network.backupRpc', backupRpcUrl, setBackupRpcUrl, 'https://')}
        {field('network.precision', precision, setPrecision, '4', true)}
        {field('network.tokenContract', systemToken, setSystemToken, 'eosio.token')}
        {field('network.resourceContract', resourceContract, setResourceContract, 'eosio')}
        {field('network.historyUrl', historyUrl, setHistoryUrl, 'https://')}
        {field('network.explorerUrl', explorerUrl, setExplorerUrl, 'https://')}
      </> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{t(error)}</Text> : null}
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('network.save')} style={[styles.save, saving && styles.disabled]}
        disabled={saving} onPress={submit}>
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{t('network.save')}</Text>}
      </TouchableOpacity>
      <Text style={[styles.hint, styles.footnote]}>{t('network.verifyHint')}</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white }, content: { paddingHorizontal: 20 },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 20, marginBottom: 4 },
  typeIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: '#EDF5FF', justifyContent: 'center', alignItems: 'center' },
  typeTitle: { fontSize: 17, fontWeight: '600', color: colors.text },
  field: { marginTop: 18 }, label: { fontSize: 14, color: colors.text, fontWeight: '500' },
  input: { minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#DDE1E8', fontSize: 15, color: colors.text, paddingVertical: 12 },
  hint: { fontSize: 12, lineHeight: 18, color: colors.textSub, marginTop: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22 },
  advanced: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 6 }, link: { fontSize: 14, color: '#2980FF' },
  save: { minHeight: 50, borderRadius: 10, backgroundColor: '#2980FF', justifyContent: 'center', alignItems: 'center', marginTop: 22 },
  saveText: { fontSize: 16, fontWeight: '600', color: '#fff' }, disabled: { opacity: 0.6 },
  error: { color: '#D44141', fontSize: 13, lineHeight: 20, marginTop: 10 }, footnote: { marginTop: 12, textAlign: 'center' },
});
