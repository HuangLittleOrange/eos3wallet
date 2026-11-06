import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CHAINS, type ChainId } from '../chain/config';
import { useCustomNetworks } from '../chain/customNetworks';
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
        <Ionicons name={networkId === 'jungle4' ? 'leaf-outline' : 'globe-outline'} size={size * 0.6} color="#fff" />
      </View>}
    {CHAINS[networkId].testnet ? <View style={styles.testnetBadge}><Text style={styles.testnetBadgeText}>T</Text></View> : null}
  </View>;
}

export function NetworkList({ selected, onSelect, manageVisibility = false }: {
  selected: ChainId; onSelect: (network: ChainId) => void; manageVisibility?: boolean;
}) {
  const { t } = useI18n();
  useCustomNetworks();
  const { enabled, ready, readError } = useNetworkVisibility();
  const [busy, setBusy] = useState<ChainId | null>(null);
  if (!ready) return <ActivityIndicator style={styles.loading} color="#2980FF" />;
  if (readError) return <View style={styles.error}>
    <Text style={styles.errorText}>{t('network.settingsError')}</Text>
    <TouchableOpacity style={styles.retry} onPress={() => { void retryNetworkVisibility(); }}><Text style={styles.activeText}>{t('content.retry')}</Text></TouchableOpacity>
  </View>;
  return <View style={styles.list}>
      <ScrollView>
        {Object.values(CHAINS).filter(network => manageVisibility || enabled.includes(network.id)).map(network => <TouchableOpacity key={network.id}
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
            <Text style={styles.description}>{t(network.testnet ? 'manageWallet.testnet' : 'manageWallet.mainnet')}
              {network.custom ? ` · ${t('network.custom')}` : ''}</Text>
          </View>
          {manageVisibility ? <Ionicons name={enabled.includes(network.id) ? 'checkmark-circle' : 'ellipse-outline'} size={25}
            color={enabled.includes(network.id) ? '#2980FF' : '#BDC2CA'} />
            : selected === network.id ? <Ionicons name="checkmark" size={23} color="#1E88FF" /> : null}
        </TouchableOpacity>)}
        <TouchableOpacity style={styles.addNetwork} accessibilityLabel={t('network.addCustom')}
          onPress={() => { if (navigationRef.isReady()) navigationRef.navigate('AddNetwork'); }}>
          <View style={styles.addIcon}><Ionicons name="add" size={24} color="#2980FF" /></View>
          <Text style={styles.addText}>{t('network.addCustom')}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
        </TouchableOpacity>
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
  addNetwork: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 76, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  addIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#EDF5FF', alignItems: 'center', justifyContent: 'center' },
  addText: { flex: 1, color: '#2980FF', fontSize: 16, fontWeight: '500' },
  activeText: { color: '#1677FF', fontWeight: '600' },
  option: { flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 78 },
  optionLabel: { flex: 1 },
  name: { fontSize: 17, fontWeight: '600', color: colors.text },
  description: { marginTop: 4, fontSize: 13, color: colors.textSub },
});
