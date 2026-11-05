jest.mock('react-native', () => ({ View: 'View', Text: 'Text', Image: 'Image', TouchableOpacity: 'Button', ScrollView: 'ScrollView', StyleSheet: { create: (s: unknown) => s } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('@react-navigation/native', () => ({ useNavigation: jest.fn(), useRoute: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/networkVisibility', () => ({ useNetworkVisibility: () => ({ enabled: ['vaulta', 'jungle4'], ready: true, readError: false }), setNetworkVisible: jest.fn(async () => {}), retryNetworkVisibility: jest.fn() }));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../navigation/navigationRef', () => ({ navigationRef: { isReady: () => true, navigate: jest.fn() } }));
import React from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useWalletSession } from '../../chain/WalletContext';
import NetworksScreen from '../NetworksScreen';
import { setNetworkVisible } from '../../chain/networkVisibility';
const { create, act } = require('react-test-renderer');
let renderer: any;
const setChain = jest.fn(), goBack = jest.fn(), replace = jest.fn(), push = jest.fn();
const button = (label: string) => renderer.root.findAllByType('Button').find((b: any) =>
  b.findAllByType('Text').some((t: any) => t.children.length === 1 && t.children[0] === label));
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'vaulta', setChain } as any);
  jest.mocked(useNavigation).mockReturnValue({ goBack, replace, push } as any);
  jest.mocked(useRoute).mockReturnValue({ params: undefined } as any);
});
afterEach(async () => { await act(async () => renderer.unmount()); });

test('switch mode selects the network and returns to the previous page', async () => {
  await act(async () => { renderer = create(React.createElement(NetworksScreen)); });
  await act(async () => button('manageWallet.testnet').props.onPress());
  expect(setChain).not.toHaveBeenCalled();
  await act(async () => button('Jungle4').props.onPress());
  expect(setChain).toHaveBeenCalledWith('jungle4');
  expect(goBack).toHaveBeenCalledTimes(1);
});

test('add mode navigates from network choice to create/import with normal page back navigation', async () => {
  jest.mocked(useRoute).mockReturnValue({ params: { addWallet: true } } as any);
  await act(async () => { renderer = create(React.createElement(NetworksScreen)); });
  await act(async () => button('Vaulta').props.onPress());
  expect(setChain).toHaveBeenCalledWith('vaulta');
  expect(goBack).not.toHaveBeenCalled();
  expect(push).toHaveBeenCalledWith('Networks', { addWallet: true, selectedNetwork: 'vaulta' });
  jest.mocked(useRoute).mockReturnValue({ params: { addWallet: true, selectedNetwork: 'vaulta' } } as any);
  await act(async () => renderer.update(React.createElement(NetworksScreen)));
  expect(button('walletList.createWallet')).toBeDefined();
  await act(async () => renderer.root.findByType('PageHeader').props.onBack());
  expect(goBack).toHaveBeenCalledTimes(1);
  await act(async () => button('walletList.importWallet').props.onPress());
  expect(replace).toHaveBeenCalledWith('Import');
});

test('visibility mode checks networks and Done returns without switching accounts', async () => {
  jest.mocked(useRoute).mockReturnValue({ params: { manageVisibility: true } } as any);
  await act(async () => { renderer = create(React.createElement(NetworksScreen)); });
  await act(async () => button('manageWallet.testnet').props.onPress());
  await act(async () => button('Jungle4').props.onPress());
  expect(setNetworkVisible).toHaveBeenCalledWith('jungle4', false);
  expect(setChain).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  await act(async () => renderer.root.findByType('PageHeader').props.right.props.onPress());
  expect(goBack).toHaveBeenCalledTimes(1);
});
