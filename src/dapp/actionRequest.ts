import { Name } from '@wharfkit/antelope';
import type { ActionSpec } from '../chain/transact';

function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z1-5.]{1,13}$/.test(value) || String(Name.from(value)) !== value) {
    throw new Error('Invalid action or authorization name');
  }
  return value;
}

export function assertActionRequestChain(params: any, chainId: string): void {
  const candidates = [params?.chainId, params?.payload?.network?.chainId,
    params?.payload?.transaction?.chainId];
  if (candidates.some((value) => value != null && value !== '' &&
      (typeof value !== 'string' || value.toLowerCase() !== chainId.toLowerCase()))) {
    throw new Error('Transaction chain mismatch');
  }
}

/** This broadcast path uses one wallet permission for every action. Never silently
 * substitute it for a different actor or an ambiguous mixture of permissions.
 */
export function prepareActionRequest(raw: any, actor: string, defaultPermission: string): {
  actions: ActionSpec[]; permission: string;
} {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.length > 64) throw new Error('Invalid actions');
  const permissions = new Set<string>();
  const actions = list.map((a): ActionSpec => {
    if (!a || typeof a !== 'object') throw new Error('Invalid action');
    const data = a.data ?? a.args ?? {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Undecoded action data');
    const auths = a.authorization == null ? [] : Array.isArray(a.authorization) ? a.authorization : [a.authorization];
    if (auths.length > 1) throw new Error('Unsupported multiple authorizations');
    for (const auth of auths) {
      const requestedActor = auth?.actor ?? auth?.account ?? actor;
      if (name(requestedActor) !== actor) throw new Error('Authorization account mismatch');
      permissions.add(name(auth?.permission));
    }
    return { account: name(a.account ?? a.code), name: name(a.name ?? a.action),
      data: JSON.parse(JSON.stringify(data)) };
  });
  if (permissions.size > 1) throw new Error('Inconsistent transaction permissions');
  const permission = permissions.size ? [...permissions][0] : name(defaultPermission);
  for (const action of actions) action.authorization = [{ actor, permission }];
  return { actions, permission };
}
