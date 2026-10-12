jest.mock('../../i18n', () => ({
  t: (key: string) => key,
}));

import { CHAINS, DEFAULT_CHAIN } from '../config';

describe('CHAINS 配置', () => {
  // 交易签名摘要包含 chain_id,这两个值改错一个字符,所有交易都会被链拒绝。
  // 常量来自 2026-08-24 实测 greymass 主网/Jungle4 节点 get_info——锁在测试里,
  // 防止以后重构时手滑改动。
  it('chainIdHash 与链上实测值一致', () => {
    expect(CHAINS.vaulta.chainIdHash).toBe('aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906');
    expect(CHAINS.jungle4.chainIdHash).toBe('73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d');
  });

  it('chainIdHash 是 64 位十六进制', () => {
    for (const c of Object.values(CHAINS)) {
      expect(c.chainIdHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('每条链都有可用的节点列表', () => {
    for (const c of Object.values(CHAINS)) {
      expect(c.nodes.length).toBeGreaterThan(0);
      // 节点 id 不允许重复——会话恢复/探测结果都按 id 定位
      const ids = c.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('默认链存在于配置中', () => {
    expect(CHAINS[DEFAULT_CHAIN]).toBeDefined();
  });
});
