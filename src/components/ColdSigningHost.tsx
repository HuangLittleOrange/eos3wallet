import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BottomSheet from './BottomSheet';
import { acceptColdSignature, cancelColdSigning, chooseColdSigningKey, coldSigningSnapshot, subscribeColdSigning } from '../chain/coldSigning';
import { useWalletSession } from '../chain/WalletContext';
import { useI18n } from '../i18n';
import { colors } from '../theme';
import { TokenPocketQrCollector, tokenPocketQrFrames } from '../chain/tokenPocketQr';

/** Uses the existing modal host so it can overlay native confirmation and DApps. */
export default function ColdSigningHost() {
  const request = useSyncExternalStore(subscribeColdSigning, coldSigningSnapshot, coldSigningSnapshot);
  const w = useWalletSession();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [camera, requestCamera] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [localError, setLocalError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [frame, setFrame] = useState(0);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const handled = useRef(false);
  const collector = useRef(new TokenPocketQrCollector());
  const frames = useMemo(() => {
    try { return request?.qr ? tokenPocketQrFrames(request.qr) : []; } catch { return []; }
  }, [request?.qr]);
  const context = JSON.stringify([w.account, w.chainId, w.node.url, w.currentWallet?.id]);
  useEffect(() => () => cancelColdSigning(), [context]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state === 'background') cancelColdSigning(); });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    setScanning(false); setLocalError(''); handled.current = false;
    if (!request) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request?.id]);
  useEffect(() => {
    collector.current = new TokenPocketQrCollector(); setProgress(null); setFrame(0);
    if (frames.length < 2) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % frames.length), 350);
    return () => clearInterval(timer);
  }, [frames]);
  if (!request) return null;
  const receive = async (data: string) => {
    if (handled.current) return;
    handled.current = true;
    setLocalError('');
    await acceptColdSignature(data, request.id);
    setScanning(false); handled.current = false;
  };
  const scan = async () => {
    setLocalError('');
    try {
      const permission = camera?.granted ? camera : await requestCamera();
      if (!permission.granted) { setLocalError(t('scan.cameraPermDesc')); return; }
      collector.current = new TokenPocketQrCollector(); setProgress(null);
      handled.current = false; setScanning(true);
    } catch { setLocalError(t('scan.cameraPermDesc')); }
  };
  const error = localError || request.error;
  return <BottomSheet visible onClose={cancelColdSigning} priority={20}>
    <View style={[styles.sheet, { maxHeight: height - insets.top - 12, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={styles.title}>{t('coldSigning.title')}</Text>
        <TouchableOpacity accessibilityRole="button" onPress={cancelColdSigning} style={styles.button}><Text style={styles.link}>{t('coldSigning.cancel')}</Text></TouchableOpacity>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text selectable style={styles.identity}>{request.actor}@{request.permission}</Text>
        <Text style={styles.hint}>{t('coldSigning.remaining', { seconds: Math.max(0, Math.ceil((request.expiration - now) / 1000)) })}</Text>
        <Text style={styles.hint}>{t('coldSigning.tpHint')}</Text>
        {request.loading || request.validating ? <ActivityIndicator accessibilityLabel={t('coldSigning.checking')} /> : null}
        {request.keys.length > 1 ? <Text style={styles.hint}>{t('coldSigning.chooseKey')}</Text> : null}
        {request.keys.map(key => <TouchableOpacity key={key} accessibilityRole="radio"
          accessibilityState={{ selected: request.publicKey === key }} disabled={request.validating}
          style={[styles.key, request.publicKey === key && styles.selected]}
          onPress={() => { setScanning(false); setLocalError(''); chooseColdSigningKey(key); }}>
          <Text selectable style={styles.keyText}>{key}</Text>
        </TouchableOpacity>)}
        {scanning ? <>
          <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              try {
                const result = collector.current.accept(data); setProgress(result);
                if (result.text !== undefined) void receive(result.text);
              } catch { setLocalError(t('coldSigning.invalidResponse')); }
            }} />
          {progress && progress.total > 1 ? <Text style={styles.hint}>{t('coldSigning.fragments', { received: progress.received, total: progress.total })}</Text> : null}
          <TouchableOpacity style={styles.button} onPress={() => setScanning(false)}><Text style={styles.link}>{t('coldSigning.backToQr')}</Text></TouchableOpacity>
        </> : frames.length ? <View style={styles.qr}><QRCode value={frames[frame % frames.length]}
          size={Math.min(width - 100, 280)} ecl="L" quietZone={12}
          onError={() => setLocalError(t('coldSigning.tooLarge'))} /></View> : null}
        {frames.length > 1 && !scanning ? <Text style={styles.hint}>{t('coldSigning.frames', { received: frame + 1, total: frames.length })}</Text> : null}
        {request.qr && !frames.length ? <Text style={styles.error}>{t('coldSigning.tooLarge')}</Text> : null}
        {error ? <Text selectable accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {!request.loading ? <TouchableOpacity style={styles.primary}
          disabled={request.validating} onPress={() => void scan()}><Text style={styles.primaryText}>{t('coldSigning.scanResult')}</Text></TouchableOpacity> : null}
        {!camera?.granted && camera?.canAskAgain === false ? <TouchableOpacity style={styles.button} onPress={() => void Linking.openSettings()}><Text style={styles.link}>{t('scan.deniedGoSettings')}</Text></TouchableOpacity> : null}
        <View style={styles.row}>
          <TouchableOpacity style={styles.button} disabled={!request.qr || request.validating} onPress={() => { void Clipboard.setStringAsync(request.qr).catch(() => setLocalError(t('coldSigning.invalidResponse'))); }}><Text style={styles.link}>{t('coldSigning.copy')}</Text></TouchableOpacity>
          <TouchableOpacity style={styles.button} disabled={request.loading || request.validating} onPress={() => {
            void Clipboard.getStringAsync().then(receive).catch(() => setLocalError(t('coldSigning.invalidResponse')));
          }}><Text style={styles.link}>{t('coldSigning.paste')}</Text></TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  </BottomSheet>;
}
const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 },
  content: { gap: 12, alignItems: 'stretch', paddingBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  title: { fontSize: 18, fontWeight: '700', color: colors.text, flexShrink: 1 },
  identity: { fontSize: 16, fontWeight: '600', color: colors.text }, hint: { color: colors.textSub, fontSize: 13, lineHeight: 20 },
  link: { color: '#1E88FF', fontSize: 14 }, button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  selected: { backgroundColor: '#EDF5FF', borderColor: '#1E88FF' },
  key: { padding: 10, minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: colors.line }, keyText: { color: colors.textSub, fontSize: 11 },
  qr: { alignSelf: 'center', backgroundColor: '#fff', padding: 12 }, camera: { height: 260, borderRadius: 12, overflow: 'hidden' },
  error: { color: '#C0392B', fontSize: 13, lineHeight: 20 }, primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1E88FF', borderRadius: 10 }, primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
