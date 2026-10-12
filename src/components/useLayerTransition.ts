import { useEffect, useRef, useState } from 'react';

/**
 * BottomSheet / CenterDialog 共用的"入场/退场时机"管理,动画本身(曲线、时长、
 * 动哪个属性)由调用方在 enter/exit 里自己写。
 *
 * 为什么不能 visible 一变就开播:弹层内容要经过 ModalPortal 登记 → ModalHost
 * 重渲染 → 原生视图挂载,才真正画到屏幕上,首次打开这一段实测约 70ms(内容越重
 * 越久)。动画在这之前就开始计时的话,等画面出来已经播了一大截——录屏里看到的
 * 是遮罩第一帧就淡入了七成、面板从半路冒出来,开场像是"啪"一下闪出来的。
 * 所以首次打开时先把起点状态画出来(遮罩透明、面板在屏幕外,看不见),等内容
 * 的 onLayout 回来——这时原生视图已经挂好了——再开始播,整段动画都看得见。
 *
 * 关闭同理要播完退场动画再卸载:一卸载内容就瞬间消失,所以 mounted 比外部的
 * visible 多活一段退场动画的时间。
 */
export function useLayerTransition(
  visible: boolean,
  anim: {
    /** 回到入场起点(直接给 shared value 赋值,不带动画) */
    reset: () => void;
    /** 开始入场动画 */
    enter: () => void;
    /** 开始退场动画;动画完整播完(没被重新打开打断)时调用 onDone */
    exit: (onDone: () => void) => void;
  }
): { mounted: boolean; onLayout: () => void } {
  const [mounted, setMounted] = useState(visible);
  // 本轮挂载的内容是否已经在宿主里布局过(= 已经在屏幕上)
  const laidOut = useRef(false);
  // 等 onLayout 回来再开播
  const enterPending = useRef(false);
  const animRef = useRef(anim);
  animRef.current = anim;

  useEffect(() => {
    const a = animRef.current;
    if (visible) {
      setMounted(true);
      // 万一上一次退场还没播完就又打开了,先归位到起点,不然从半路继续播,
      // 开场动画的时长/曲线全乱了
      a.reset();
      if (laidOut.current) {
        // 退场播到一半又被打开:内容还在屏幕上,不会再来一次 onLayout,直接播
        a.enter();
      } else {
        enterPending.current = true;
      }
    } else {
      enterPending.current = false;
      a.exit(() => {
        laidOut.current = false;
        setMounted(false);
      });
    }
  }, [visible]);

  const onLayout = () => {
    laidOut.current = true;
    if (enterPending.current) {
      enterPending.current = false;
      animRef.current.enter();
    }
  };

  return { mounted, onLayout };
}
