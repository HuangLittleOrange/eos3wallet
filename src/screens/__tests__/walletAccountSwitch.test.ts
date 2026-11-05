jest.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView', FlatList: (props: any) => require('react').createElement('FlatList', props, props.ListHeaderComponent),
  TouchableOpacity: 'TouchableOpacity', Pressable: 'Pressable', RefreshControl: 'RefreshControl',
  ActivityIndicator: 'ActivityIndicator', AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon', MaterialCommunityIcons: 'Icon', Feather: 'Icon' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('../../components/TokenBadge', () => 'TokenBadge');
jest.mock('../../components/WalletListSheet', () => 'WalletListSheet');
jest.mock('../../components/ToolsSheet', () => 'ToolsSheet');
jest.mock('../../components/TokenPickerSheet', () => 'TokenPickerSheet');
jest.mock('../../chain/WalletContext', () => ({ useWallet: jest.fn() }));
jest.mock('../../chain/useWalletPermissionBadges', () => ({ useWalletPermissionBadges: () => ({}) }));
jest.mock('../../chain/useManualRefresh', () => ({ useManualRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }) }));
jest.mock('../../chain/prices', () => ({ priceIn: () => 0 }));
jest.mock('../../chain/tokenPrefs', () => ({ loadTokenPrefs: jest.fn() }));
jest.mock('../../chain/permissions', () => ({ fetchAuthorizedApps: jest.fn(), permissionDisplayAppType: () => 'App', permissionKey: (p: any) => p.permission }));
jest.mock('../../dapp/linkSessions', () => ({ listLinkSessions: async () => [], subscribeLinkSessions: () => () => {} }));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), t: (key: string) => key }));
import React from 'react';
import WalletScreen from '../WalletScreen';
import { useWallet } from '../../chain/WalletContext';
import { loadTokenPrefs } from '../../chain/tokenPrefs';
import { fetchAuthorizedApps } from '../../chain/permissions';
const { act, create } = require('react-test-renderer');
let renderer: any;
let session: any;
const balances = [{ contract: 'core.vaulta', symbol: 'A', amount: 1, precision: 4, raw: '1.0000 A' }];
const tokenRows = () => renderer.root.findByType('FlatList').props.data;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers(); jest.clearAllMocks();
  session = { chainId: 'vaulta', account: 'wallet-switch-alice', status: 'ready', tokens: balances,
    client: { config: { systemToken: 'core.vaulta', symbol: 'A' } }, node: { name: 'RPC' },
    refresh: jest.fn(), wallets: [], hasAccount: true };
  jest.mocked(useWallet).mockImplementation(() => session);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; jest.clearAllTimers(); jest.useRealTimers(); });

test('account switch immediately removes previously added token rows before storage finishes', async () => {
  let finish!: (prefs: any) => void;
  jest.mocked(loadTokenPrefs).mockResolvedValueOnce({ hidden: [], added: ['oldcontract:OLD'] })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { renderer = create(React.createElement(WalletScreen)); });
  expect(tokenRows().map((row: any) => row.symbol)).toEqual(['A', 'OLD']);
  session = { ...session, account: 'wallet-switch-bob', tokens: [] };
  await act(async () => renderer.update(React.createElement(WalletScreen)));
  expect(tokenRows()).toEqual([]);
  await act(async () => finish({ hidden: [], added: ['newcontract:NEW'] }));
  expect(tokenRows().map((row: any) => row.symbol)).toEqual(['NEW']);
});

test('authorized apps clear immediately and late previous-account results stay isolated', async () => {
  jest.mocked(loadTokenPrefs).mockResolvedValue({ hidden: [], added: [] });
  let finishOld!: (value: any) => void;
  let finishNew!: (value: any) => void;
  jest.mocked(fetchAuthorizedApps).mockImplementation(account => new Promise(resolve => {
    if (account === 'wallet-switch-alice') finishOld = resolve; else finishNew = resolve;
  }));
  await act(async () => { renderer = create(React.createElement(WalletScreen)); });
  const button = renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
    node.findAllByType('Text').some((text: any) => text.children.includes('wallet.assetsTabAuthorized')));
  expect(button).toBeDefined();
  await act(async () => button.props.onPress());
  session = { ...session, account: 'wallet-switch-bob' };
  await act(async () => renderer.update(React.createElement(WalletScreen)));
  await act(async () => finishOld({ eosAccount: 'wallet-switch-alice', permissions: [{ permission: 'old.permission', managedByPayLimit: true, parent: 'active', active: true, assets: [] }] }));
  expect(tokenRows()).toEqual([]);
  await act(async () => finishNew({ eosAccount: 'wallet-switch-bob', permissions: [{ permission: 'new.permission', managedByPayLimit: true, parent: 'active', active: true, assets: [] }] }));
  expect(tokenRows().map((row: any) => row.permission)).toEqual(['new.permission']);
});
jest.mock('../../components/NetworkSelector', () => 'NetworkSelector');
