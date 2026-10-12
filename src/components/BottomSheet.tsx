import React, { useRef, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { ModalPortal } from './ModalHost';
import { useLayerTransition } from './useLayerTransition';

const SCREEN_H = Dimensions.get('window').height;
const IN_MS = 260;
const OUT_MS = 220;
const FADE_MS = 180;

// 弹出/收起分别用非对称曲线,而不是 timing 默认的 Easing.inOut(ease)(两头都慢的
// 对称曲线,面板刚弹出的头几十毫秒几乎看不出在动,像是点了没反应):
//   - 弹出:一入场就是最大速度(ease-out),手指一抬起来面板立刻有响应,
//     越到后面越慢地停稳,不会硬停
//   - 收起:同理反过来(ease-in),关闭动作要干脆
const EASE_OUT = Easing.out(Easing.cubic);
const EASE_IN = Easing.in(Easing.cubic);

/**
 * 统一的"从底部弹出"容器 —— 替代各处裸用 `<Modal transparent animationType="slide">`。
 *
 * RN 的 Modal 内置动画把遮罩和内容当成同一块一起位移:遮罩本该是"啪"一下
 * 就在(或者淡入)的,却被迫跟着面板一起从屏幕外提上来,看着很僵硬,像是
 * 背景和菜单粘在了一起。这里自己接管两条动画轴,互不牵连:
 *   - 遮罩:只做透明度淡入淡出
 *   - 面板:只做垂直位移滑入滑出
 *
 * 用 Reanimated 而不是 RN 内置 Animated(哪怕带 useNativeDriver)——后者数值
 * 虽是原生驱动,但动画的发起/推进仍挂在 JS 线程的调度节奏上:面板第一次
 * 挂载时子树(列表、图标)本身要花时间创建/排布,跟动画启动抢同一条线程,
 * 之前得靠"多等一帧再开始播"这种错峰手段才能不让开场动画被吞帧。
 * Reanimated 的 shared value 由 JSI 在 JS/UI 线程间直接同步,动画整个在 UI
 * 线程上调度和推进,JS 线程这会儿在忙挂载也不耽误动画按时往下走,不再
 * 需要错峰技巧。
 *
 * 什么时候开播、什么时候卸载(等内容真正上屏才开播、播完退场才卸载)交给
 * useLayerTransition,这里只写动画本身。
 *
 * 不自己开原生 Modal,而是经 ModalPortal 交给全局唯一的 ModalHost 渲染——
 * iOS 上多个原生 Modal 并存会被系统静默吞掉,见 modalLayers.ts。
 */
export default function BottomSheet({
  visible,
  onClose,
  children,
  backdropColor = 'rgba(0,0,0,0.45)',
  closeOnBackdrop = true,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  backdropColor?: string;
  /** 忙碌中不许点遮罩关掉时传 false(比如签名/提交进行中) */
  closeOnBackdrop?: boolean;
}) {
  // 动画期间(且仅动画期间)把面板这一整棵子树栅格化成一张位图去做变换,
  // 而不是每一帧都重新合成里面所有的 ScrollView/图标/文字——面板内容本来就
  // 不轻(链导轨 + 钱包卡片列表),逐帧合成本身是跟动画驱动方式无关的一笔
  // GPU 合成开销,换了 Reanimated 也省不掉,所以继续保留这个优化。动画一
  // 结束就关掉,不然常驻打开的话,里面 ScrollView 一滚动,栅格化缓存反而
  // 每帧失效重画,比不栅格化还慢。
  const [rasterize, setRasterize] = useState(false);
  const backdrop = useSharedValue(0);
  // 面板位置用 0→1 的进度表示,实际位移 = (1 - 进度) × 面板自身高度。
  // 以前是从"一整屏高"的位置滑上来,可面板本身往往只有三四百像素高——按
  // ease-out 曲线,前一半时间都在屏幕外空跑,用户只看得到曲线末尾那段减速,
  // 录屏里是"点了 → 遮罩先暗 → 100ms 后面板才冒头",一点都不跟手。
  // 按面板自身高度算位移,整条曲线都落在看得见的那段距离上。
  const progress = useSharedValue(0);
  // 面板高度量出来之前先按整屏算:保证起点一定在屏幕外,不会闪一下
  const distance = useSharedValue(SCREEN_H);
  const containerH = useRef(0);
  const spacerH = useRef<number | null>(null);

  // 什么时候开播/什么时候卸载交给 useLayerTransition(内容真正上屏才开播,
  // 见那边注释),这里只管动画本身
  const { mounted, onLayout } = useLayerTransition(visible, {
    reset: () => {
      setRasterize(true);
      backdrop.value = 0;
      progress.value = 0;
    },
    enter: () => {
      backdrop.value = withTiming(1, { duration: FADE_MS, easing: EASE_OUT });
      progress.value = withTiming(1, { duration: IN_MS, easing: EASE_OUT }, (finished) => {
        if (finished) runOnJS(setRasterize)(false);
      });
    },
    exit: (onDone) => {
      setRasterize(true);
      const done = () => {
        setRasterize(false);
        containerH.current = 0;
        spacerH.current = null;
        onDone();
      };
      backdrop.value = withTiming(0, { duration: OUT_MS, easing: EASE_IN });
      progress.value = withTiming(0, { duration: OUT_MS, easing: EASE_IN }, (finished) => {
        if (finished) runOnJS(done)();
      });
    },
  });

  // 面板高度 = 容器高度 − 顶部占位块高度(见下面 JSX 里的占位块)。两个 onLayout
  // 都到了才算数,算出来再通知 useLayerTransition 可以开播了。量不出来(比如
  // 面板自己用了 position: 'absolute',不占布局)就维持整屏距离,只是回到以前
  // 的效果,不会出错。
  const measure = () => {
    if (!containerH.current || spacerH.current === null) return;
    const sheetH = containerH.current - spacerH.current;
    if (sheetH > 1) distance.value = sheetH;
    onLayout();
  };
  const onContainerLayout = (e: LayoutChangeEvent) => {
    containerH.current = e.nativeEvent.layout.height;
    measure();
  };
  const onSpacerLayout = (e: LayoutChangeEvent) => {
    spacerH.current = e.nativeEvent.layout.height;
    measure();
  };

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * distance.value }] }));

  if (!mounted) return null;

  return (
    <ModalPortal onRequestClose={onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: backdropColor }, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={closeOnBackdrop ? onClose : undefined} />
      </Animated.View>
      {/* 撑满整屏再把面板推到底部(靠下面的占位块)——不能只给 left/right/bottom
          不给 top:那样这层没有自己的高度,面板里各处写的 height: '68%' 这类
          百分比就没有基准可算,量出来会比预期矮一截,底部内容(比如管理钱包
          那颗宫格按钮)就被切没了。 */}
      <Animated.View
        style={[StyleSheet.absoluteFill, panelStyle]}
        pointerEvents="box-none"
        onLayout={onContainerLayout}
        shouldRasterizeIOS={rasterize}
        renderToHardwareTextureAndroid={rasterize}
      >
        {/* 顶部占位块:吃掉面板上方的全部空白,效果等同于 justifyContent: 'flex-end'
            (所以面板里的百分比高度照旧以整屏为基准),顺便让我们量出面板有多高。
            不拦截点击,点它就是点到下面的遮罩。面板根节点因此不要用 flex: 1
            撑满——会跟它平分空间;要撑满整屏用 height: '100%'。 */}
        <View style={styles.spacer} pointerEvents="none" onLayout={onSpacerLayout} />
        {children}
      </Animated.View>
    </ModalPortal>
  );
}

const styles = StyleSheet.create({
  spacer: { flex: 1 },
});
