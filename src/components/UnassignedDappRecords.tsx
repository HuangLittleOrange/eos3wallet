import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { assignDappRecord, type DappHistoryItem, type DappFavorite } from '../dapp/dappGate';
import { CHAINS, type ChainId } from '../chain/config';
import { useI18n } from '../i18n';
import { colors } from '../theme';

export default function UnassignedDappRecords({ entries, kind, networkId, existingUrls = [] }: {
  entries: (DappHistoryItem | DappFavorite)[]; kind: 'history' | 'favorite'; networkId: ChainId;
  existingUrls?: string[];
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const unclaimed = entries.filter(item => !existingUrls.includes(item.url));
  if (!unclaimed.length) return null;
  return <View style={styles.section}>
    <Text style={styles.title}>{t('network.unassigned')}</Text>
    {unclaimed.map(item => <View key={item.url} style={styles.row}>
      <Text numberOfLines={2} style={styles.url}>{item.url}</Text>
      <TouchableOpacity disabled={busy !== null} style={styles.action} onPress={async () => {
        setBusy(item.url);
        try { await assignDappRecord(kind, item.url, networkId); }
        catch { Alert.alert(t('content.refreshFailed')); }
        finally { setBusy(null); }
      }}>
        <Text style={styles.actionText}>{t('network.assign', { network: CHAINS[networkId].name })}</Text>
      </TouchableOpacity>
    </View>)}
  </View>;
}
const styles = StyleSheet.create({
  section: { paddingVertical: 16 },
  title: { color: colors.textSub, fontSize: 13, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  url: { flex: 1, color: colors.textSub, fontSize: 13 },
  action: { minHeight: 44, justifyContent: 'center', maxWidth: '48%' },
  actionText: { color: '#1677FF', fontSize: 13 },
});
