// eos3.app 那套"后端拼交易(noop 代付排第一位) → 本地签名 → 发回去广播"流程的
// 公共部分。sponsor.ts(资源代付)和 permissions.ts(已授权应用管理)用的是
// 同一套后端机制(paylimit 合约 noop + ONLY_BILL_FIRST_AUTHORIZER),这里只抽
// 公共的"请求 eos3.app API"和"本地签一笔它返回的交易"两件事,避免两处重复。
import { ABI, Action, Bytes, Checksum256, Name, PrivateKey, Serializer, Transaction } from '@wharfkit/antelope';

import { getCachedAbi } from './abiCache';
import { EOS3_BASE_URL } from '../passkey/constants';
import { signDigestWithPasskey } from '../passkey/webauthnSigning';
import type { NodeInfo } from './config';
import type { Signer } from './transact';
import { t } from '../i18n';
import { fetchWithRetry as fetchWithRetryRaw } from '../net/fetchRetry';
import { coreActionAbi } from './coreTokenAbi';
import { AuthorizationFailureError, isAuthorizationFailure } from './authorizationError';

export class Eos3SignError extends Error {}

export type PlainTxAction = {
  account: string;
  name: string;
  authorization: { actor: string; permission: string }[];
  data: Record<string, any>;
};

/** eos3.app 后端返回的标准 EOS 交易 JSON(未签名) */
export type PlainTxJSON = {
  expiration: string;
  ref_block_num: number;
  ref_block_prefix: number;
  max_net_usage_words: number;
  max_cpu_usage_ms: number;
  delay_sec: number;
  context_free_actions: any[];
  actions: PlainTxAction[];
  transaction_extensions: any[];
};

/**
 * 重试逻辑本身在 net/fetchRetry.ts(TLS 握手偶尔因网络抖动直接失败,只重试
 * "连接本身失败"这一种情况,不重试 HTTP 层面正常返回的业务错误)——这里只是
 * 把重试耗尽后的原始异常(比如 "SSLHandshakeException: connection closed")
 * 包成调用方认得的 Eos3SignError,不糊给用户原始系统异常。
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchWithRetryRaw(url, init);
  } catch {
    throw new Eos3SignError(t('eos3Error.unstableNetwork'));
  }
}

async function parseEos3Response<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Eos3SignError(res.ok ? t('eos3Error.badResponseFormat') : t('eos3Error.requestFailed', { status: res.status }));
  }
  if (!res.ok) {
    if (isAuthorizationFailure(parsed)) throw new AuthorizationFailureError();
    throw new Eos3SignError(parsed?.error ?? t('eos3Error.requestFailed', { status: res.status }));
  }
  return parsed as T;
}

export async function eos3Request<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`${EOS3_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseEos3Response<T>(res);
}

export async function eos3Get<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${EOS3_BASE_URL}${path}`, { method: 'GET' });
  return parseEos3Response<T>(res);
}

/**
 * 本地签一笔 eos3.app 后端返回的未签名交易 JSON,返回签名和序列化后的字节
 * (hex),原样交给调用方去拼 push 请求。只签名,不广播——广播都是各自领域
 * (资源代付 / 权限变更)自己拼 push 请求体去发。
 */
export async function signPlainTransactionJSON(opts: {
  transactionJson: PlainTxJSON;
  chainId: string;
  node: NodeInfo;
  signer: Signer;
}): Promise<{ signature: string; serializedTransaction: string }> {
  // 交易里出现的每个合约(代付合约的 noop、可能的手续费代币合约、目标合约)
  // 都要先拿到 ABI,才能把 JSON 形式的 action data 编码成链上二进制。
  // 走 abiCache 的缓存,连续几笔权限操作不用回回重拉同一份系统合约 ABI。
  const contracts = Array.from(new Set(opts.transactionJson.actions.map((a) => a.account)));
  const abis = await Promise.all(
    contracts.map(async (contract) => ({
      contract: Name.from(contract),
      abi: await getCachedAbi(opts.node.url, contract),
    }))
  );

  const transaction = Transaction.from({ ...opts.transactionJson,
    actions: opts.transactionJson.actions.map((action) => Action.from(action,
      coreActionAbi(action.account, action.name) ?? ABI.from(abis.find((entry) => String(entry.contract) === action.account)!.abi))) });
  const chainId = Checksum256.from(opts.chainId);
  const digest = transaction.signingDigest(chainId);

  const signature =
    opts.signer.kind === 'passkey'
      ? await signDigestWithPasskey({
          digest: digest.array,
          chainPublicKey: opts.signer.chainPublicKey,
          credentialIdHex: opts.signer.credentialIdHex,
        })
      : PrivateKey.from(opts.signer.privateKey).signDigest(digest);

  return {
    signature: String(signature),
    serializedTransaction: Serializer.encode({ object: transaction }).hexString,
  };
}

/**
 * 给后端已经序列化好的交易签名——不重新拼、不重新编码。
 *
 * 资源代付(sponsor.ts)这条线跟上面 signPlainTransactionJSON 的关键区别:
 * 后端存的"意图"就是这段十六进制字节本身,submit 时会逐字节比对
 * (serialized transaction does not match stored intent 就是这么来的)。
 * 如果本地按 JSON 重新构建/重新序列化一遍,哪怕语义完全一样,字节序列
 * 也可能对不上(字段顺序、ABI 版本、数值编码的细微差异),会被后端拒收。
 * 所以这里直接对服务端返回的原始字节算签名摘要,不经过 Transaction.from()。
 *
 * 签名摘要公式和 Transaction.signingDigest() 内部算法一致(sha256(chainId +
 * 序列化交易 + 32 字节 context-free 数据摘要占位)),这里只是不经过重新
 * 序列化这一步,直接用服务端给的字节。
 */
export async function signSerializedTransaction(opts: {
  serializedTransaction: string;
  chainId: string;
  signer: Signer;
}): Promise<{ signature: string }> {
  const chainId = Checksum256.from(opts.chainId);
  const txBytes = Bytes.from(opts.serializedTransaction, 'hex');
  const digestInput = Bytes.from(chainId.array).appending(txBytes).appending(new Uint8Array(32));
  const digest = Checksum256.hash(digestInput);

  const signature =
    opts.signer.kind === 'passkey'
      ? await signDigestWithPasskey({
          digest: digest.array,
          chainPublicKey: opts.signer.chainPublicKey,
          credentialIdHex: opts.signer.credentialIdHex,
        })
      : PrivateKey.from(opts.signer.privateKey).signDigest(digest);

  return { signature: String(signature) };
}
