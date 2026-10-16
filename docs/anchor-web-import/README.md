# Anchor 网页直接授权导入

2026-10-16：导入钱包新增独立的“通过 Anchor 授权”入口。原有“通过 eos3.app 授权”入口保留，用于 eos3.app 的账户。

Anchor 路径：导入钱包 → 通过 Anchor 授权 → 生成或恢复本机待授权密钥 → 直接打开 `https://vaulta.anchorwallet.io/sign` 连接已有 Passkey 账户 → 回到手机核对账户名与本机公钥 → 确认并通过 Anchor 网页签名 → API 代付广播 → 手机独立查询链上 active 权限后导入。

整个 Anchor 路径不加载 eos3.app 网页，不请求 Google 登录，不发出 `anchor://` 或 `esr://` 应用跳转。`eos3.app` 仅作为已部署的设备授权 API，调用 `/api/passkey-chain/device-keys/account/build` 和 `/push`。没有增加依赖或更改依赖锁文件，也不需要本次再部署 Go API。

连接和签名使用现有 WharfKit ESR 编码、Anchor Link 密封消息及一次性回调频道。按照 `@wharfkit/wallet-plugin-anchor@1.7.3` 的 web transport 格式构造 `/sign?esr=…&chain=…&requestKey=…` 和 `/sign?sealed=…&nonce=…&…`。通过 Expo 系统浏览器认证会话打开 Anchor，签名响应经一次性 relay 回传，收到后结束认证会话或回到 App。若系统没有自动返回，可关闭网页继续。回调中的账户名仅用来构建待核对请求，不作为账户访问证明。

会话密钥只在内存保留，且与控制账户的密钥不同；本机设备私钥始终留在加密 vault，不发送给 Anchor 或 API。签名前核对当前主网权限、完整序列化交易字节和固定代付 action，只允许保留全部旧权限并新增本机权重 1 密钥。拒绝费用转账、额外操作、网络/账户/公钥替换、过期请求、多签阈值变化和旧设备移除。同名设备的自动替换也会被拒绝，提示先改名。

签名响应必须对应同一请求、账户、网络和交易 ID；广播仍使用核对过的原始字节。API 与链执行签名验证。成功响应后还需通过手机所选主网节点检查本机公钥拥有足够 active 权重，才能写入钱包并清除 pending。取消、签名失败或网络问题保留待授权密钥，可重试或检查链上授权。页面卸载或网络切换会停止回调监听，避免在已离开的页面继续请求签名或广播。

验证：53 项相关 Jest 测试（Anchor web 传输、交易字节校验、API 选择、原有设备密钥导入和页面流程），项目强制执行的 45 项依赖/原生构建策略测试、TypeScript 类型检查。使用生成的公开 identity 请求在浏览器访问 Anchor 官方站点，确认请求被识别并可进入已有账户连接页面；另用一次性频道实测 cb.anchor.link 的二进制回调收发，内容与发送值一致。截图见 `anchor-web-direct.jpg`。

初次接入时仅验证公开 identity 请求和回调收发；后续 Android Google Play 虚拟机的真实 Passkey 验证见下文。已安装的旧版本不会仅因网页部署而获得客户端修复。

参考：[Anchor 官方开发指南](https://anchorwallet.io/developers)、[WharfKit Anchor 插件](https://github.com/wharfkit/wallet-plugin-anchor)、[Expo 57 WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/)。

## Android 返回钱包后的网络恢复

修复验证后返回钱包时直接出现 `java.net.SocketException: Software caused connection abort` 的恢复流程：

- 收到 relay 响应后，先完成系统回跳并等待钱包恢复前台，再读取 RPC 或提交签名。
- 读取账户权限使用同链 RPC 故障切换；最终导入校验沿用已验证的可用节点。
- 连接成功后立即在内存中保留 Anchor 会话。RPC/API 网络失败会保留账户和待授权密钥，显示“重试并继续导入”，重试只重新读取和生成待核对交易。
- 未签名的 build 请求可以有界重试；签名后的 push 始终只尝试一次。若 push 响应丢失，需检查链上授权或重新获取并确认待签名交易，不能自动重复广播。
- 离开页面时取消前台等待、网络请求和重试计时器。切换网络或待授权密钥后不复用旧会话。

回归测试模拟 Android 前后台切换、SocketException、不可用和错误链节点、保留会话后重试、丢失广播响应及中途退出。此修复需要新的完整安装包，不会通过热更新进入已安装的 1.0.5。

## 同设备返回与真实 Passkey 验证

参照 [WharfKit 同设备 ESR 元数据](https://github.com/wharfkit/js/blob/dev/packages/protocol-esr/src/esr.ts)，连接与签名请求加入 `same_device=true` 和固定的 `return_path=eos3wallet://device-key-authorized?provider=anchor`。这两个值编码在 ESR info 中，不是 `/sign` 顶层查询参数。签名页面会读取返回路径；截至本次验证，Anchor 网页的 identity 登录分支只发送回调并返回账户首页，可能仍需关闭网页一次。

Android 在 Chrome/Google Passkey 验证期间可能以 `Software caused connection abort` 中断钱包的 WebSocket。Anchor 的回调 POST 已成功（HTTP 200），Buoy 会缓冲消息。钱包恢复前台时重新订阅该频道；浏览器的 `dismiss`、`cancel` 或 `success` 结果均先给予 8 秒恢复窗口，避免把已经完成的登录误判为取消。真正的拒绝、离开导入页面和超时仍会停止监听并清理计时器。

2026-10-16 在既有 `EOS3_Passkey_API35`（Android 15、Google Play、已有 Google 账户和屏幕锁）上完成验证：真实 Anchor Passkey 登录，关闭登录网页后恢复已缓冲的 identity 回调，生成并核对授权交易；经用户确认后签名，自动返回钱包，广播、链上权限校验和导入全部成功。独立主网查询确认新增设备公钥生效、原 Passkey 保留、active 阈值仍为 1。测试使用现有开发客户端加载本地源码，诊断日志和直达测试页面的导航只存在于临时副本，正式源码无这些调试修改；尚未以新的正式 APK 复测。
