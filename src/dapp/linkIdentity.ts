// 本机在 Anchor Link 协议里的"身份"——一对长期持有的接收密钥 + 一条常驻
// 接收频道地址,生成一次之后就固定下来,不随每次登录/每次签名变。
//
// 这把 receive key 不是控制资产的密钥,丢了/换了顶多是要求所有已经建立
// 会话的 dApp 重新扫码登录一次,不涉及资金安全,所以：
//   - 不套主密码那层 AES 加密(vault.ts 那套「密码派生密钥」是给控制资产的
//     私钥用的,这里没必要,平时也不会有机会问用户要密码)
//   - 但还是存进 SecureStore(Android Keystore / iOS Keychain),不是明文
//     散落在 AsyncStorage 里——虽然丢了不影响资产,泄露出去还是能让人冒充
//     本机去接 dApp 推送来的签名请求,不是完全无所谓的东西。
import 'react-native-get-random-values';

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { Bytes, KeyType, PrivateKey, PublicKey } from '@wharfkit/antelope';

import { BRAND_NAME } from '../theme';
import { t } from '../i18n';

const PRIVATE_KEY_STORE_KEY = 'aurora.link.receiveKey';
const CHANNEL_ID_STORE_KEY = 'aurora.link.channelId';

/**
 * 默认的 channel 转发服务——Anchor Link 生态默认用的那个(anchor-link 库
 * 的 LinkOptions.defaults.service),不是我们自己搭的。真机上要和 Anchor
 * App、各家 dApp 的 anchor-link 前端互通,就得走同一个转发服务,不能自己
 * 随便挑一个只有我们自己认的地址。
 */
export const LINK_FORWARDER = 'https://cb.anchor.link';

export type LinkIdentity = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  /** 本机常驻接收频道——dApp 建立会话后,后续签名请求会一直推到这条地址 */
  channelUrl: string;
};

/** 生成一个 UUID v4 字符串——只是给 channel 地址当路径段用,不接第三方 uuid 包,
 *  16 字节随机数按 RFC4122 的版本/变体位改两个半字节就够了。用 polyfill 好的
 *  crypto.getRandomValues 现取,不走 wharfkit 的 Bytes.random()——理由见下面
 *  randomReceiveKey() 那段注释,这里是同一个坑。 */
function randomUuidV4(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // 版本 4
  b[8] = (b[8] & 0x3f) | 0x80; // 变体 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 生成一把新的接收私钥——不用 antelope 自带的 PrivateKey.generate(),它底层走
 * elliptic/brorand 的 curve.genKeyPair() 取随机数,brorand 在这套 RN/Hermes
 * 环境里探测不到 self.crypto.getRandomValues,会掉进"老古董浏览器"分支直接
 * throw('Not implemented yet')——crypto/keys.ts 的 generateKey() 已经踩过
 * 这个坑,这里是同一个问题,抄它的解法:自己用 polyfill 好的
 * crypto.getRandomValues 取 32 字节随机数,直接拼私钥对象,不经过 elliptic
 * 的随机数这一步(toPublic() 之类的标量乘法是确定性的,不会碰到 brorand)。
 */
function randomReceiveKey(): PrivateKey {
  for (let i = 0; i < 8; i++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    if (bytes.every((b) => b === 0)) continue;
    try {
      return new PrivateKey(KeyType.K1, Bytes.from(bytes));
    } catch {
      // 极小概率不是合法的 secp256k1 标量,重新取一次
    }
  }
  throw new Error(t('keysError.derivationFailed'));
}

/** 给 dApp 那边"已连接的钱包"列表看的展示名——参考 TP/Anchor,带上机型,
 *  方便用户在多台设备上都连过同一个 dApp 时分清是哪一台 */
export function linkDeviceName(): string {
  const c = (Platform as any).constants ?? {};
  const model: string | undefined = Platform.OS === 'android' ? c.Model : undefined;
  return model ? `${BRAND_NAME} (${model})` : BRAND_NAME;
}

let cached: LinkIdentity | null = null;

/** 本机的接收身份——第一次用到时才生成并落盘,之后每次都是同一份 */
export async function getLinkIdentity(): Promise<LinkIdentity> {
  if (cached) return cached;

  let privateKeyWif = await SecureStore.getItemAsync(PRIVATE_KEY_STORE_KEY).catch(() => null);
  let channelId = await SecureStore.getItemAsync(CHANNEL_ID_STORE_KEY).catch(() => null);

  if (!privateKeyWif || !channelId) {
    privateKeyWif = randomReceiveKey().toWif();
    channelId = randomUuidV4();
    await SecureStore.setItemAsync(PRIVATE_KEY_STORE_KEY, privateKeyWif, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(CHANNEL_ID_STORE_KEY, channelId);
  }

  const privateKey = PrivateKey.from(privateKeyWif);
  cached = {
    privateKey,
    publicKey: privateKey.toPublic(),
    channelUrl: `${LINK_FORWARDER}/${channelId}`,
  };
  return cached;
}
