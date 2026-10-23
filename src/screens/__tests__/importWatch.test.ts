jest.mock('react-native', () => ({ Alert: { alert: jest.fn() }, View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
  TextInput: 'TextInput', ScrollView: 'ScrollView', StyleSheet: { create: (v: any) => v } }));
jest.mock('@react-navigation/native', () => ({ useNavigation: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ addWallet: jest.fn(), newWalletId: () => 'watch-id' }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));
import React from 'react';
import { Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useWalletSession } from '../../chain/WalletContext';
import ImportWatchScreen from '../ImportWatchScreen';
import { addWallet } from '../../crypto/vault';
const { act, create } = require('react-test-renderer');
let renderer: any;
const setAccount = jest.fn(), reloadWallets = jest.fn(), reset = jest.fn();
const submit = () => renderer.root.findByType('TouchableOpacity');
const input = async (text: string) => { await act(async () => renderer.root.findByType('TextInput').props.onChangeText(text)); };
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  jest.mocked(useNavigation).mockReturnValue({ reset } as any);
  jest.mocked(addWallet).mockResolvedValue(undefined);
  reloadWallets.mockResolvedValue(undefined);
  jest.mocked(useWalletSession).mockReturnValue({ chainId: 'vaulta', client: { config: { name: 'Vaulta' } }, setAccount, reloadWallets } as any);
  await act(async () => { renderer = create(React.createElement(ImportWatchScreen)); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });
test.each(['', '.', '...', 'abc0', 'abcdef123451a'])('rejects invalid or zero-valued account %j without changing the session', async value => {
  await input(value);
  expect(submit().props.disabled).toBe(true);
  await act(async () => submit().props.onPress());
  expect(addWallet).not.toHaveBeenCalled();
  expect(setAccount).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
});
test.each([[' EOSIO. ', 'eosio'], ['foo.bar', 'foo.bar'], ['abcdef12345a', 'abcdef12345a']])(
  'imports %j as canonical account %j', async (value, canonical) => {
    await input(value); expect(submit().props.disabled).toBe(false);
    await act(async () => submit().props.onPress());
    expect(addWallet).toHaveBeenCalledWith({ id: 'watch-id', account: canonical, chainId: 'vaulta',
      source: 'watch', publicKey: '', createdAt: expect.any(Number) });
    expect(reloadWallets).toHaveBeenCalledTimes(1);
    expect(setAccount).toHaveBeenCalledWith(canonical);
    expect(reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Tabs' }] });
  });

test('waits for persistence before switching accounts and prevents duplicate submissions', async () => {
  let finish!: () => void;
  jest.mocked(addWallet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await input('watchacct');
  let pending!: Promise<void>;
  await act(async () => { pending = submit().props.onPress(); });
  expect(submit().props.disabled).toBe(true);
  await act(async () => submit().props.onPress());
  expect(addWallet).toHaveBeenCalledTimes(1);
  expect(reloadWallets).not.toHaveBeenCalled();
  expect(setAccount).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
  await act(async () => { finish(); await pending; });
  expect(setAccount).toHaveBeenCalledWith('watchacct');
  expect(reset).toHaveBeenCalledTimes(1);
});

test('a failed save stays on the form and can be retried', async () => {
  jest.mocked(addWallet).mockRejectedValueOnce(new Error('storage unavailable'));
  await input('watchacct');
  await act(async () => submit().props.onPress());
  expect(Alert.alert).toHaveBeenCalledWith('importSecret.saveFailed', 'storage unavailable');
  expect(setAccount).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
  expect(submit().props.disabled).toBe(false);
  await act(async () => submit().props.onPress());
  expect(setAccount).toHaveBeenCalledWith('watchacct');
});
