import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { ModalPortal } from './ModalHost';
import { useLayerTransition } from './useLayerTransition';
import { spacing } from '../theme';

const IN_MS = 200;
const OUT_MS = 160;
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);

/**
 * 统一的"居中淡入"弹窗容器 —— 替代各处裸用 `<Modal transparent animationType="fade">`。
 * 跟 BottomSheet(见那边注释)是同一套思路:遮罩和卡片各自的动画轴分开、
 * Reanimated 在 UI 线程上驱动、退场播完再真正卸载、经 ModalPortal 交给全局
 * ModalHost 渲染——只是形状换成居中卡片而不是贴底面板,给密码校验、二次确认
 * 这类居中弹窗用。
 *
 * 卡片额外带一点缩放(0.96→1),不是照抄 BottomSheet:纯淡入在原生 fade
 * 转场下几乎看不出方向感,居中卡片配一点"从近处浮现"的缩放才有弹窗该有的
 * 出场感;底部面板不需要这个,滑入本身已经给了方向感。
 */
export default function CenterDialog({
  visible,
  onClose,
  children,
  backdropColor = 'rgba(0,0,0,0.45)',
  closeOnBackdrop = true,
  padding = spacing.lg,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  backdropColor?: string;
  /** 忙碌中不许点遮罩关掉时传 false(比如密码校验/提交进行中) */
  closeOnBackdrop?: boolean;
  /** 卡片跟屏幕边缘的最小间距——各处卡片宽度策略不一样(定宽 / 百分比 + maxWidth),
   * 这个间距因此也不统一,交给调用方传,不强行统一视觉 */
  padding?: number;
}) {
  const backdrop = useSharedValue(0);
  const scale = useSharedValue(0.96);

  // 开播/卸载时机见 useLayerTransition,这里只管动画本身
  const { mounted, onLayout } = useLayerTransition(visible, {
    reset: () => {
      backdrop.value = 0;
      scale.value = 0.96;
    },
    enter: () => {
      backdrop.value = withTiming(1, { duration: IN_MS, easing: EASE_OUT });
      scale.value = withTiming(1, { duration: IN_MS, easing: EASE_OUT });
    },
    exit: (onDone) => {
      backdrop.value = withTiming(0, { duration: OUT_MS, easing: EASE_IN });
      scale.value = withTiming(0.96, { duration: OUT_MS, easing: EASE_IN }, (finished) => {
        if (finished) runOnJS(onDone)();
      });
    },
  });

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const cardStyle = useAnimatedStyle(() => ({ opacity: backdrop.value, transform: [{ scale: scale.value }] }));

  if (!mounted) return null;

  return (
    <ModalPortal onRequestClose={onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor }, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={closeOnBackdrop ? onClose : undefined} />
      </Animated.View>
      <Animated.View
        style={[styles.wrap, { padding }, cardStyle]}
        pointerEvents="box-none"
        onLayout={onLayout}
      >
        {children}
      </Animated.View>
    </ModalPortal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
