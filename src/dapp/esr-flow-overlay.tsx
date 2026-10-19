import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import ConfirmTxSheet from '../components/ConfirmTxSheet';
import { useI18n } from '../i18n';
import { colors } from '../theme';
import type { useEsrFlow } from './useEsrFlow';

/** Shared presentation for browser links, QR requests and Link session pushes.
 * All signing identity and handlers come from the flow that owns the request.
 */
export default function EsrFlowOverlay({ flow, origin }: {
  flow: ReturnType<typeof useEsrFlow>;
  origin?: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {flow.parsing ? (
        <View style={styles.loading} pointerEvents="none">
          <View style={styles.loadingCard}>
            <ActivityIndicator color="#1E88FF" />
            <Text style={styles.loadingTxt}>{t('dappBrowser.connectingNode')}</Text>
          </View>
        </View>
      ) : null}
      <ConfirmTxSheet
        visible={flow.esr !== null}
        callbackOrigin={flow.esr?.req.callbackOrigin}
        origin={origin}
        onClose={flow.close}
        actions={flow.sheetActions(origin)}
        chainName={flow.chainConfig.name}
        testnet={flow.chainConfig.testnet}
        actor={flow.account}
        permission={flow.permission}
        busy={flow.busy}
        error={flow.err}
        walletId={flow.wallet?.id}
        passkey={flow.wallet?.source === 'passkey'}
        external={flow.wallet?.source === 'watch'}
        onConfirm={flow.submitPassword}
        onConfirmBiometric={flow.submitBiometric}
        onConfirmPasskey={flow.submitPasskey}
      />
      {flow.repairElement}
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.15)',
  },
  loadingCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.white,
    paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12,
  },
  loadingTxt: { fontSize: 14, color: colors.text },
});
