// wharfkit Session 的 passkey 签名插件 —— 结构上照抄 @wharfkit/wallet-plugin-privatekey,
// 只是把"用本机私钥对摘要签名"换成"发起一次系统 passkey 认证,把结果拼成 WA 签名"。
import {
  AbstractWalletPlugin,
  cancelable,
  Cancelable,
  Checksum256,
  LoginContext,
  Transaction,
  WalletPluginConfig,
  WalletPluginLoginResponse,
  WalletPluginMetadata,
  WalletPluginSignResponse,
} from '@wharfkit/session';
import type { ResolvedSigningRequest, TransactContext } from '@wharfkit/session';

import { signDigestWithPasskey } from '../passkey/webauthnSigning';

export class WalletPluginPasskey extends AbstractWalletPlugin {
  id = 'wallet-plugin-passkey';
  config: WalletPluginConfig = { requiresChainSelect: true, requiresPermissionSelect: true };
  metadata: WalletPluginMetadata;

  private credentialIdHex: string;
  private chainPublicKey: string;

  constructor(opts: { credentialIdHex: string; chainPublicKey: string }) {
    super();
    this.credentialIdHex = opts.credentialIdHex;
    this.chainPublicKey = opts.chainPublicKey;
    this.metadata = WalletPluginMetadata.from({
      name: 'Passkey Signer',
      description: '用系统 Passkey(通行密钥)签名,私钥从不离开安全硬件。',
      publicKey: opts.chainPublicKey,
    });
  }

  login(context: LoginContext): Cancelable<WalletPluginLoginResponse> {
    const chain = context.chain ? context.chain.id : context.chains[0].id;
    return cancelable(
      new Promise((resolve, reject) => {
        if (!context.permissionLevel) {
          return reject(new Error('WalletPluginPasskey 不支持不带 permissionLevel 的 login()'));
        }
        resolve({ chain, permissionLevel: context.permissionLevel });
      })
    );
  }

  sign(resolved: ResolvedSigningRequest, context: TransactContext): Cancelable<WalletPluginSignResponse> {
    return cancelable(
      (async () => {
        const transaction = Transaction.from(resolved.transaction);
        const digest = transaction.signingDigest(Checksum256.from(context.chain.id));
        const signature = await signDigestWithPasskey({
          digest: digest.array,
          chainPublicKey: this.chainPublicKey,
          credentialIdHex: this.credentialIdHex,
        });
        return { signatures: [signature] };
      })()
    );
  }
}
