// 格式化与展示辅助

export const fmtUSD = (n: number) => {
  if (!isFinite(n)) return '$0.00';
  const d = n > 0 && n < 0.01 ? 6 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: d });
};

export const fmtAmount = (n: number, precision = 4) => {
  if (!isFinite(n)) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toFixed(precision).replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * 过滤掉数字/小数点以外的字符,只保留第一个小数点。
 * keyboardType="decimal-pad" 只决定弹出哪种软键盘样式,不会真的拦截字符——
 * 模拟器上用电脑物理键盘、或者粘贴内容,都能绕过软键盘限制直接把任意文本
 * 塞进 TextInput,所以过滤必须做在 onChangeText 里,不能只靠 keyboardType。
 * 转账页(校验输入)和收款页(「设置金额」生成收款二维码)都要用同一份过滤,
 * 不单独各写一份。
 */
export const sanitizeAmountInput = (text: string): string => {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot === -1) return cleaned;
  return cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
};

/**
 * PowerUp「预计可支持约几笔转账」——estimateTransfersForBudget 本身只是拿
 * "每笔约 300µs CPU / 200 字节 NET" 的粗略假设二分出来的估算,链上够便宜时
 * 很容易算出上亿这种数字。原样吐出 "109952736" 这种九位精确数字,看着像是
 * 精确值,反而不可信——这里统一只保留约 2 位有效数字再配千分位,老实承认
 * "这是个约数",不是打印精度不够。
 */
export const fmtEstimatedCount = (n: number): string => {
  if (!isFinite(n) || n <= 0) return '0';
  let rounded = n;
  if (n >= 1000) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(n)) - 1);
    rounded = Math.round(n / magnitude) * magnitude;
  }
  return rounded.toLocaleString('en-US');
};

export const fmtBytes = (b: number) => {
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return Math.round(b) + ' B';
};

export const fmtUs = (us: number) => {
  if (us >= 1000 * 1000) return (us / 1000 / 1000).toFixed(2) + ' s';
  if (us >= 1000) return (us / 1000).toFixed(2) + ' ms';
  return Math.round(us) + ' µs';
};

/** 把 "12.3456 EOS" 拆成数值 */
export const assetValue = (raw?: string) => {
  if (!raw) return 0;
  const n = parseFloat(String(raw).split(' ')[0]);
  return isFinite(n) ? n : 0;
};

/** ISO 时间 → MM-DD HH:mm */
export const fmtTime = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 时间戳(毫秒) → YYYY-MM-DD HH:mm */
export const fmtDateTime = (ts: number) => {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 已知正规发行方 —— 用于识别同名假币 */
const CANONICAL: Record<string, string> = {
  EOS: 'eosio.token',
  A: 'core.vaulta',
  USDT: 'tethertether',
  USDC: 'usdcusdcusdc',
  BOX: 'boxbdaotoken',
  DFS: 'minedfstoken',
};

/**
 * 该代币是否冒用了知名符号但发行合约不符。
 * 返回正规合约名,供 UI 提示用户;非冒用则返回 null。
 *
 * EOS 上任何人都能发行同名代币 —— 实测 bitfinexdep1 就持有
 * wawnkjidnrhs 发行的假 EOS 和 issue.newdex 发行的假 USDT。
 */
export const impersonates = (symbol: string, contract: string): string | null => {
  const canonical = CANONICAL[(symbol ?? '').toUpperCase()];
  if (!canonical) return null;
  return canonical !== contract ? canonical : null;
};

/** 代币徽标配色 —— 按符号派生,保证同一代币颜色稳定 */
const FIXED: Record<string, string> = {
  EOS: '#111827',
  A: '#111827',
  USDT: '#26A17B',
  USDC: '#2775CA',
  BOX: '#3366FF',
  DFS: '#00C2A8',
};

const PALETTE = ['#3B47D6', '#F5851F', '#7C3AED', '#EF4444', '#0EA5E9', '#12A566', '#E0A93B', '#EC4899'];

export const tokenColor = (symbol: string) => {
  const s = (symbol ?? '').toUpperCase();
  if (FIXED[s]) return FIXED[s];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
