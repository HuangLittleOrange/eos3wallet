// 二维码内容解析 —— 从 ScanScreen 抽出来的纯逻辑,不带任何相机/UI 依赖,
// 方便单测覆盖(扫码识别错一个分支就是把钱转错地方的事故,值得测全)。
import { isValidAccountName } from './account';
import { isEsrLink } from '../dapp/esr';

export type ScanResult =
  | {
      kind: 'account';
      account: string;
      memo?: string;
      amount?: string;
      /** 只有 TP ScanProtocol 这种结构化码才带得出来,普通 URI/纯账户名码没有 */
      symbol?: string;
      contract?: string;
      precision?: number;
    }
  | { kind: 'url'; url: string }
  /** EOSIO 签名请求 —— 桌面 DApp 出的二维码 */
  | { kind: 'esr'; uri: string }
  | { kind: 'text'; text: string };

/**
 * 解析二维码内容。EOS 生态常见五种:
 *   1. 纯账户名          binancecleos
 *   2. URI 形式          eosio:binancecleos?amount=1.0000&memo=905112(本机自己生成的旧格式,仍要认)
 *   3. TP ScanProtocol   {"protocol":"ScanProtocol","blockchain":"EOS","address":"...","amount":"...","symbol":"EOS","contract":"eosio.token","precision":4,"action":"transfer"}
 *      —— TokenPocket 的公开收款码协议(见 https://help.tokenpocket.pro/developer-cn/scan-protocol),
 *      比纯 URI 多带 symbol/contract/precision,不用猜是哪个代币。本机生成的收款码在设了金额时
 *      也改用这个格式(见 ReceiveScreen),这里对称地要认得,不然自己生成的码自己扫不出来。
 *   4. 签名请求          esr:… / anchor://link?…(桌面 DApp 的登录/签名码)
 *   5. 网址              https://…  (DApp)
 */
export function parseQr(raw: string): ScanResult {
  const v = (raw ?? '').trim();

  // 签名请求要先于 eosio: 判断 —— eosio://link 也属于签名请求
  if (isEsrLink(v)) return { kind: 'esr', uri: v };

  if (/^https?:\/\//i.test(v)) return { kind: 'url', url: v };

  // TP ScanProtocol —— 唯一能用花括号开头简单识别的分支,失败就落到下面几种
  if (v.startsWith('{')) {
    try {
      const j = JSON.parse(v);
      const account = String(j.address ?? j.to ?? '').toLowerCase();
      if (j.protocol === 'ScanProtocol' && isValidAccountName(account)) {
        return {
          kind: 'account',
          account,
          amount: j.amount != null ? String(j.amount) : undefined,
          memo: j.memo != null ? String(j.memo) : undefined,
          symbol: j.symbol ? String(j.symbol) : undefined,
          contract: j.contract ? String(j.contract) : undefined,
          precision: typeof j.precision === 'number' ? j.precision : undefined,
        };
      }
    } catch {
      // 不是合法 JSON,落到下面继续按其它格式试
    }
  }

  // eosio:account?amount=..&memo=..
  const m = v.match(/^(?:eosio|eos|vaulta):([a-z1-5.]{1,12})(?:\?(.*))?$/i);
  if (m) {
    const params = new URLSearchParams(m[2] ?? '');
    return {
      kind: 'account',
      account: m[1].toLowerCase(),
      amount: params.get('amount') ?? undefined,
      memo: params.get('memo') ?? undefined,
    };
  }

  if (isValidAccountName(v)) return { kind: 'account', account: v };

  return { kind: 'text', text: v };
}
