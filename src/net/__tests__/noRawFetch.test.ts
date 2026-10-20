// 守门测试——纯靠"记得复用 fetchWithRetry/fetchWithTimeout"这种约定是会漏的
// (这次 abiCache.ts/transact.ts/signup.ts/keys.ts/eos3Api.ts 就是活生生的例子:
// 同样的 TLS 握手偶发失败,各自漏加过一次重试)。这个测试把约定变成机器检查:
// src 下任何地方新写一处裸 fetch(),这个测试就会报出具体文件,逼你要么改成走
// net/fetchRetry.ts,要么把文件加进下面的白名单并写清楚"为什么这处不能重试"。
// 项目没装 @types/node(RN/Expo 应用代码本来就不该碰 fs/path),这里就地声明
// 最小够用的类型,不去动全局 tsconfig——这两个标识符只在这一个测试文件里有意义。
declare const require: any;
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = require('fs');
const { join } = require('path');

const SRC_ROOT = join(__dirname, '..', '..');

// 允许保留裸 fetch() 的文件——都必须在文件自己的注释里说明原因,不能只靠这里
// 这一行注释。
const ALLOWLIST = new Set([
  'net/fetchRetry.ts', // 唯一的底层实现,别的地方都应该 import 它
  'dapp/esr.ts', // ESR 回调地址是不受我们控制的第三方 dApp,幂等性未知,见文件内注释
]);

// 只抓真正的函数调用形态(await fetch(/ return fetch(/ = fetch(),不匹配注释里
// "fetch() 会怎样" 这种不带真实参数、也不出现在赋值/return/await 位置的提及。
const RAW_FETCH_CALL = /\b(?:await\s+fetch|return\s+fetch|=\s*fetch)\s*\(/;

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

describe('没有裸 fetch() 漏网', () => {
  it('src 下的 fetch 调用都经过 net/fetchRetry.ts,或者在白名单里说明了原因', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
      if (ALLOWLIST.has(rel)) continue;
      const content = readFileSync(file, 'utf8');
      if (RAW_FETCH_CALL.test(content)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
