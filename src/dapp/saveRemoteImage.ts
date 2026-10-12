// TokenPocket 的 tp.saveImage({ url }) —— 把网页上的一张图存进系统相册。
//
// 相册接口只收本地文件,所以先下载到缓存目录再导入。只接受 http(s) 地址:
// data: / file: / content: 这类由页面给出的本地协议,要么没必要走下载,
// 要么能被用来读 App 自己的沙箱文件,一律不碰。
import { Directory, File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';

export class SaveImageError extends Error {}

export async function saveRemoteImage(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new SaveImageError('unsupported-url');

  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) throw new SaveImageError('permission-denied');

  const file = await File.downloadFileAsync(url, new Directory(Paths.cache), { idempotent: true });
  try {
    await MediaLibrary.Asset.create(file.uri);
  } finally {
    // 已经导入相册了,缓存里这份留着只占空间
    try {
      file.delete();
    } catch {}
  }
}
