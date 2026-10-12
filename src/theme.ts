// EOS³ Wallet — 原创品牌主题（TP 风格,但配色/标识全部自定义）
export const colors = {
  // 品牌主色:极光蓝紫渐变
  brand: '#2E7DF7',
  brandDark: '#1E5FD9',
  brandGradient: ['#3B82F6', '#2563EB'] as const,
  auroraGradient: ['#4F8CFF', '#6D5DF6'] as const,

  bg: '#F5F6FA',
  card: '#FFFFFF',
  cardAlt: '#F7F8FB',

  text: '#1A1D26',
  textSub: '#8A90A0',
  textFaint: '#B4B9C6',

  line: '#EDEFF4',
  divider: '#F0F1F5',

  green: '#12B76A',
  red: '#F04438',
  gold: '#F5A623',

  tabActive: '#2E7DF7',
  tabInactive: '#B4B9C6',

  white: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.45)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

export const font = {
  h1: 28,
  h2: 22,
  h3: 18,
  body: 15,
  sub: 13,
  tiny: 11,
};

export const shadow = {
  card: {
    shadowColor: '#1A1D26',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  soft: {
    shadowColor: '#1A1D26',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
};

export const BRAND_NAME = 'EOS³ Wallet';
