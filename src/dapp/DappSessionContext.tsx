import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * DApp 浏览会话 —— 全局只记一个"当前/最近打开"的会话。
 *
 * DappBrowserScreen 不是一个会被 push/pop 的路由,而是挂在 App 根部的
 * 常驻宿主(见 DappOverlayHost)按 session/minimized 决定要不要挂载。
 * 「最小化」不保活:退到后台就整个卸载(WebView 一起销毁),只留一个
 * 悬浮球记着网址;点悬浮球恢复是重新挂载、重新加载,不是切回原状态。
 * 再打开别的网址会直接替换掉这个槽位。
 */
export type DappSession = {
  /** 每次 openDapp 递增,用于判断"这是同一个会话被切回来了"还是"要开一个新的" */
  id: number;
  url: string;
};

type Ctx = {
  session: DappSession | null;
  minimized: boolean;
  openDapp: (url: string) => void;
  /**
   * 处理一条 Anchor/ESR 签名请求(扫码、LinkSessionProvider 收到的推送)——
   * 跟"打开一个网页"是两码事,不占用/不影响上面的 session 和悬浮球。见
   * EsrRequestHost.tsx 顶部注释:这类请求本质只是弹确认框、签名、把签名
   * POST 出去,不需要真的起一个 WebView。
   */
  openEsr: (uri: string, signal?: AbortSignal) => void;
  /** EsrRequestHost 消费掉一条待处理请求后调用,清空这个槽位 */
  pendingEsr: string | null;
  pendingEsrSignal: AbortSignal | undefined;
  clearPendingEsr: () => void;
  minimize: () => void;
  restore: () => void;
  close: () => void;
};

const DappSessionCtx = createContext<Ctx | null>(null);

let nextId = 1;

export function DappSessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<DappSession | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<{ uri: string; signal?: AbortSignal } | null>(null);
  const pendingEsr = pendingRequest?.uri ?? null;
  const pendingEsrSignal = pendingRequest?.signal;

  const openDapp = useCallback((url: string) => {
    setSession({ id: nextId++, url });
    setMinimized(false);
  }, []);

  const openEsr = useCallback((uri: string, signal?: AbortSignal) => {
    if (!signal?.aborted) setPendingRequest({ uri, signal });
  }, []);
  const clearPendingEsr = useCallback(() => setPendingRequest(null), []);

  const minimize = useCallback(() => setMinimized(true), []);
  const restore = useCallback(() => setMinimized(false), []);
  const close = useCallback(() => {
    setSession(null);
    setMinimized(false);
  }, []);

  // 和 WalletContext 同一条规则:Provider 的 value 必须 memo 化,
  // 不然每次渲染造新对象,所有消费方跟着白渲染一遍
  const value = useMemo(
    () => ({ session, minimized, openDapp, openEsr, pendingEsr, pendingEsrSignal, clearPendingEsr, minimize, restore, close }),
    [session, minimized, openDapp, openEsr, pendingEsr, pendingEsrSignal, clearPendingEsr, minimize, restore, close]
  );

  return <DappSessionCtx.Provider value={value}>{children}</DappSessionCtx.Provider>;
}

export function useDappSession(): Ctx {
  const v = useContext(DappSessionCtx);
  if (!v) throw new Error('useDappSession 必须在 DappSessionProvider 内使用');
  return v;
}
