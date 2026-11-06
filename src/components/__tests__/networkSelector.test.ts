jest.mock('react-native', () => ({ View: 'View', Text: 'Text', Image: 'Image', TouchableOpacity: 'Button', ScrollView: 'ScrollView', StyleSheet: { create: (s: unknown) => s } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../../navigation/navigationRef', () => ({ navigationRef: { isReady: () => true, navigate: jest.fn() } }));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/customNetworks', () => ({ useCustomNetworks: () => ({ networks: [], ready: true, readError: false }) }));
jest.mock('../../chain/networkVisibility', () => ({ useNetworkVisibility: jest.fn(), setNetworkVisible: jest.fn(async () => {}), retryNetworkVisibility: jest.fn() }));
import React from 'react';
import NetworkSelector, { NetworkList } from '../NetworkSelector';
import { useWalletSession } from '../../chain/WalletContext';
import { navigationRef } from '../../navigation/navigationRef';
import { useNetworkVisibility, setNetworkVisible } from '../../chain/networkVisibility';
const { create, act } = require('react-test-renderer');
let renderer: any;
const select = jest.fn();
const button = (label: string) => renderer.root.findAllByType('Button').find((b: any) =>
  b.props.accessibilityLabel === label || b.findAllByType('Text').some((t: any) => t.children.length === 1 && t.children[0] === label));
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta', 'jungle4'], ready: true, readError: false });
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'vaulta', setChain: select } as any); });
afterEach(async () => { await act(async () => renderer.unmount()); });

test('the network trigger navigates to a page without opening a modal', async () => {
  await act(async () => { renderer = create(React.createElement(NetworkSelector)); });
  await act(async () => button('manageWallet.manageNetwork').props.onPress());
  expect(navigationRef.navigate).toHaveBeenCalledWith('Networks');
  expect(select).not.toHaveBeenCalled();
});

test('unchecked test networks have no entry or testnet tab in the normal selector', async () => {
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta'], ready: true, readError: false });
  await act(async () => { renderer = create(React.createElement(NetworkList, { selected: 'vaulta', onSelect: select })); });
  expect(button('EOS')).toBeDefined();
  expect(button('manageWallet.testnet')).toBeUndefined();
  expect(button('Jungle4')).toBeUndefined();
});

test('configuration shows both network types together and changes visibility without switching', async () => {
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta'], ready: true, readError: false });
  const props = { selected: 'vaulta' as const, onSelect: select, manageVisibility: true };
  await act(async () => { renderer = create(React.createElement(NetworkList, props)); });
  expect(button('EOS')).toBeDefined();
  expect(renderer.root.findAll((node: any) => node.props.accessibilityRole === 'tab')).toHaveLength(0);
  expect(button('Jungle4').props.accessibilityRole).toBe('checkbox');
  expect(button('Jungle4').props.accessibilityState.checked).toBe(false);
  await act(async () => button('Jungle4').props.onPress());
  expect(setNetworkVisible).toHaveBeenCalledWith('jungle4', true);
  expect(select).not.toHaveBeenCalled();
  jest.mocked(useNetworkVisibility).mockReturnValue({ enabled: ['vaulta', 'jungle4'], ready: true, readError: false });
  await act(async () => renderer.update(React.createElement(NetworkList, props)));
  expect(button('Jungle4').props.accessibilityState.checked).toBe(true);
});

test('enabled mainnet and testnet appear together; selecting a row chooses the network', async () => {
  await act(async () => { renderer = create(React.createElement(NetworkList, { selected: 'vaulta', onSelect: select })); });
  expect(button('EOS')).toBeDefined();
  expect(button('Jungle4')).toBeDefined();
  expect(select).not.toHaveBeenCalled();
  expect(button('EOS')).toBeDefined();
  await act(async () => button('Jungle4').props.onPress());
  expect(select).toHaveBeenCalledWith('jungle4');
  await act(async () => renderer.update(React.createElement(NetworkList, { selected: 'jungle4', onSelect: select })));
  expect(button('Jungle4').props.accessibilityState.selected).toBe(true);
});

test('custom network entry is available from both selection and management', async () => {
  await act(async () => { renderer = create(React.createElement(NetworkList, { selected: 'vaulta', onSelect: select })); });
  await act(async () => button('network.addCustom').props.onPress());
  expect(navigationRef.navigate).toHaveBeenCalledWith('AddNetwork');
  await act(async () => renderer.update(React.createElement(NetworkList, { selected: 'vaulta', onSelect: select, manageVisibility: true })));
  expect(button('network.addCustom')).toBeDefined();
});
