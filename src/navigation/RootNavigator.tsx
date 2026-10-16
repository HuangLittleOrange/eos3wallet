import React from 'react';
import { Platform, View, ActivityIndicator } from 'react-native';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { navigationRef } from './navigationRef';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { PlatformPressable } from '@react-navigation/elements';

import { colors } from '../theme';
import { TokenBalance, ChainAction } from '../chain/client';
import { useWallet } from '../chain/WalletContext';
import { useI18n } from '../i18n';

import OnboardingScreen from '../screens/OnboardingScreen';
import WalletScreen from '../screens/WalletScreen';
import DiscoverScreen from '../screens/DiscoverScreen';
import MeScreen from '../screens/MeScreen';
import ReceiveScreen from '../screens/ReceiveScreen';
import SendScreen from '../screens/SendScreen';
import TokenDetailScreen from '../screens/TokenDetailScreen';
import ResourceScreen from '../screens/ResourceScreen';
import ImportScreen from '../screens/ImportScreen';
import ImportSecretScreen from '../screens/ImportSecretScreen';
import ImportWatchScreen from '../screens/ImportWatchScreen';
import DeviceKeyImportScreen from '../screens/DeviceKeyImportScreen';
import SetMasterPasswordScreen from '../screens/SetMasterPasswordScreen';
import CreateWalletMethodScreen from '../screens/CreateWalletMethodScreen';
import CreateAccountPayScreen from '../screens/CreateAccountPayScreen';
import PasskeyLoginScreen from '../screens/PasskeyLoginScreen';
import PasskeyCreateScreen from '../screens/PasskeyCreateScreen';
import SearchScreen from '../screens/SearchScreen';
import AddTokenScreen from '../screens/AddTokenScreen';
import TotalAssetScreen from '../screens/TotalAssetScreen';
import ManageWalletScreen from '../screens/ManageWalletScreen';
import SecurityScreen from '../screens/SecurityScreen';
import LanguageScreen from '../screens/LanguageScreen';
import NodeScreen from '../screens/NodeScreen';
import ScanScreen from '../screens/ScanScreen';
import AddressBookScreen from '../screens/AddressBookScreen';
import TxRecordScreen from '../screens/TxRecordScreen';
import WalletDetailScreen from '../screens/WalletDetailScreen';
import PermissionScreen from '../screens/PermissionScreen';
import PermissionDetailScreen from '../screens/PermissionDetailScreen';
import BindAuthorizeScreen from '../screens/BindAuthorizeScreen';
import DappTabsScreen from '../screens/DappTabsScreen';
import MessageCenterScreen from '../screens/MessageCenterScreen';
import TransactionDetailScreen from '../screens/TransactionDetailScreen';
import LinkSessionsScreen from '../screens/LinkSessionsScreen';
import LinkSessionDetailScreen from '../screens/LinkSessionDetailScreen';

export type RootStackParamList = {
  Tabs: undefined;
  Receive: { token?: TokenBalance } | undefined;
  Send: {
    token?: TokenBalance;
    scanned?: { account: string; memo?: string; amount?: string; symbol?: string; contract?: string; precision?: number };
  } | undefined;
  TokenDetail: { token: TokenBalance };
  TransactionDetail: { tx: ChainAction; token: TokenBalance };
  Resource: undefined;
  Import: undefined;
  ImportSecret: { mode: 'mnemonic' | 'privatekey' };
  ImportWatch: undefined;
  DeviceKeyImport: { provider?: 'anchor' } | undefined;
  SetMasterPassword: undefined;
  CreateWalletMethod: undefined;
  CreateAccountPay: undefined;
  PasskeyLogin: undefined;
  PasskeyCreate: undefined;
  Search: undefined;
  AddToken: undefined;
  TotalAsset: undefined;
  ManageWallet: undefined;
  Security: undefined;
  Language: undefined;
  Node: undefined;
  Scan: { returnTo?: keyof RootStackParamList } | undefined;
  AddressBook: { picking?: boolean } | undefined;
  TxRecord: undefined;
  WalletDetail: undefined;
  Permission: undefined;
  PermissionDetail: { permissionKey: string };
  BindAuthorize: { bindId: string };
  DappTabs: undefined;
  MessageCenter: undefined;
  LinkSessions: undefined;
  LinkSessionDetail: { requestKey: string };
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * 第三方授权链接的 bindId 自动解析为路由参数。
 * HTTPS 链接需要应用域名关联；自定义 scheme 可用于本地路由验证。
 * 配置说明见 docs/universal-links.md。
 */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['https://eos3.app', 'aurorawallet://', 'eos3wallet://'],
  config: {
    screens: {
      BindAuthorize: 'tgbind',
      DeviceKeyImport: 'device-key-authorized',
    },
  },
};

function Tabs() {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const w = useWallet();

  // 当前链没有已选账户时显示创建/导入引导,仍可使用发现和设置标签页。
  const hasWallets = w.hasAccount;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: '#2A7FFF',
        tabBarInactiveTintColor: '#B4B9C6',
        tabBarStyle: {
          // 用安全区 inset 而不是写死的数值 —— 不同机型的系统导航栏(三键/手势条)
          // 高度不一样,写死会在有些机型上把 Tab 栏文字/图标盖住。
          height: Platform.OS === 'web' ? 58 : 56 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Platform.OS === 'web' ? 6 : insets.bottom + 6,
          borderTopColor: colors.line,
          backgroundColor: colors.white,
        },
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: '500' },
        // 去掉点击 Tab 时那圈半透明水波纹——bottom-tabs 默认给按钮加了
        // android_ripple(安卓上是一圈从触点扩散的灰色渐变涟漪,iOS 上是
        // PlatformPressable 的透明度渐变),这里把两边的视觉反馈都关掉,
        // 只保留切换本身,不需要额外提示"你点到了"。
        tabBarButton: (props) => (
          <PlatformPressable {...props} android_ripple={{ color: 'transparent' }} pressOpacity={1} />
        ),
        // 路由 key 固定用英文(Wallet/Discover/Me)——之前直接拿中文文案当路由名,
        // 导致切了语言以后路由名和显示文案就对不上号了(路由名不跟着 t() 走)。
        // 显示文案单独用 tabBarLabel 接 t(),两者彻底分开。
        tabBarLabel: t(
          route.name === 'Wallet' ? 'tab.assets' : route.name === 'Discover' ? 'tab.discover' : 'tab.me'
        ),
        tabBarIcon: ({ color }) => {
          const map: Record<string, string> = {
            Wallet: 'wallet-outline',
            Discover: 'web',
            Me: 'account-outline',
          };
          return (
            <MaterialCommunityIcons
              name={(map[route.name] ?? 'circle-outline') as any}
              size={21}
              color={color}
            />
          );
        },
      })}
    >
      <Tab.Screen name="Wallet" component={hasWallets ? WalletScreen : OnboardingScreen} />
      {/* DApp 浏览器依赖 react-native-webview 的原生注入能力,web 端无法连接钱包,故隐藏该入口 */}
      {Platform.OS !== 'web' && <Tab.Screen name="Discover" component={DiscoverScreen} />}
      <Tab.Screen
        name="Me"
        component={MeScreen}
        options={{
          // 消息中心暂不上线(产品决定,「我」页也没放入口)——红点必须跟着一起
          // 隐藏:未读只有进消息中心才会清零,没有入口的红点就是一个永远
          // 点不掉的骚扰。恢复上线时改回 `unreadCount > 0 ? '' : undefined`,
          // 并把 MeScreen 的铃铛入口一起加回来。
          tabBarBadge: undefined,
          tabBarBadgeStyle: { backgroundColor: '#FF3B30', minWidth: 8, maxHeight: 8, borderRadius: 4, transform: [{ translateX: -2 }, { translateY: 2 }] },
        }}
      />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const w = useWallet();

  // 本机钱包列表还没读完之前先不渲染导航器 —— 否则会先闪一下"无账户"引导页,
  // 等 SecureStore 读完又跳回资产页,体验很差。
  if (!w.walletsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#2A7FFF" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} linking={linking}>
      <Stack.Navigator
        initialRouteName="Tabs"
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          // 安卓默认的 native-stack 转场是系统 Material 那套(整页淡入/从下往上),
          // 跟 iOS 的横向推入不统一,看着比较怪 —— 统一改成 iOS 风格的从右滑入。
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="Receive" component={ReceiveScreen} options={{ presentation: 'card' }} />
        <Stack.Screen name="Send" component={SendScreen} />
        <Stack.Screen name="TokenDetail" component={TokenDetailScreen} />
        <Stack.Screen name="TransactionDetail" component={TransactionDetailScreen} />
        <Stack.Screen name="Resource" component={ResourceScreen} />
        <Stack.Screen name="Import" component={ImportScreen} />
        <Stack.Screen name="ImportSecret" component={ImportSecretScreen} />
        <Stack.Screen name="ImportWatch" component={ImportWatchScreen} />
        <Stack.Screen name="DeviceKeyImport" component={DeviceKeyImportScreen} />
        <Stack.Screen name="SetMasterPassword" component={SetMasterPasswordScreen} />
        <Stack.Screen name="CreateWalletMethod" component={CreateWalletMethodScreen} />
        <Stack.Screen name="CreateAccountPay" component={CreateAccountPayScreen} />
        <Stack.Screen name="PasskeyLogin" component={PasskeyLoginScreen} />
        <Stack.Screen name="PasskeyCreate" component={PasskeyCreateScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="AddToken" component={AddTokenScreen} />
        <Stack.Screen name="TotalAsset" component={TotalAssetScreen} />
        <Stack.Screen name="ManageWallet" component={ManageWalletScreen} />
        <Stack.Screen name="Security" component={SecurityScreen} />
        <Stack.Screen name="Language" component={LanguageScreen} />
        <Stack.Screen name="Node" component={NodeScreen} />
        <Stack.Screen name="Scan" component={ScanScreen} />
        <Stack.Screen name="AddressBook" component={AddressBookScreen} />
        <Stack.Screen name="TxRecord" component={TxRecordScreen} />
        <Stack.Screen name="WalletDetail" component={WalletDetailScreen} />
        <Stack.Screen name="Permission" component={PermissionScreen} />
        <Stack.Screen name="PermissionDetail" component={PermissionDetailScreen} />
        <Stack.Screen name="BindAuthorize" component={BindAuthorizeScreen} />
        <Stack.Screen name="DappTabs" component={DappTabsScreen} />
        <Stack.Screen name="MessageCenter" component={MessageCenterScreen} />
        <Stack.Screen name="LinkSessions" component={LinkSessionsScreen} />
        <Stack.Screen name="LinkSessionDetail" component={LinkSessionDetailScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
