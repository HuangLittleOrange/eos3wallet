// ConfirmTxSheet 三条确认路径(密码 / 生物识别 / passkey)对应的 Signer 工厂。
//
// 之前每个要签名的页面都手抄一遍"解 vault 拿私钥包成 Signer"的三件套,
// 8 处几乎逐字相同——签名入口这种地方最不该各写各的:哪天要统一调整
// (比如给解密加节流、错误归一),漏改任何一处都是安全隐患。收拢到这里,
// 页面只写 `broadcast(passwordSigner(wallet, password))` 一行。
//
// 返回的是"获取器"(() => Promise<Signer>)而不是 Signer 本身——私钥只在
// 调用方真正要签名的那一刻才从 vault 解出来,用完即弃,不在组件状态里过手。
import { loadSecret, loadSecretWithBiometric, type StoredWallet } from '../crypto/vault';
import type { Signer } from './transact';
import { PrivateKey, PublicKey } from '@wharfkit/antelope';
import { t } from '../i18n';

export type SignerGetter = () => Promise<Signer>;

function localSigner(wallet: StoredWallet, privateKey: string): Signer {
  try {
    if (!PrivateKey.from(privateKey).toPublic().equals(PublicKey.from(wallet.publicKey))) throw new Error();
  } catch {
    // Never return raw key-parser errors: third-party callers must not see key material.
    throw new Error(t('walletDetail.unlockFailed'));
  }
  return { kind: 'privatekey', privateKey };
}

/** 用户输入的密码解 vault 取私钥 */
export function passwordSigner(wallet: StoredWallet, password: string): SignerGetter {
  return async () => localSigner(wallet, await loadSecret(wallet.id, password));
}

/** 生物识别解锁(系统认证弹窗由 SecureStore 触发,见 vault.ts) */
export function biometricSigner(wallet: StoredWallet): SignerGetter {
  return async () => localSigner(wallet, await loadSecretWithBiometric(wallet.id));
}

/** passkey 钱包:本机不存密钥,签名时现场发起一次系统 passkey 认证 */
export function passkeySigner(wallet: StoredWallet): SignerGetter {
  return async () => ({
    kind: 'passkey',
    credentialIdHex: wallet.credentialIdHex!,
    chainPublicKey: wallet.publicKey,
  });
}
