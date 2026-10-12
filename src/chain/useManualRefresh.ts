import { useEffect, useState } from 'react';

/**
 * 各页面的下拉刷新(RefreshControl)之前直接绑 w.status === 'loading'——
 * 但这个 status 是 WalletContext 全局共用的,冷启动、切账户、切节点故障转移、
 * 广播完交易后……这些静默的后台刷新全都会把它设成 'loading',于是每次打开
 * App 或者切个账户,页面顶部都会毫无缘由地弹出一次原生下拉转圈,像是又卡住了。
 *
 * 这里把"用户确实自己拉了一下"单独记一份本地状态,只在调用 onRefresh 时才亮起,
 * 静默刷新不会碰它;等这一轮刷新真正跑完(status 离开 'loading',无论成功/失败/
 * 期间故障转移重试完)再统一收起。首页余额、资源页卡片等展示用的还是原来的
 * w.status/缓存兜底逻辑,不受影响——这里只管 RefreshControl 那一个转圈。
 */
export function useManualRefresh(status: string, refresh: (opts?: { force?: boolean }) => Promise<void>) {
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (status !== 'loading') setRefreshing(false);
  }, [status]);

  const onRefresh = () => {
    setRefreshing(true);
    refresh({ force: true });
  };

  return { refreshing, onRefresh };
}
