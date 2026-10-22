jest.mock('../../i18n', () => ({ t: (key: string) => key }));
jest.mock('../../passkey/webauthnSigning', () => ({ signDigestWithPasskey: jest.fn() }));
jest.mock('../trustedRpc', () => ({ readTrustedRpc: jest.fn() }));

import { readTrustedRpc } from '../trustedRpc';
import { verifyManagedApp, type AuthorizedApp } from '../permissions';

const app: AuthorizedApp = {
  permission: 'demo',
  parent: 'active',
  managedByPayLimit: true,
  active: true,
  botIdHash: 'ab'.repeat(32),
  assets: [],
  threshold: 1,
  keys: 1,
  accounts: 0,
  linkedActions: 0,
};

const mockRead = readTrustedRpc as jest.MockedFunction<typeof readTrustedRpc>;
const verify = (value: AuthorizedApp = app) => verifyManagedApp({ chainId: 'vaulta', account: 'alice', app: value });

function reply(opts: { permissions?: any[]; rows?: any[]; more?: boolean } = {}) {
  const permissions = opts.permissions ?? [{ perm_name: 'demo', parent: 'active' }];
  const rows = opts.rows ?? [{ id: 7, bot_id_hash: 'ab'.repeat(32), owner: 'alice', permission: 'demo' }];
  mockRead.mockImplementation((async (_chain: string, query: any) =>
    (await query(async (path: string) =>
      path.endsWith('get_account') ? { permissions } : { rows, more: opts.more ?? false })).value) as any);
}

test('accepts a permission/bot pair that exists on chain', async () => {
  reply();
  await expect(verify()).resolves.toBeUndefined();
});

test('rejects when the bot row points at another permission', async () => {
  reply({ rows: [{ id: 7, bot_id_hash: 'ab'.repeat(32), owner: 'alice', permission: 'other' }] });
  await expect(verify()).rejects.toThrow('permission.appNotOnChain');
});

test('rejects when the permission is missing on chain', async () => {
  reply({ permissions: [{ perm_name: 'other', parent: 'active' }] });
  await expect(verify()).rejects.toThrow('permission.appNotOnChain');
});

test('rejects a system permission before querying', async () => {
  reply();
  await expect(verify({ ...app, permission: 'active' })).rejects.toThrow('permission.appNotOnChain');
});

test('rejects a truncated table response instead of guessing', async () => {
  reply({ rows: [], more: true });
  await expect(verify()).rejects.toThrow('permission.appNotOnChain');
});

test('rejects a malformed bot id', async () => {
  reply();
  await expect(verify({ ...app, botIdHash: 'not-a-hash' })).rejects.toThrow('permission.appNotOnChain');
});
