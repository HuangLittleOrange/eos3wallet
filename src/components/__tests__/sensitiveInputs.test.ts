jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({}), useRoute: jest.fn() }));
jest.mock('../PageHeader', () => 'PageHeader');
jest.mock('../CenterDialog', () => 'CenterDialog');
jest.mock('../useScreenCaptureGuard', () => ({ useScreenCaptureGuard: () => true }));
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: () => ({ client: { config: { name: 'Test' } }, chainId: 'test' }) }));
jest.mock('../../chain/config', () => ({ legacyLabel: () => 'Test' }));
jest.mock('../../crypto/keys', () => ({ isValidMnemonic: () => false, isValidPrivateKey: () => false }));
jest.mock('../../crypto/vault', () => ({}));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import { useRoute } from '@react-navigation/native';
import MasterPasswordCard from '../MasterPasswordCard';
import PasswordDialog from '../PasswordDialog';
import ImportSecretScreen from '../../screens/ImportSecretScreen';

const { create, act } = require('react-test-renderer');
let renderer: any;
const expectExcluded = (input: any) => expect(input.props).toEqual(expect.objectContaining({
  textContentType: 'none', autoComplete: 'off', importantForAutofill: 'no',
  autoCorrect: false, spellCheck: false, smartInsertDelete: false,
}));
const mount = async (element: React.ReactElement) => { await act(async () => { renderer = create(element); }); };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

it.each([false, true])('excludes master-password setup/verification fields (hasPwd=%s)', async hasPwd => {
  const change = jest.fn();
  await mount(React.createElement(MasterPasswordCard, { hasPwd, pwd: '', onChangePwd: change }));
  const inputs = renderer.root.findAllByType('TextInput');
  expect(inputs).toHaveLength(hasPwd ? 1 : 2);
  inputs.forEach((input: any) => { expectExcluded(input); expect(input.props.secureTextEntry).toBe(true); });
  await act(async () => inputs[0].props.onChangeText('test-only-password'));
  expect(change).toHaveBeenCalledWith('test-only-password');
});

it('keeps password-dialog typing, submit and clearing functional with autofill disabled', async () => {
  const submit = jest.fn();
  const props = { visible: true, title: 'Verify', onClose: jest.fn(), onSubmit: submit };
  await mount(React.createElement(PasswordDialog, props));
  await act(async () => renderer.root.findByType('TextInput').props.onChangeText('test-only-password'));
  expectExcluded(renderer.root.findByType('TextInput'));
  await act(async () => renderer.root.findByType('TextInput').props.onSubmitEditing());
  expect(submit).toHaveBeenCalledWith('test-only-password');
  await act(async () => renderer.update(React.createElement(PasswordDialog, { ...props, visible: false })));
  expect(renderer.root.findByType('TextInput').props.value).toBe('');
});

it.each(['privatekey', 'mnemonic'])('excludes %s import text from credential detection while allowing paste', async mode => {
  jest.mocked(useRoute).mockReturnValue({ params: { mode } } as any);
  await mount(React.createElement(ImportSecretScreen));
  const secret = renderer.root.findAllByType('TextInput').find((input: any) => input.props.multiline);
  expect(secret).toBeDefined();
  expectExcluded(secret);
  // Synthetic text only: no real wallet material belongs in a regression test.
  await act(async () => secret.props.onChangeText('test only secret text'));
  expect(secret.props.value).toBe('test only secret text');
  expectExcluded(secret);
});
