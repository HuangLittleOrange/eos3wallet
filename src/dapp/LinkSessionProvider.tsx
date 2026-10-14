// 挂在 App 根部的常驻组件——App 在前台时,一直监听本机的 Anchor Link
// 接收频道(见 linkSocket.ts),收到已知会话推来的签名请求就直接弹确认框,
// 不需要用户再扫一次码。不渲染任何东西,纯副作用。
//
// App 退到后台就断开——没必要为了"可能收到的推送"一直占着一条 WebSocket,
// 况且大多数系统本来也不会让后台的 RN App 一直保持网络连接。重新回到前台
// 会自动重连。
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';

import { useDappSession } from './DappSessionContext';
import { isEsrLink } from './esr-links';
import { getLinkIdentity } from './linkIdentity';
import { sealedMessageFromWire, unsealMessage } from './linkCrypto';
import { listenLinkChannel, LinkChannelListener } from './linkSocket';
import { isKnownLinkSession } from './linkSessions';

export default function LinkSessionProvider() {
  const { openEsr } = useDappSession();
  // openEsr 每次渲染都是新引用(DappSessionContext 里 useCallback 依赖为空数组,
  // 其实稳定,但不想让这个 effect 的依赖数组跟着它走、导致前后台切一次就
  // 重新订阅一遍),用 ref 存最新的,effect 本身只跑一次
  const openEsrRef = useRef(openEsr);
  openEsrRef.current = openEsr;

  // 已经成功处理过的 (发送方, nonce)——密封消息本身没有时效字段,截获一条旧
  // 消息原样重放,解封照样成功、确认框照样会弹。记住最近处理过的 nonce 去重,
  // 只在内存里留一份就够:App 重启后旧请求里的交易早过了 expiration,链上
  // 自然拒收,不需要落盘。上限内先进先出,防止长期运行无限膨胀。
  const seenNoncesRef = useRef<Set<string>>(new Set());
  const MAX_SEEN_NONCES = 500;

  useEffect(() => {
    let cancelled = false;
    let listener: LinkChannelListener | null = null;

    const handleMessage = async (raw: Uint8Array) => {
      try {
        const sealed = sealedMessageFromWire(raw);
        // 先比对"认不认识这个发送方",不认识的直接丢弃——不用白跑一次
        // ECDH+AES 解密,也不会弹确认框打扰用户(见 linkSessions.ts 顶部注释,
        // 这就是撤销会话的实际生效点)
        if (!(await isKnownLinkSession(String(sealed.from)))) return;
        const replayKey = `${String(sealed.from)}:${String(sealed.nonce)}`;
        if (seenNoncesRef.current.has(replayKey)) return;
        const identity = await getLinkIdentity();
        const plaintext = unsealMessage(sealed, identity.privateKey);
        // 解封成功才记入去重表——伪造/损坏的消息不占名额,也不会把同一条
        // 合法消息"第一次就没处理成"的重试挡在门外
        seenNoncesRef.current.add(replayKey);
        if (seenNoncesRef.current.size > MAX_SEEN_NONCES) {
          seenNoncesRef.current.delete(seenNoncesRef.current.values().next().value!);
        }
        // 解密出来的是签名请求本体(不带 esr: 前缀也一样接得住)
        openEsrRef.current(isEsrLink(plaintext) ? plaintext : `esr:${plaintext}`);
      } catch {
        // 解不开/格式不对的推送——校验和错、伪造的、传输中坏掉,统统当噪音
        // 丢弃,不弹任何东西打扰用户
      }
    };

    // 读接收身份要等一次异步,这中间可能又来一次 active——不挡住的话会
    // 订阅出两条监听同一频道的连接,同一条推送被处理两遍(第二遍撞上去重表
    // 才没弹出两个确认框),而且旧的那条永远没人 stop()。wanted 记的是
    // "现在到底还想不想听",await 回来先对一遍,免得 stop() 之后才把连接建起来。
    let wanted = false;
    let starting = false;
    const start = async () => {
      wanted = true;
      if (listener || starting) return;
      starting = true;
      try {
        const identity = await getLinkIdentity();
        if (!wanted || cancelled) return;
        listener = listenLinkChannel(identity.channelUrl, handleMessage);
      } catch {
        // 接收身份读不出来(SecureStore 一过性抖动之类)——这是个静默的后台
        // 功能,不该弹任何东西打扰用户;下次前后台切换会自动再试一次
      } finally {
        starting = false;
      }
    };
    const stop = () => {
      wanted = false;
      listener?.stop();
      listener = null;
    };

    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') start();
      else stop();
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      cancelled = true;
      sub.remove();
      stop();
    };
  }, []);

  return null;
}
