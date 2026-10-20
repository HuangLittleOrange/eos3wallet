import { useCallback, useEffect, useRef, useState } from 'react';

import { addDappHistory, getRiskAck, setRiskAck } from './dappGate';
import { useDappSession } from './DappSessionContext';
import { useWalletSession } from '../chain/WalletContext';
import type { ChainId } from '../chain/config';

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
  const { chainId } = useWalletSession();
  const network = useRef(chainId), sequence = useRef(0);
  network.current = chainId;
  type Request = { url: string; networkId: ChainId; id: number };
  const [request, setRequest] = useState<Request | null>(null);
  const currentRequest = useRef(request);
  currentRequest.current = request;
  useEffect(() => { sequence.current++; setRequest(null); return () => { sequence.current++; }; }, [chainId]);

  const goto = useCallback(
    (url: string, networkId: ChainId) => {
      if (network.current !== networkId) return;
      void addDappHistory(url, undefined, networkId);
      openDapp(url, networkId);
      onOpened?.();
    },
    [openDapp, onOpened]
  );

  const open = useCallback(
    async (url: string) => {
      const networkId = network.current, id = ++sequence.current;
      setRequest(null);
      const acknowledged = await getRiskAck();
      if (network.current !== networkId || sequence.current !== id) return;
      if (acknowledged) {
        goto(url, networkId);
      } else {
        setRequest({ url, networkId, id });
      }
    },
    [goto]
  );

  const cancel = useCallback(() => {
    if (currentRequest.current === request) { sequence.current++; setRequest(null); }
  }, [request]);

  const confirm = useCallback(
    (dontShowAgain: boolean) => {
      if (!request || currentRequest.current !== request || sequence.current !== request.id || network.current !== request.networkId) return;
      sequence.current++;
      if (dontShowAgain) void setRiskAck();
      goto(request.url, request.networkId);
      setRequest(null);
    },
    [request, goto]
  );

  return { open, pending: request?.networkId === chainId && request.id === sequence.current ? request.url : null, cancel, confirm };
}
