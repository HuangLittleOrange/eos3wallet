import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import PageHeader from '../components/PageHeader';
import { NetworkIcon, NetworkList } from '../components/NetworkSelector';
import { useWalletSession } from '../chain/WalletContext';
import { CHAINS, isChainId, type ChainId } from '../chain/config';
import { useI18n } from '../i18n';
import { colors } from '../theme';

/** Network selection is a navigation page, never a second sheet above the wallet list. */
export default function NetworksScreen() {
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { chainId, setChain } = useWalletSession();
  const { t } = useI18n();
  const addWallet = route.params?.addWallet === true;
  const manageVisibility = route.params?.manageVisibility === true;
  const addingNetwork = addWallet && isChainId(route.params?.selectedNetwork) ? route.params.selectedNetwork as ChainId : null;
  const select = (network: ChainId) => {
    setChain(network);
    if (addWallet) nav.push('Networks', { addWallet: true, selectedNetwork: network });
    else nav.goBack();
  };
  return <View style={[styles.root, { paddingBottom: insets.bottom }]}>
    <PageHeader title={t(manageVisibility ? 'manageWallet.manageNetwork' : addingNetwork ? 'walletList.selectAddMethod' : 'walletList.selectNetwork')}
      right={manageVisibility ? <TouchableOpacity accessibilityLabel={t('dappTabs.done')} style={styles.headerAction} onPress={() => nav.goBack()}>
        <Text style={styles.done}>{t('dappTabs.done')}</Text>
      </TouchableOpacity> : !addingNetwork ? <TouchableOpacity accessibilityLabel={t('manageWallet.manageNetwork')} style={styles.headerAction}
        onPress={() => nav.push('Networks', { manageVisibility: true })}><Ionicons name="add" size={24} color={colors.text} /></TouchableOpacity> : undefined}
      onBack={() => nav.goBack()} />
    {addingNetwork ? <View style={styles.actions}>
      <View style={styles.network}>
        <NetworkIcon networkId={addingNetwork} />
        <Text style={styles.name}>{CHAINS[addingNetwork].name} · {t(CHAINS[addingNetwork].testnet ? 'manageWallet.testnet' : 'manageWallet.mainnet')}</Text>
      </View>
      <TouchableOpacity style={styles.action} onPress={() => nav.replace('CreateWalletMethod')}>
        <Text style={styles.label}>{t('walletList.createWallet')}</Text><Ionicons name="chevron-forward" size={20} color={colors.textSub} />
      </TouchableOpacity>
      <TouchableOpacity style={styles.action} onPress={() => nav.replace('Import')}>
        <Text style={styles.label}>{t('walletList.importWallet')}</Text><Ionicons name="chevron-forward" size={20} color={colors.textSub} />
      </TouchableOpacity>
    </View> : <NetworkList selected={chainId} onSelect={select} manageVisibility={manageVisibility} />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  actions: { paddingHorizontal: 16 },
  network: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 20 },
  name: { flex: 1, fontSize: 16, color: colors.text },
  action: { flexDirection: 'row', alignItems: 'center', minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  label: { flex: 1, fontSize: 17, color: colors.text },
  headerAction: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' },
  done: { fontSize: 15, color: '#2980FF' },
});
