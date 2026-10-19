import { Name, PublicKey } from '@wharfkit/antelope';
import { CHAINS, type ChainId } from './config';
import { isValidAccountName } from './account';
import { readTrustedRpc } from './trustedRpc';
import { t } from '../i18n';

type Permission = {
  name: string; parent: string; threshold: number;
  keys: { key: string; weight: number }[];
  accounts: { actor: string; permission: string; weight: number }[];
  waits: { wait_sec: number; weight: number }[];
};
const failure = () => new Error(t('importSecret.accountVerificationFailed'));
const mismatch = () => new Error(t('importSecret.accountKeyMismatch'));
function check(value: unknown): asserts value { if (!value) throw failure(); }
function name(value: unknown): string {
  check(typeof value === 'string' && /^[a-z1-5.]{1,13}$/.test(value) && String(Name.from(value)) === value);
  return value;
}
function integer(value: unknown, max: number, min = 1): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const keys = items.map(key);
  check(new Set(keys).size === keys.length);
  return items.sort((a, b) => key(a).localeCompare(key(b)));
}
function permissions(reply: any, account: string): Permission[] {
  check(reply?.account_name === account && Array.isArray(reply.permissions) && reply.permissions.length > 0);
  const result: Permission[] = reply.permissions.map((entry: any) => {
    const auth = entry?.required_auth;
    check(auth && Array.isArray(auth.keys) && Array.isArray(auth.accounts) && Array.isArray(auth.waits));
    return {
      name: name(entry.perm_name), parent: entry.parent === '' ? '' : name(entry.parent),
      threshold: integer(auth.threshold, 0xffffffff),
      keys: unique<Permission['keys'][number]>(auth.keys.map((k: any) => ({ key: String(PublicKey.from(k.key)), weight: integer(k.weight, 0xffff) })), k => k.key),
      accounts: unique<Permission['accounts'][number]>(auth.accounts.map((a: any) => ({ actor: name(a.permission.actor),
        permission: name(a.permission.permission), weight: integer(a.weight, 0xffff) })), a => `${a.actor}@${a.permission}`),
      waits: unique<Permission['waits'][number]>(auth.waits.map((w: any) => ({ wait_sec: integer(w.wait_sec, 0xffffffff, 0), weight: integer(w.weight, 0xffff) })), w => String(w.wait_sec)),
    };
  });
  unique(result, p => p.name);
  check(result.some(p => p.name === 'owner' && p.parent === '') &&
    result.some(p => p.name === 'active' && p.parent === 'owner'));
  for (const permission of result) {
    const seen = new Set<string>();
    let current: Permission | undefined = permission;
    while (current) {
      check(!seen.has(current.name)); seen.add(current.name);
      if (!current.parent) { check(current.name === 'owner'); break; }
      const parent = result.find(p => p.name === current!.parent);
      check(parent); current = parent;
    }
  }
  return result;
}

async function verifiedPermissions(opts: { chainId: ChainId; account: string; signal?: AbortSignal }): Promise<Permission[]> {
  const chain = CHAINS[opts.chainId];
  check(chain && isValidAccountName(opts.account) && opts.account.trim() === opts.account);
  return readTrustedRpc(chain.chainIdHash, async read => {
    const result = permissions(await read('/v1/chain/get_account', { account_name: opts.account }), opts.account);
    return { key: JSON.stringify(result), value: result };
  }, failure, opts.signal);
}

/** External signing initially supports keys that alone satisfy the exact permission.
 * Read uncached, corroborated authority; a page or selected RPC cannot choose the key.
 */
export async function readDirectSigningKeys(opts: {
  chainId: ChainId; account: string; permission: string; signal?: AbortSignal;
}): Promise<string[]> {
  const authority = (await verifiedPermissions(opts)).find(p => p.name === opts.permission);
  return authority?.keys.filter(k => k.weight >= authority.threshold).map(k => k.key) ?? [];
}

/** A newly generated signup key must actually be able to operate the account.
 * Do not infer its permissions from the selected RPC or from an empty key match.
 * Re-read at both activation and final save; ordinary multisig import is unchanged.
 */
export async function verifyCreatedAccount(opts: {
  chainId: ChainId; account: string; publicKey: string; signal?: AbortSignal;
}): Promise<string[]> {
  const publicKey = String(PublicKey.from(opts.publicKey));
  const verified = await verifiedPermissions(opts);
  const controlled = verified.filter(p => p.keys.some(k => k.key === publicKey && k.weight >= p.threshold)).map(p => p.name);
  if (!controlled.some(p => p === 'active' || p === 'owner')) throw mismatch();
  // Preserve the default signing permission when the key also has custom roles.
  const rank = (name: string) => name === 'active' ? 0 : name === 'owner' ? 1 : 2;
  return controlled.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Discovery is only a list of candidates. Re-read uncached authority from the
 * built-in quorum immediately before storing a wallet. Keys are compared locally.
 * A positive weight establishes membership, not exclusive or single-key control:
 * partial multisig keys remain importable, as do parent/custom permissions.
 */
export async function verifyImportedAccount(opts: {
  chainId: ChainId; account: string; publicKey: string; permissions: string[]; signal?: AbortSignal;
  /** Device enrollment requires a direct key that alone meets the threshold. */
  requireDirectThreshold?: boolean;
}): Promise<void> {
  check(opts.permissions.length > 0);
  const publicKey = String(PublicKey.from(opts.publicKey));
  const requested = opts.permissions.map(name);
  const verified = await verifiedPermissions(opts);
  for (const selected of requested) {
    let permission = verified.find(p => p.name === selected);
    let member = false;
    while (permission) {
      if (permission.keys.some(k => k.key === publicKey && k.weight >= (opts.requireDirectThreshold ? permission!.threshold : 1))) {
        member = true; break;
      }
      if (opts.requireDirectThreshold) break;
      permission = verified.find(p => p.name === permission!.parent);
    }
    if (!member) throw mismatch();
  }
}
