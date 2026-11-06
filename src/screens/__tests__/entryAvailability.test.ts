jest.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView', Image: 'Image',
  TouchableOpacity: 'Button', TextInput: 'Input', ActivityIndicator: 'Spinner', RefreshControl: 'RefreshControl',
  StyleSheet: { create: (v: unknown) => v }, Alert: { alert: jest.fn() }, Linking: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon', MaterialCommunityIcons: 'Icon' }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useFocusEffect: () => {} }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../components/RexOperations', () => 'RexOperations');
jest.mock('../../components/ResourceRepairSheet', () => ({ useResourceRepair: () => ({ element: null }) }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn(), useWallet: jest.fn() }));
jest.mock('../../chain/useManualRefresh', () => ({ useManualRefresh: () => ({ refreshing: false, onRefresh: jest.fn() }) }));
jest.mock('../../chain/resourceRepairQuote', () => ({ peekResourceRepairMarket: () => null, getResourceRepairMarket: async () => null }));
jest.mock('../../chain/signers', () => ({}));
jest.mock('../../chain/transact', () => ({ transact: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ hasMasterPassword: async () => true, signingPermission: () => 'active' }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));
import React from 'react';
import { useWallet, useWalletSession } from '../../chain/WalletContext';
import ImportScreen from '../ImportScreen';
import CreateWalletMethodScreen from '../CreateWalletMethodScreen';
import OnboardingScreen from '../OnboardingScreen';
import ResourceScreen from '../ResourceScreen';
import { CHAINS } from '../../chain/config';
const { act, create } = require('react-test-renderer');
let renderer: any;
let state: any;
const button = (label: string) => renderer.root.findAllByType('Button').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.children.includes(label)));
const mount = async (screen: React.ComponentType) => { await act(async () => { renderer = create(React.createElement(screen)); }); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const usage = { used: 0, max: 100, available: 100, pct: 0, unlimited: false, unallocated: false };
  state = { chainId: 'vaulta', wallets: [], account: 'alice', hasAccount: true, status: 'ready', tokens: [], headBlock: 1,
    node: { name: 'RPC', url: 'https://rpc.example.com' }, client: { config: CHAINS.vaulta },
    resources: { cpu: usage, net: usage, ram: usage, permissions: [], selfStakedCpu: '0.0000 A', selfStakedNet: '0.0000 A', refunding: '0.0000 A' } };
  jest.mocked(useWallet).mockImplementation(() => state);
  jest.mocked(useWalletSession).mockImplementation(() => state);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test.each(['vaulta', 'jungle4'] as const)('%s import keeps working methods and only offers web authorization on mainnet', async chainId => {
  state = { ...state, chainId, client: { config: CHAINS[chainId] } };
  await mount(ImportScreen);
  expect(button('import.privateKey')).toBeDefined(); expect(button('import.watchWallet')).toBeDefined();
  expect(!!button('import.viaEos3')).toBe(chainId === 'vaulta');
});
test.each(['vaulta', 'jungle4'] as const)('%s creation methods and onboarding do not lead into unsupported signup', async chainId => {
  state = { ...state, chainId };
  await mount(CreateWalletMethodScreen);
  expect(!!button('createWalletMethod.byContract')).toBe(chainId === 'vaulta');
  expect(!!button('createWalletMethod.googleOneTap')).toBe(chainId === 'vaulta');
  await act(async () => renderer.unmount()); renderer = null;
  await mount(OnboardingScreen);
  expect(!!button('onboarding.noAccount')).toBe(chainId === 'vaulta');
  expect(button('onboarding.haveAccount')).toBeDefined();
});
test('switching away from mainnet closes the REX panel and removes its tab', async () => {
  await mount(ResourceScreen);
  await act(async () => button('REX').props.onPress());
  expect(renderer.root.findAllByType('RexOperations')).toHaveLength(1);
  state = { ...state, chainId: 'jungle4', client: { config: CHAINS.jungle4 } };
  await act(async () => renderer.update(React.createElement(ResourceScreen)));
  expect(button('REX')).toBeUndefined(); expect(renderer.root.findAllByType('RexOperations')).toHaveLength(0);
  expect(button('CPU/NET')).toBeDefined(); expect(button('RAM')).toBeDefined();
});
