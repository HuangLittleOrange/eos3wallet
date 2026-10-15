// i18n 会拉起 AsyncStorage/expo-localization 整棵依赖树,这里只需要 key 原样返回
jest.mock('../../i18n', () => ({
  t: (key: string) => key,
}));

import {
  accountNameError,
  assertAccountName,
  isValidAccountName,
  randomAccountName,
  resolveAuthPermissions,
} from '../account';

describe('isValidAccountName', () => {
  it('合法账户名', () => {
    expect(isValidAccountName('alice')).toBe(true);
    expect(isValidAccountName('binancecleos')).toBe(true);
    expect(isValidAccountName('a.b.c')).toBe(true);
    expect(isValidAccountName('  alice  ')).toBe(true); // 两端空白允许,trim 后校验
  });

  it('Name.from 会静默改写的输入必须判非法(6-9/0、大写)', () => {
    // 这正是往返校验存在的意义:多打一个数字就是把钱转给别人
    expect(isValidAccountName('account6')).toBe(false);
    expect(isValidAccountName('user9')).toBe(false);
    expect(isValidAccountName('ABCDEF')).toBe(false);
  });

  it('长度限制:最长 12 位', () => {
    expect(isValidAccountName('abcdefghijkl')).toBe(true); // 12 位
    expect(isValidAccountName('abcdefghijklm')).toBe(false); // 13 位
    expect(isValidAccountName('')).toBe(false);
  });
});

describe('randomAccountName', () => {
  it('默认生成 12 位、且天然合法', () => {
    for (let i = 0; i < 20; i++) {
      const name = randomAccountName();
      expect(name).toHaveLength(12);
      expect(isValidAccountName(name)).toBe(true);
    }
  });
});

describe('accountNameError', () => {
  it('空串不报错(还没输入不该红字)', () => {
    expect(accountNameError('')).toBeNull();
  });
  it('合法名不报错', () => {
    expect(accountNameError('alice')).toBeNull();
  });
  it('非法输入给出具体原因(mock 后返回 key)', () => {
    expect(accountNameError('abcdefghijklm')).toBe('accountError.tooLong');
    expect(accountNameError('user9')).toBe('accountError.noDigits');
    expect(accountNameError('ABC')).toBe('accountError.noUppercase');
  });
});

describe('assertAccountName', () => {
  it('合法名原样返回(带 trim)', () => {
    expect(assertAccountName(' alice ')).toBe('alice');
  });
  it('非法名抛错', () => {
    expect(() => assertAccountName('user9')).toThrow();
  });
});

describe('resolveAuthPermissions', () => {
  const resources = {
    permissions: [
      { name: 'owner', keys: ['PUB_K1_owner'] },
      { name: 'active', keys: ['PUB_K1_active'] },
    ],
  };

  it('链上权限覆盖导入时保存的旧标识', () => {
    expect(
      resolveAuthPermissions({ account: 'alice', publicKey: 'PUB_K1_active', authPermissions: ['owner'] }, 'alice', resources)
    ).toEqual(['active']);
  });

  it('没有记录时按公钥反查链上权限', () => {
    expect(resolveAuthPermissions({ account: 'alice', publicKey: 'PUB_K1_active' }, 'alice', resources)).toEqual([
      'active',
    ]);
  });

  it('resources 属于别的账户时不瞎猜,返回空', () => {
    expect(resolveAuthPermissions({ account: 'bob', publicKey: 'PUB_K1_active' }, 'alice', resources)).toEqual([]);
  });

  it('无钱包返回空', () => {
    expect(resolveAuthPermissions(undefined, 'alice', resources)).toEqual([]);
  });
});


describe('live permission badge regressions', () => {
  const wallet = { account: 'alice', publicKey: 'PUB_K1_old', authPermissions: ['active', 'owner'] };
  it('revoked keys show an empty list even when imported with active and owner', () => {
    expect(resolveAuthPermissions(wallet, 'alice', { permissions: [{ name: 'active', keys: ['PUB_K1_new'] }] })).toEqual([]);
  });
  it('unloaded, failed, or wrong-account reads never fall back to saved metadata', () => {
    expect(resolveAuthPermissions(wallet, 'alice', null)).toEqual([]);
    expect(resolveAuthPermissions(wallet, 'bob', { permissions: [] })).toEqual([]);
    expect(resolveAuthPermissions(wallet, 'alice', { account: 'bob', permissions: [{ name: 'active', keys: [wallet.publicKey] }] })).toEqual([]);
  });
  it('matches legacy EOS and modern PUB_K1 encodings of the same key', () => {
    expect(resolveAuthPermissions({ account: 'alice', publicKey: 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV' }, 'alice', {
      permissions: [{ name: 'owner', keys: ['PUB_K1_6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5BoDq63'] }]
    })).toEqual(['owner']);
  });
});
