jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../BottomSheet', () => 'BottomSheet');
jest.mock('../TokenBadge', () => 'TokenBadge');
jest.mock('../../chain/WalletContext', () => ({ useWallet: jest.fn() }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));
import React from 'react';
import { useWallet } from '../../chain/WalletContext';
import TokenPickerSheet from '../TokenPickerSheet';
const { create, act } = require('react-test-renderer');
let renderer: any;
const token = { contract: 'core.vaulta', symbol: 'A', amount: 7, precision: 4, raw: '7.0000 A' };
const refresh = jest.fn(); const onPick = jest.fn(); const onClose = jest.fn();
const props = { visible: true, onPick, onClose };
const setState = (extra: object = {}) => jest.mocked(useWallet).mockReturnValue({
  tokens: [], cachedTokens: [token], status: 'loading', prices: null, refresh, ...extra,
} as any);
const texts = () => renderer.root.findAllByType('Text').flatMap((node: any) => node.children);
const render = async () => { await act(async () => { renderer = create(React.createElement(TokenPickerSheet, props)); }); };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks(); setState(); });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('cached tokens are selectable while loading or offline and opening never refetches', async () => {
  await render(); expect(texts()).toContain('A'); expect(texts()).toContain('content.cached');
  expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  const row = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('TokenBadge').length);
  await act(async () => row.props.onPress());
  expect(onPick).toHaveBeenCalledWith(token); expect(onClose).toHaveBeenCalled();
  setState({ status: 'error', error: 'offline' });
  await act(async () => renderer.update(React.createElement(TokenPickerSheet, { ...props, visible: false })));
  await act(async () => renderer.update(React.createElement(TokenPickerSheet, props)));
  expect(texts()).toContain('A'); expect(refresh).not.toHaveBeenCalled();
  setState({ tokens: [{ ...token, symbol: 'EOS' }] });
  await act(async () => renderer.update(React.createElement(TokenPickerSheet, props)));
  expect(texts()).toContain('EOS'); expect(texts()).not.toContain('A');
  expect(texts()).not.toContain('content.cached');
});

test('first loading and failed requests are distinct from an empty search and errors can retry', async () => {
  setState({ cachedTokens: null }); await render();
  expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
  expect(texts()).not.toContain('tokenPicker.noMatch');
  setState({ cachedTokens: null, status: 'error', error: 'offline' });
  await act(async () => renderer.update(React.createElement(TokenPickerSheet, props)));
  expect(texts()).toContain('offline'); expect(texts()).toContain('content.retry');
  const retry = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((text: any) => text.children.includes('content.retry')));
  await act(async () => retry.props.onPress()); expect(refresh).toHaveBeenCalledWith({ force: true });
});
test('a 24-hour directory can render without a balance snapshot and selects metadata with zero amount', async () => {
  const metadata = { contract: 'tethertether', symbol: 'USDT', precision: 6 };
  setState({ tokenDirectory: [metadata], cachedTokens: null }); await render();
  expect(texts()).toContain('USDT'); expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  const row = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('TokenBadge').length);
  await act(async () => row.props.onPress());
  expect(onPick).toHaveBeenCalledWith({ ...metadata, amount: 0, raw: '0.000000 USDT' });
  expect(refresh).not.toHaveBeenCalled();
});
