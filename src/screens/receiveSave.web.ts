// web 端没有系统相册这个概念,也没有 expo-media-library 的实现(见 receiveSave.ts
// 顶部注释)——退回浏览器原生的"下载文件",体验上等价于「保存」。
export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'denied'; canAskAgain: boolean }
  | { ok: false; reason: 'error'; message?: string };

export async function saveImageToGallery(uri: string): Promise<SaveResult> {
  try {
    const a = document.createElement('a');
    a.href = uri;
    a.download = 'receive-qr.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message };
  }
}
