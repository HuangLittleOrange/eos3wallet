// 守门测试——iOS 上原生弹出(RN 的 Modal、导航的原生 modal 页面)同一时间只能
// present 一个,多开的会被系统静默吞掉(界面上"点了没反应",安卓却正常,开发
// 时很难发现,详见 components/modalLayers.ts)。弹层一律走 BottomSheet /
// CenterDialog(内部经 ModalPortal 交给纯 JS 的 ModalHost),这里把几条相关约定
// 变成机器检查,违反就报出具体文件:
//   1. 不许用 react-native 的 Modal;
//   2. 不许直接用 BackHandler 监听返回键(弹层开着时要让路,走 addBackHandler);
//   3. 导航里不许用原生弹出的 presentation(纯 JS 弹层盖不住它们)。
// 项目没装 @types/node,和 net/__tests__/noRawFetch.test.ts 一样就地声明类型。
declare const require: any;
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');

const SRC_ROOT = join(__dirname, '..', '..');
const APP_ROOT = join(SRC_ROOT, '..');

type Rule = { name: string; patterns: RegExp[]; allow: Set<string> };

const RULES: Rule[] = [
  {
    name: 'react-native 的原生 Modal',
    patterns: [/import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*['"]react-native['"]/, /<Modal[\s>]/, /\.Modal\b/],
    allow: new Set(),
  },
  {
    name: '直接监听返回键(改用 ModalHost 的 addBackHandler)',
    patterns: [/BackHandler\.addEventListener/],
    allow: new Set(['src/components/ModalHost.tsx']), // addBackHandler 本身和宿主的返回键接管
  },
  {
    name: "原生弹出的导航 presentation(只能用 'card')",
    patterns: [/presentation\s*:\s*['"](?!card['"])/],
    allow: new Set(),
  },
];

// 注释里提到 `<Modal ...>`(比如解释"为什么不用它")不算违规
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const violates = (rule: Rule, src: string) => rule.patterns.some((re) => re.test(stripComments(src)));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES: { rel: string; content: string }[] = [...listSourceFiles(SRC_ROOT), join(APP_ROOT, 'App.tsx')].map((file) => ({
  rel: file.slice(APP_ROOT.length + 1),
  content: readFileSync(file, 'utf8'),
}));

describe('弹层相关约定没有漏网', () => {
  for (const rule of RULES) {
    it(`没有任何地方使用${rule.name}`, () => {
      const offenders = FILES.filter((f) => !rule.allow.has(f.rel) && violates(rule, f.content)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  it('守门规则本身能抓到违规写法(防止正则失效后测试永远绿)', () => {
    const [modal, back, presentation] = RULES;
    for (const src of ["import { View, Modal } from 'react-native';", '<Modal visible transparent>', '<RN.Modal visible>']) {
      expect(violates(modal, src)).toBe(true);
    }
    for (const src of [
      "import { ModalPortal } from './ModalHost';",
      '<DappScanModal visible />',
      '<ModalPortal onRequestClose={x}>',
      '// 替代各处裸用 `<Modal transparent>`',
      '/** 卸载 <Modal visible> 时 */',
    ]) {
      expect(violates(modal, src)).toBe(false);
    }

    expect(violates(back, "BackHandler.addEventListener('hardwareBackPress', fn)")).toBe(true);
    expect(violates(back, 'addBackHandler(fn)')).toBe(false);

    for (const src of ["options={{ presentation: 'modal' }}", 'presentation: "formSheet"', "presentation: 'transparentModal'"]) {
      expect(violates(presentation, src)).toBe(true);
    }
    expect(violates(presentation, "options={{ presentation: 'card' }}")).toBe(false);
  });
});
