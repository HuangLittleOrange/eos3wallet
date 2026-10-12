// App 版本检查与安卓安装包更新。
//
// 后端接口是现成的(eospasskey go-api 的 app_update_routes.go),发布记录在
// 管理后台维护:
//   GET {EOS3_BASE_URL}/api/app-update/check?platform=android&versionCode=<当前>
//   → { updateAvailable: boolean, release: AppRelease | null }
// 只支持安卓:iOS 不能侧载安装包,更新只能走 App Store,后端也直接回 400。
//
// 版本比较用 versionCode(整数,每次出包必须递增,见 app.json 的
// expo.android.versionCode),不用 versionName 字符串——"1.10.0" 和 "1.9.0"
// 按字符串比是反的。当前值从已安装包里实时读,不在代码里抄一份。
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import { DownloadTask, File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

import { EOS3_BASE_URL } from '../passkey/constants';
import { fetchWithTimeout } from '../net/fetchRetry';

export type AppRelease = {
  id: string;
  versionName: string;
  versionCode: number;
  title: string;
  releaseNotes: string;
  apkUrl: string;
  /** 后台标了强制更新:更新弹窗不给"稍后"按钮 */
  forceUpdate: boolean;
};

/** 已安装包的版本名,如 "1.0.0";读不到(网页版等)时退回 app.json 里的版本 */
export function currentAppVersion(): string {
  return Application.nativeApplicationVersion ?? '1.0.0';
}

/** 已安装包的 versionCode;读不到时按 0 处理,等于"任何发布都比我新" */
export function currentVersionCode(): number {
  const n = Number(Application.nativeBuildVersion);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 这个平台能不能在 App 里直接下载安装更新 */
export const canSelfUpdate = Platform.OS === 'android';

export class AppUpdateError extends Error {
  constructor(public readonly code: 'network' | 'server' | 'insecure-url' | 'download' | 'install') {
    super(code);
  }
}

/** 有比当前更新的版本就返回它,否则返回 null */
export async function checkForUpdate(): Promise<AppRelease | null> {
  if (!canSelfUpdate) return null;
  const url = `${EOS3_BASE_URL}/api/app-update/check?platform=android&versionCode=${currentVersionCode()}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new AppUpdateError('network');
  }
  if (!res.ok) throw new AppUpdateError('server');

  const body: any = await res.json().catch(() => null);
  const release: AppRelease | null = body?.updateAvailable ? body.release ?? null : null;
  // 服务端已经按 versionCode 比过一次,这里再比一次:接口万一回了一个不比当前新的
  // 版本,不能让用户"更新"到同一个甚至更旧的包
  if (!release || !(Number(release.versionCode) > currentVersionCode())) return null;

  // 安装包只从 https 下载。安卓装更新时会校验签名和已装的是否一致,被篡改的包装不上,
  // 但明文下载仍然可能被中途换成别的东西、白白让用户下一个装不了的包
  if (!/^https:\/\//i.test(release.apkUrl ?? '')) throw new AppUpdateError('insecure-url');
  return release;
}

/**
 * 下载安装包到缓存目录,返回本地文件地址。onProgress 给 0~1 的进度,
 * 服务端没给文件大小时回 -1。signal 用来取消下载。
 */
export async function downloadRelease(
  release: AppRelease,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const dest = new File(Paths.cache, `eos3-wallet-${release.versionCode}.apk`);
  // 上次没下完或者下坏了的残留文件,直接清掉重下
  if (dest.exists) dest.delete();

  const task = new DownloadTask(release.apkUrl, dest, {
    signal,
    onProgress: ({ bytesWritten, totalBytes }) => onProgress(totalBytes > 0 ? bytesWritten / totalBytes : -1),
  });

  let file: File | null;
  try {
    file = await task.downloadAsync();
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new AppUpdateError('download');
  }
  if (!file || !file.exists || file.size === 0) throw new AppUpdateError('download');
  return file.uri;
}

/**
 * 把下载好的安装包交给系统安装器。系统会校验签名:只有和当前安装的 App 同一把
 * 签名的包才能覆盖安装。第一次用时系统会先让用户去设置里允许本 App 安装应用,
 * 允许完回到 App 需要再点一次安装。
 */
export async function installRelease(fileUri: string): Promise<void> {
  try {
    const contentUri = await getContentUriAsync(fileUri);
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      // FLAG_GRANT_READ_URI_PERMISSION:不给这个标志,安装器读不到我们缓存里的文件
      flags: 1,
    });
  } catch {
    throw new AppUpdateError('install');
  }
}
