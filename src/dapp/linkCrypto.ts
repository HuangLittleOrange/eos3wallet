// Anchor Link 协议(EEP-7 持久会话)用到的"密封消息"加解密。
//
// 协议原文: https://github.com/greymass/anchor-link/blob/master/protocol.md
// 摘要(dApp <-> 钱包双方各自持有一对密钥,共享密钥用 ECDH 派生):
//   1. shared = ECDH(自己的私钥, 对方的公钥)                      —— SHA-512,64 字节,双方算出来的完全一样
//   2. material = SHA-512(nonce 的 8 字节小端序列化 + shared)     —— 每条消息的 nonce 不同,派生结果跟着变
//   3. AES 密钥 = material 前 32 字节,IV = material 接下来 16 字节
//   4. ciphertext = AES-256-CBC(明文, 密钥, IV)(PKCS7 补齐)
//   5. checksum = SHA-256(material) 的前 4 字节(小端读作 uint32)——校验和是对着
//      "这条消息实际派生出的 key+IV"算的,不是对着静态共享密钥,收到消息先比
//      这个,对不上直接判定密钥/nonce 有一处不对,不用白跑一次 AES 解密。
//
// 这里没有照抄官方 anchor-link 库的实现(那是它的版权代码),是照着协议文档 +
// 官方仓库 test/aes.ts 的公开测试向量,用本仓库已有的 @noble/hashes、
// @noble/ciphers、@wharfkit/antelope 独立重新实现的——见同目录测试文件,
// 拿协议仓库那组公开测试向量验证过字节级对得上。
import 'react-native-get-random-values';

import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { cbc } from '@noble/ciphers/aes.js';
import { ABI, Bytes, BytesType, Checksum512, PrivateKey, PublicKey, Serializer, UInt64 } from '@wharfkit/antelope';

import { t } from '../i18n';

export type SealedMessage = {
  /** 发送方公钥——收到消息的一方靠这个知道该用哪把私钥配对做 ECDH */
  from: PublicKey;
  nonce: UInt64;
  ciphertext: Bytes;
  /** uint32,小端读出 */
  checksum: number;
};

/**
 * SealedMessage 在 channel 上走的是链上那套二进制 ABI 编码(`sealed_message`
 * 结构体:public_key/uint64/bytes/uint32,字段顺序就是这个),**不是** JSON——
 * 这里曾经按 JSON 实现过一版,线上联调时发现收到的是二进制帧,解不开(见
 * 2026-09-10 debug session)。核对过官方仓库 src/link-types.ts 的
 * `SealedMessage` 结构体定义和 src/link-session.ts 里 `Serializer.encode(...)`
 * 直接把编码结果的字节当 fetch body 发出去这两处,确认线上格式就是裸 ABI 字节,
 * 换成这样用 `ABI.from({structs:[...]})` + `Serializer.encode/decode` 编解码
 * ——和 txIntentCheck.ts 核对代付交易时用的是同一套模式,不依赖装饰器语法。
 */
const sealedMessageAbi = ABI.from({
  structs: [
    {
      name: 'sealed_message',
      base: '',
      fields: [
        { name: 'from', type: 'public_key' },
        { name: 'nonce', type: 'uint64' },
        { name: 'ciphertext', type: 'bytes' },
        { name: 'checksum', type: 'uint32' },
      ],
    },
  ],
});

export function sealedMessageToWire(m: SealedMessage): Bytes {
  return Serializer.encode({
    object: { from: m.from, nonce: m.nonce, ciphertext: m.ciphertext, checksum: m.checksum },
    type: 'sealed_message',
    abi: sealedMessageAbi,
  });
}

export function sealedMessageFromWire(data: BytesType): SealedMessage {
  const raw: any = Serializer.decode({ data, type: 'sealed_message', abi: sealedMessageAbi });
  return {
    from: PublicKey.from(raw.from),
    nonce: UInt64.from(raw.nonce),
    ciphertext: Bytes.from(raw.ciphertext),
    checksum: Number(raw.checksum),
  };
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** UInt64 按 Antelope 的小端序列化成 8 字节——协议里 nonce 就是这样喂进哈希的 */
function nonceBytes(nonce: UInt64): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(nonce.toString()), true);
  return b;
}

/**
 * 只取 48 位随机数,不用满 64 位——nonce 走 ABI 二进制编码,没有 JSON 数字
 * 精度那茬事,纯粹是安全边际:2^48 ≈ 281 万亿的碰撞空间,对"同一对密钥别
 * 短时间内重复用同一个 nonce"这个需求早就绰绰有余,没必要为了凑满 64 位
 * 多占 2 个字节。
 *
 * 用 polyfill 好的 crypto.getRandomValues 现取,不走 wharfkit 的
 * Bytes.random()——这套 RN/Hermes 环境里没验证过 Bytes.random() 内部走的
 * 是不是同一条安全的随机数路径,统一用这份已经在 crypto/keys.ts 里验证过
 * 能用的原语,不去猜。
 */
function randomNonce(): UInt64 {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  const v = new DataView(b.buffer, b.byteOffset, 6);
  const hi = v.getUint16(0, true);
  const lo = v.getUint32(2, true);
  return UInt64.from(BigInt(hi) * 4294967296n + BigInt(lo));
}

/** 这条消息实际用的 AES 密钥 + IV + 校验和——都是从同一份 material 里切出来的,
 *  material 本身随 nonce 变,同一对公私钥反复发消息不会重复用同一把 AES key/IV,
 *  校验和也跟着换,不是对着静态共享密钥算的。 */
function deriveMaterial(sharedSecret: Checksum512, nonce: UInt64): Uint8Array {
  return sha512(concatBytes(nonceBytes(nonce), sharedSecret.array));
}

function keyIvFromMaterial(material: Uint8Array): { key: Uint8Array; iv: Uint8Array } {
  return { key: material.slice(0, 32), iv: material.slice(32, 48) };
}

function checksumFromMaterial(material: Uint8Array): number {
  const h = sha256(material);
  return new DataView(h.buffer, h.byteOffset, 4).getUint32(0, true);
}

/**
 * 用自己的私钥 + 对方公钥封装一条消息——nonce 不传就随机生成一个
 * (每次调用生成新的一次性 nonce,同一对密钥反复发消息不会用同一把 AES key/IV)。
 */
export function sealMessage(
  message: string,
  privateKey: PrivateKey,
  publicKey: PublicKey,
  nonce?: UInt64
): SealedMessage {
  const n = nonce ?? randomNonce();
  const shared = privateKey.sharedSecret(publicKey);
  const material = deriveMaterial(shared, n);
  const { key, iv } = keyIvFromMaterial(material);
  const ciphertext = cbc(key, iv).encrypt(new TextEncoder().encode(message));
  return {
    from: privateKey.toPublic(),
    nonce: n,
    ciphertext: Bytes.from(ciphertext),
    checksum: checksumFromMaterial(material),
  };
}

/**
 * 密码错误(校验和对不上,或者 AES 解密/补齐失败)统一抛这个,调用方不用
 * 挨个判断到底是校验和没过还是 CBC 补齐炸了——两种情况都等价于"这条消息
 * 不是发给我的,或者对方用错了公钥"。
 */
export class UnsealError extends Error {
  constructor() {
    super(t('linkCrypto.unsealFailed'));
    this.name = 'UnsealError';
  }
}

/** 用自己的私钥解开对方封装过来的消息;校验和或 AES 解密失败统一抛 UnsealError */
export function unsealMessage(sealed: SealedMessage, privateKey: PrivateKey): string {
  const shared = privateKey.sharedSecret(sealed.from);
  const material = deriveMaterial(shared, sealed.nonce);
  if (checksumFromMaterial(material) !== sealed.checksum) throw new UnsealError();
  const { key, iv } = keyIvFromMaterial(material);
  try {
    const plain = cbc(key, iv).decrypt(sealed.ciphertext.array);
    return new TextDecoder().decode(plain);
  } catch {
    throw new UnsealError();
  }
}
