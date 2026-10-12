// Base64URL 编解码 —— WebAuthn JSON(rp/公钥选项、断言响应等)里所有的二进制字段
// 都是不带 padding 的 base64url 字符串,不依赖 RN 是否提供全局 atob/btoa。

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += CHARS[b2 & 0x3f];
  }
  return out;
}

export function base64urlToBytes(input: string): Uint8Array {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);

  const lookup: Record<string, number> = {};
  const std = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < std.length; i++) lookup[std[i]] = i;

  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = lookup[padded[i]] ?? 0;
    const c1 = lookup[padded[i + 1]] ?? 0;
    const c2 = padded[i + 2] === '=' ? undefined : lookup[padded[i + 2]];
    const c3 = padded[i + 3] === '=' ? undefined : lookup[padded[i + 3]];

    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 !== undefined) bytes.push(((c2! & 0x03) << 6) | c3);
  }
  return new Uint8Array(bytes);
}
