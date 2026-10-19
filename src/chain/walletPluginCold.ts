import { AbstractWalletPlugin, cancelable, WalletPluginMetadata } from '@wharfkit/session';
import type { LoginContext, ResolvedSigningRequest, TransactContext } from '@wharfkit/session';
import { requestColdSignature } from './coldSigning';
import type { ChainId } from './config';
import { t } from '../i18n';

export class WalletPluginCold extends AbstractWalletPlugin {
  id = 'wallet-plugin-cold';
  config = { requiresChainSelect: true, requiresPermissionSelect: true };
  metadata = WalletPluginMetadata.from({ name: 'TokenPocket Cold Wallet' });
  constructor(private chainSlug: ChainId, private actor: string, private isCurrent?: () => boolean) { super(); }
  login(context: LoginContext) {
    return cancelable(Promise.resolve({ chain: context.chain!.id, permissionLevel: context.permissionLevel! }));
  }
  sign(resolved: ResolvedSigningRequest, context: TransactContext) {
    return cancelable((async () => {
      if (String(resolved.signer.actor) !== this.actor) throw new Error(t('dappBrowser.requestChanged'));
      return { signatures: [await requestColdSignature({ transaction: resolved.transaction,
        chainId: String(context.chain.id), chainSlug: this.chainSlug, actor: this.actor,
        permission: String(resolved.signer.permission), isCurrent: this.isCurrent })] };
    })());
  }
}
