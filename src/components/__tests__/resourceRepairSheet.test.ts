jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('react-native-get-random-values', () => ({}));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../BottomSheet', () => 'BottomSheet');
jest.mock('../../i18n', () => {
  const t = (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key;
  return { t, useI18n: () => ({ t }) };
});
jest.mock('../../chain/transact', () => ({ transact: jest.fn(), sponsoredTransact: jest.fn() }));
jest.mock('../../chain/resourceRepairQuote', () => ({ getResourceRepairMarket: jest.fn(), refreshResourceRepairFee: jest.fn() }));
jest.mock('../../chain/sponsorFeeCache', () => ({ getCachedSponsorFee: jest.fn() }));
jest.mock('../../chain/powerupPricing', () => ({ estimateTransfersForPayment: () => 10 }));
jest.mock('../../chain/resourceRepair', () => ({
  ...jest.requireActual('../../chain/resourceRepair'),
  buildPowerupTopUp: () => ({ action: { account: 'core.vaulta', name: 'powerup', data: {} } }),
}));

import React from 'react';
import { Alert, AppState } from 'react-native';
import { useResourceRepair } from '../ResourceRepairSheet';
import { transact, sponsoredTransact } from '../../chain/transact';
import { CpuNetExhaustedError, RamExhaustedError, SponsorFeeChangedError } from '../../chain/sponsor';
import { getResourceRepairMarket, refreshResourceRepairFee } from '../../chain/resourceRepairQuote';
import { getCachedSponsorFee } from '../../chain/sponsorFeeCache';

const { create, act } = require('react-test-renderer');
let renderer: any;
let repair: ReturnType<typeof useResourceRepair>;
const signer = { kind: 'privatekey' as const, privateKey: 'test-only' };
const client = {
  config: { resourceContract: 'core.vaulta', systemToken: 'core.vaulta', symbol: 'A', precision: 4 },
  getBalance: jest.fn(), getRamQuote: jest.fn(),
};
const ramQuote = { targetBytes: 1024, estimatedBytes: 1023,
  marketCost: '0.0200 A', chainFee: '0.0002 A', total: '0.0202 A' };
const wallet = { currentWallet: { id: 'alice' }, chainId: 'vaulta' as const,
  node: { url: 'https://node.example' }, account: 'alice', client };
function Harness({ account = 'alice' }: { account?: string }) {
  repair = useResourceRepair({ ...wallet, account } as any);
  return repair.element;
}
const button = (key: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) =>
  node.findAllByType('Text').some((text: any) => text.children.includes(key)));
const textContent = () => renderer.root.findAllByType('Text').map((node: any) => node.children.join('')).join('\n');
const press = async (key: string) => {
  expect(button(key)).toBeDefined();
  expect(button(key).props.disabled).not.toBe(true);
  await act(async () => { await button(key).props.onPress(); });
};
const open = async (error: Error = new RamExhaustedError('RAM')) => {
  await act(async () => { renderer = create(React.createElement(Harness)); });
  await act(async () => { expect(repair.offer(error, signer, 'active')).toBe(true); });
};
const needPowerup = async () => {
  jest.mocked(transact).mockRejectedValueOnce(new CpuNetExhaustedError('CPU'));
  await press('repair.buyRam');
  expect(button('repair.buyPowerupThenRam')).toBeDefined();
};
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.resetAllMocks();
  AppState.currentState = 'active';
  client.getBalance.mockResolvedValue([{ raw: '1.0000 A' }]);
  client.getRamQuote.mockResolvedValue(ramQuote);
  jest.mocked(getCachedSponsorFee).mockResolvedValue({ fee: '0.0020 A' } as any);
  jest.mocked(refreshResourceRepairFee).mockResolvedValue({ fee: '0.0020 A' } as any);
  jest.mocked(getResourceRepairMarket).mockResolvedValue({ powerupDays: 1 } as any);
  jest.mocked(transact).mockResolvedValue({ txId: 'ram-tx', explorerUrl: '' });
  jest.mocked(sponsoredTransact).mockResolvedValue({ txId: 'powerup-tx', explorerUrl: '' });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  renderer = null;
});

test('RAM purchase displays only the all-in total and broadcasts directly without sponsorship', async () => {
  await open();
  expect(textContent()).toContain('repair.totalLine');
  expect(textContent()).toContain('0.0202 A');
  expect(textContent()).not.toContain('repair.ramFeeLine');
  expect(textContent()).not.toContain('repair.ramChainFeeLine');
  expect(textContent()).not.toContain('repair.ramMarketLine');
  expect(textContent()).not.toContain('repair.ramEstimatedBytes');
  expect(textContent()).not.toContain('0.0002 A');
  await press('repair.buyRam');
  expect(transact).toHaveBeenCalledWith(expect.objectContaining({ actor: 'alice', signer, permission: 'active',
    actions: [{ account: 'core.vaulta', name: 'buyrambytes', data: { payer: 'alice', receiver: 'alice', bytes: 1024 } }] }));
  expect(sponsoredTransact).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith('repair.ramDoneTitle', expect.stringContaining('ram-tx'));
});

test('combined quote requires confirmation, then completes PowerUp followed by direct RAM', async () => {
  await open(); await needPowerup();
  expect(textContent()).not.toContain('repair.powerupLine');
  expect(textContent()).not.toContain('repair.feeLine');
  expect(textContent()).not.toContain('repair.ramChainFeeLine');
  expect(textContent()).toContain('0.0322 A');
  expect(sponsoredTransact).not.toHaveBeenCalled();
  await press('repair.buyPowerupThenRam');
  expect(sponsoredTransact).toHaveBeenCalledTimes(1);
  expect(sponsoredTransact).toHaveBeenCalledWith(expect.objectContaining({ approvedFee: '0.0020 A',
    actions: [expect.objectContaining({ name: 'powerup' })] }));
  expect(transact).toHaveBeenCalledTimes(2);
  expect(jest.mocked(sponsoredTransact).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(transact).mock.invocationCallOrder[1]);
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect(Alert.alert).toHaveBeenCalledWith('repair.ramDoneTitle', expect.stringContaining('ram-tx'));
});

test('balance must cover PowerUp, its sponsor fee and RAM together', async () => {
  client.getBalance.mockResolvedValue([{ raw: '0.0250 A' }]);
  await open(); await needPowerup();
  expect(button('repair.buyPowerupThenRam').props.disabled).toBe(true);
  expect(textContent()).toContain('repair.insufficientBalance');
  expect(sponsoredTransact).not.toHaveBeenCalled();
});

test('a changed sponsor fee requires another confirmation before either purchase', async () => {
  await open(); await needPowerup();
  jest.mocked(sponsoredTransact).mockRejectedValueOnce(new SponsorFeeChangedError('0.0040 A'));
  await press('repair.buyPowerupThenRam');
  expect(textContent()).toContain('0.0342 A');
  expect(transact).toHaveBeenCalledTimes(1);
  await press('repair.buyPowerupThenRam');
  expect(jest.mocked(sponsoredTransact).mock.calls[1][0].approvedFee).toBe('0.0040 A');
  expect(transact).toHaveBeenCalledTimes(2);
});

test('failed RAM after a successful PowerUp retries only RAM and keeps the PowerUp receipt', async () => {
  await open(); await needPowerup();
  jest.mocked(transact).mockRejectedValueOnce(new Error('Network request failed'));
  await press('repair.buyPowerupThenRam');
  expect(textContent()).toContain('powerup-tx');
  expect(button('repair.buyPowerupThenRam')).toBeUndefined();
  expect(Alert.alert).not.toHaveBeenCalled();
  await press('repair.buyRam');
  expect(sponsoredTransact).toHaveBeenCalledTimes(1);
  expect(transact).toHaveBeenCalledTimes(3);
});

test('a missing RAM quote disables spending and can be reloaded in place', async () => {
  client.getRamQuote.mockRejectedValueOnce(new Error('offline'));
  await open();
  expect(button('repair.buyRam').props.disabled).toBe(true);
  await press('wallet.retryHint');
  expect(button('repair.buyRam').props.disabled).toBe(false);
  expect(transact).not.toHaveBeenCalled();
});

test('changing account during PowerUp prevents automatic RAM on the old account', async () => {
  await open(); await needPowerup();
  let finish!: (value: any) => void;
  jest.mocked(sponsoredTransact).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = button('repair.buyPowerupThenRam').props.onPress(); });
  await act(async () => { renderer.update(React.createElement(Harness, { account: 'bob' })); });
  await act(async () => { finish({ txId: 'powerup-tx' }); await pending; });
  expect(transact).toHaveBeenCalledTimes(1);
  expect(Alert.alert).not.toHaveBeenCalled();
});

test('CPU/NET-only repair does not buy RAM', async () => {
  await open(new CpuNetExhaustedError('CPU'));
  await press('repair.buyPowerup');
  expect(sponsoredTransact).toHaveBeenCalledTimes(1);
  expect(transact).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith('repair.powerupDoneTitle', expect.stringContaining('powerup-tx'));
});

test('balance must cover the chain RAM fee as well as the market payment', async () => {
  client.getBalance.mockResolvedValue([{ raw: '0.0201 A' }]);
  await open();
  expect(button('repair.buyRam').props.disabled).toBe(true);
  expect(textContent()).toContain('repair.insufficientBalance');
  expect(transact).not.toHaveBeenCalled();
});

test('RAM remains a market-priced byte purchase without an extra price confirmation', async () => {
  await open();
  client.getRamQuote.mockResolvedValue({ ...ramQuote, total: '0.0500 A' });
  await press('repair.buyRam');
  expect(client.getRamQuote).toHaveBeenCalledTimes(1);
  expect(client.getRamQuote).toHaveBeenCalledWith(1024);
  expect(transact).toHaveBeenCalledTimes(1);
  expect(jest.mocked(transact).mock.calls[0][0].actions[0]).toEqual({
    account: 'core.vaulta', name: 'buyrambytes', data: { payer: 'alice', receiver: 'alice', bytes: 1024 },
  });
  expect(sponsoredTransact).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith('repair.ramDoneTitle', expect.stringContaining('ram-tx'));
});
