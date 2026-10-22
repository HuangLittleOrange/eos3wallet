// 签名前的「意图核对」——凡是要对 Sponsor 服务端拼好的交易签名,先在本地
// 验证"实际要签的内容"和"用户在弹窗里点头过的内容"一致,对不上直接拒签。
//
// 这层校验约束显式使用用户授权的 action;它不能证明任意合约、ABI 或用户已经
// 授予的 eosio.code 委托安全。业务合约与 Sponsor 的附加 action 仍需独立审查。
// 本地要求:
//
//   凡是以用户身份授权的 action,必须要么逐字节等于用户确认过的某条 action,
//   要么是弹窗里明码展示过的那笔代付费。其余一律拒签。
//
// 服务端诚实时这里静默通过(它拼的本来就是我们发过去的内容,ABI 编码是确定性
// 的,同样内容必然编出同样字节);服务端被攻破想夹带私货时,字节必然对不上。
// 校验只解码、只比对,不重新序列化——提交给服务端的仍是它返回的原始字节,
// 不影响它那边"逐字节核对存储意图"的机制(见 eos3Sign.ts 里的说明)。
import { ABI, Action, Bytes, Serializer, Transaction } from '@wharfkit/antelope';

import type { ActionSpec } from './transact';
import { t } from '../i18n';
import { assertVisibleTransaction } from './transactionSafety';
import { coreActionAbi } from './coreTokenAbi';

/** 服务端返回的交易和用户确认的内容对不上——一律拒签,绝不能带着疑问继续 */
export class TxIntentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxIntentMismatchError';
  }
}

export type AbiProvider = (account: string) => Promise<ABI.Def | ABI>;

/**
 * 核对代付服务(powerup.eos3.app)返回的序列化字节:解码出交易骨架(不需要
 * ABI 就能看到每个 action 的合约/名字/授权,只有 data 留作字节),再把用户
 * 确认过的 action 用链上 ABI 编码成字节逐条比对。
 *
 * 代付费 transfer 只认一笔,且合约、收款人、金额都必须等于报价里展示过的值;
 * 没报过价(免费)就不放行任何 transfer。
 */
export async function assertSponsoredTxMatchesIntent(opts: {
  /** 服务端返回、即将要签的原始字节(hex) */
  serializedTransaction: string;
  actor: string;
  permission: string;
  /** 用户在弹窗里看到并同意的 action——比对的原件 */
  userActions: ActionSpec[];
  /** 弹窗里展示过的代付费报价,如 "0.0100 A";没有就是免费 */
  sponsorFee?: string;
  sponsorFeeReceiver?: string;
  /** 代付费只允许走这条链的系统代币合约,别的合约的 transfer 一律不认 */
  feeTokenContract: string;
  getAbi: AbiProvider;
}): Promise<void> {
  const tx = Serializer.decode({
    data: Bytes.from(opts.serializedTransaction, 'hex'),
    type: Transaction,
  }) as Transaction;
  try { assertVisibleTransaction(tx); } catch {
    throw new TxIntentMismatchError(t('txCheck.unexpectedAction', { contract: '(transaction)', action: '*' }));
  }

  // context-free action 不带授权就能执行,正常代付交易里根本不该出现
  if (tx.context_free_actions.length > 0) {
    throw new TxIntentMismatchError(t('txCheck.unexpectedAction', { contract: '(context-free)', action: '*' }));
  }

  // 用户 action 涉及的合约 + 代付费代币合约,ABI 并发拉一轮
  const contracts = new Set(opts.userActions.map((a) => a.account));
  if (opts.sponsorFee) contracts.add(opts.feeTokenContract);
  const abis = new Map<string, ABI>();
  await Promise.all(
    Array.from(contracts).map(async (c) => {
      abis.set(c, ABI.from(await opts.getAbi(c)));
    })
  );

  // 期望字节:把用户确认过的 JSON data 用同一份链上 ABI 编码——编码是确定性的,
  // 服务端没改内容,两边字节必然一致
  const expected = opts.userActions.map((spec) => ({
    spec,
    dataHex: Action.from(
      {
        account: spec.account,
        name: spec.name,
        authorization: [{ actor: opts.actor, permission: opts.permission }],
        data: spec.data,
      },
      coreActionAbi(spec.account, spec.name) ?? abis.get(spec.account)!
    ).data.hexString,
    used: false,
  }));

  let feeSeen = false;
  let nextUserAction = 0;
  for (const act of tx.actions) {
    const auths = act.authorization;
    // An action with no authorization needs no signature to execute; it must
    // never ride along hidden as if it were a sponsor-owned action.
    if (auths.length === 0) {
      throw new TxIntentMismatchError(t('txCheck.unexpectedAction', { contract: String(act.account), action: String(act.name) }));
    }
    if (!auths.some((l) => String(l.actor) === opts.actor)) {
      // 保留 Sponsor 自己授权的附加 action。它们不在本校验的保护范围内。
      continue;
    }
    const account = String(act.account);
    const name = String(act.name);

    // 1) 用户确认过的业务 action:合约、名字、data 字节、授权必须全等,
    //    且每条只能对上一次(防止服务端复制同一条凑数、真正的那条却被换掉)
    const exactAuth =
      auths.length === 1 &&
      String(auths[0].actor) === opts.actor &&
      String(auths[0].permission) === opts.permission;
    const match = expected[nextUserAction];
    if (match && exactAuth && match.spec.account === account && match.spec.name === name && match.dataHex === act.data.hexString) {
      match.used = true;
      nextUserAction++;
      continue;
    }

    // 2) 弹窗里展示过的那笔代付费 transfer——合约、收款人、金额三者都要对上报价
    if (opts.sponsorFee && !feeSeen && account === opts.feeTokenContract && name === 'transfer') {
      let ok = false;
      try {
        const d: any = Serializer.decode({ data: act.data, type: 'transfer',
          abi: coreActionAbi(account, name) ?? abis.get(opts.feeTokenContract)! });
        ok =
          String(d.from) === opts.actor &&
          String(d.to) === String(opts.sponsorFeeReceiver ?? '') &&
          String(d.quantity) === opts.sponsorFee &&
          exactAuth;
      } catch {
        ok = false;
      }
      if (ok) {
        feeSeen = true;
        continue;
      }
      throw new TxIntentMismatchError(t('txCheck.feeMismatch'));
    }

    throw new TxIntentMismatchError(t('txCheck.unexpectedAction', { contract: account, action: name }));
  }

  // 反向核对:用户确认过的每一条都必须真的在交易里——服务端"少签"业务 action
  // 同样是货不对板(比如把真转账偷偷抽掉,只留代付费)
  const missing = expected.find((e) => !e.used);
  if (missing) {
    throw new TxIntentMismatchError(
      t('txCheck.missingAction', { contract: missing.spec.account, action: missing.spec.name })
    );
  }
}
