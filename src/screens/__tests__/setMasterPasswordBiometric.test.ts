jest.mock('react-native', () => ({
  TurboModuleRegistry: jest.requireActual('react-native').TurboModuleRegistry,
  NativeModules: jest.requireActual('react-native').NativeModules,
  Platform: jest.requireActual('react-native').Platform,
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (value: unknown) => value },
  Alert: { alert: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: jest.fn(),
  useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]),
}));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/MasterPasswordCard', () => 'MasterPasswordCard');
jest.mock('../../components/ModalHost', () => ({ addBackHandler: jest.fn(() => ({ remove: jest.fn() })) }));
jest.mock('../../crypto/vault', () => ({
  biometricAvailable: jest.fn(), enableBiometric: jest.fn(), setMasterPassword: jest.fn(),
}));
jest.mock('../../i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});

import React from 'react';
import { Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { addBackHandler } from '../../components/ModalHost';
import { biometricAvailable, enableBiometric, setMasterPassword } from '../../crypto/vault';
import SetMasterPasswordScreen from '../SetMasterPasswordScreen';

const { create, act } = require('react-test-renderer');
const nav = { getState: () => ({ index: 2 }), pop: jest.fn(), goBack: jest.fn() };
let renderer: any;
const card = () => renderer.root.findByType('MasterPasswordCard');
const submit = () => renderer.root.findByType('TouchableOpacity').props.onPress;
const prompt = () => jest.mocked(Alert.alert).mock.calls[0];
const choose = (index: number) => prompt()[2]![index].onPress!();
const mount = async () => {
  await act(async () => { renderer = create(React.createElement(SetMasterPasswordScreen)); });
  await act(async () => {
    card().props.onChangePwd('shared-password');
    card().props.onChangePwd2('shared-password');
  });
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  jest.mocked(useNavigation).mockReturnValue(nav as any);
  jest.mocked(setMasterPassword).mockReset().mockResolvedValue(undefined);
  jest.mocked(enableBiometric).mockReset().mockResolvedValue(undefined);
  jest.mocked(biometricAvailable).mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  renderer = null;
});

it('asks only after successful saving, waits for explicit consent and clears the form', async () => {
  const saving = deferred();
  jest.mocked(setMasterPassword).mockReturnValue(saving.promise);
  await mount();
  let task!: Promise<void>;
  await act(async () => { task = submit()(); });
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(biometricAvailable).not.toHaveBeenCalled();
  await act(async () => { saving.resolve(); await task; });
  expect(setMasterPassword).toHaveBeenCalledWith('shared-password');
  expect(prompt()[0]).toBe('setMasterPwd.biometricTitle');
  expect(prompt()[2]!.map((option) => option.text)).toEqual(['setMasterPwd.biometricLater', 'security.enableAction']);
  expect(card().props.pwd).toBe('');
  expect(card().props.pwd2).toBe('');
  expect(enableBiometric).not.toHaveBeenCalled();
  expect(nav.goBack).not.toHaveBeenCalled();
  await act(async () => { await choose(1); });
  expect(enableBiometric).toHaveBeenCalledWith('shared-password');
  expect(nav.goBack).toHaveBeenCalledTimes(1);
  expect(nav.pop).not.toHaveBeenCalled();
});

it.each(['later', 'dismiss'])('continues without biometric enrollment after %s', async (action) => {
  await mount();
  await act(async () => { await submit()(); });
  await act(async () => {
    if (action === 'later') choose(0);
    else prompt()[3]!.onDismiss!();
  });
  await act(async () => { prompt()[3]!.onDismiss!(); });
  expect(nav.goBack).toHaveBeenCalledTimes(1);
  expect(enableBiometric).not.toHaveBeenCalled();
});

it.each(['no-hardware', 'not-enrolled', 'check-error'])('skips optional setup for %s', async (reason) => {
  if (reason === 'check-error') jest.mocked(biometricAvailable).mockRejectedValue(new Error('unavailable'));
  else jest.mocked(biometricAvailable).mockResolvedValue({ ok: false, reason: reason as 'no-hardware' | 'not-enrolled' });
  await mount();
  await act(async () => { await submit()(); });
  expect(nav.goBack).toHaveBeenCalledTimes(1);
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(enableBiometric).not.toHaveBeenCalled();
});

it.each(['User canceled authentication', 'vaultError.cancelled', 'Keystore failed'])('keeps the saved password and continues after %s', async (message) => {
  jest.mocked(enableBiometric).mockRejectedValue(new Error(message));
  await mount();
  await act(async () => { await submit()(); await choose(1); });
  expect(nav.goBack).toHaveBeenCalledTimes(1);
  expect(setMasterPassword).toHaveBeenCalledTimes(1);
  expect(Alert.alert).toHaveBeenCalledTimes(message === 'Keystore failed' ? 2 : 1);
  if (message === 'Keystore failed') {
    expect(jest.mocked(Alert.alert).mock.calls[1]).toEqual(['security.enableFailed', 'setMasterPwd.biometricFailed']);
  }
});

it('allows retry on save failure without offering biometrics or clearing the draft', async () => {
  jest.mocked(setMasterPassword).mockRejectedValueOnce(new Error('save failed'));
  await mount();
  await act(async () => { await submit()(); });
  expect(card().props.pwd).toBe('shared-password');
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(biometricAvailable).not.toHaveBeenCalled();
  expect(nav.goBack).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('Text').some((node: any) => node.children.includes('save failed'))).toBe(true);
  await act(async () => { await submit()(); choose(0); });
  expect(setMasterPassword).toHaveBeenCalledTimes(2);
  expect(nav.goBack).toHaveBeenCalledTimes(1);
});

it('blocks duplicate saves and back navigation during saving', async () => {
  const saving = deferred();
  jest.mocked(setMasterPassword).mockReturnValue(saving.promise);
  await mount();
  const press = submit();
  let task!: Promise<void>;
  await act(async () => {
    task = press();
    await press();
    renderer.root.findByType('PageHeader').props.onBack();
    jest.mocked(addBackHandler).mock.calls.at(-1)![0]();
  });
  expect(nav.pop).not.toHaveBeenCalled();
  expect(nav.goBack).not.toHaveBeenCalled();
  expect(setMasterPassword).toHaveBeenCalledTimes(1);
  await act(async () => { saving.resolve(); await task; choose(0); });
});

it('does not dismiss the flow or enable twice while system authentication is pending', async () => {
  const enabling = deferred();
  jest.mocked(enableBiometric).mockReturnValue(enabling.promise);
  await mount();
  await act(async () => { await submit()(); });
  let task: unknown;
  await act(async () => {
    task = choose(1);
    await choose(1);
    prompt()[3]!.onDismiss!();
    renderer.root.findByType('PageHeader').props.onBack();
  });
  expect(nav.goBack).not.toHaveBeenCalled();
  expect(enableBiometric).toHaveBeenCalledTimes(1);
  await act(async () => { enabling.resolve(); await task; });
  expect(nav.goBack).toHaveBeenCalledTimes(1);
});

it('leaves both the gateway and password page when canceled before saving', async () => {
  await mount();
  await act(async () => { renderer.root.findByType('PageHeader').props.onBack(); });
  expect(nav.pop).toHaveBeenCalledWith(2);
  expect(setMasterPassword).not.toHaveBeenCalled();
});

it('never opens an optional prompt or navigates after the screen unmounts', async () => {
  const saving = deferred();
  jest.mocked(setMasterPassword).mockReturnValue(saving.promise);
  await mount();
  let task!: Promise<void>;
  await act(async () => { task = submit()(); renderer.unmount(); });
  await act(async () => { saving.resolve(); await task; });
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(nav.goBack).not.toHaveBeenCalled();
});
