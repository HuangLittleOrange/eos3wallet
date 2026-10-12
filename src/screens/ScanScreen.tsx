import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';

import { colors, spacing } from '../theme';
import { parseQr } from '../chain/parseQr';
import { useDappSession } from '../dapp/DappSessionContext';
import { RootStackParamList } from '../navigation/RootNavigator';
import { useI18n } from '../i18n';

const BLUE = '#1E88FF';

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<RouteProp<RootStackParamList, 'Scan'>>();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [pickingAlbum, setPickingAlbum] = useState(false);
  const handled = useRef(false);
  const { openDapp, openEsr } = useDappSession();
  const { t } = useI18n();

  /** 相机连续回调、相册选图各走一次,识别结果的处理逻辑是同一套,抽出来共用。
   *  返回 true 表示识别出了能处理的内容(已经跳走/关页),false 表示这码
   *  认不出来,调用方决定要不要提示用户。 */
  const handleScanResult = useCallback(
    (data: string): boolean => {
      const r = parseQr(data);
      const back = route.params?.returnTo;

      if (r.kind === 'esr') {
        // 交给常驻浏览会话统一处理签名请求(复用同一套确认弹窗),关掉扫码页
        openEsr(r.uri);
        nav.goBack();
        return true;
      }
      if (r.kind === 'url') {
        openDapp(r.url);
        nav.goBack();
        return true;
      }
      if (r.kind === 'account') {
        // 有来源页就回填,否则去转账页
        nav.navigate(back ?? 'Send', { scanned: r } as any);
        return true;
      }
      return false;
    },
    [nav, route.params, openDapp, openEsr]
  );

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      // 相机会连续回调,只处理第一次
      if (handled.current) return;
      handled.current = true;
      // 无法识别 —— 放行让用户再扫,不弹提示打断(扫到无关二维码很常见)
      if (!handleScanResult(data)) handled.current = false;
    },
    [handleScanResult]
  );

  /** 从相册选一张图,识别里面的二维码——参考 Anchor/主流钱包的扫码页,
   *  很多签名请求二维码是在电脑网页上生成的,用户经常是先截图存到相册
   *  再打开钱包,而不是举着手机对着屏幕拍。expo-camera 的 scanFromURLAsync
   *  是纯离线识别(同一个原生条码引擎,只是喂图片文件而不是取景器画面),
   *  不上传图片。 */
  const pickFromAlbum = useCallback(async () => {
    if (pickingAlbum) return;
    setPickingAlbum(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          t('scan.albumPermTitle'),
          perm.canAskAgain ? t('scan.albumPermBody') : t('scan.albumPermDeniedBody')
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      const uri = result.canceled ? null : result.assets?.[0]?.uri;
      if (!uri) return;
      const codes = await scanFromURLAsync(uri, ['qr']);
      if (!codes.length || !handleScanResult(codes[0].data)) {
        Alert.alert(t('scan.albumNoCodeTitle'), t('scan.albumNoCodeBody'));
      }
    } catch (e: any) {
      Alert.alert(t('scan.albumFailedTitle'), e?.message ?? t('send.unknownError'));
    } finally {
      setPickingAlbum(false);
    }
  }, [pickingAlbum, handleScanResult, t]);

  if (!permission) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={BLUE} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <Header onClose={() => nav.goBack()} t={t} />
        <View style={styles.center}>
          <Ionicons name="camera-outline" size={64} color="#C7CBD4" />
          <Text style={styles.permTitle}>{t('scan.cameraPermTitle')}</Text>
          <Text style={styles.permDesc}>{t('scan.cameraPermDesc')}</Text>
          <TouchableOpacity style={styles.permBtn} onPress={requestPermission} activeOpacity={0.85}>
            <Text style={styles.permBtnTxt}>{t('scan.grantCamera')}</Text>
          </TouchableOpacity>
          {!permission.canAskAgain ? (
            <TouchableOpacity onPress={() => Linking.openSettings()}>
              <Text style={styles.settingsTxt}>{t('scan.deniedGoSettings')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill as any}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScanned}
      />

      {/* 取景框 */}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.topMask, { paddingTop: insets.top }]}>
          <Header light onClose={() => nav.goBack()} t={t} />
          <Text style={styles.tip}>{t('scan.frameTip')}</Text>
        </View>

        <View style={styles.frameRow}>
          <View style={styles.sideMask} />
          <View style={styles.frame}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />
          </View>
          <View style={styles.sideMask} />
        </View>

        <View style={styles.bottomMask}>
          <View style={styles.bottomRow}>
            <TouchableOpacity style={styles.torchBtn} onPress={() => setTorch((v) => !v)}>
              <Ionicons name={torch ? 'flashlight' : 'flashlight-outline'} size={26} color="#fff" />
              <Text style={styles.torchTxt}>{torch ? t('scan.torchOff') : t('scan.torchOn')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.torchBtn} onPress={pickFromAlbum} disabled={pickingAlbum}>
              {pickingAlbum ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Ionicons name="images-outline" size={26} color="#fff" />
              )}
              <Text style={styles.torchTxt}>{t('scan.albumBtn')}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>{t('scan.hint')}</Text>
        </View>
      </View>
    </View>
  );
}

function Header({
  onClose,
  light,
  t,
}: {
  onClose: () => void;
  light?: boolean;
  t: (key: 'scan.title') => string;
}) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.headerBtn}>
        <Ionicons name="close" size={26} color={light ? '#fff' : colors.text} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, light && { color: '#fff' }]}>{t('scan.title')}</Text>
      <View style={styles.headerBtn} />
    </View>
  );
}

const MASK = 'rgba(0,0,0,0.6)';
const FRAME = 260;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 14, backgroundColor: colors.white },

  header: { flexDirection: 'row', alignItems: 'center', height: 50, paddingHorizontal: 12 },
  headerBtn: { width: 44 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },

  permTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 6 },
  permDesc: { fontSize: 14, color: colors.textSub, textAlign: 'center', lineHeight: 22 },
  permBtn: { backgroundColor: BLUE, paddingHorizontal: 32, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  permBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
  settingsTxt: { color: BLUE, fontSize: 14, marginTop: 4 },

  overlay: { flex: 1 },
  topMask: { flex: 1, backgroundColor: MASK },
  tip: { color: '#fff', fontSize: 15, textAlign: 'center', marginTop: 'auto', marginBottom: 20 },
  frameRow: { flexDirection: 'row', height: FRAME },
  sideMask: { flex: 1, backgroundColor: MASK },
  frame: { width: FRAME, height: FRAME },
  corner: { position: 'absolute', width: 28, height: 28, borderColor: BLUE },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  bottomMask: { flex: 1, backgroundColor: MASK, alignItems: 'center', paddingTop: 30, gap: 12 },
  bottomRow: { flexDirection: 'row', gap: 48 },
  torchBtn: { alignItems: 'center', gap: 6, minWidth: 64 },
  torchTxt: { color: '#fff', fontSize: 13 },
  hint: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
});
