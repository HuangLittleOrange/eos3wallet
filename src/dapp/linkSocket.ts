// 常驻监听本机的 Anchor Link 接收频道——dApp 建立会话之后,后续的签名请求
// 会推到这条频道上,不需要再扫一次码。
//
// 频道的传输行为不是"长连接吐多条消息",而是"连上去,等下一条,收到就自动
// 断"——想一直收就得每收完一条马上重新订阅。断线/连不上时才需要退避重试,
// 收到消息后紧接着重连不用等(不然错过 dApp 紧接着推来的下一条请求)。
const MAX_BACKOFF_MS = 10_000;
const MAX_IMMEDIATE_RETRIES = 3;

function backoffMs(tries: number): number {
  return Math.min((tries * 10) ** 2, MAX_BACKOFF_MS);
}

function toWsUrl(channelUrl: string): string {
  return channelUrl.replace(/^http/i, 'ws');
}

/**
 * 这条频道推过来的是二进制帧,不是文本帧,而且内容本身就是二进制的 ABI
 * 编码字节(SealedMessage 结构体,见 linkCrypto.ts),不是 UTF-8 文本——
 * 之前这里先无脑 `String(e.data)`(ArrayBuffer 被转成字面量
 * "[object ArrayBuffer]",刚好 20 字节,巧合到骗过了肉眼),后来发现真收到
 * 内容后又想当然过一遍 TextDecoder,把二进制字节硬解成"文本"同样是错的——
 * 二进制 ABI 字节本来就不是合法 UTF-8,解出来是一堆替换字符,信息已经丢了。
 * 正确做法是保持字节原样,交给上层按 ABI 结构体解码(sealedMessageFromWire）。
 */
function decodeFrame(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error(`unsupported WebSocket frame type: ${Object.prototype.toString.call(data)}`);
}

export type LinkChannelListener = {
  /** 停止监听——App 退到后台/用户主动断开这个频道时调 */
  stop: () => void;
};

/**
 * 订阅一条频道:收到一条消息就回调一次,回调完自动重新订阅接着等下一条。
 * 网络断了/连不上会按退避公式重试,不会因为一次抖动就彻底停摆;`stop()`
 * 之后不会再重连,也不会再触发回调。
 */
export function listenLinkChannel(channelUrl: string, onMessage: (raw: Uint8Array) => void,
  options: { retryImmediately?: () => boolean } = {}): LinkChannelListener {
  let stopped = false;
  let tries = 0;
  let immediateRetries = 0;
  let current: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const socket = new WebSocket(toWsUrl(channelUrl));
    // 明确要二进制帧解成 ArrayBuffer(不是默认的 'blob')——这条频道推的是
    // 二进制帧,解码逻辑(decodeFrame)按 ArrayBuffer 写的,两边要对上。
    socket.binaryType = 'arraybuffer';
    current = socket;
    // 收完一条消息我们会主动 close() 立即重连,不等 onclose 触发的退避逻辑——
    // 这个标记只属于*这一个* socket 实例的闭包,不是几代连接共用的外层变量:
    // 旧连接的 close 事件是异步到达的,如果改用外层共享变量,新连接的 connect()
    // 一开始就会把它重置掉,等旧连接的 close 事件终于到达时,会把它误判成
    // "异常断线"又发起一次重连——两条重连链同时跑,顶着同一个频道抢连接。
    let handledReconnect = false;
    socket.onopen = () => {
      tries = 0; // 连上就算这一轮退避结束,下次真断线从头计
    };
    socket.onmessage = (e) => {
      if (stopped || current !== socket || handledReconnect) return;
      handledReconnect = true;
      socket.close();
      try {
        onMessage(decodeFrame(e.data));
      } catch {
        // 帧格式不对(不是二进制帧/长度为零之类)——当噪音丢弃,继续等下一条
      }
      connect();
    };
    socket.onclose = () => {
      // current !== socket:这个 close 事件来自已经被替换掉的上一代连接
      // (比如 stop() 期间又收到一条消息触发了 connect()),不该由它来决定要不要重连
      if (handledReconnect || stopped || current !== socket) return;
      handledReconnect = true;
      tries += 1;
      // Android pauses RN timers while a Custom Tab / Passkey prompt covers the
      // app. A timer-only reconnect would wait for the very return this callback
      // must trigger. Native socket events still run; allow a bounded recovery
      // without timers for that transport, then fall back to normal backoff.
      if (immediateRetries < MAX_IMMEDIATE_RETRIES && options.retryImmediately?.()) {
        immediateRetries += 1;
        connect();
      } else retryTimer = setTimeout(connect, backoffMs(tries));
    };
    // onerror 后面必然紧跟一次 onclose,退避统一交给 onclose 处理,
    // 这里不接管:一次错误如果两边都调 connect(),会排上两条重连队列
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.close();
      current = null;
    },
  };
}
