// 把页面递过来的、已经序列化好的交易还原成人能看懂的样子。
//
// 用在 Scatter 的 requestSignature 上:eosjs2 的 signatureProvider 是页面自己
// 把交易打包好再交给钱包签名的,钱包拿到的只有一串十六进制。签名前必须把它
// 拆开逐条摆给用户看——直接对一串看不懂的字节点确认,交易详情就形同虚设,
// 页面完全可以嘴上说转 1 个币、实际打包的是转空全部余额。
import { ABI, Serializer, Transaction } from '@wharfkit/antelope';

import { getCachedAbi } from '../chain/abiCache';
import type { ActionSpec } from '../chain/transact';
import { assertVisibleTransaction, decodeVisibleAction } from '../chain/transactionSafety';

export type DecodedTx = {
  transaction: Transaction;
  actions: ActionSpec[];
  /** 交易里对当前账户指定的权限;各 action 指定得不一致就返回 null */
  permission: string | null;
};

export async function decodeSerializedTransaction(
  serializedTransaction: string,
  opts: { nodeUrl: string; actor: string }
): Promise<DecodedTx> {
  const transaction = Serializer.decode({ data: serializedTransaction, type: Transaction });
  assertVisibleTransaction(transaction);

  const actions: ActionSpec[] = [];
  const perms = new Set<string>();

  for (const action of transaction.actions) {
    for (const auth of action.authorization) {
      if (String(auth.actor) === opts.actor) perms.add(String(auth.permission));
    }

    let data: Record<string, any>;
    try {
      const abi = ABI.from(await getCachedAbi(opts.nodeUrl, String(action.account)));
      data = decodeVisibleAction(action, abi);
    } catch {
      throw new Error('Cannot decode transaction action');
    }

    actions.push({ account: String(action.account), name: String(action.name), data,
      authorization: action.authorization.map((auth) => ({ actor: String(auth.actor), permission: String(auth.permission) })) });
  }

  return { transaction, actions, permission: perms.size === 1 ? Array.from(perms)[0] : null };
}
