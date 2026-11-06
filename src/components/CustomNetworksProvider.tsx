import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { retryCustomNetworks, useCustomNetworks } from '../chain/customNetworks';
import { useI18n } from '../i18n';

/** Restore chain identities before restoring wallet sessions or filtering saved visibility. */
export default function CustomNetworksProvider({ children }: { children: React.ReactNode }) {
  const { ready, readError } = useCustomNetworks();
  const { t } = useI18n();
  if (ready && !readError) return <>{children}</>;
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 }}>
    {readError ? <>
      <Text>{t('network.settingsError')}</Text>
      <TouchableOpacity onPress={() => { void retryCustomNetworks(); }}><Text style={{ color: '#2980FF' }}>{t('content.retry')}</Text></TouchableOpacity>
    </> : <ActivityIndicator color="#2980FF" />}
  </View>;
}
