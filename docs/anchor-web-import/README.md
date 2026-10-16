# Anchor 网页直接授权导入

2026-10-16：导入钱包新增独立的“通过 Anchor 授权”入口。原有“通过 eos3.app 授权”入口保留，用于 eos3.app 的账户。

Anchor 路径：导入钱包 → 通过 Anchor 授权 → 生成或恢复本机待授权密钥 → 直接打开 `https://vaulta.anchorwallet.io/sign` 连接已有 Passkey 账户 → 回到手机核对账户名与本机公钥 → 确认并通过 Anchor 网页签名 → API 代付广播 → 手机独立查询链上 active 权限后导入。

整个 Anchor 路径不加载 eos3.app 网页，不请求 Google 登录，不发出 `anchor://` 或 `esr://` 应用跳转。`eos3.app` 仅作为已部署的设备授权 API，调用 `/api/passkey-chain/device-keys/account/build` 和 `/push`。没有增加依赖或更改依赖锁文件，也不需要本次再部署 Go API。

连接和签名使用现有 WharfKit ESR 编码、Anchor Link 密封消息及一次性回调频道。按照 `@wharfkit/wallet-plugin-anchor@1.7.3` 的 web transport 格式构造 `/sign?esr=…&chain=…&requestKey=…` 和 `/sign?sealed=…&nonce=…&…`。通过 Expo 系统浏览器认证会话打开 Anchor，签名响应经一次性 relay 回传，收到后结束认证会话或回到 App。若系统没有自动返回，可关闭网页继续。回调中的账户名仅用来构建待核对请求，不作为账户访问证明。

会话密钥只在内存保留，且与控制账户的密钥不同；本机设备私钥始终留在加密 vault，不发送给 Anchor 或 API。签名前核对当前主网权限、完整序列化交易字节和固定代付 action，只允许保留全部旧权限并新增本机权重 1 密钥。拒绝费用转账、额外操作、网络/账户/公钥替换、过期请求、多签阈值变化和旧设备移除。同名设备的自动替换也会被拒绝，提示先改名。

签名响应必须对应同一请求、账户、网络和交易 ID；广播仍使用核对过的原始字节。API 与链执行签名验证。成功响应后还需通过手机所选主网节点检查本机公钥拥有足够 active 权重，才能写入钱包并清除 pending。取消、签名失败或网络问题保留待授权密钥，可重试或检查链上授权。页面卸载或网络切换会停止回调监听，避免在已离开的页面继续请求签名或广播。

验证：53 项相关 Jest 测试（Anchor web 传输、交易字节校验、API 选择、原有设备密钥导入和页面流程），项目强制执行的 45 项依赖/原生构建策略测试、TypeScript 类型检查。使用生成的公开 identity 请求在浏览器访问 Anchor 官方站点，确认请求被识别并可进入已有账户连接页面；另用一次性频道实测 cb.anchor.link 的二进制回调收发，内容与发送值一致。截图见 `anchor-web-direct.jpg`。

未代用户执行真实 Passkey 登录、签名或账户权限修改。iOS/Android 系统浏览器中的完整授权与回跳仍需真机验证。本次是手机端代码更新，未生成或分发新版 APK/IPA；已安装的旧版本不会仅因网页部署而获得这个入口。

参考：[Anchor 官方开发指南](https://anchorwallet.io/developers)、[WharfKit Anchor 插件](https://github.com/wharfkit/wallet-plugin-anchor)、[Expo 57 WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/)。
