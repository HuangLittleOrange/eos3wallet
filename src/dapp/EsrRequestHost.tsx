// 常驻在 App 根部 —— 处理"没有关联 DApp 浏览会话"的 Anchor/ESR 签名请求
// (ScanScreen 扫码、LinkSessionProvider 收到已建立会话的推送)。
//
// 这类请求本质只是"弹一个确认框、签个名、把签名 POST 出去",压根不需要
// 真的打开一个网页/起一个 WebView。以前借用 DappBrowserScreen 走这条路,
// 是为了跟"网页内触发的 esr:/anchor:// 深链、esrRequest postMessage"复用
// 同一套 parseEsr/签名逻辑(那两种情况有一个正在浏览的 WebView,继续用
// DappBrowserScreen 是对的,见该文件)——代价是每次扫码/推送登录都会在
// 背后多起一个 WebView,还得给它挑一个"占位网址"垫底:历史上挂的是
// bloks.io,后来这个域名自己被重定向去了别的网站,用户点完登录码,确认框
// 一关背后突然冒出一个不相关的网页,以为是自己点错了/登录出了问题——而这
// 类请求本来就不该有"背后的网页"这个概念。这个文件把这条路径整个搬出来,
// 不碰 DappSessionContext 的 session/悬浮球,自然也没有"占位网址"这一说。
//
// 解析/签名/回调的具体流程在 useEsrFlow 里,和 DappBrowserScreen 共用同一份
// ——本文件只剩"从 pendingEsr 槽位接请求"和确认弹窗的壳。唯一的分叉:
// signAndCallback 返回 'redirect' 时,回调本身是一个要导航过去的真实网址,
// 这时候是真的要打开一个网页,交给 openDapp() 走正常的 DApp 浏览器。
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import ConfirmTxSheet from '../components/ConfirmTxSheet';
import { useI18n } from '../i18n';
import { useDappSession } from './DappSessionContext';
import { useEsrFlow } from './useEsrFlow';

const BLUE = '#1E88FF';

export default function EsrRequestHost() {
  const { pendingEsr, clearPendingEsr, openDapp } = useDappSession();
  const { t } = useI18n();
  const flow = useEsrFlow({ onRedirect: openDapp });

  // pendingEsr 一出现就立刻认领掉(清空槽位),避免同一条请求被处理两次
  useEffect(() => {
    if (!pendingEsr) return;
    const uri = pendingEsr;
    clearPendingEsr();
    flow.open(uri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEsr]);

  return (
    <>
      {flow.parsing ? (
        <View style={styles.loading} pointerEvents="none">
          <View style={styles.loadingCard}>
            <ActivityIndicator color={BLUE} />
            <Text style={styles.loadingTxt}>{t('dappBrowser.connectingNode')}</Text>
          </View>
        </View>
      ) : null}
      <ConfirmTxSheet
        callbackOrigin={flow.esr?.req.callbackOrigin}
        visible={flow.esr !== null}
        onClose={flow.close}
        // 没有浏览页可以兜底显示域名(见文件顶部注释)——没报 scope 的老式
        // 请求就留空,不用一个不相关的网址去凑
        actions={flow.sheetActions()}
        chainName={flow.chainConfig.name}
        testnet={flow.chainConfig.testnet}
        actor={flow.account}
        permission={flow.permission}
        busy={flow.busy}
        error={flow.err}
        walletId={flow.wallet?.id}
        passkey={flow.wallet?.source === 'passkey'}
        onConfirm={flow.submitPassword}
        onConfirmBiometric={flow.submitBiometric}
        onConfirmPasskey={flow.submitPasskey}
      />
      {flow.repairElement}
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.white,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
  },
  loadingTxt: { fontSize: 14, color: colors.text },
});
