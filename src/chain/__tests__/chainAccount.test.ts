jest.mock('../../i18n', () => ({
  t: (key: string) => key,
}));

import { pickChainAccount } from '../chainAccount';
import type { StoredWallet } from '../../crypto/vault';

const wallet = (over: Partial<StoredWallet> & { id: string; account: string }): StoredWallet => ({
  publicKey: 'EOS_PUB',
  createdAt: 1,
  source: 'privatekey',
  ...over,
});

describe('pickChainAccount(切链时落到哪个账户)', () => {
  // 这一条就是「切到测试网,主网账户被带过去了」那个 bug 的回归护栏:
  // 目标链上没有任何记录时,绝不能沿用当前这条链正在看的账户
  it('目标链没用过、也没有钱包时返回空账户', () => {
    const picked = pickChainAccount('jungle4', undefined, [
      wallet({ id: 'w1', account: 'btc.r2m', chainId: 'vaulta' }),
    ]);
    expect(picked).toEqual({ account: '', walletId: undefined });
    expect(picked.account).not.toBe('btc.r2m');
  });

  it('目标链上次用过就原样恢复(纯观察的账户名也算)', () => {
    const picked = pickChainAccount('jungle4', { account: 'watchme.j4' }, []);
    expect(picked).toEqual({ account: 'watchme.j4', walletId: undefined });
  });

  it('恢复时带上上次那把钥匙', () => {
    const w = wallet({ id: 'w2', account: 'mine.j4', chainId: 'jungle4' });
    expect(pickChainAccount('jungle4', { account: 'mine.j4', walletId: 'w2' }, [w])).toEqual({
      account: 'mine.j4',
      walletId: 'w2',
    });
  });

  it('上次钱包已被删掉时返回空账户,不自动转成观察钱包', () => {
    expect(pickChainAccount('jungle4', { account: 'mine.j4', walletId: 'gone' }, [])).toEqual({
      account: '',
      walletId: undefined,
    });
  });

  it('没用过但本机存着这条链的钱包时,落到最近添加的那个', () => {
    const picked = pickChainAccount('jungle4', undefined, [
      wallet({ id: 'old', account: 'old.j4', chainId: 'jungle4', createdAt: 100 }),
      wallet({ id: 'new', account: 'new.j4', chainId: 'jungle4', createdAt: 200 }),
      wallet({ id: 'main', account: 'btc.r2m', chainId: 'vaulta', createdAt: 300 }),
    ]);
    expect(picked).toEqual({ account: 'new.j4', walletId: 'new' });
  });

  it('缺 chainId 的旧钱包按主网算,不会被算进测试网', () => {
    const legacy = wallet({ id: 'legacy', account: 'legacy.acc', createdAt: 100 });
    expect(pickChainAccount('jungle4', undefined, [legacy]).account).toBe('');
    expect(pickChainAccount('vaulta', undefined, [legacy])).toEqual({
      account: 'legacy.acc',
      walletId: 'legacy',
    });
  });

  it.each([['vaulta', 'bitfinexdep1'], ['jungle4', 'eosio']] as const)(
    '忽略 %s 的旧默认账户会话', (chain, account) => {
      expect(pickChainAccount(chain, { account }, []).account).toBe('');
      expect(pickChainAccount(chain, { account, hasAccount: false }, []).account).toBe('');
    }
  );

  it('节点设置保存的无账户会话不算观察钱包', () => {
    expect(pickChainAccount('vaulta', { account: 'watchme', hasAccount: false }, []).account).toBe('');
  });

  it('主动导入与旧默认账户同名的观察钱包仍可恢复', () => {
    expect(pickChainAccount('vaulta', { account: 'bitfinexdep1', hasAccount: true }, [])).toEqual({
      account: 'bitfinexdep1', walletId: undefined,
    });
  });

  it('旧默认会话不会覆盖已导入的钱包', () => {
    const saved = wallet({ id: 'mine', account: 'myaccount', chainId: 'vaulta' });
    expect(pickChainAccount('vaulta', { account: 'bitfinexdep1', hasAccount: false }, [saved])).toEqual({
      account: 'myaccount', walletId: 'mine',
    });
  });

  it('删除当前钱包后选择同链剩余钱包', () => {
    const remaining = wallet({ id: 'other', account: 'other', chainId: 'vaulta' });
    expect(pickChainAccount('vaulta', { account: 'deleted', walletId: 'gone', hasAccount: true }, [remaining])).toEqual({
      account: 'other', walletId: 'other',
    });
  });

  it('同账户的另一把钥匙仍在时继续使用该钱包', () => {
    const remaining = wallet({ id: 'otherkey', account: 'mine', chainId: 'vaulta' });
    expect(pickChainAccount('vaulta', { account: 'mine', walletId: 'gone' }, [remaining])).toEqual({
      account: 'mine', walletId: 'otherkey',
    });
  });
});
