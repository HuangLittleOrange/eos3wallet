import { Serializer, Signature, Transaction } from '@wharfkit/antelope';
import { CHAINS, type ChainId } from './config';
import { assertVisibleTransaction } from './transactionSafety';
import { readDirectSigningKeys } from './importAccount';
import { tokenPocketResult, tokenPocketSigningQr, verifyColdResult, type ColdTransaction } from './coldSigningProtocol';
import { t } from '../i18n';

type Options = ColdTransaction & { chainSlug: ChainId; isCurrent?: () => boolean };
export type ColdSigningState = {
  id: number; actor: string; permission: string; chainSlug: ChainId; expiration: number;
  loading: boolean; validating: boolean;
  keys: string[]; publicKey: string; qr: string; error: string | null;
};
type Pending = { options: Options; state: ColdSigningState; controller: AbortController;
  resolve: (signature: Signature) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setInterval> };
let pending: Pending | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
export const subscribeColdSigning = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const coldSigningSnapshot = () => pending?.state ?? null;
const emit = () => listeners.forEach(listener => listener());
function update(p: Pending, fields: Partial<ColdSigningState>) {
  if (pending !== p) return;
  p.state = { ...p.state, ...fields }; emit();
}
function current(p: Pending): boolean {
  return pending === p && !p.controller.signal.aborted && p.options.isCurrent?.() !== false && p.state.expiration > Date.now();
}
function finish(p: Pending, error?: Error, signature?: Signature) {
  if (pending !== p) return;
  pending = null; clearInterval(p.timer); p.controller.abort(); emit();
  if (error) p.reject(error); else p.resolve(signature!);
}
export function cancelColdSigning() {
  if (pending) finish(pending, new Error(t('coldSigning.cancelled')));
}

export function requestColdSignature(options: Options): Promise<Signature> {
  if (pending) return Promise.reject(new Error(t('coldSigning.busy')));
  try {
    if (CHAINS[options.chainSlug].chainIdHash !== options.chainId || options.isCurrent?.() === false) throw new Error(t('dappBrowser.requestChanged'));
    // Snapshot all signed bytes before opening any asynchronous UI or RPC read.
    const transaction = Serializer.decode({ data: Serializer.encode({ object: options.transaction }), type: Transaction });
    assertVisibleTransaction(transaction);
    const mine = transaction.actions.flatMap(a => a.authorization).filter(a => String(a.actor) === options.actor);
    if (!mine.length || mine.some(a => String(a.permission) !== options.permission)) throw new Error(t('coldSigning.unsupported'));
    options = { ...options, transaction };
  } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const p: Pending = { options, resolve, reject, controller: new AbortController(),
      state: { id: ++sequence, actor: options.actor, permission: options.permission, chainSlug: options.chainSlug,
        expiration: options.transaction.expiration.toMilliseconds(), loading: true, validating: false,
        keys: [], publicKey: '', qr: '', error: null }, timer: undefined! };
    pending = p;
    p.timer = setInterval(() => {
      if (!current(p)) finish(p, new Error(t(p.state.expiration <= Date.now() ? 'coldSigning.expired' : 'dappBrowser.requestChanged')));
    }, 250);
    emit();
    void readDirectSigningKeys({ chainId: options.chainSlug, account: options.actor, permission: options.permission,
      signal: p.controller.signal }).then(keys => {
      if (!current(p)) return;
      if (!keys.length) throw new Error(t('coldSigning.unsupported'));
      update(p, { keys, publicKey: keys[0], loading: false, qr: tokenPocketSigningQr(options, keys[0]) });
    }).catch(error => finish(p, error));
  });
}

export function chooseColdSigningKey(key: string): void {
  const p = pending;
  if (!p || !current(p) || p.state.loading || p.state.validating) return;
  if (!p.state.keys.includes(key)) return;
  update(p, { publicKey: key, error: null, qr: tokenPocketSigningQr(p.options, key) });
}

export async function acceptColdSignature(raw: string, id: number): Promise<boolean> {
  const p = pending;
  if (!p || p.state.id !== id || !current(p) || p.state.loading || p.state.validating) return false;
  update(p, { validating: true, error: null });
  try {
    if (raw.length > 65_536) throw new Error(t('coldSigning.invalidResponse'));
    let payload: Record<string, any>;
    try { payload = tokenPocketResult(raw); }
    catch { throw new Error(t('coldSigning.invalidResponse')); }
    const signature = verifyColdResult(p.options, p.state.publicKey, payload);
    // A permission may have been revoked while the user was scanning. Re-read it.
    const keys = await readDirectSigningKeys({ chainId: p.options.chainSlug, account: p.options.actor,
      permission: p.options.permission, signal: p.controller.signal });
    if (!current(p)) return false;
    if (!keys.includes(p.state.publicKey)) throw new Error(t('coldSigning.keyChanged'));
    assertVisibleTransaction(p.options.transaction);
    finish(p, undefined, signature);
    return true;
  } catch (error: any) {
    if (current(p)) update(p, { validating: false, error: error?.message ?? t('coldSigning.invalidResponse') });
    return false;
  }
}
