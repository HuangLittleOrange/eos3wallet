import {
  assetValue,
  fmtAmount,
  fmtBytes,
  fmtTime,
  fmtUSD,
  fmtUs,
  impersonates,
  sanitizeAmountInput,
  tokenColor,
} from '../format';

describe('sanitizeAmountInput', () => {
  it('只保留数字和第一个小数点', () => {
    expect(sanitizeAmountInput('1.2.3')).toBe('1.23');
    expect(sanitizeAmountInput('abc1.5xyz')).toBe('1.5');
    expect(sanitizeAmountInput('..5')).toBe('.5');
    expect(sanitizeAmountInput('')).toBe('');
    expect(sanitizeAmountInput('1,000.5')).toBe('1000.5');
  });
});

describe('fmtAmount', () => {
  it('大数取两位小数并加千分位', () => {
    expect(fmtAmount(12345.6789)).toBe('12,345.68');
  });
  it('小数按精度显示并去掉尾零', () => {
    expect(fmtAmount(1.23, 4)).toBe('1.23');
    expect(fmtAmount(1.0, 4)).toBe('1');
  });
  it('非有限值兜底为 0', () => {
    expect(fmtAmount(NaN)).toBe('0');
    expect(fmtAmount(Infinity)).toBe('0');
  });
});

describe('fmtUSD', () => {
  it('常规金额两位小数', () => {
    expect(fmtUSD(1234.5)).toBe('$1,234.50');
  });
  it('低于 1 美分的价格保留 6 位,避免显示成 $0.00', () => {
    expect(fmtUSD(0.001234)).toBe('$0.001234');
  });
  it('非有限值兜底', () => {
    expect(fmtUSD(NaN)).toBe('$0.00');
  });
});

describe('assetValue', () => {
  it('解析 "12.3456 EOS" 形式的余额字符串', () => {
    expect(assetValue('12.3456 EOS')).toBe(12.3456);
    expect(assetValue(undefined)).toBe(0);
    expect(assetValue('not a number')).toBe(0);
  });
});

describe('fmtTime', () => {
  it('无时区后缀的链上时间按 UTC 处理', () => {
    // 具体输出随本机时区,这里只验证能解析、格式形如 MM-DD HH:mm
    expect(fmtTime('2026-08-20T12:00:00')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it('非法输入返回空串', () => {
    expect(fmtTime('garbage')).toBe('');
    expect(fmtTime(undefined)).toBe('');
  });
});

describe('impersonates(假币识别)', () => {
  it('正规发行方不报警', () => {
    expect(impersonates('EOS', 'eosio.token')).toBeNull();
    expect(impersonates('USDT', 'tethertether')).toBeNull();
    expect(impersonates('A', 'core.vaulta')).toBeNull();
  });
  it('知名符号 + 非正规合约 → 返回正规合约名', () => {
    expect(impersonates('EOS', 'wawnkjidnrhs')).toBe('eosio.token');
    expect(impersonates('usdt', 'issue.newdex')).toBe('tethertether');
  });
  it('未收录的符号一律不报警', () => {
    expect(impersonates('FOO', 'anycontract1')).toBeNull();
  });
});

describe('tokenColor', () => {
  it('同一符号颜色稳定', () => {
    expect(tokenColor('XYZ')).toBe(tokenColor('xyz'));
  });
  it('固定表内的符号用固定色', () => {
    expect(tokenColor('USDT')).toBe('#26A17B');
  });
});

describe('fmtBytes / fmtUs', () => {
  it('字节按量级换单位', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
  it('微秒按量级换单位', () => {
    expect(fmtUs(500)).toBe('500 µs');
    expect(fmtUs(1500)).toBe('1.50 ms');
    expect(fmtUs(2_500_000)).toBe('2.50 s');
  });
});
