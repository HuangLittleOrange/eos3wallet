# 深链接入

钱包通过 `/tgbind?bindId=...` 接收第三方绑定请求。路由配置位于 [RootNavigator.tsx](../src/navigation/RootNavigator.tsx)，应用域名关联配置位于 `app.json`。

## iOS

在自有域名的 `/.well-known/apple-app-site-association` 部署关联声明，填写对应的应用标识和支持路径。仓库中的 [apple-app-site-association](../well-known/apple-app-site-association) 可作为结构参考，独立应用需要替换其中的标识。

文件使用 JSON 格式，无文件扩展名。相关应用能力包括 Universal Links 和 Passkey 域名关联。

## Android

在自有域名的 `/.well-known/assetlinks.json` 声明应用包名、签名证书指纹和关联能力，并与 `app.json` 中的 App Links 配置一致。仓库中的 [assetlinks.json](../well-known/assetlinks.json) 可作为结构参考。

固定正式 Android 证书的指纹来自 [签名策略](../android-signing-policy.json)，已加入仓库关联文件。生成正式签名 APK 后，还需将该文件部署到对应域名；提交仓库不会自动更新服务器。证书轮换前应保留仍受支持安装包的指纹，部署后验证 Passkey 和 HTTPS 深链。

## 验证

使用有效的绑定请求，在安装了应用的真机上打开对应 HTTPS 链接，确认进入授权页面。

开发阶段可以使用自定义 scheme 检查路由：

```bash
npx uri-scheme open "eos3wallet://tgbind?bindId=YOUR_BIND_ID" --ios
npx uri-scheme open "eos3wallet://tgbind?bindId=YOUR_BIND_ID" --android
```

自定义 scheme 测试只检查应用内跳转；域名关联还需单独验证。更多说明见 [Apple Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app) 和 [Android App Links](https://developer.android.com/training/app-links)。
