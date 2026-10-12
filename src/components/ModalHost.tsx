import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { BackHandler, Keyboard, StyleSheet, View, type NativeEventSubscription } from 'react-native';

import {
  allocLayerId,
  getLayers,
  hasOpenLayers,
  removeLayer,
  requestCloseTop,
  subscribeLayers,
  upsertLayer,
} from './modalLayers';

// 全 App 的弹层宿主——纯 JS 实现,不用原生 Modal,原因见 modalLayers.ts 顶部说明。
//
// 用法约定:
//   - App.tsx 里用 <ModalHost> 把整个 App 内容包起来,放在所有全局 Provider 里面;
//   - 业务代码一律用 BottomSheet / CenterDialog(它们内部走 ModalPortal),
//     不要直接用 react-native 的 Modal——守门测试 noRawModal.test.ts 会拦;
//   - 弹层可以随便并排摆、随便叠、关一个马上开另一个,都不用再操心;
//   - 监听安卓返回键用这里的 addBackHandler,别直接用 BackHandler(同样有守门测试)。
//
// 原生 Modal 顺带替我们做的几件事,这里逐一补上:
//   1. 盖在一切之上:弹层容器是 App 内容的后一个兄弟,再加上足够高的 zIndex/
//      elevation;App 内容单独包一层 View,里面的悬浮球(zIndex 999)之类只在
//      这一层里比较,越不过弹层。
//   2. 安卓返回键:见下面 ModalHost 里的 BackHandler 和 addBackHandler。
//   3. 读屏隔离:有弹层时把 App 内容和被盖住的下层弹层对 VoiceOver/TalkBack 隐藏,
//      焦点只在最上面一层里走。
//   4. 收键盘:新弹层打开时收起底下页面的键盘,见 ModalPortal。
//
// 限制:
//   - 弹层内容实际渲染在 ModalHost 的位置,只能拿到 App 级的 Context(钱包、
//     i18n、安全区、DApp 会话……),拿不到页面级的 useNavigation()/useRoute()。
//     弹层里要跳页面,就在页面组件里写好回调传进去。
//   - 纯 JS 层画在 RN 根视图里,盖不住系统原生弹出的页面——所以导航里不能用
//     presentation: 'modal' / 'formSheet' 这类原生弹出方式(守门测试会拦)。

let hostMounted = 0;

/**
 * 把 children 登记成全局弹层栈里的一层,原地什么都不渲染。挂载即打开、
 * 卸载即关闭,层级按打开的先后顺序叠——所以动画/延迟卸载这些逻辑仍然由
 * 调用方(BottomSheet/CenterDialog)自己管,这里只负责"放到哪儿显示"。
 */
export function ModalPortal({ children, onRequestClose }: { children: React.ReactNode; onRequestClose?: () => void }) {
  const idRef = useRef<number | null>(null);
  if (idRef.current === null) idRef.current = allocLayerId();
  const id = idRef.current;

  // 这个 effect 必须写在下面登记内容的 effect 前面(同一组件的 layout effect
  // 按声明顺序执行)。
  useLayoutEffect(() => {
    // 原生 Modal 弹出时,底下页面的输入框会失去焦点、键盘收起;纯 JS 层没有这
    // 一步,不补的话页面上正在输入的框会让键盘一直顶着,把新弹层底部的按钮盖住。
    // 在登记之前收:这时新弹层的内容还没渲染,收掉的只可能是底下的输入框,
    // 不会误伤新弹层里 autoFocus 的输入框。
    Keyboard.dismiss();
    // 晚一拍再查:首帧里 ModalHost 自己的 effect 可能比这里还晚执行
    const timer = __DEV__
      ? setTimeout(() => {
          if (hostMounted === 0) console.error('ModalPortal: 没有找到 <ModalHost>,弹层不会显示。检查 App.tsx 是否用 ModalHost 包住了 App 内容。');
        }, 0)
      : undefined;
    return () => {
      clearTimeout(timer);
      removeLayer(id);
    };
  }, [id]);

  // 每次渲染都把最新的 children 推过去(不带依赖数组是故意的):children 里
  // 捕获着页面的最新 state/回调,漏推一次弹层里显示的就是旧数据。
  // 用 layout effect 而不是 effect:和原地渲染一样在同一帧上屏,不慢一拍。
  useLayoutEffect(() => {
    upsertLayer({ id, node: children, onRequestClose });
  });

  return null;
}

/**
 * 监听安卓返回键,代替 BackHandler.addEventListener('hardwareBackPress', ...)。
 *
 * 有弹层开着时自动让路(返回 false,交给后面的处理者),返回键先由 ModalHost
 * 关掉最上面那层——原来原生 Modal 是独立窗口,返回键天然先到它那里;换成纯 JS
 * 层以后,BackHandler 是"后注册的先执行",页面在弹层打开之后才(重新)注册的
 * 处理(比如 DApp 浏览器随网页能否后退重新注册)会抢在弹层前面,必须由这里兜住。
 */
export function addBackHandler(handler: () => boolean | null | undefined): NativeEventSubscription {
  return BackHandler.addEventListener('hardwareBackPress', () => (hasOpenLayers() ? false : handler()));
}

/** 有弹层时对 VoiceOver(accessibilityElementsHidden)和 TalkBack(importantForAccessibility)都隐藏 */
function hiddenFromScreenReader(hidden: boolean) {
  return {
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? ('no-hide-descendants' as const) : ('auto' as const),
  };
}

export default function ModalHost({ children }: { children: React.ReactNode }) {
  const layers = useSyncExternalStore(subscribeLayers, getLayers);
  const open = layers.length > 0;
  const topId = layers[layers.length - 1]?.id;

  useEffect(() => {
    hostMounted += 1;
    return () => {
      hostMounted -= 1;
    };
  }, []);

  // 有弹层时接管安卓返回键:只关最上面一层,并且吞掉这次按键(和原生 Modal
  // 一样,不会同时把底下的页面也退掉)。页面自己的返回键处理都走
  // addBackHandler,弹层开着时会让路,所以不管谁先注册都轮得到这里。
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestCloseTop();
      return true;
    });
    return () => sub.remove();
  }, [open]);

  return (
    <View style={styles.fill}>
      <View style={styles.fill} {...hiddenFromScreenReader(open)}>
        {children}
      </View>
      {open ? (
        // 每层各占一整屏、按登记顺序叠放:后打开的在上面。层内的遮罩、面板、
        // 动画都由各层自己画(BottomSheet/CenterDialog),样式和动画与原来一层
        // 一个原生 Modal 时完全一样——原来的 Modal 就是 animationType="none"
        // 的透明容器,动画本来就全在 JS 这边。
        <View style={styles.layers} pointerEvents="box-none">
          {layers.map((layer) => (
            <View
              key={layer.id}
              style={StyleSheet.absoluteFill}
              pointerEvents="box-none"
              {...hiddenFromScreenReader(layer.id !== topId)}
            >
              {layer.node as React.ReactNode}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // 比 App 里任何悬浮层都高;elevation 是给安卓的——安卓按 elevation 决定兄弟
  // 视图的绘制先后,只写 zIndex 不够
  layers: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000, elevation: 10000 },
});
