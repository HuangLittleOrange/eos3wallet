jest.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
  ActivityIndicator: 'ActivityIndicator', TextInput: 'TextInput', Alert: {}, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn() }));
jest.mock('../../components/CenterDialog', () => 'CenterDialog');
jest.mock('../../chain/WalletContext', () => ({ useWalletSession: jest.fn() }));
jest.mock('../../chain/NodeCatalogContext', () => ({ useNodeCatalogRefresh: jest.fn() }));
jest.mock('../../chain/customNodes', () => ({ listCustomNodes: jest.fn(async () => []) }));
jest.mock('../../chain/client', () => ({ probeNode: jest.fn(async () => ({ ms: 10, block: 1 })), probeHistoryNode: jest.fn(async () => ({ ms: 20, block: 1 })) }));
jest.mock('../../chain/prices', () => ({ PRICE_SOURCES: [{ id: 'coingecko', name: 'CoinGecko' }], probePriceSource: jest.fn(async () => ({ ms: 30, covered: 2 })) }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }));
import React from 'react';
import { useWalletSession } from '../../chain/WalletContext';
import { useNodeCatalogRefresh } from '../../chain/NodeCatalogContext';
import { probeNode } from '../../chain/client';
import NodeScreen from '../NodeScreen';
const { create, act } = require('react-test-renderer');
let renderer: any, scope = 0, session: any;
const refreshCatalog = jest.fn();
const tree = () => React.createElement(NodeScreen);
const render = async () => { await act(async () => { renderer = create(tree()); }); };
const pressRefresh = async () => {
  const button = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((text: any) => text.children.includes('node.refresh')));
  await act(async () => button.props.onPress());
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  const node = { id: 'same', name: 'RPC', url: `https://rpc-${++scope}.example` };
  const history = { id: 'history', name: 'History', url: `https://history-${scope}.example` };
  session = { chainId: 'vaulta', node, historyNode: history, rpcNodes: [node], defaultHistoryNodes: [history], priceSource: 'coingecko' };
  jest.mocked(useWalletSession).mockImplementation(() => session);
  jest.mocked(useNodeCatalogRefresh).mockReturnValue(refreshCatalog);
  refreshCatalog.mockImplementation(async () => ({ vaulta: { rpc: session.rpcNodes, history: session.defaultHistoryNodes } }));
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('reopening renders cached metrics without spinning or reprobing; refresh explicitly retests', async () => {
  await render(); await act(async () => renderer.unmount()); await render();
  expect(probeNode).toHaveBeenCalledTimes(1); expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
  await pressRefresh(); expect(probeNode).toHaveBeenCalledTimes(2);
});
test('manual refresh still retests when a catalog publication replaces equivalent arrays', async () => {
  await render();
  refreshCatalog.mockImplementation(async () => {
    session = { ...session, rpcNodes: [...session.rpcNodes], defaultHistoryNodes: [...session.defaultHistoryNodes] };
    return { vaulta: { rpc: session.rpcNodes, history: session.defaultHistoryNodes } };
  });
  await pressRefresh(); await act(async () => renderer.update(tree()));
  expect(probeNode).toHaveBeenCalledTimes(2);
});
test('late metrics from another chain do not replace the new chain rows', async () => {
  let finish!: (value: any) => void;
  jest.mocked(probeNode).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  session = { ...session, chainId: 'jungle4', rpcNodes: [{ ...session.node, url: 'https://new-chain.example' }] };
  await act(async () => renderer.update(tree()));
  await act(async () => finish({ ms: 999, block: 9 }));
  const values = renderer.root.findAllByType('Text').flatMap((node: any) => node.children).map(String);
  expect(probeNode).toHaveBeenCalledTimes(2);
  expect(values).toContain('10'); expect(values).not.toContain('999');
});
