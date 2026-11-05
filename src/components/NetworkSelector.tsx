import React, { useEffect, useState } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CHAINS, networksFor, type ChainId, type NetworkKind } from '../chain/config';
import { useWalletSession } from '../chain/WalletContext';
import { useI18n } from '../i18n';
import { colors } from '../theme';
import { navigationRef } from '../navigation/navigationRef';
import { useNetworkVisibility, setNetworkVisible, retryNetworkVisibility } from '../chain/networkVisibility';

export function NetworkIcon({ networkId, size = 36 }: { networkId: ChainId; size?: number }) {
  return <View style={{ width: size, height: size }}>
    {networkId === 'vaulta' ? <Image source={require('../../assets/tokens/vaulta.png')}
      style={{ width: size, height: size, borderRadius: size / 2 }} /> :
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#21A76B', alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="leaf-outline" size={size * 0.6} color="#fff" />
      </View>}
    {CHAINS[networkId].testnet ? <View style={styles.testnetBadge}><Text style={styles.testnetBadgeText}>T</Text></View> : null}
  </View>;
}

export function NetworkList({ selected, onSelect, manageVisibility = false }: {
  selected: ChainId; onSelect: (network: ChainId) => void; manageVisibility?: boolean;
}) {
  const { t } = useI18n();
  const { enabled, ready, readError } = useNetworkVisibility();
  const [busy, setBusy] = useState<ChainId | null>(null);
  const [kind, setKind] = useState<NetworkKind>(!manageVisibility && CHAINS[selected].testnet ? 'testnet' : 'mainnet');
  useEffect(() => {
    if (!manageVisibility) setKind(CHAINS[selected].testnet ? 'testnet' : 'mainnet');
  }, [selected, manageVisibility]);
  const kinds = (['mainnet', 'testnet'] as const).filter(value => manageVisibility || networksFor(value).some(network => enabled.includes(network.id)));
  const activeKind = kinds.includes(kind) ? kind : 'mainnet';
  if (!ready) return <ActivityIndicator style={styles.loading} color="#2980FF" />;
  if (readError) return <View style={styles.error}>
    <Text style={styles.errorText}>{t('network.settingsError')}</Text>
    <TouchableOpacity style={styles.retry} onPress={() => { void retryNetworkVisibility(); }}><Text style={styles.activeText}>{t('content.retry')}</Text></TouchableOpacity>
  </View>;
  return <View style={styles.list}>
      <View style={styles.tabs}>
        {kinds.map(value => <TouchableOpacity key={value}
          accessibilityRole="tab" accessibilityState={{ selected: activeKind === value }}
          onPress={() => setKind(value)} style={[styles.tab, activeKind === value && styles.activeTab]}>
          <Text style={[styles.tabText, activeKind === value && styles.activeText]}>
            {t(value === 'mainnet' ? 'manageWallet.mainnet' : 'manageWallet.testnet')}
          </Text>
        </TouchableOpacity>)}
      </View>
      <ScrollView>
        {networksFor(activeKind).filter(network => manageVisibility || enabled.includes(network.id)).map(network => <TouchableOpacity key={network.id}
          accessibilityRole={manageVisibility ? 'checkbox' : 'button'}
          accessibilityState={manageVisibility ? { checked: enabled.includes(network.id), disabled: busy !== null || network.id === 'vaulta' } : { selected: selected === network.id }}
          disabled={manageVisibility && (busy !== null || network.id === 'vaulta')} style={styles.option}
          onPress={async () => {
            if (!manageVisibility) { onSelect(network.id); return; }
            setBusy(network.id);
            try { await setNetworkVisible(network.id, !enabled.includes(network.id)); }
            catch { Alert.alert(t('network.settingsError')); }
            finally { setBusy(null); }
          }}>
          <NetworkIcon networkId={network.id} />
          <View style={styles.optionLabel}>
            <Text style={styles.name}>{network.name}</Text>
            <Text style={styles.description}>{t(network.testnet ? 'manageWallet.testnet' : 'manageWallet.mainnet')}</Text>
          </View>
          {manageVisibility ? <Ionicons name={enabled.includes(network.id) ? 'checkmark-circle' : 'ellipse-outline'} size={25}
            color={enabled.includes(network.id) ? '#2980FF' : '#BDC2CA'} />
            : selected === network.id ? <Ionicons name="checkmark" size={23} color="#1E88FF" /> : null}
        </TouchableOpacity>)}
      </ScrollView>
    </View>;
}

/** Every entry point reads the same WalletContext network selection. */
export default function NetworkSelector() {
  const { chainId } = useWalletSession();
  const { t } = useI18n();
  const network = CHAINS[chainId];
  return <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('manageWallet.manageNetwork')}
      onPress={() => { if (navigationRef.isReady()) navigationRef.navigate('Networks'); }} style={styles.trigger}>
      <Text numberOfLines={1} style={[styles.triggerText, network.testnet && styles.testnetText]}>
        {network.name} · {t(network.testnet ? 'manageWallet.testnet' : 'manageWallet.mainnet')}
      </Text>
      <Ionicons name="chevron-down" size={15} color={colors.textSub} />
    </TouchableOpacity>;
}

const styles = StyleSheet.create({
  trigger: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  triggerText: { fontSize: 13, fontWeight: '600', color: colors.text, flexShrink: 1 },
  testnetBadge: { position: 'absolute', right: -2, bottom: -1, backgroundColor: '#FFF0CD', borderRadius: 5, paddingHorizontal: 3, borderWidth: 1, borderColor: '#fff' },
  testnetBadgeText: { fontSize: 9, fontWeight: '700', color: '#945900' },
  testnetText: { color: '#A15C00' },
  list: { flex: 1, paddingHorizontal: 16, backgroundColor: colors.white },
  loading: { marginTop: 32 },
  error: { padding: 24, alignItems: 'center' },
  errorText: { color: colors.textSub, textAlign: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', marginTop: 12 },
  tabs: { flexDirection: 'row', gap: 10, marginVertical: 12 },
  tab: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderBottomWidth: 2, borderBottomColor: '#F2F3F5' },
  activeTab: { borderBottomColor: '#2980FF' },
  tabText: { fontSize: 15, color: colors.textSub },
  activeText: { color: '#1677FF', fontWeight: '600' },
  option: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 78 },
  optionLabel: { flex: 1 },
  name: { fontSize: 17, fontWeight: '600', color: colors.text },
  description: { marginTop: 4, fontSize: 13, color: colors.textSub },
});
