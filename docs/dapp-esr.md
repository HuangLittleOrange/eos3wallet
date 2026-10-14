# DApp 浏览器的 Anchor / ESR 与 TokenPocket

Anchor 登录和签名链接统一进入 ESR 流程。浏览器页面只接入入口与页面生命周期，协议解析、签名和回调由公共流程负责。

| 模块 | 职责 |
| --- | --- |
| `src/dapp/esr-links.ts` | 链接识别、URI 归一化和 WebView 协议白名单；不依赖钱包或网络。 |
| `src/dapp/injected-esr.ts` | 生成网页里的点击和 location 拦截脚本，使用 provider 已有的 `call()` 桥。链接规则来自 `esr-links.ts`。 |
| `src/dapp/use-browser-esr.ts` | 汇合网页桥、当前窗口导航、新窗口链接，接入同一个 `useEsrFlow`；普通网页链接交回浏览器。 |
| `src/dapp/useEsrFlow.ts` | 请求状态、去重、失效处理、认证、资源修复、签名、回调及结果反馈。 |
| `src/dapp/esr.ts` | 协议解析、链与回调校验、交易解析和签名回调实现。 |
| `src/dapp/esr-flow-overlay.tsx` | 共用的解析进度、确认弹窗和资源修复弹窗。展示的账户、权限和链来自同一个 flow。 |
| `src/dapp/EsrRequestHost.tsx` | 认领扫码或 Link 会话推送的请求，复用 flow 与 overlay，不创建占位网页。 |

浏览器在 `onMessage` 校验桥 token、页面来源和 document 后，才调用 `handleBridgeRequest`。确认桥接消息仅表示收到请求，签名仍需用户在原生弹窗确认。

WebView 必须使用 hook 提供的 `originWhitelist`。白名单检查发生在导航回调之前；遗漏 ESR 协议会把链接交给系统，使封闭 Shadow DOM 内的 Anchor 按钮失效。`onOpenWindow` 也接入同一个 hook。

页面开始加载或跨来源导航时调用 `invalidate()`。钱包上下文变化、切后台、卸载、并发请求与认证期间的失效由 `useEsrFlow` 处理。网页桥和导航重复截获同一条请求时，也由 flow 的同步占位避免重复解析。

`eosio:账户名` 收款链接不属于 ESR，只有 `eosio://link` 是旧版签名请求传输。HTTP 页面可提交需要明确确认的 ESR 链接，不因此获得钱包连接或账户 API 权限。

主要回归测试：`use-browser-esr.test.ts`、`esr-flow-overlay.test.ts`、`injected.test.ts`、`useEsrFlow.test.ts`、`esr.test.ts` 和 `accessGuard.test.ts`。

## TokenPocket 兼容

| 模块 | 职责 |
| --- | --- |
| `src/dapp/injected-token-pocket.ts` | `window.tp`、`TPJSBrigeClient.callMessage`、SDK 方法分发、参数与返回结构适配。通过显式依赖使用共用桥和已授权身份。 |
| `src/dapp/use-token-pocket-browser.tsx` | 原生页面操作、历史读取、扫码弹窗、分享、收藏、存图、全屏、菜单和导航手势。浏览器传入返回、关闭与打开导入页的动作。 |
| `src/dapp/token-pocket-user-agent.ts` | TP User-Agent 标记与 Android UA 组装，保留当前的设备信息及 iOS 默认 UA。 |
| `src/dapp/injected.ts` | 组装共用桥、Scatter、TP 和 ESR 脚本，统一 document/token 与账户授权。 |

TP 适配层将钱包读取和签名转换为公共的 `getIdentity`、`getBalance`、`requestSignature` 等请求。账户授权、交易解码、链校验、签名确认仍使用浏览器已有的公共桥，页面操作 hook 不另开签名通道。

`window.tp` 的业务失败保持 `{ result: false, data: null, msg }`，SDK 桥继续通过指定的全局回调名返回 JSON 字符串。扫码仍返回字符串，返回/关闭/全屏等调用仍不返回值，其他链的方法仍明确返回不支持。

`use-token-pocket-browser.test.ts` 覆盖原生动作、扫码取消、读取失败与重试、上下文更新和响应；`token-pocket-user-agent.test.ts` 覆盖 UA；`injected.test.ts` 覆盖 SDK 全量方法与 Scatter/TP 的接口约定。
