import { useCallback, useState } from 'react';

import { addDappHistory, getRiskAck, setRiskAck } from './dappGate';
import { useDappSession } from './DappSessionContext';

/**
 * 打开 DApp 的统一入口 —— 首次跳转(或未勾选「不再提示」)先弹风险确认,
 * 确认后记入历史并交给常驻的浏览会话打开。供宫格、搜索页等所有打开入口
 * 复用,保证不管从哪点进去,步骤都一致。
 *
 * onOpened 在「真正打开」那一刻触发(跳过确认时立即触发,需要确认时等
 * confirm() 之后才触发)—— 从搜索页这类临时页面打开时用它顺手退掉搜索页,
 * 这样之后「最小化」浮层露出来的才是主页面,而不是停在搜索的中间状态。
 */
export function useOpenDapp(onOpened?: () => void) {
  const { openDapp } = useDappSession();
  const [pending, setPending] = useState<string | null>(null);

  const goto = useCallback(
    (url: string) => {
      addDappHistory(url);
      openDapp(url);
      onOpened?.();
    },
    [openDapp, onOpened]
  );

  const open = useCallback(
    async (url: string) => {
      if (await getRiskAck()) {
        goto(url);
      } else {
        setPending(url);
      }
    },
    [goto]
  );

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(
    (dontShowAgain: boolean) => {
      if (!pending) return;
      if (dontShowAgain) setRiskAck();
      goto(pending);
      setPending(null);
    },
    [pending, goto]
  );

  return { open, pending, cancel, confirm };
}
