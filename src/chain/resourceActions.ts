// EOS 资源操作的 action 构建器
//
// 资源获取有三条路径,现代做法优先 PowerUp:
//   PowerUp  —— 按 24 小时租用 CPU/NET,不锁仓,当前主流
//   抵押     —— delegatebw 锁定代币换资源,赎回有 3 天等待期
//   REX      —— 把闲置代币出借给租用者,赚租金
// RAM 与前三者不同,只能从 Bancor 曲线市场买卖,不能抵押获得。
import { Asset } from '@wharfkit/antelope';
import { ActionSpec } from './transact';
import { assertAccountName } from './account';
import { t } from '../i18n';
import { rexQuantity } from './rex';

const asset = (amount: number, symbol: string, precision: number) =>
  String(Asset.fromFloat(amount, `${precision},${symbol}`));

/** 抵押代币换取 CPU / NET */
export function buildDelegate(opts: {
  /**
   * 处理这些系统 action 的合约账户 —— 传 w.client.config.resourceContract。
   * Vaulta 主网上这是 core.vaulta,不是 eosio:core.vaulta 把 eosio 系统合约的
   * delegatebw/buyram/powerup/REX 全套都镜像了一份,自己收 A、内部桥接兑换成
   * EOS 再转发给真正的 eosio 系统 action——eosio 系统合约本身编译时写死只认
   * EOS(core_symbol 没有跟着 Vaulta 改名),直接打 eosio 传 A 会被
   * "max_payment doesn't match core symbol" 拒绝。Jungle4 测试网没有这层
   * 桥接合约,直接是 eosio。
   */
  contract: string;
  from: string;
  receiver: string;
  cpu: number;
  net: number;
  symbol: string;
  precision: number;
  transfer?: boolean;
}): ActionSpec {
  const from = assertAccountName(opts.from, t('accountError.labelPayer'));
  const receiver = assertAccountName(opts.receiver, t('accountError.labelReceiver'));
  if (opts.cpu <= 0 && opts.net <= 0) throw new Error(t('resourceError.cpuNetRequired'));

  return {
    account: opts.contract,
    name: 'delegatebw',
    data: {
      from,
      receiver,
      stake_net_quantity: asset(Math.max(opts.net, 0), opts.symbol, opts.precision),
      stake_cpu_quantity: asset(Math.max(opts.cpu, 0), opts.symbol, opts.precision),
      // true 表示所有权一并转移,普通抵押应为 false
      transfer: opts.transfer ?? false,
    },
  };
}

/** 赎回抵押 —— 注意 EOS 有 3 天赎回等待期,期间资金不可用 */
export function buildUndelegate(opts: {
  contract: string;
  from: string;
  receiver: string;
  cpu: number;
  net: number;
  symbol: string;
  precision: number;
}): ActionSpec {
  const from = assertAccountName(opts.from, t('accountError.labelAccount'));
  const receiver = assertAccountName(opts.receiver, t('accountError.labelReceiver'));
  if (opts.cpu <= 0 && opts.net <= 0) throw new Error(t('resourceError.cpuNetRequired'));

  return {
    account: opts.contract,
    name: 'undelegatebw',
    data: {
      from,
      receiver,
      unstake_net_quantity: asset(Math.max(opts.net, 0), opts.symbol, opts.precision),
      unstake_cpu_quantity: asset(Math.max(opts.cpu, 0), opts.symbol, opts.precision),
    },
  };
}

/** 买 RAM —— 按花费的代币数量买 */
export function buildBuyRam(opts: {
  contract: string;
  payer: string;
  receiver: string;
  quantity: number;
  symbol: string;
  precision: number;
}): ActionSpec {
  const payer = assertAccountName(opts.payer, t('accountError.labelPayer'));
  const receiver = assertAccountName(opts.receiver, t('accountError.labelReceiver'));
  if (!(opts.quantity > 0)) throw new Error(t('resourceError.buyAmountPositive'));

  return {
    account: opts.contract,
    name: 'buyram',
    data: { payer, receiver, quant: asset(opts.quantity, opts.symbol, opts.precision) },
  };
}

/**
 * 买 RAM —— 按字节数买,价格由市场决定。不涉及 Asset 参数,不受 core symbol
 * 限制影响,eosio 原生就能直接用,这里的 contract 只是为了让扣款代币跟其它
 * 资源操作保持一致(Vaulta 上传 core.vaulta,扣的是 A,不是遗留的 EOS)。
 */
export function buildBuyRamBytes(opts: { contract: string; payer: string; receiver: string; bytes: number }): ActionSpec {
  const payer = assertAccountName(opts.payer, t('accountError.labelPayer'));
  const receiver = assertAccountName(opts.receiver, t('accountError.labelReceiver'));
  const bytes = Math.floor(opts.bytes);
  if (!(bytes > 0)) throw new Error(t('resourceError.buyBytesPositive'));

  return { account: opts.contract, name: 'buyrambytes', data: { payer, receiver, bytes } };
}

/** 卖 RAM */
export function buildSellRam(opts: { contract: string; account: string; bytes: number }): ActionSpec {
  const account = assertAccountName(opts.account, t('accountError.labelAccount'));
  const bytes = Math.floor(opts.bytes);
  if (!(bytes > 0)) throw new Error(t('resourceError.sellBytesPositive'));

  return { account: opts.contract, name: 'sellram', data: { account, bytes } };
}

/**
 * 转移 RAM —— 把已经买到手的字节数直接转给另一个账户,不经过市场,不花钱、
 * 不可撤销。跟 buyram(代买)不是一回事:代买是花自己的钱、买完直接算在别人
 * 账上;这个是把自己名下已经有的 RAM 挪走。
 */
export function buildRamTransfer(opts: { contract: string; from: string; to: string; bytes: number; memo?: string }): ActionSpec {
  const from = assertAccountName(opts.from, t('accountError.labelAccount'));
  const to = assertAccountName(opts.to, t('accountError.labelReceiver'));
  const bytes = Math.floor(opts.bytes);
  if (!(bytes > 0)) throw new Error(t('resourceError.transferBytesPositive'));

  return { account: opts.contract, name: 'ramtransfer', data: { from, to, bytes, memo: opts.memo ?? '' } };
}

/**
 * PowerUp —— 按 24 小时租用资源。
 * frac 是「占全网可租资源的比例」,以 1e15 为分母。
 */
export function buildPowerUp(opts: {
  contract: string;
  payer: string;
  receiver: string;
  cpuFrac: number;
  netFrac: number;
  maxPayment: number;
  symbol: string;
  precision: number;
  days?: number;
}): ActionSpec {
  const payer = assertAccountName(opts.payer, t('accountError.labelPayer'));
  const receiver = assertAccountName(opts.receiver, t('accountError.labelReceiver'));
  if (!(opts.maxPayment > 0)) throw new Error(t('resourceError.maxPaymentPositive'));

  return {
    account: opts.contract,
    name: 'powerup',
    data: {
      payer,
      receiver,
      days: opts.days ?? 1,
      net_frac: Math.floor(opts.netFrac),
      cpu_frac: Math.floor(opts.cpuFrac),
      max_payment: asset(opts.maxPayment, opts.symbol, opts.precision),
    },
  };
}

/** 存入 REX —— 需先把代币转入 REX 基金,再买入 REX */
export function buildRexDeposit(opts: {
  contract: string;
  owner: string;
  amount: string;
  symbol: string;
  precision: number;
}): ActionSpec[] {
  const owner = assertAccountName(opts.owner, t('accountError.labelAccount'));
  if (opts.precision !== 4) throw new Error(t('rex.invalidAmount'));
  const quantity = rexQuantity(opts.amount, opts.symbol);

  return [
    { account: opts.contract, name: 'deposit', data: { owner, amount: quantity } },
    { account: opts.contract, name: 'buyrex', data: { from: owner, amount: quantity } },
  ];
}

/** Only withdraw already available core tokens. Never infer A from a REX amount. */
export function buildRexWithdraw(opts: {
  contract: string;
  owner: string;
  amount: string;
  symbol: string;
  precision: number;
}): ActionSpec[] {
  const owner = assertAccountName(opts.owner, t('accountError.labelAccount'));
  if (opts.precision !== 4) throw new Error(t('rex.invalidAmount'));

  return [
    { account: opts.contract, name: 'withdraw', data: { owner, amount: rexQuantity(opts.amount, opts.symbol) } },
  ];
}

export function buildRexSell(opts: { contract: string; owner: string; rexAmount: string }): ActionSpec[] {
  const from = assertAccountName(opts.owner, t('accountError.labelAccount'));
  return [{ account: opts.contract, name: 'sellrex', data: { from, rex: rexQuantity(opts.rexAmount, 'REX') } }];
}
export function buildRexUnlock(opts: { contract: string; owner: string; rexAmount: string }): ActionSpec[] {
  const owner = assertAccountName(opts.owner, t('accountError.labelAccount'));
  return [{ account: opts.contract, name: 'mvfrsavings', data: { owner, rex: rexQuantity(opts.rexAmount, 'REX') } }];
}
export function buildRexCancel(owner: string): ActionSpec[] {
  return [{ account: 'eosio', name: 'cnclrexorder', data: { owner: assertAccountName(owner, t('accountError.labelAccount')) } }];
}
