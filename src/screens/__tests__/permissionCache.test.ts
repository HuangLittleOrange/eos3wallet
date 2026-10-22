jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles }, Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('@react-navigation/native', () => ({ useRoute: jest.fn(), useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useFocusEffect: (effect: () => void) => require('react').useEffect(effect, [effect]) }));
jest.mock('../../components/PageHeader', () => 'PageHeader');
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../components/AssetEditSheet', () => 'AssetEditSheet');
jest.mock('../../components/ResourceRepairSheet', () => ({ useResourceRepair: () => ({ prepare: jest.fn(), offer: () => false, element: null }) }));
jest.mock('../../chain/WalletContext', () => ({ useWallet: jest.fn(), useWalletSession: jest.fn() }));
jest.mock('../../chain/eos3Sign', () => ({ eos3Get: jest.fn() }));
jest.mock('../../chain/trustedRpc', () => ({
  readTrustedRpc: async (_chain: string, query: any) => (await query(async (path: string) =>
    path.endsWith('get_account')
      ? { permissions: [{ perm_name: 'demo', parent: 'active' }] }
      : { rows: [{ id: 1, bot_id_hash: 'ab'.repeat(32), owner: 'alice', permission: 'demo' }], more: false })).value,
}));
jest.mock('../../chain/transact', () => ({ transact: jest.fn(async () => ({})) }));
jest.mock('../../chain/signers', () => ({ passwordSigner: () => async () => ({}), biometricSigner: jest.fn(), passkeySigner: jest.fn() }));
jest.mock('../../crypto/vault', () => ({ signingPermission: () => 'active' }));
jest.mock('../../i18n', () => ({ t: (key: string) => key, useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
import React from 'react';
import { Alert } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useWallet, useWalletSession } from '../../chain/WalletContext';
import { eos3Get } from '../../chain/eos3Sign';
import { invalidateAuthorizedApps } from '../../chain/authorizedAppsCache';
import { transact } from '../../chain/transact';
import { permissionKey } from '../../chain/permissions';
import PermissionScreen from '../PermissionScreen';
import PermissionDetailScreen from '../PermissionDetailScreen';
const { act, create } = require('react-test-renderer');
const app = { permission: 'demo', parent: 'active', managedByPayLimit: true, active: true, botIdHash: 'ab'.repeat(32),
  assets: [], threshold: 1, keys: 1, accounts: 0, linkedActions: 0, projectName: 'Demo project' };
const overview = { eosAccount: 'alice', permissions: [app], assetCatalog: [] };
const getLinkedActions = jest.fn(async () => []);
const wallet = { account: 'alice', chainId: 'vaulta', node: { url: 'https://rpc.example' }, status: 'ready',
  client: { config: { name: 'EOS' }, getLinkedActions }, currentWallet: { id: 'alice', publicKey: 'key' }, resources: null };
let renderer: any;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.useFakeTimers(); jest.clearAllMocks();
  invalidateAuthorizedApps('vaulta', 'alice');
  jest.mocked(useWallet).mockReturnValue(wallet as any); jest.mocked(useWalletSession).mockReturnValue(wallet as any);
  jest.mocked(useRoute).mockReturnValue({ params: { permissionKey: permissionKey(app) } } as any);
  jest.mocked(eos3Get).mockResolvedValue(overview);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; jest.clearAllTimers(); jest.useRealTimers(); });
const render = async (screen: React.ComponentType) => { await act(async () => { renderer = create(React.createElement(screen)); }); };
const text = () => renderer.root.findAllByType('Text').flatMap((node: any) => node.children);
const revoke = async () => {
  const button = renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((item: any) => item.children.includes('permission.revoke')));
  await act(async () => button.props.onPress());
};

test('opening a detail from a loaded list reuses the overview without another request', async () => {
  await render(PermissionScreen); expect(text()).toContain('demo');
  await act(async () => renderer.unmount()); await render(PermissionDetailScreen);
  expect(text()).toContain('Demo project'); expect(eos3Get).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
});
test('the authorized list stays fresh for one hour rather than five minutes', async () => {
  await render(PermissionScreen);
  await act(async () => jest.advanceTimersByTimeAsync(59 * 60 * 1000));
  expect(eos3Get).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTimeAsync(60 * 1000));
  expect(eos3Get).toHaveBeenCalledTimes(2);
});

test('failed refresh keeps the detail visible and cached permission data cannot build a management transaction', async () => {
  await render(PermissionDetailScreen);
  jest.mocked(eos3Get).mockRejectedValue(new Error('offline'));
  await revoke();
  expect(text()).toContain('Demo project'); expect(text()).toContain('offline');
  expect(renderer.root.findByType('ConfirmTxSheet').props.visible).toBe(false);
  expect(getLinkedActions).not.toHaveBeenCalled(); expect(Alert.alert).toHaveBeenCalled();
});

test('management rechecks the server before broadcasting and closes the confirmation on success', async () => {
  await render(PermissionDetailScreen); await revoke();
  expect(eos3Get).toHaveBeenCalledTimes(2); expect(getLinkedActions).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType('ConfirmTxSheet').props.visible).toBe(true);
  await act(async () => renderer.root.findByType('ConfirmTxSheet').props.onConfirm('password'));
  expect(transact).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType('ConfirmTxSheet').props.visible).toBe(false);
});
