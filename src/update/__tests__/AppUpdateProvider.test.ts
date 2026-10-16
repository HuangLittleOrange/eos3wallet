jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../../components/AppUpdateSheet', () => 'AppUpdateSheet');
jest.mock('../appUpdate', () => ({ canCheckUpdates: true, checkForUpdate: jest.fn() }));
import React from 'react';
import { AppState } from 'react-native';
import { AppUpdateProvider, useAppUpdates } from '../AppUpdateProvider';
import { checkForUpdate, type AppRelease } from '../appUpdate';
import { allocLayerId, getLayers, removeLayer, upsertLayer } from '../../components/modalLayers';
const { act, create } = require('react-test-renderer');
const release = (extra: Partial<AppRelease> = {}): AppRelease => ({ id: 'r5', platform: 'android', versionCode: 5,
  versionName: '1.0.5', title: 'New version', releaseNotes: 'Fixes', apkUrl: 'https://example.com/5.apk', forceUpdate: false, ...extra });
let renderer: any;
let updates: ReturnType<typeof useAppUpdates>;
const network = jest.mocked(checkForUpdate);
function Observer() { updates = useAppUpdates(); return null; }
const mount = async () => { await act(async () => { renderer = create(React.createElement(AppUpdateProvider, null, React.createElement(Observer))); }); };
const prompt = () => renderer.root.findAllByType('AppUpdateSheet')[0];
async function transition(state: 'active' | 'background' | 'inactive') {
  AppState.currentState = state;
  const listener = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1];
  await act(async () => { listener(state); });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers(); jest.clearAllMocks(); AppState.currentState = 'active'; network.mockResolvedValue(null);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount()); renderer = null;
  getLayers().forEach(layer => removeLayer(layer.id)); jest.clearAllTimers(); jest.useRealTimers();
});

test('cold launch checks without login or opening the Me screen and presents release metadata', async () => {
  network.mockResolvedValue(release()); await mount();
  expect(network).toHaveBeenCalledTimes(1);
  expect(prompt().props.release).toMatchObject({ versionName: '1.0.5', releaseNotes: 'Fixes', forceUpdate: false });
});
test('no update or automatic network errors leave the wallet unobstructed', async () => {
  network.mockRejectedValueOnce(new Error('offline')); await mount(); expect(prompt()).toBeUndefined();
  await transition('background'); await act(async () => jest.advanceTimersByTime(5 * 60 * 1000)); await transition('active');
  expect(network).toHaveBeenCalledTimes(2); expect(prompt()).toBeUndefined();
});
test('initial background launch waits until foreground, and short trips do not duplicate checks', async () => {
  AppState.currentState = 'background'; await mount(); expect(network).not.toHaveBeenCalled();
  await transition('active'); await transition('inactive'); await transition('active');
  expect(network).toHaveBeenCalledTimes(1);
});
test('manual and automatic checks share one request and one prompt', async () => {
  let finish!: (release: AppRelease) => void;
  network.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await mount();
  let manual!: Promise<AppRelease | null>;
  await act(async () => { manual = updates.checkUpdates(); });
  expect(network).toHaveBeenCalledTimes(1);
  await act(async () => { finish(release()); await manual; });
  expect(renderer.root.findAllByType('AppUpdateSheet')).toHaveLength(1);
});
test('Later suppresses the same optional release for this launch; manual checking can reopen it', async () => {
  network.mockResolvedValue(release()); await mount();
  await act(async () => prompt().props.onClose()); expect(prompt()).toBeUndefined();
  await transition('background'); await act(async () => jest.advanceTimersByTime(5 * 60 * 1000)); await transition('active');
  expect(prompt()).toBeUndefined();
  await act(async () => updates.checkUpdates()); expect(prompt()).toBeDefined();
});
test('a new version or mandatory policy overrides an earlier Later choice', async () => {
  network.mockResolvedValue(release()); await mount(); await act(async () => prompt().props.onClose());
  network.mockResolvedValue(release({ forceUpdate: true }));
  await transition('background'); await act(async () => jest.advanceTimersByTime(5 * 60 * 1000)); await transition('active');
  expect(prompt().props.release.forceUpdate).toBe(true);
  await act(async () => prompt().props.onClose()); expect(prompt()).toBeDefined();
  network.mockResolvedValue(release({ versionCode: 6, forceUpdate: false }));
  await transition('background'); await transition('active');
  expect(prompt().props.release.versionCode).toBe(6);
});
test('backend withdrawal removes a mandatory gate, and network errors preserve known policy', async () => {
  network.mockResolvedValueOnce(release({ forceUpdate: true })); await mount();
  network.mockRejectedValueOnce(new Error('offline'));
  await transition('background'); await transition('active'); expect(prompt().props.release.forceUpdate).toBe(true);
  network.mockResolvedValue(null); await transition('background'); await transition('active'); expect(prompt()).toBeUndefined();
});
test('backend can change mandatory back to optional after the user previously dismissed it', async () => {
  network.mockResolvedValue(release()); await mount(); await act(async () => prompt().props.onClose());
  network.mockResolvedValue(release({ forceUpdate: true })); await act(async () => updates.checkUpdates());
  network.mockResolvedValue(release()); await transition('background'); await transition('active');
  expect(prompt()).toBeUndefined();
});
test('optional automatic prompts wait for an existing wallet confirmation to close', async () => {
  const id = allocLayerId(); upsertLayer({ id, node: 'Signing confirmation' });
  network.mockResolvedValue(release()); await mount(); expect(prompt()).toBeUndefined();
  await act(async () => removeLayer(id)); expect(prompt()).toBeDefined();
});
test('a response received in background is held until foreground', async () => {
  let finish!: (value: AppRelease) => void;
  network.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await mount();
  await transition('background'); await act(async () => finish(release())); expect(prompt()).toBeUndefined();
  await transition('active'); expect(prompt()).toBeDefined(); expect(network).toHaveBeenCalledTimes(1);
});
test('late requests after unmount do not reopen a prompt', async () => {
  let finish!: (value: AppRelease) => void;
  network.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await mount();
  await act(async () => renderer.unmount()); renderer = null;
  await act(async () => finish(release()));
  expect(jest.mocked(AppState.addEventListener).mock.results[0].value.remove).toHaveBeenCalled();
});
test('manual failures remain visible to the existing manual check error handler', async () => {
  await mount(); network.mockRejectedValueOnce(new Error('offline'));
  await expect(updates.checkUpdates()).rejects.toThrow('offline');
});
