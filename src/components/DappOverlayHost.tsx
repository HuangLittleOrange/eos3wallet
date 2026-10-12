import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDappSession } from '../dapp/DappSessionContext';
import DappBrowserScreen from '../screens/DappBrowserScreen';

/**
 * 挂在 App 根部的常驻宿主 —— 「最小化」不保活:退到后台就把
 * DappBrowserScreen 整个卸载掉(WebView 一起销毁,不占内存/电量),
 * 只留一个悬浮球记着这是哪个网址;点悬浮球恢复时是重新挂载、重新加载,
 * 不是切回原来的会话。「关闭」和「最小化」因此只剩一个区别:
 * 关闭会把 session 清空、悬浮球也一起消失;最小化还留着悬浮球和网址,
 * 方便一键再打开。
 */
export default function DappOverlayHost() {
  const { session, minimized, restore } = useDappSession();
  const insets = useSafeAreaInsets();

  if (!session) return null;

  return (
    <>
      {!minimized ? (
        <View style={styles.full}>
          {/* 按 session.id 建 key ——不能指望「切会话前一定先经过最小化卸载」
              这个假设总成立(比如上一个会话还开着、没最小化就直接来了新的
              openDapp):没有 key,React 会照常复用同一个组件实例,url 这个
              只在 mount 时算一次的 state 就会拿着上一个会话的残留值不放,
              DappBrowserScreen 自己「每次打开都整个重新挂载」的假设(见该
              文件顶部注释)就被打破了。加 key 保证每次都是真正的全新挂载。 */}
          <DappBrowserScreen key={session.id} />
        </View>
      ) : null}

      {minimized ? (
        <TouchableOpacity
          style={[styles.bubble, { bottom: insets.bottom + 74 }]}
          activeOpacity={0.85}
          onPress={restore}
        >
          <Ionicons name="globe-outline" size={20} color="#fff" />
        </TouchableOpacity>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  full: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 },

  bubble: {
    position: 'absolute',
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1E88FF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    zIndex: 999,
  },
});
