// DApp 调 tp.invokeQRScanner() 时弹的扫码框。
//
// 为什么不直接跳去 App 的扫码页:DApp 浏览器是铺在整个导航栈上面的悬浮层
// (见 DappOverlayHost),跳过去的扫码页会被它盖在底下,用户根本看不见。
// 而且那个扫码页扫到东西会按类型分流(转账、打开网页、签名请求),这里要的
// 只是把原始文本原样交还给页面,两边行为本来就不一样。
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';

import BottomSheet from './BottomSheet';
import { useI18n } from '../i18n';

export default function DappScanModal({
  visible,
  onResult,
  onCancel,
}: {
  visible: boolean;
  onResult: (text: string) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [permission, requestPermission] = useCameraPermissions();
  // 相机会对同一张码连续回调好几次,只认第一次
  const handled = useRef(false);

  useEffect(() => {
    if (visible) handled.current = false;
    if (visible && permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [visible, permission, requestPermission]);

  return (
    // 走 BottomSheet 而不是自己开原生 Modal(原因见 modalLayers.ts):内容撑满
    // 整屏、遮罩透明,效果就是原来 animationType="slide" 的整页从下往上推入
    <BottomSheet visible={visible} onClose={onCancel} backdropColor="transparent" closeOnBackdrop={false}>
      <View style={styles.root}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              handled.current = true;
              onResult(data);
            }}
          />
        ) : (
          <View style={styles.center}>
            <Text style={styles.permTxt}>{t('scan.cameraPermDesc')}</Text>
            {permission && !permission.canAskAgain ? (
              <TouchableOpacity onPress={() => Linking.openSettings()}>
                <Text style={styles.link}>{t('scan.deniedGoSettings')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}

        <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={onCancel} hitSlop={10}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>{t('scan.title')}</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.frame} pointerEvents="none" />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  // 撑满整屏用 height 而不是 flex: 1——BottomSheet 顶部有个 flex: 1 的占位块,
  // 用 flex: 1 会跟它平分高度,见 BottomSheet
  root: { height: '100%', backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 14 },
  permTxt: { color: '#fff', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  link: { color: '#4DA3FF', fontSize: 14 },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '600' },
  frame: {
    position: 'absolute',
    alignSelf: 'center',
    top: '30%',
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 16,
  },
});
