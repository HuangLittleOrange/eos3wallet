jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
  FlatList: (props: any) => require('react').createElement('FlatList', props, props.data.map((item: any) => require('react').cloneElement(props.renderItem({ item }), { key: item.id }))),
  TextInput: 'TextInput', Image: 'Image', RefreshControl: 'RefreshControl', ActivityIndicator: 'ActivityIndicator',
  Dimensions: { get: () => ({ width: 390 }) }, Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFillObject: {} },
  Alert: { alert: jest.fn() },
  Linking: { openURL: jest.fn(async () => {}) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', MaterialCommunityIcons: 'MaterialCommunityIcons', FontAwesome: 'FontAwesome' }));
jest.mock('../../components/DappRiskSheet', () => 'DappRiskSheet');
jest.mock('../../components/TokenBadge', () => 'TokenBadge');
jest.mock('../../chain/WalletContext', () => ({ useWallet: () => ({ tokens: [], prices: {} }), useWalletSession: () => ({ walletsReadError: false }) }));
jest.mock('../../chain/MessagesContext', () => ({ useMessages: jest.fn() }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../dapp/useOpenDapp', () => ({ useOpenDapp: jest.fn() }));
jest.mock('../../dapp/DappSessionContext', () => ({ useDappSession: () => ({ session: null, minimized: false }) }));
jest.mock('../../dapp/dappGate', () => ({
  listDappHistory: jest.fn(async () => []), listDappFavorites: jest.fn(async () => []),
  clearDappHistory: jest.fn(), removeDappFavorite: jest.fn(), toggleDappFavorite: jest.fn(),
  isUrlLike: () => false, normalizeDappUrl: (url: string) => url,
}));
jest.mock('../../i18n', () => ({ useI18n: jest.fn() }));
jest.mock('../../content/AppContentContext', () => ({ useAppContent: jest.fn() }));
jest.mock('../../components/AppUpdateSheet', () => 'AppUpdateSheet');
jest.mock('../../update/AppUpdateProvider', () => ({ useAppUpdates: () => ({ checkUpdates: jest.fn(async () => null) }) }));
jest.mock('../../update/appUpdate', () => ({ canSelfUpdate: false, currentAppVersion: () => '1.0.1' }));

import React from 'react';
import DiscoverScreen from '../DiscoverScreen';
import SearchScreen from '../SearchScreen';
import OnboardingScreen from '../OnboardingScreen';
import MessageCenterScreen from '../MessageCenterScreen';
import MeScreen from '../MeScreen';
import { Linking } from 'react-native';
import { useMessages } from '../../chain/MessagesContext';
import { useI18n } from '../../i18n';
import { useAppContent } from '../../content/AppContentContext';
import { useOpenDapp } from '../../dapp/useOpenDapp';
import type { AppContent, AppBrowseProject, ContentBanner } from '../../content/types';

const { create, act } = require('react-test-renderer');
let renderer: any;
const scrollTo = jest.fn();
const open = jest.fn();
const refresh = jest.fn(async () => {});
const deactivate = jest.fn();
const activate = jest.fn(() => deactivate);
const empty: AppContent = {
  schemaVersion: 1, intro: null, banners: [], promos: [], earnTitle: {}, earnDescription: {},
  earnItems: [], announcements: [], links: [],
};
const project = (id: string, overrides: Partial<AppBrowseProject> = {}): AppBrowseProject => ({
  id, enabled: true, sortOrder: 0, featured: true, name: id, description: 'description',
  iconUrl: '', appUrl: `https://${id}.example`, category: 'Tools', ...overrides,
});
const banner = (id: string): ContentBanner => ({
  id, enabled: true, sortOrder: 0, imageUrl: `https://images.example/${id}.png`, url: `https://${id}.example`,
});
const setContent = (content = empty, projects: AppBrowseProject[] = []) => jest.mocked(useAppContent).mockReturnValue({
  content, projects, source: 'remote', loading: false, refreshing: false, error: null, refresh, activate,
});
const setLocale = (locale: 'en' | 'zh') => jest.mocked(useI18n).mockReturnValue({ locale, t: (key) => key, setLocale: jest.fn() });
const textValues = () => renderer.root.findAllByType('Text').flatMap((node: any) => node.children.filter((child: unknown) => typeof child === 'string'));
const pressText = async (label: string) => {
  const row = renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
    node.findAllByType('Text').some((text: any) => text.children.includes(label))
  );
  expect(row).toBeDefined();
  await act(async () => { row.props.onPress(); });
};
const render = async (screen: React.ComponentType) => {
  await act(async () => { renderer = create(React.createElement(screen), { createNodeMock: () => ({ scrollTo }) }); });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  jest.clearAllMocks();
  setLocale('en');
  setContent();
  jest.mocked(useMessages).mockReturnValue({ messages: [], unreadCount: 0, markAllRead: jest.fn() });
  jest.mocked(useOpenDapp).mockReturnValue({ open, pending: null, cancel: jest.fn(), confirm: jest.fn() });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  renderer = null;
  jest.useRealTimers();
});

it('发现页只显示启用且featured的项目，服务端空目录不会恢复内置项目', async () => {
  setContent(empty, [project('featured'), project('search-only', { featured: false }), project('disabled', { enabled: false })]);
  await render(DiscoverScreen);
  expect(textValues()).toContain('featured');
  expect(textValues()).not.toContain('search-only');
  expect(textValues()).not.toContain('disabled');
  setContent();
  await act(async () => { renderer.update(React.createElement(DiscoverScreen)); });
  expect(textValues()).not.toContain('featured');
  expect(textValues()).toContain('content.emptyDapps');
});

it('应用图标跨页面和间隔重新进入复用磁盘缓存标识，换图时使用新地址', async () => {
  const icon = 'https://images.example/app-icon.png';
  setContent(empty, [project('cached', { iconUrl: icon })]);
  const remoteImages = () => renderer.root.findAllByType('Image').filter((image: any) => image.props.source.uri);
  await render(DiscoverScreen);
  expect(remoteImages().map((image: any) => [image.props.source.uri, image.props.cachePolicy])).toEqual([[icon, 'memory-disk']]);
  await act(async () => renderer.unmount());
  jest.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
  await render(DiscoverScreen);
  expect(remoteImages().map((image: any) => [image.props.source.uri, image.props.cachePolicy])).toEqual([[icon, 'memory-disk']]);
  await act(async () => renderer.unmount());
  await render(SearchScreen);
  await pressText('search.dapp');
  expect(remoteImages().map((image: any) => [image.props.source.uri, image.props.cachePolicy])).toEqual([[icon, 'memory-disk']]);
  setContent(empty, [project('cached', { iconUrl: 'https://images.example/app-icon-v2.png' })]);
  await act(async () => renderer.update(React.createElement(SearchScreen)));
  expect(remoteImages().map((image: any) => image.props.source.uri)).toEqual(['https://images.example/app-icon-v2.png']);
});

it('轮播缩到一张或清空时重置位置且停止自动播放', async () => {
  setContent({ ...empty, banners: [banner('first'), banner('second')] });
  await render(DiscoverScreen);
  await act(async () => { jest.advanceTimersByTime(4000); });
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 390, animated: true });
  setContent({ ...empty, banners: [banner('replacement')] });
  await act(async () => { renderer.update(React.createElement(DiscoverScreen)); });
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });
  const calls = scrollTo.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(8000); });
  expect(scrollTo).toHaveBeenCalledTimes(calls);
  setContent();
  await act(async () => { renderer.update(React.createElement(DiscoverScreen)); jest.advanceTimersByTime(8000); });
  expect(renderer.root.findAllByType('Image').some((image: any) => image.props.source.uri === 'https://images.example/replacement.png')).toBe(false);
});

it('轮播内容同长度更新也重置并使用新卡片播放', async () => {
  setContent({ ...empty, banners: [banner('first'), banner('second')] });
  await render(DiscoverScreen);
  await act(async () => { jest.advanceTimersByTime(4000); });
  setContent({ ...empty, banners: [banner('edited'), banner('second')] });
  await act(async () => { renderer.update(React.createElement(DiscoverScreen)); });
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });
  expect(renderer.root.findAllByType('Image').some((image: any) => image.props.source.uri === 'https://images.example/edited.png')).toBe(true);
  await act(async () => { jest.advanceTimersByTime(4000); });
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 390, animated: true });
});

it('搜索包含非featured项目，并随目录和当前语言更新匹配结果', async () => {
  setContent(empty, [project('initial', { featured: false })]);
  await render(SearchScreen);
  await pressText('search.dapp');
  expect(textValues()).toContain('initial');
  setContent(empty, [project('changed', { featured: false, translations: { zh: { name: '中文名称', description: '中文介绍' } } })]);
  await act(async () => { renderer.update(React.createElement(SearchScreen)); });
  expect(textValues()).not.toContain('initial');
  expect(textValues()).toContain('changed');
  setLocale('zh');
  await act(async () => { renderer.update(React.createElement(SearchScreen)); });
  expect(textValues()).toContain('中文名称');
  await act(async () => { renderer.root.findByType('TextInput').props.onChangeText('介绍'); });
  expect(textValues()).toContain('中文名称');
  setContent();
  await act(async () => { renderer.update(React.createElement(SearchScreen)); });
  expect(textValues()).not.toContain('中文名称');
  expect(textValues()).toContain('search.noMatchingDapps');
});

it('推广项只在配置url时可点击，远端图片能够渲染', async () => {
  setContent({ ...empty, earnItems: [{ id: 'earn', enabled: true, sortOrder: 0, title: { en: 'Earn item' }, description: {}, color: '#1234ABFF', hot: false, imageUrl: 'https://images.example/earn.png' }] });
  await render(DiscoverScreen);
  const row = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((text: any) => text.children.includes('Earn item')));
  expect(row.props.disabled).toBe(true);
  expect(renderer.root.findAllByType('Image').some((image: any) => image.props.source.uri === 'https://images.example/earn.png')).toBe(true);
  setContent({ ...empty, earnItems: [{ id: 'earn', enabled: true, sortOrder: 0, title: { en: 'Earn item' }, description: {}, color: '#123', hot: false, url: 'https://earn.example' }] });
  await act(async () => { renderer.update(React.createElement(DiscoverScreen)); });
  await pressText('Earn item');
  expect(open).toHaveBeenCalledWith('https://earn.example');
});

it('发现页下拉刷新和失败重试都调用共享运营接口', async () => {
  setContent();
  jest.mocked(useAppContent).mockReturnValue({ ...jest.mocked(useAppContent)(), error: 'offline', source: 'cache' });
  await render(DiscoverScreen);
  expect(textValues().some((text: string) => text.includes('content.cached'))).toBe(true);
  const scroll = renderer.root.findAllByType('ScrollView').find((node: any) => node.props.refreshControl);
  await act(async () => { await scroll.props.refreshControl.props.onRefresh(); });
  await pressText('content.retry');
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('帮助链接随后台发布、停用和空列表更新，安全入口不受影响', async () => {
  setContent({ ...empty, links: [
    { id: 'support', enabled: true, sortOrder: 0, title: { zh: '帮助中心', en: 'Support' }, url: 'https://support.example' },
    { id: 'hidden', enabled: false, sortOrder: 1, title: { en: 'Hidden link' }, url: 'https://hidden.example' },
  ] });
  setLocale('zh');
  await render(MeScreen);
  expect(textValues()).not.toContain('Hidden link');
  await pressText('帮助中心');
  expect(Linking.openURL).toHaveBeenCalledWith('https://support.example');
  setContent();
  await act(async () => { renderer.update(React.createElement(MeScreen)); });
  expect(textValues()).not.toContain('帮助中心');
  expect(textValues()).toContain('me.security');
});


it('创建导入页面完全使用本地文案，不订阅运营内容或依赖后台引导', async () => {
  const subtitle = 'Long introduction\n'.repeat(80);
  setContent({ ...empty, intro: { title: { en: 'Intro title' }, subtitle: { en: subtitle } } });
  await render(OnboardingScreen);
  expect(renderer.root.findByType('ScrollView').props.contentContainerStyle.flexGrow).toBe(1);
  expect(useAppContent).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(textValues()).not.toContain(subtitle);
  expect(textValues()).not.toContain('Intro title');
  expect(textValues()).toContain('onboarding.title');
  expect(textValues()).toContain('onboarding.haveAccount');
  expect(textValues()).toContain('onboarding.noAccount');
});

it('代币搜索不激活运营连接，切到 DApp 搜索才订阅，离开后释放', async () => {
  await render(SearchScreen);
  expect(activate).not.toHaveBeenCalled();
  await pressText('search.dapp');
  expect(activate).toHaveBeenCalledTimes(1);
  await pressText('search.myTokens');
  expect(deactivate).toHaveBeenCalledTimes(1);
});

it('发现页离开趋势栏目时释放运营订阅，返回时重新订阅', async () => {
  await render(DiscoverScreen);
  expect(activate).toHaveBeenCalledTimes(1);
  await pressText('discover.tabBrowser');
  expect(deactivate).toHaveBeenCalledTimes(1);
  await pressText('discover.tabTrending');
  expect(activate).toHaveBeenCalledTimes(2);
});

it('公告详情链接经过统一DApp打开入口，普通转入不产生可点击链接', async () => {
  jest.mocked(useMessages).mockReturnValue({
    messages: [
      { id: 'sys-news', kind: 'system', title: 'News details', body: 'Announcement', time: 1, url: 'https://news.example' },
      { id: 'tx-transfer', kind: 'transfer', title: 'Received transfer', body: '1 A', time: 1 },
    ],
    unreadCount: 2,
    markAllRead: jest.fn(),
  });
  await render(MessageCenterScreen);
  await pressText('News details');
  expect(open).toHaveBeenCalledWith('https://news.example');
  const transfer = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((text: any) => text.children.includes('Received transfer')));
  expect(transfer.props.disabled).toBe(true);
});

it('轮播只展示完整图片，点击打开链接，无图片和停用项不展示', async () => {
  setContent({ ...empty, banners: [
    { ...banner('linked'), title: { en: 'Legacy title' }, lines: [{ en: 'Legacy description' }], colors: ['#123', '#456'] } as ContentBanner,
    { ...banner('missing'), imageUrl: undefined },
    { ...banner('disabled'), enabled: false },
    { ...banner('no-link'), url: undefined },
  ] });
  await render(DiscoverScreen);
  const images = renderer.root.findAllByType('Image').filter((image: any) => image.props.source.uri?.startsWith('https://images.example/'));
  expect(images.map((image: any) => image.props.source.uri)).toEqual(['https://images.example/linked.png', 'https://images.example/no-link.png']);
  expect(images[0].props.contentFit).toBe('contain');
  expect(textValues()).not.toContain('Legacy title');
  expect(textValues()).not.toContain('Legacy description');
  const linked = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.props.accessibilityLabel === 'https://linked.example');
  await act(async () => { linked.props.onPress(); });
  expect(open).toHaveBeenCalledWith('https://linked.example');
  const unlinked = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Image').some((image: any) => image.props.source.uri === 'https://images.example/no-link.png'));
  expect(unlinked.props.disabled).toBe(true);
});

it('自定义模块使用目录元数据和实际链接，开关后整块隐藏且空列表不恢复理财', async()=>{
 const module={id:'custom',enabled:true,sortOrder:0,title:{en:'Community'},description:{en:'Explore community'},items:[{id:'entry',enabled:true,sortOrder:0,projectId:'chosen',title:{en:'stale'},description:{},color:'#123',hot:false,url:'https://stale.example'}]};
 setContent({...empty,modules:[module]},[project('chosen',{featured:false,name:'Selected app',appUrl:'https://current.example'})]);
 await render(DiscoverScreen);
 expect(textValues()).toContain('Community');expect(textValues()).toContain('Selected app');expect(textValues()).not.toContain('stale');
 await pressText('Selected app');expect(open).toHaveBeenCalledWith('https://current.example');
 setContent({...empty,modules:[{...module,enabled:false}]});await act(async()=>{renderer.update(React.createElement(DiscoverScreen));});
 expect(textValues()).not.toContain('Community');expect(textValues()).not.toContain('Explore community');
 setContent({...empty,modules:[],earnTitle:{en:'Old Earn'},earnItems:[{...module.items[0],title:{en:'Old item'}}]});await act(async()=>{renderer.update(React.createElement(DiscoverScreen));});
 expect(textValues()).not.toContain('Old Earn');expect(textValues()).not.toContain('Old item');
});
