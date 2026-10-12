// 「选择钱包 → 最近」的数据源。只收转账页亲手转过的收款方,最近的在前、
// 不重复、每条链各自一份、最多 10 个。
import AsyncStorage from '@react-native-async-storage/async-storage';

import { listRecentRecipients, recordRecentRecipient } from '../recentRecipients';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('recentRecipients', () => {
  it('没转过账时为空', async () => {
    await expect(listRecentRecipients('vaulta')).resolves.toEqual([]);
  });

  it('最近一次转账的收款方排在最前面', async () => {
    await recordRecentRecipient('vaulta', 'alice1111111');
    await recordRecentRecipient('vaulta', 'bob111111111');
    await expect(listRecentRecipients('vaulta')).resolves.toEqual(['bob111111111', 'alice1111111']);
  });

  it('再转给同一个人不会重复出现,只是挪到最前面', async () => {
    await recordRecentRecipient('vaulta', 'alice1111111');
    await recordRecentRecipient('vaulta', 'bob111111111');
    await recordRecentRecipient('vaulta', 'alice1111111');
    await expect(listRecentRecipients('vaulta')).resolves.toEqual(['alice1111111', 'bob111111111']);
  });

  it('主网和测试网各记各的,不会串', async () => {
    await recordRecentRecipient('vaulta', 'alice1111111');
    await recordRecentRecipient('jungle4', 'testacc11111');
    await expect(listRecentRecipients('vaulta')).resolves.toEqual(['alice1111111']);
    await expect(listRecentRecipients('jungle4')).resolves.toEqual(['testacc11111']);
  });

  it('每条链最多留 10 个,最早的被挤掉', async () => {
    for (let i = 1; i <= 12; i++) await recordRecentRecipient('vaulta', `acct${i}`);
    const list = await listRecentRecipients('vaulta');
    expect(list).toHaveLength(10);
    expect(list[0]).toBe('acct12');
    expect(list).not.toContain('acct1');
    expect(list).not.toContain('acct2');
  });

  it('存储里是坏数据时当作空,不让整个选择钱包弹层崩掉', async () => {
    await AsyncStorage.setItem('aurora.recentRecipients.v1', '{not json');
    await expect(listRecentRecipients('vaulta')).resolves.toEqual([]);
  });
});
