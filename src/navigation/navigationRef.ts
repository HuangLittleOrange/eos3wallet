import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './RootNavigator';

/**
 * 顶层导航 ref —— 给不在导航树里的组件用(比如 DappBrowserScreen 现在挂在
 * App 根部,不再是一个路由,里头的 WalletListSheet 拿不到 useNavigation())。
 * 从任何地方都能调用 navigationRef.navigate(...),不依赖组件在树里的位置。
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
