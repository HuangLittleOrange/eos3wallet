jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value },
}));
jest.mock('../../components/ConfirmTxSheet', () => 'ConfirmTxSheet');
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import React from 'react';
import EsrFlowOverlay from '../esr-flow-overlay';

const { create, act } = require('react-test-renderer');
let renderer: any;
const flow = () => ({
  esr: { req: { callbackOrigin: 'https://cb.anchor.link' } }, parsing: false,
  busy: false, err: null, close: jest.fn(), sheetActions: jest.fn(() => []),
  chainConfig: { name: 'Vaulta', testnet: false }, account: 'alice', permission: 'owner',
  wallet: { id: 'wallet', source: 'passkey' },
  submitPassword: jest.fn(), submitBiometric: jest.fn(), submitPasskey: jest.fn(), repairElement: null,
}) as any;
const mount = async (state: any, origin?: string) => {
  await act(async () => { renderer = create(React.createElement(EsrFlowOverlay, { flow: state, origin })); });
};
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); renderer = null; });

test('browser confirmation displays and signs with the identity owned by its flow', async () => {
  const state = flow();
  await mount(state, 'alcor.exchange');
  expect(state.sheetActions).toHaveBeenCalledWith('alcor.exchange');
  const sheet = renderer.root.findByType('ConfirmTxSheet');
  expect(sheet.props).toMatchObject({ visible: true, origin: 'alcor.exchange',
    callbackOrigin: 'https://cb.anchor.link', chainName: 'Vaulta', testnet: false,
    actor: 'alice', permission: 'owner', walletId: 'wallet', passkey: true });
  sheet.props.onClose(); sheet.props.onConfirm('password');
  sheet.props.onConfirmBiometric(); sheet.props.onConfirmPasskey();
  expect(state.close).toHaveBeenCalledTimes(1);
  expect(state.submitPassword).toHaveBeenCalledWith('password');
  expect(state.submitBiometric).toHaveBeenCalledTimes(1);
  expect(state.submitPasskey).toHaveBeenCalledTimes(1);
});

test('standalone parsing shows progress without inventing a browser origin or opening confirmation', async () => {
  const state = flow(); state.esr = null; state.parsing = true;
  await mount(state);
  expect(renderer.root.findByType('ConfirmTxSheet').props.visible).toBe(false);
  expect(renderer.root.findByType('ConfirmTxSheet').props.origin).toBeUndefined();
  expect(state.sheetActions).toHaveBeenCalledWith(undefined);
  expect(renderer.root.findByType('ActivityIndicator')).toBeDefined();
  expect(renderer.root.findByType('Text').children).toEqual(['dappBrowser.connectingNode']);
});
