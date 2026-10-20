# GitHub Actions iOS 打包与 TestFlight

[iOS TestFlight 工作流](../.github/workflows/ios-testflight.yml)在 GitHub 托管的 `macos-26` 上使用 Xcode 26.4.1 / iOS SDK 26.4 编译。开发电脑不需要升级 macOS，也不需要安装 Xcode。流程不调用 EAS Build、EAS Submit 或 EAS Update，不需要 Expo 账号、Token 或远程凭据。

项目保留 Expo SDK 57 和原生模块，使用锁定依赖中的本地模板执行 Prebuild；这是生成 Xcode 工程的本地工具，不是 Expo 云构建。应用标识保持 `com.eos3.wallet`。

## 一次性配置

需要有效的 Apple Developer Program 会员，以及 App Store Connect 中同 Bundle ID 的应用记录。

在仓库 **Settings → Environments** 创建两个环境，将 **Deployment branches and tags** 设为 **Selected branches and tags → Branch: main**。可按团队需要设置 Required reviewers。

### `ios-production-signing`

在该环境中添加以下 Secrets：

| Secret | 内容 |
|---|---|
| `IOS_DISTRIBUTION_P12_BASE64` | Apple Distribution 证书及对应私钥导出的 `.p12` 文件，Base64 编码 |
| `IOS_DISTRIBUTION_P12_PASSWORD` | 导出 P12 时的密码；无密码的 P12 可留空 |
| `IOS_APP_STORE_PROFILE_BASE64` | `com.eos3.wallet` 的 **App Store Connect** 分发描述文件，Base64 编码 |

在这个环境的 **Variables** 中添加 `APPLE_TEAM_ID`，值为十位 Apple Developer Team ID（不是 App Store Connect 的数字应用 ID）。

在 Apple Developer → Certificates, Identifiers & Profiles 中，确认 App ID 已启用 **Associated Domains**，再为它创建 App Store Connect 描述文件；文件必须包含 P12 对应的分发证书，且未过期。此前 EAS 使用的 Apple Distribution 证书可以复用，但 **Ad Hoc / Development / Enterprise 描述文件不能用于 TestFlight**。不需要收集用户 UDID。

可以通过 GitHub CLI 从本地文件上传，不把编码内容打印到终端：

```bash
base64 -i /absolute/path/distribution.p12 | gh secret set IOS_DISTRIBUTION_P12_BASE64 --env ios-production-signing
gh secret set IOS_DISTRIBUTION_P12_PASSWORD --env ios-production-signing
base64 -i /absolute/path/app-store.mobileprovision | gh secret set IOS_APP_STORE_PROFILE_BASE64 --env ios-production-signing
gh variable set APPLE_TEAM_ID --env ios-production-signing --body YOUR_TEAM_ID
```

请在本仓库目录执行；替换文件路径和 Team ID。密码命令会交互读取，不要把密码放进命令参数。

### `ios-testflight`

在 App Store Connect → Users and Access → Integrations → App Store Connect API 创建具有应用上传权限的 **Team API Key**，例如 Developer 角色。下载 `.p8` 并妥善保存；Apple 只允许下载一次。该流程使用 Team Key 的 Issuer ID，不使用个人 API Key。

| Secret | 内容 |
|---|---|
| `APP_STORE_CONNECT_KEY_ID` | 十位 API Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | API 页面的 Issuer ID，UUID 格式 |
| `APP_STORE_CONNECT_PRIVATE_KEY_BASE64` | `AuthKey_XXXXXXXXXX.p8` 文件，Base64 编码 |

```bash
gh secret set APP_STORE_CONNECT_KEY_ID --env ios-testflight
gh secret set APP_STORE_CONNECT_ISSUER_ID --env ios-testflight
base64 -i /absolute/path/AuthKey_XXXXXXXXXX.p8 | gh secret set APP_STORE_CONNECT_PRIVATE_KEY_BASE64 --env ios-testflight
```

不要把 P12、P8、密码、描述文件或它们的 Base64 值提交到 Git。应用代码、npm 安装、配置插件和 CocoaPods 不会在持有上述凭据的作业中执行。

## 触发打包

将工作流和相关修改合入 `main` 后，在 **Actions → iOS TestFlight → Run workflow**：

1. 分支选择 `main`。其他分支、PR、标签推送不会触发发行。
2. `build_number` 填写比此前所有 iOS 包更大的正整数，最多九位。先在 App Store Connect 确认最高构建号；不要只依赖旧文档或 GitHub 运行次数。来自 EAS 的旧包同样占用构建号，重跑已上传构建时也必须换新号。
3. 默认勾选 `upload_to_testflight`，签名后自动上传。取消勾选则仅生成签名 IPA，不需要上传 API Key，但仍需要签名环境。

命令行触发示例（`27` 只是格式示例，执行前确认它高于已有构建号）：

```bash
gh workflow run ios-testflight.yml --ref main -f build_number=27 -f upload_to_testflight=true
```

版本名取自 `app.json` 的 `expo.version`；构建号通过 `IOS_BUILD_NUMBER` 注入 iOS 配置。流程不使用 `eas.json` 的远程版本号，不改写源文件，也不改变 Android `versionCode`。需要发布新版本名时，先更新 `app.json` 并合入 main。并发运行排队，显式构建号仍由操作者确保递增。

## 作业与交付物

1. **build**：校验触发上下文和工具链，安装锁定依赖、核验来源与安全补丁，运行测试和类型检查，生成工程、安装 Pods，再用 `CODE_SIGNING_ALLOWED=NO` 归档。随后以不使用证书的 ad hoc 签名保留 Associated Domains 权限，供后续 Xcode 导出重新签名；此归档不能直接分发安装。
2. **sign**：新 VM 只检出标准库控制脚本，校验本次运行的归档摘要、版本号和身份，创建临时钥匙串，检查证书、描述文件和 Team ID，再通过 `xcodebuild -exportArchive` 生成 App Store Connect IPA。检查最终签名及 `webcredentials:eos3.app` / `applinks:eos3.app` 权限，保存 IPA 和 dSYMs。不运行 npm、Pods、应用构建脚本或 Fastlane。
3. **upload**：另一台新 VM 只获取已签名产物，校验摘要和包内版本，然后使用 Apple `altool` 和 API Key 验证并上传。上传密钥不进入签名作业。

Actions Artifacts：

| 名称 | 内容 |
|---|---|
| `ios-unsigned-<run_id>-<attempt>` | 无 Apple 身份签名的 `Wallet.xcarchive.tar.gz`、工具链与源码提交信息、SHA-256 |
| `ios-signed-<run_id>-<attempt>` | `wallet.ipa`、`dSYMs.zip`、构建与签名信息、`SHA256SUMS` |
| `ios-upload-<run_id>-<attempt>` | 上传成功回执 `upload-result.json` |
| `ios-build-failed-<run_id>-<attempt>` | 原生工程生成、Pods 或归档失败时的可用日志 |

构建和产物保留 90 天，失败日志保留 14 天，实际也受仓库保留策略约束。及时将各渠道最新 IPA、归档、dSYMs、校验文件和报告下载到稳定发布目录，避免 artifact 到期后无法取回；脚本不会自动删除已有发布交付物。导入的证书、描述文件、API Key、原生构建中间文件和本次依赖安装在结束时清理，托管 VM 最终销毁。签名/上传作业同时有脚本 `finally` 与 Actions `always()` 清理，突然终止时仍以托管 VM 销毁作为兜底。不要改为持久化的 self-hosted runner。

上传成功只表示 Apple 接受了传输。等待 Apple 处理后，在 **App Store Connect → 应用 → TestFlight** 查看状态并分配测试组，或启用内部组的自动分发；外部组还可能需要 Beta App Review。工作流不自动提交外部审核、不公开邀请链接、不发布 App Store 正式版，也不修改钱包后台更新记录。Apple 拒绝重复构建号、协议待接受、出口合规信息不完整或签名权限错误时，需先处理对应原因。

## 验证范围

控制脚本的自动化测试覆盖触发分支、构建号、错误描述文件、过期凭据、归档路径越界、摘要篡改、跨运行产物替换和 IPA 版本不一致；配置测试确认构建号注入不破坏 Associated Domains 或 Android 版本。`npm test` 会执行这些检查。

当前本机缺少兼容 Xcode，因此本地检查与 Prebuild 验证不代表 iOS 已编译、签名或上传成功。首次配置凭据后，应在 GitHub 完成整条工作流并在 TestFlight 真机验证安全存储、Passkey、关联链接和 Firebase 等原生能力。

参考：[Expo SDK 57 要求](https://docs.expo.dev/versions/v57.0.0/)、[GitHub macOS 26 工具链](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)、[GitHub Apple 签名凭据](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)、[Apple 上传构建](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)。
