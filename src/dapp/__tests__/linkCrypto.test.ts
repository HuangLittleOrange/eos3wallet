// 拿 anchor-link 协议仓库(greymass/anchor-link)公开的 test/aes.ts 测试向量核对
// 咱们自己这份独立实现是否字节级对得上——不是抄它的代码,是抄它公开发布的
// 输入/输出这组数据,用来验证咱们的算法和它协议文档描述的完全一致。
// 来源: https://github.com/greymass/anchor-link/blob/master/test/aes.ts
import { PrivateKey, UInt64 } from '@wharfkit/antelope';
import { sealMessage, unsealMessage, sealedMessageToWire, sealedMessageFromWire, UnsealError } from '../linkCrypto';

const KEY1_WIF = '5KGNiwTYdDWVBc9RCC28hsi7tqHGUsikn9Gs8Yii93fXbkYzxGi';
const KEY2_WIF = '5Kik3tbLSn24ScHFsj6GwLkgd1H4Wecxkzt1VX7PBBRDQUCdGFa';
const MESSAGE = 'The hovercraft is full of eels';
const EXPECTED_CIPHERTEXT_HEX =
  'a26b34e0fe70e2d624da9fddf3ba574c5b827d729d0edc172641f44ea3739ab0';
const EXPECTED_CHECKSUM = 2660735416;

describe('sealMessage / unsealMessage', () => {
  it('对官方协议仓库公开的测试向量,密文和校验和字节级一致', () => {
    const key1 = PrivateKey.from(KEY1_WIF);
    const key2 = PrivateKey.from(KEY2_WIF);
    const sealed = sealMessage(MESSAGE, key1, key2.toPublic(), UInt64.from(42));

    expect(sealed.ciphertext.hexString).toBe(EXPECTED_CIPHERTEXT_HEX);
    expect(sealed.checksum).toBe(EXPECTED_CHECKSUM);
  });

  it('对方能用自己的私钥解开,拿回原文', () => {
    const key1 = PrivateKey.from(KEY1_WIF);
    const key2 = PrivateKey.from(KEY2_WIF);
    const sealed = sealMessage(MESSAGE, key1, key2.toPublic());
    expect(unsealMessage(sealed, key2)).toBe(MESSAGE);
  });

  it('不传 nonce 时每次随机——同一条消息连续封两次,密文不一样', () => {
    const key1 = PrivateKey.from(KEY1_WIF);
    const key2 = PrivateKey.from(KEY2_WIF);
    const a = sealMessage(MESSAGE, key1, key2.toPublic());
    const b = sealMessage(MESSAGE, key1, key2.toPublic());
    expect(a.nonce.toString()).not.toBe(b.nonce.toString());
    expect(a.ciphertext.hexString).not.toBe(b.ciphertext.hexString);
  });

  it('拿第三把不相关的私钥去解,校验和对不上,抛 UnsealError', () => {
    const key1 = PrivateKey.from(KEY1_WIF);
    const key2 = PrivateKey.from(KEY2_WIF);
    const stranger = PrivateKey.generate('K1');
    const sealed = sealMessage(MESSAGE, key1, key2.toPublic());
    expect(() => unsealMessage(sealed, stranger)).toThrow(UnsealError);
  });

  it('过一遍线上二进制格式(toWire/fromWire)还能正常解开', () => {
    const key1 = PrivateKey.from(KEY1_WIF);
    const key2 = PrivateKey.from(KEY2_WIF);
    const sealed = sealMessage(MESSAGE, key1, key2.toPublic());
    const wire = sealedMessageToWire(sealed);
    const roundTripped = sealedMessageFromWire(wire);
    expect(roundTripped.nonce.toString()).toBe(sealed.nonce.toString());
    expect(unsealMessage(roundTripped, key2)).toBe(MESSAGE);
  });
});
