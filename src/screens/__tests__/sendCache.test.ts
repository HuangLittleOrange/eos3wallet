jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView', TextInput: 'TextInput',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }, Alert: { alert: jest.fn() }, Linking: {},
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useRoute: jest.fn(), useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock('../../chain/WalletContext', () => ({ useWallet: jest.fn() }));
jest.mock('../../components/TokenPickerSheet', () => 'TokenPickerSheet');
jest.mock('../../components/SelectWalletSheet', () => 'SelectWalletSheet');
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../components/ResourceRepairSheet', () => ({ useResourceRepair: () => ({ prepare: jest.fn(), element: null }) }));
jest.mock('../../chain/signers', () => ({ biometricSigner: jest.fn(), passkeySigner: jest.fn(), passwordSigner: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ signingPermission: () => 'active' }));
jest.mock('../../chain/transact', () => ({ buildTransfer: jest.fn(() => ({ account: 'core.vaulta', name: 'transfer', data: {} })) }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));
import React from 'react';
import { useRoute } from '@react-navigation/native';
import { useWallet } from '../../chain/WalletContext';
import { buildTransfer } from '../../chain/transact';
import SendScreen from '../SendScreen';
const { create, act } = require('react-test-renderer');
let renderer: any;
const token = { contract: 'core.vaulta', symbol: 'A', amount: 7, precision: 4, raw: '7.0000 A' };
const setState = (tokens: any[] = []) => jest.mocked(useWallet).mockReturnValue({
  tokens, cachedTokens: [token], chainId: 'vaulta', node: { url: 'https://node.example' }, account: 'alice',
  currentWallet: { id: 'alice', account: 'alice', publicKey: 'key', source: 'privatekey' },
  client: { config: { systemToken: 'core.vaulta', symbol: 'A', precision: 4, name: 'EOS' } },
} as any);
const button = (key: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.children.includes(key)));
const amountInput = () => renderer.root.findAllByType('TextInput').find((node: any) => node.props.placeholder === 'send.amountPlaceholder');
const rerender = async () => { await act(async () => renderer.update(React.createElement(SendScreen))); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); setState();
  jest.mocked(useRoute).mockReturnValue({ params: { scanned: { account: 'bob', amount: '5', memo: 'original' } } } as any);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('cached balances can display, but only RPC balances enable transfer and supply transaction precision', async () => {
  await act(async () => { renderer = create(React.createElement(SendScreen)); });
  expect(button('send.confirm').props.disabled).toBe(true);
  expect(button('send.all').props.disabled).toBe(true);
  expect(renderer.root.findAllByType('Text').some((node: any) => node.children.includes('7'))).toBe(true);
  setState([{ ...token, amount: 8, precision: 6 }]); await rerender();
  expect(button('send.confirm').props.disabled).toBe(false);
  await act(async () => button('send.confirm').props.onPress());
  expect(buildTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 5, precision: 6 }));
  setState([{ ...token, amount: 2 }]); await rerender();
  expect(button('send.confirm').props.disabled).toBe(true);
  await act(async () => button('send.all').props.onPress());
  expect(amountInput().props.value).toBe('2');
});

test('background token updates do not overwrite edited scanned transfer fields', async () => {
  await act(async () => { renderer = create(React.createElement(SendScreen)); });
  await act(async () => amountInput().props.onChangeText('6'));
  setState([{ ...token, amount: 10 }]); await rerender();
  expect(amountInput().props.value).toBe('6');
});
