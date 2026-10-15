import { PublicKey } from '@wharfkit/antelope';
import { fetchWithTimeout } from '../net/fetchRetry';
import { t } from '../i18n';

export type AuthorizationContext = { actor: string; permission: string };
export type AuthorizationDiagnosis = 'unavailable-key' | 'insufficient-weight' | 'unknown';

/** Inspect only RPC error fields, including structured/JSON-wrapped proxy errors. */
export function chainErrorText(error: unknown, depth = 0): string {
  if (error == null || depth > 8) return '';
  if (typeof error === 'string') {
    const text = error.slice(0, 16384);
    if (/^\s*[\[{]/.test(text)) {
      try { return chainErrorText(JSON.parse(text), depth + 1); } catch { /* plain text */ }
    }
    return text.toLowerCase();
  }
  if (typeof error === 'number') return String(error);
  if (typeof error !== 'object') return '';
  if (Array.isArray(error)) return error.slice(0, 32).map(value => chainErrorText(value, depth + 1)).join(' ');
  const fields = error as Record<string, unknown>;
  return ['code', 'message', 'name', 'what', 'error', 'details', 'response', 'json', 'processed', 'except', 'cause', 'body', 'data']
    .map(key => chainErrorText(fields[key], depth + 1)).join(' ');
}

export function isAuthorizationFailure(error: unknown): boolean {
  if (error instanceof AuthorizationFailureError) return true;
  const text = chainErrorText(error);
  return /\b(309000[2-7]|3060001)\b/.test(text) ||
    /unsatisfied_authorization|missing_auth_exception|irrelevant_auth_exception|tx_irrelevant_sig|permission_query_exception|invalid_permission/.test(text) ||
    text.includes('missing required authority') || text.includes('irrelevant signature') || text.includes('irrelevant keys provided') ||
    text.includes('provided keys, permissions, and delays do not satisfy') ||
    (text.includes('transaction declares authority') && text.includes('does not have signatures'));
}

export class AuthorizationFailureError extends Error {
  constructor(readonly context?: AuthorizationContext, readonly diagnosis: AuthorizationDiagnosis = 'unknown') {
    super(context ? t(diagnosis === 'unavailable-key' ? 'chainError.keyNotAuthorized' :
      diagnosis === 'insufficient-weight' ? 'chainError.signatureWeight' : 'chainError.authorizationPermission',
    { account: context.actor, permission: context.permission }) : t('chainError.authorization'));
    this.name = 'AuthorizationFailureError';
  }
}

/** Conservative explanation of an already failed operation; never an authorization decision. */
export function diagnoseAuthorization(account: any, context: AuthorizationContext, publicKey: string): AuthorizationDiagnosis {
  if (account?.account_name !== context.actor || !Array.isArray(account.permissions)) return 'unknown';
  let publicKeyValue: PublicKey;
  try { publicKeyValue = PublicKey.from(publicKey); } catch { return 'unknown'; }
  let name = context.permission;
  let hasKey = false;
  let complex = false;
  const visited = new Set<string>();
  while (name) {
    if (visited.has(name) || visited.size >= 16) return 'unknown';
    visited.add(name);
    const permission = account.permissions.find((value: any) => value.perm_name === name);
    if (!permission) return visited.size === 1 ? 'unavailable-key' : 'unknown';
    const auth = permission.required_auth;
    if (!auth || !Number.isSafeInteger(auth.threshold) || auth.threshold < 1 ||
      !Array.isArray(auth.keys) || !Array.isArray(auth.accounts) || !Array.isArray(auth.waits) ||
      typeof permission.parent !== 'string') return 'unknown';
    complex ||= auth.accounts.length > 0 || auth.waits.length > 0;
    let weight = 0;
    for (const entry of auth.keys) {
      if (!Number.isSafeInteger(entry.weight) || entry.weight < 0) return 'unknown';
      try { if (publicKeyValue.equals(PublicKey.from(entry.key))) weight += entry.weight; }
      catch { return 'unknown'; }
    }
    if (visited.size > 1 && weight > 0) return 'unknown';
    hasKey ||= weight > 0;
    // A parent (including owner) may satisfy a child permission. Do not call
    // such a key revoked just because it is absent from the active keys array.
    if (weight >= auth.threshold) return 'unknown';
    name = permission.parent;
  }
  if (complex) return 'unknown'; // Delegated authorities/delays require the node's full evaluator.
  return hasKey ? 'insufficient-weight' : 'unavailable-key';
}

/** Only called after a permission failure. No signing, simulation, retry or broadcast. */
export async function explainAuthorizationFailure(error: AuthorizationFailureError, opts: {
  nodeUrl: string; chainId: string; publicKey?: string; isCurrent?: () => boolean;
}): Promise<AuthorizationFailureError> {
  if (!error.context || !opts.publicKey || (opts.isCurrent && !opts.isCurrent())) return error;
  try {
    const read = async (path: string, body: unknown) => {
      const response = await fetchWithTimeout(`${opts.nodeUrl.replace(/\/$/, '')}/v1/chain/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, 3000);
      if (!response.ok) throw new Error('RPC unavailable');
      return response.json();
    };
    const [info, account] = await Promise.all([read('get_info', {}), read('get_account', { account_name: error.context.actor })]);
    if (info.chain_id !== opts.chainId || (opts.isCurrent && !opts.isCurrent())) return error;
    return new AuthorizationFailureError(error.context, diagnoseAuthorization(account, error.context, opts.publicKey));
  } catch { return error; } // Query failure cannot prove that a key was revoked.
}
