jest.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (v: any) => v } }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../BottomSheet', () => ({ children, ...p }: any) => require('react').createElement('BottomSheet', p, children));
jest.mock('../CenterDialog', () => ({ children, ...p }: any) => require('react').createElement('CenterDialog', p, children));
jest.mock('../../crypto/vault', () => ({ biometricEnabled: jest.fn(async () => true) }));
jest.mock('../../chain/sponsor', () => ({ friendlyChainErrorMessage: (v: string) => v }));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import React from 'react';
import ConfirmTxSheet from '../ConfirmTxSheet';
import { biometricEnabled } from '../../crypto/vault';
const { create, act } = require('react-test-renderer');
test('external confirmation starts QR signing without a password or biometric prompt', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const onConfirm = jest.fn(); let renderer: any;
  await act(async () => { renderer = create(React.createElement(ConfirmTxSheet, { visible: true, external: true,
    actions: [], chainName: 'Vaulta', testnet: false, actor: 'alice', busy: false, error: null,
    walletId: 'watch:vaulta:alice', onConfirm, onClose() {} })); });
  expect(onConfirm).not.toHaveBeenCalled(); expect(biometricEnabled).not.toHaveBeenCalled();
  const button = renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
    node.findAllByType('Text').some((text: any) => text.props.children === 'coldSigning.title'));
  await act(async () => { button.props.onPress(); });
  expect(onConfirm).toHaveBeenCalledWith('');
  expect(renderer.root.findByType('CenterDialog').props.visible).toBe(false);
  await act(async () => { renderer.unmount(); });
});
