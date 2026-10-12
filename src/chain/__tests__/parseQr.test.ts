jest.mock('../../i18n', () => ({
  t: (key: string) => key,
}));
// esr.ts 依赖的 passkey 签名走原生模块,纯逻辑测试里用不到
jest.mock('../../passkey/webauthnSigning', () => ({
  signDigestWithPasskey: jest.fn(),
}));

import { parseQr } from '../parseQr';

describe('parseQr', () => {
  it('纯账户名', () => {
    expect(parseQr('binancecleos')).toEqual({ kind: 'account', account: 'binancecleos' });
    expect(parseQr('  alice  ')).toEqual({ kind: 'account', account: 'alice' });
  });

  it('eosio: URI 带金额与备注', () => {
    expect(parseQr('eosio:binancecleos?amount=1.0000&memo=905112')).toEqual({
      kind: 'account',
      account: 'binancecleos',
      amount: '1.0000',
      memo: '905112',
    });
  });

  it('eosio: URI 不带参数', () => {
    expect(parseQr('vaulta:alice')).toEqual({ kind: 'account', account: 'alice', amount: undefined, memo: undefined });
  });

  it('TP ScanProtocol 结构化码', () => {
    const qr = JSON.stringify({
      protocol: 'ScanProtocol',
      blockchain: 'EOS',
      action: 'transfer',
      address: 'alice',
      amount: '2.5',
      memo: 'hi',
      symbol: 'EOS',
      contract: 'eosio.token',
      precision: 4,
    });
    expect(parseQr(qr)).toEqual({
      kind: 'account',
      account: 'alice',
      amount: '2.5',
      memo: 'hi',
      symbol: 'EOS',
      contract: 'eosio.token',
      precision: 4,
    });
  });

  it('ScanProtocol 里的非法账户名不放行,落回 text', () => {
    const qr = JSON.stringify({ protocol: 'ScanProtocol', address: 'User9' });
    expect(parseQr(qr).kind).toBe('text');
  });

  it('签名请求:esr:/anchor:// 且优先于 eosio: 判断', () => {
    expect(parseQr('esr://abcdef')).toEqual({ kind: 'esr', uri: 'esr://abcdef' });
    expect(parseQr('anchor://link?req=xxx')).toEqual({ kind: 'esr', uri: 'anchor://link?req=xxx' });
    // eosio://link 也是签名请求,不能被当成 eosio:账户名
    expect(parseQr('eosio://link?req=xxx').kind).toBe('esr');
  });

  it('网址', () => {
    expect(parseQr('https://defibox.io')).toEqual({ kind: 'url', url: 'https://defibox.io' });
  });

  it('无法识别的内容落回 text', () => {
    expect(parseQr('hello world 123')).toEqual({ kind: 'text', text: 'hello world 123' });
    expect(parseQr('{broken json')).toEqual({ kind: 'text', text: '{broken json' });
  });
});
