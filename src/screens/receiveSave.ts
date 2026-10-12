// 把收款码卡片存进系统相册——原生专属实现。
//
// expo-media-library 这个版本(New Architecture 的 index.js/ExpoMediaLibraryNext.js)
// 在模块求值阶段就会 requireNativeModule('ExpoMediaLibraryNext'),web 端没有这个原生
// 模块,一 import 就直接抛出未捕获异常,把整个 App 崩成白屏——不是调用时才炸,是
// import 那一刻就炸,所以不能靠 Platform.OS 判断来"绕开调用",必须让这个文件本身
// 不出现在 web 包里。靠 receiveSave.web.ts 承接 web 端的实现,Metro 按平台后缀选
// 文件,两边各自的 import 互不影响。
import { Asset, requestPermissionsAsync } from 'expo-media-library';

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'denied'; canAskAgain: boolean }
  | { ok: false; reason: 'error'; message?: string };

/**
 * 只是把生成的二维码图片存进相册,不需要读已有照片,更用不上音频/视频——不传
 * 这两个参数会连音乐库权限都一起问用户,一个钱包 App 弹"允许访问音乐"看着像
 * 可疑行为。writeOnly + 只要 photo 这个粒度,Android 13+ 才不会把三种媒体类型
 * 的系统弹窗都过一遍。
 */
export async function saveImageToGallery(uri: string): Promise<SaveResult> {
  try {
    const { status, canAskAgain } = await requestPermissionsAsync(true, ['photo']);
    if (status !== 'granted') {
      return { ok: false, reason: 'denied', canAskAgain };
    }
    await Asset.create(uri);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  }
}
