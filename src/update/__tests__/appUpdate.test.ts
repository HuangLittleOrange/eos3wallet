jest.mock('react-native', () => ({Platform: {OS: 'android'}}));
// 版本检查:按 versionCode 比新旧、只接受 https 的安装包地址、网络和服务端
// 出错各给一个可区分的错误码。接口是 eospasskey go-api 的
// GET /api/app-update/check,响应形状 { updateAvailable, release }。
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.2.0', nativeBuildVersion: '3' }));
jest.mock('expo-file-system', () => ({ DownloadTask: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-file-system/legacy', () => ({ getContentUriAsync: jest.fn() }));
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: jest.fn() }));

jest.mock('expo', () => ({ requireNativeModule: jest.fn() }));

type Mod = typeof import('../appUpdate');

/** 模块在加载时就按平台算好了 canSelfUpdate,所以每个用例都按安卓重新加载一份 */
function loadAndroid(): Mod {
  let mod!: Mod;
  jest.isolateModules(() => {
    require('react-native').Platform.OS = 'android';
    mod = require('../appUpdate');
  });
  return mod;
}

const release = (over: Partial<Record<string, any>> = {}) => ({
  id: 'r5',
  platform: 'android',
  versionName: '1.3.0',
  versionCode: 5,
  title: '新版本',
  releaseNotes: '修复若干问题',
  apkUrl: 'https://cdn.example.com/eos3-wallet-5.apk',
  forceUpdate: false,
  enabled: true,
  ...over,
});

function mockFetch(impl: () => Promise<any>) {
  (globalThis as any).fetch = jest.fn(impl);
  return (globalThis as any).fetch as jest.Mock;
}
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

describe('checkForUpdate', () => {
  it('iOS 按 iOS 版本目录检查 HTTPS 安装或商店链接', async () => {
    let mod!: Mod;
    jest.isolateModules(() => { require('react-native').Platform.OS = 'ios'; mod = require('../appUpdate'); });
    const f = mockFetch(() => ok({ updateAvailable: true, release: release({platform:'ios',apkUrl:'https://apps.apple.com/app/example'}) }));
    await expect(mod.checkForUpdate()).resolves.toMatchObject({platform:'ios'});
    expect(String(f.mock.calls[0][0])).toContain('platform=ios&versionCode=3');
    expect(mod.canSelfUpdate).toBe(false);
  });
  it('带上当前的 versionCode 去问后端', async () => {
    const f = mockFetch(() => ok({ updateAvailable: false, release: null }));
    await loadAndroid().checkForUpdate();
    expect(String(f.mock.calls[0][0])).toBe('https://eos3.app/api/app-update/check?platform=android&versionCode=3');
  });

  it('后端说没有更新时返回 null', async () => {
    mockFetch(() => ok({ updateAvailable: false, release: null }));
    await expect(loadAndroid().checkForUpdate()).resolves.toBeNull();
  });

  it('有更高 versionCode 的发布时把它返回', async () => {
    mockFetch(() => ok({ updateAvailable: true, release: release() }));
    await expect(loadAndroid().checkForUpdate()).resolves.toMatchObject({ versionCode: 5, versionName: '1.3.0' });
  });

  it('后端回了一个不比当前新的版本,也当作没有更新,不让用户"更新"到同版或旧版', async () => {
    mockFetch(() => ok({ updateAvailable: true, release: release({ versionCode: 3 }) }));
    await expect(loadAndroid().checkForUpdate()).resolves.toBeNull();
  });

  it('安装包地址不是 https 时拒绝,报 insecure-url', async () => {
    mockFetch(() => ok({ updateAvailable: true, release: release({ apkUrl: 'http://cdn.example.com/a.apk' }) }));
    await expect(loadAndroid().checkForUpdate()).rejects.toMatchObject({ code: 'insecure-url' });
  });

  it('网络失败报 network,服务端出错报 server', async () => {
    mockFetch(() => Promise.reject(new Error('offline')));
    await expect(loadAndroid().checkForUpdate()).rejects.toMatchObject({ code: 'network' });
    mockFetch(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    await expect(loadAndroid().checkForUpdate()).rejects.toMatchObject({ code: 'server' });
  });

  it('当前版本号从已安装的包里读', () => {
    const mod = loadAndroid();
    expect(mod.currentAppVersion()).toBe('1.2.0');
    expect(mod.currentVersionCode()).toBe(3);
  });
});

it.each([
  null, { updateAvailable: 'true', release: release() }, { updateAvailable: true, release: null },
  { updateAvailable: true, release: release({ versionCode: 5.5 }) },
  { updateAvailable: true, release: release({ forceUpdate: 'false' }) },
  { updateAvailable: true, release: release({ releaseNotes: {} }) },
])('拒绝格式错误的更新策略，避免错误提示或误判为强制更新 %#', async body => {
  mockFetch(() => ok(body)); await expect(loadAndroid().checkForUpdate()).rejects.toMatchObject({ code: 'server' });
});
it('不显示已停用的版本，也不使用 HTTP 缓存里的旧强制更新策略', async () => {
  const fetch = mockFetch(() => ok({ updateAvailable: true, release: release({ enabled: false }) }));
  await expect(loadAndroid().checkForUpdate()).resolves.toBeNull();
  expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
});
it('拒绝错误平台和不完整或带登录凭据的下载 URL', async () => {
  mockFetch(() => ok({ updateAvailable: true, release: release({ platform: 'ios' }) }));
  await expect(loadAndroid().checkForUpdate()).rejects.toMatchObject({ code: 'server' });
  for (const apkUrl of ['https://', 'https://user:secret@example.com/file.apk']) {
    mockFetch(() => ok({ updateAvailable: true, release: release({ apkUrl }) }));
    await expect(loadAndroid().checkForUpdate()).rejects.toMatchObject({ code: 'insecure-url' });
  }
});


describe('verified Android installation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    require('expo-intent-launcher');
    require('expo-file-system/legacy');
  });
  it('checks the exact cached APK and advertised version before invoking the system installer', async () => {
    const verify = jest.fn(async () => true);
    require('expo').requireNativeModule.mockReturnValue({ verify });
    require('expo-file-system/legacy').getContentUriAsync.mockResolvedValue('content://wallet/update');
    await loadAndroid().installRelease('file:///cache/update.apk', 5);
    expect(verify).toHaveBeenCalledWith('file:///cache/update.apk', 5);
    expect(require('expo-intent-launcher').startActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW',
      { data: 'content://wallet/update', type: 'application/vnd.android.package-archive', flags: 1 });
  });
  it.each(['wrong-package', 'wrong-signer', 'wrong-version', 'invalid-apk'])('blocks %s without handing it to the installer', async reason => {
    require('expo').requireNativeModule.mockReturnValue({ verify: jest.fn(async () => { throw new Error(reason); }) });
    await expect(loadAndroid().installRelease('file:///cache/update.apk', 5)).rejects.toMatchObject({ code: 'verify' });
    expect(require('expo-file-system/legacy').getContentUriAsync).not.toHaveBeenCalled();
    expect(require('expo-intent-launcher').startActivityAsync).not.toHaveBeenCalled();
  });
  it('refuses a missing verifier, false results, and non-new/invalid version codes without fallback', async () => {
    const mod = loadAndroid();
    require('expo').requireNativeModule.mockImplementation(() => { throw new Error('old binary'); });
    await expect(mod.installRelease('file:///cache/update.apk', 5)).rejects.toMatchObject({ code: 'verify' });
    require('expo').requireNativeModule.mockImplementation(() => ({ verify: async () => false }));
    await expect(mod.installRelease('file:///cache/update.apk', 5)).rejects.toMatchObject({ code: 'verify' });
    for (const code of [0, 3, 4.5, NaN]) await expect(mod.installRelease('file:///cache/update.apk', code)).rejects.toMatchObject({ code: 'verify' });
    expect(require('expo-intent-launcher').startActivityAsync).not.toHaveBeenCalled();
  });
});
