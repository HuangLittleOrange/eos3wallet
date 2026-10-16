jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  KeyboardAvoidingView: 'KeyboardAvoidingView', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' }, StyleSheet: { create: (value: unknown) => value },
  Alert: { alert: jest.fn() }, AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn(), usePreventRemove: jest.fn(),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/ModalHost', () => ({ addBackHandler: () => ({ remove: () => {} }) }));
jest.mock('../../crypto/vault', () => ({ changeMasterPassword: jest.fn(), WrongPasswordError: class WrongPasswordError extends Error {} }));
jest.mock('../../i18n', () => { const t = (key: string) => key; return { useI18n: () => ({ t }) }; });

import React from 'react';
import { Alert } from 'react-native';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { changeMasterPassword, WrongPasswordError } from '../../crypto/vault';
import ChangePasswordScreen from '../ChangePasswordScreen';

const { create, act } = require('react-test-renderer');
const goBack = jest.fn();
let renderer: any;
const input = (index: number) => renderer.root.findByProps({ testID: `change-password-${index}` });
const confirm = () => renderer.root.findByProps({ testID: 'change-password-confirm' });
const fill = async (values = ['old-password', 'new-password', 'new-password']) => {
  await act(async () => values.forEach((value, index) => input(index).props.onChangeText(value)));
};
const mount = async () => { await act(async () => { renderer = create(React.createElement(ChangePasswordScreen)); }); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  jest.mocked(useNavigation).mockReturnValue({ goBack } as any);
  jest.mocked(changeMasterPassword).mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('reference form has three masked inputs, requires matching new passwords and allows revealing each independently', async () => {
  await mount();
  expect(renderer.root.findByType('PageHeader').props.title).toBe('security.changePassword');
  expect(confirm().props.disabled).toBe(true);
  expect([0, 1, 2].every(index => input(index).props.secureTextEntry)).toBe(true);
  await fill(['old-password', 'new-password', 'different']);
  expect(confirm().props.disabled).toBe(true);
  await fill(['old-password', 'short', 'short']);
  expect(confirm().props.disabled).toBe(true);
  await fill(['old-password', 'old-password', 'old-password']);
  expect(confirm().props.disabled).toBe(true);
  await fill(); expect(confirm().props.disabled).toBe(false);
  const toggle = renderer.root.findAllByProps({ accessibilityLabel: 'changePwd.showPassword' })[0];
  await act(async () => toggle.props.onPress());
  expect(input(0).props.secureTextEntry).toBe(false);
  expect(input(1).props.secureTextEntry).toBe(true);
  // Revealing a password must not re-enable credential capture on either platform.
  for (const index of [0, 1, 2]) expect(input(index).props).toEqual(expect.objectContaining({
    textContentType: 'none', autoComplete: 'off', importantForAutofill: 'no',
    autoCorrect: false, spellCheck: false,
  }));
});

test('incorrect current password retains the form and can be corrected and saved', async () => {
  await mount(); await fill();
  jest.mocked(changeMasterPassword).mockRejectedValueOnce(new WrongPasswordError());
  await act(async () => { await confirm().props.onPress(); });
  expect(renderer.root.findAllByType('Text').some((node: any) => node.children.includes('security.passwordWrong'))).toBe(true);
  expect(input(1).props.value).toBe('new-password');
  expect(Alert.alert).not.toHaveBeenCalled();
  await act(async () => input(0).props.onChangeText('correct-password'));
  await act(async () => { await confirm().props.onPress(); });
  expect(changeMasterPassword).toHaveBeenLastCalledWith('correct-password', 'new-password');
  expect([0, 1, 2].every(index => input(index).props.value === '')).toBe(true);
  expect(Alert.alert).toHaveBeenCalledWith('changePwd.doneTitle', 'changePwd.doneBody', expect.any(Array));
});

test('prevents duplicate submissions and navigation while persisting, then reports success once', async () => {
  await mount(); await fill();
  let resolve!: () => void;
  jest.mocked(changeMasterPassword).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const submit = confirm().props.onPress;
  let pending!: Promise<void>;
  await act(async () => { pending = submit(); await submit(); });
  expect(changeMasterPassword).toHaveBeenCalledTimes(1);
  expect(confirm().props.disabled).toBe(true);
  expect(usePreventRemove).toHaveBeenLastCalledWith(true, expect.any(Function));
  await act(async () => renderer.root.findByType('PageHeader').props.onBack());
  expect(goBack).not.toHaveBeenCalled();
  await act(async () => { resolve(); await pending; });
  expect(Alert.alert).toHaveBeenCalledTimes(1);
});

test('storage failure keeps passwords editable and does not report success', async () => {
  await mount(); await fill();
  jest.mocked(changeMasterPassword).mockRejectedValueOnce(new Error('storage unavailable'));
  await act(async () => { await confirm().props.onPress(); });
  expect(input(0).props.editable).toBe(true);
  expect(input(0).props.value).toBe('old-password');
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(goBack).not.toHaveBeenCalled();
});
