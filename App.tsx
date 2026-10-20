import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import { WalletProvider } from './src/chain/WalletContext';
import { MessagesProvider } from './src/chain/MessagesContext';
import { DappSessionProvider } from './src/dapp/DappSessionContext';
import DappOverlayHost from './src/components/DappOverlayHost';
import EsrRequestHost from './src/dapp/EsrRequestHost';
import LinkSessionProvider from './src/dapp/LinkSessionProvider';
import ModalHost from './src/components/ModalHost';
import ColdSigningHost from './src/components/ColdSigningHost';
import { I18nProvider } from './src/i18n';
import { AppContentProvider } from './src/content/AppContentContext';
import { NodeCatalogProvider } from './src/chain/NodeCatalogContext';
import { AppUpdateProvider } from './src/update/AppUpdateProvider';
import { UsageAnalyticsProvider } from './src/analytics/UsageAnalyticsContext';
import NetworkVisibilityGuard from './src/components/NetworkVisibilityGuard';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <UsageAnalyticsProvider>
      <I18nProvider>
        <AppContentProvider>
          <NodeCatalogProvider>
          <WalletProvider>
            <NetworkVisibilityGuard />
            <MessagesProvider>
              <DappSessionProvider>
                {/* 弹层宿主:包住整个 App 内容,所有 BottomSheet/CenterDialog 都叠在这层上面
                    渲染(纯 JS,不用原生 Modal)。必须放在所有全局 Provider 里面,
                    见 components/ModalHost.tsx */}
                <ModalHost>
                  <AppUpdateProvider>
                    <RootNavigator />
                    {/* 常驻在导航器之上,「最小化」的 DApp 页面靠它保活,不受路由栈影响 */}
                    <DappOverlayHost />
                    {/* 扫码/推送来的签名请求——不需要 WebView,不占用/不影响上面的
                        浏览会话和悬浮球,见文件内注释 */}
                    <EsrRequestHost />
                    {/* 常驻监听 Anchor Link 接收频道——已建立会话的 dApp 推新的签名请求
                        过来不用再扫码,见文件内注释 */}
                    <LinkSessionProvider />
                    <ColdSigningHost />
                  </AppUpdateProvider>
                </ModalHost>
              </DappSessionProvider>
            </MessagesProvider>
          </WalletProvider>
          </NodeCatalogProvider>
        </AppContentProvider>
      </I18nProvider>
      </UsageAnalyticsProvider>
    </SafeAreaProvider>
  );
}
