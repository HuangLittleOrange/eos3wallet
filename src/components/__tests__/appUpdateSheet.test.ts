jest.mock('react-native', () => ({ View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles }, Linking: { openURL: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
jest.mock('../BottomSheet', () => 'BottomSheet');
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../update/appUpdate', () => ({ canSelfUpdate: true, downloadRelease: jest.fn(), installRelease: jest.fn(), AppUpdateError: class extends Error { code: string; constructor(code: string) { super(code); this.code = code; } } }));
import React from 'react';
import { Linking } from 'react-native';
import AppUpdateSheet from '../AppUpdateSheet';
import { downloadRelease, installRelease, type AppRelease, AppUpdateError } from '../../update/appUpdate';
const { act, create } = require('react-test-renderer');
let renderer: any;
const onClose = jest.fn();
const release = (forceUpdate = false): AppRelease => ({ id: 'r5', platform: 'android', versionCode: 5,
  versionName: '1.0.5', title: 'New release', releaseNotes: 'Changes from the admin', apkUrl: 'https://example.com/5.apk', forceUpdate });
const render = async (forced = false) => {
  const data = release(forced);
  if (!require('../../update/appUpdate').canSelfUpdate) {
    data.platform = 'ios'; data.apkUrl = 'https://testflight.apple.com/join/example';
  }
  await act(async () => { renderer = create(React.createElement(AppUpdateSheet, { release: data, onClose })); });
};
const texts = () => renderer.root.findAllByType('Text').flatMap((node: any) => node.children);
const button = (text: string) => renderer.root.findAllByType('TouchableOpacity').find((node: any) => node.findAllByType('Text').some((label: any) => label.children.includes(text)));
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; jest.clearAllMocks();
  require('../../update/appUpdate').canSelfUpdate = true;
  jest.mocked(installRelease).mockResolvedValue(undefined);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

test('optional prompt shows version/notes and can be postponed', async () => {
  await render(); expect(texts()).toEqual(expect.arrayContaining(['v', '1.0.5', 'Changes from the admin']));
  await act(async () => button('update.later').props.onPress()); expect(onClose).toHaveBeenCalledTimes(1);
});
test('mandatory prompt has no Later/close escape and takes priority over ordinary sheets', async () => {
  await render(true);
  expect(button('update.later')).toBeUndefined(); expect(texts()).toContain('update.requiredHint');
  const sheet = renderer.root.findByType('BottomSheet');
  expect(sheet.props.closeOnBackdrop).toBe(false); expect(sheet.props.priority).toBe(100);
  await act(async () => sheet.props.onClose()); expect(onClose).not.toHaveBeenCalled();
});
test('Android downloads only after confirmation, then calls the installer and supports retry after system settings', async () => {
  jest.mocked(downloadRelease).mockResolvedValue('file:///5.apk'); await render();
  expect(downloadRelease).not.toHaveBeenCalled();
  await act(async () => button('update.updateNow').props.onPress());
  expect(installRelease).toHaveBeenCalledWith('file:///5.apk', 5);
  expect(button('update.install')).toBeDefined();
  await act(async () => button('update.install').props.onPress());
  expect(downloadRelease).toHaveBeenCalledTimes(1); expect(installRelease).toHaveBeenCalledTimes(2);
});
test('double tapping cannot start two downloads; unmount cancels and cannot install a late result', async () => {
  let finish!: (uri: string) => void;
  jest.mocked(downloadRelease).mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render();
  const start = button('update.updateNow').props.onPress;
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => { first = start(); second = start(); });
  expect(downloadRelease).toHaveBeenCalledTimes(1);
  const signal = jest.mocked(downloadRelease).mock.calls[0][2]!;
  await act(async () => renderer.unmount()); renderer = null; expect(signal.aborted).toBe(true);
  await act(async () => { finish('file:///5.apk'); await Promise.all([first, second]); });
  expect(installRelease).not.toHaveBeenCalled();
});
test('cancelling download keeps a mandatory gate and permits retry', async () => {
  jest.mocked(downloadRelease).mockImplementation((_release, _progress, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })));
  })); await render(true);
  let started!: Promise<void>; await act(async () => { started = button('update.updateNow').props.onPress(); });
  await act(async () => { button('update.cancelDownload').props.onPress(); await started; });
  expect(button('update.updateNow')).toBeDefined(); expect(button('update.later')).toBeUndefined();
  expect(installRelease).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
});
test('iOS opens its configured installation/store page without downloading an APK', async () => {
  require('../../update/appUpdate').canSelfUpdate = false;
  jest.mocked(Linking.openURL).mockResolvedValue(undefined); await render();
  await act(async () => button('update.updateNow').props.onPress());
  expect(Linking.openURL).toHaveBeenCalledWith('https://testflight.apple.com/join/example');
  expect(downloadRelease).not.toHaveBeenCalled(); expect(installRelease).not.toHaveBeenCalled();
  expect(texts()).toContain('update.iosInstallHint');
});
test('an iOS link failure remains retryable without dismissing the mandatory prompt', async () => {
  require('../../update/appUpdate').canSelfUpdate = false;
  jest.mocked(Linking.openURL).mockRejectedValue(new Error('Cannot open')); await render(true);
  await act(async () => button('update.updateNow').props.onPress());
  expect(texts()).toContain('update.openFailed'); expect(button('update.updateNow')).toBeDefined();
  expect(onClose).not.toHaveBeenCalled();
});


test('an unverified package never traps the user on Install and can be downloaded again', async () => {
  jest.mocked(downloadRelease).mockResolvedValue('file:///unverified.apk');
  jest.mocked(installRelease).mockRejectedValueOnce(new AppUpdateError('verify'));
  await render(true);
  await act(async () => button('update.updateNow').props.onPress());
  expect(texts()).toContain('update.verifyFailed');
  expect(button('update.install')).toBeUndefined();
  expect(button('update.updateNow')).toBeDefined();
  await act(async () => button('update.updateNow').props.onPress());
  expect(downloadRelease).toHaveBeenCalledTimes(2);
});
