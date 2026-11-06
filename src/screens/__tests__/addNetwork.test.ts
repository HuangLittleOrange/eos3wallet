jest.mock('react-native', () => ({ View: 'View', Text: 'Text', TouchableOpacity: 'Button', TextInput: 'Input',
  ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView', Switch: 'Switch', ActivityIndicator: 'Spinner',
  StyleSheet: { create: (v: unknown) => v }, Platform: { OS: 'android' }, Alert: { alert: jest.fn() } }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('@react-navigation/native', () => ({ useNavigation: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 20 }) }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../chain/customNetworks', () => ({ addCustomNetwork: jest.fn(), NetworkValidationError: class extends Error {
  key: string;
  constructor(value: string) { super(value); this.key = value; }
} }));
jest.mock('../../chain/networkVisibility', () => ({ setNetworkVisible: jest.fn() }));
import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { addCustomNetwork, NetworkValidationError } from '../../chain/customNetworks';
import { setNetworkVisible } from '../../chain/networkVisibility';
import AddNetworkScreen from '../AddNetworkScreen';
const { act, create } = require('react-test-renderer');
let renderer: any;
const goBack = jest.fn();
const customId = 'custom:abcd' as const;
const button = (label: string) => renderer.root.findAllByType('Button').find((node: any) => node.props.accessibilityLabel === label ||
  node.findAllByType('Text').some((text: any) => text.children[0] === label));
const fill = async (label: string, value: string) => act(async () => renderer.root.findAllByType('Input')
  .find((node: any) => node.props.accessibilityLabel === label).props.onChangeText(value));
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  jest.mocked(useNavigation).mockReturnValue({ goBack } as any);
  jest.mocked(addCustomNetwork).mockResolvedValue({ id: customId } as any);
  jest.mocked(setNetworkVisible).mockResolvedValue(undefined);
  await act(async () => { renderer = create(React.createElement(AddNetworkScreen)); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });
test('saves form data, enables the new network and returns to the list without changing wallets', async () => {
  await fill('network.name', 'My chain'); await fill('network.rpcUrl', 'https://rpc.example.com');
  await fill('network.chainId', 'ab'.repeat(32)); await fill('network.symbol', 'wax');
  await act(async () => renderer.root.findByType('Switch').props.onValueChange(true));
  await act(async () => button('network.save').props.onPress());
  expect(addCustomNetwork).toHaveBeenCalledWith(expect.objectContaining({ name: 'My chain', symbol: 'WAX', testnet: true,
    precision: 4, systemToken: 'eosio.token', resourceContract: 'eosio', rpcUrl: 'https://rpc.example.com' }));
  expect(setNetworkVisible).toHaveBeenCalledWith(customId, true); expect(goBack).toHaveBeenCalledTimes(1);
});
test('advanced settings preserve entered values when collapsed', async () => {
  await act(async () => button('network.advanced').props.onPress());
  await fill('network.precision', '8'); await fill('network.backupRpc', 'https://backup.example.org');
  await act(async () => button('network.advanced').props.onPress());
  await act(async () => button('network.save').props.onPress());
  expect(addCustomNetwork).toHaveBeenCalledWith(expect.objectContaining({ precision: 8, backupRpcUrl: 'https://backup.example.org' }));
});
test('a mismatched chain stays in the form and shows the specific validation error', async () => {
  jest.mocked(addCustomNetwork).mockRejectedValueOnce(new NetworkValidationError('network.chainMismatch'));
  await act(async () => button('network.save').props.onPress());
  expect(renderer.root.findAllByType('Text').some((node: any) => node.children[0] === 'network.chainMismatch')).toBe(true);
  expect(setNetworkVisible).not.toHaveBeenCalled(); expect(goBack).not.toHaveBeenCalled();
});
test('a double save during RPC verification does not submit two writes', async () => {
  let finish!: (network: any) => void;
  jest.mocked(addCustomNetwork).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const save = button('network.save').props.onPress;
  let pending!: Promise<void>;
  await act(async () => { pending = save(); await save(); });
  expect(addCustomNetwork).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ id: customId }); await pending; });
  expect(goBack).toHaveBeenCalledTimes(1);
});
