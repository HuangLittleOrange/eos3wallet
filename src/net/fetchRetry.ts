// 网络请求里两类经常各自撞上、又各自修一遍的问题,统一收在这里:
//
// 1. TLS 握手偶发失败:fetch() 直接 throw(不是拿到了错误响应)——国内网络到
//    境外服务器尤其常见,单次失败不该直接判定"这个服务不可用"。
// 2. 请求发出去后石沉大海:部分网络环境不是快速失败(连接被拒绝、fetch
//    立刻 reject),而是底层 socket 一直挂起,原生 fetch 没有默认超时,
//    调用方的 try/catch 只能兜住"拒绝",兜不住"一直不响应"。
//
// 教训:这两段逻辑曾经在 chain/client.ts、chain/sponsor.ts、chain/eos3Sign.ts
// 里各自抄了一份,新增的网络调用很容易忘了抄——chain/transact.ts 的广播路径
// 和 chain/abiCache.ts 的 ABI 拉取就都漏过,直接后果是用户偶发网络抖动就看到
// 原始的系统异常(比如 "TLS 错误导致安全连接失败"),还得手动重试一遍操作。
// 以后任何直连节点/后端的 fetch,优先复用这里的两个函数,不要再各写一份。

/**
 * 带重试的 fetch。只重试"连接本身失败"这一种情况——HTTP 层面正常返回的
 * 业务错误(4xx/5xx)不重试,那是确定性的结果,重试没有意义,调用方该按
 * 状态码/响应体自己判断分流。
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { attempts?: number; backoffMs?: number; timeoutMs?: number }
): Promise<Response> {
  const attempts = opts?.attempts ?? 3;
  const backoffMs = opts?.backoffMs ?? 300;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (init?.signal?.aborted) throw cancellationError();
    try {
      return await (opts?.timeoutMs ? fetchWithTimeout(input, init, opts.timeoutMs) : fetch(input, init));
    } catch (e) {
      if (init?.signal?.aborted) throw cancellationError();
      lastErr = e;
      if (i < attempts - 1) await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancellationError()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, backoffMs * (i + 1));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  throw lastErr;
}

/** 带超时的 fetch——单次请求挂起太久就主动放弃,不等底层网络栈自己放弃。 */
export async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  if (init?.signal?.aborted) throw cancellationError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  init?.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', abort);
  }
}

function cancellationError(): Error {
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  return error;
}
