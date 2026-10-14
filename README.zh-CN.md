# EOS³ Wallet

[English](README.md) | **简体中文**

基于 Expo SDK 57、React Native 和 TypeScript 的 EOS / Vaulta 移动钱包，面向 Vaulta 主网。

## 功能

- 私钥导入、观察账户、付费开户、Google / Passkey 登录和设备密钥授权导入。
- 代币余额、资产估值、资源管理、交易记录、转账和 Memo。
- RAM、抵押、REX、PowerUp 和资源代付。
- 主密码加密、生物识别解锁、私钥导出和授权管理。
- 内置 DApp 浏览器、Scatter / TokenPocket 兼容接口、ESR / Anchor 签名和会话管理。
- 地址簿、二维码、多语言、发现页和 Android 更新检查。

## 本地开发

使用 Node.js 22.13 或更高版本，并通过仓库中的锁文件安装依赖。SDK 要求见 [Expo 57 文档](https://docs.expo.dev/versions/v57.0.0/)。

默认禁用依赖安装脚本。使用下面的安装入口明确应用已审查的安全补丁；测试和 Metro 构建会检查依赖来源、锁文件及补丁，详见[依赖安全维护](docs/dependency-security.md)。

```bash
npm run install:safe
npm start
```

完整钱包功能需要原生开发构建。Android 需要 Android SDK；iOS 需要 macOS 和 Xcode。

```bash
npm run android
npm run ios
```

网页预览：

```bash
npm run web
```

网页预览不支持全部原生密钥存储、Passkey 和生物识别能力。

可选环境配置：

```bash
cp .env.example .env.local
```

`EXPO_PUBLIC_CONTENT_API_URL` 用于指定发现页、公告和帮助内容的数据服务。不设置时使用默认服务。`EXPO_PUBLIC_*` 会进入客户端安装包，仅用于公开配置。

## 验证

```bash
npm test -- --runInBand
npm run typecheck
npm run check:source
```

原生存储、Passkey、深链和签名流程还需真机验证。主网操作会改变真实链上状态，请在确认网络、账户和交易内容后签名。

使用 Docker 可在不挂载本机环境文件、钱包备份和签名凭据的容器内安装、核验依赖来源、测试并生成 Android / iOS JavaScript 包：

```bash
npm run verify:isolated
```

结果保存于已忽略的 `exports/isolated-review/`。此入口用于 JavaScript 验证。

在装有 JDK 17、Android SDK 36、Build Tools 36.0.0、NDK 27.1.12297006 和 CMake 3.22.1 的 macOS 上，可生成原生测试 APK：

```bash
npm run build:android:isolated
```

该入口在 macOS 沙箱内生成未签名 APK，随后在独立沙箱中用一次性测试密钥签名，输出位于 `exports/native-review/`。编译使用离线 Gradle 依赖缓存，不复制本机 Gradle 初始化脚本或凭据配置；缓存不足时停止。测试签名与正式签名不同，不能用于覆盖正式安装。流程与限制见[原生构建与签名](docs/native-build-security.md)。

## 公开 APK 构建

[GitHub Actions 流程](.github/workflows/android-build.yml)在 `main` 更新时构建，也支持从 `main` 手动运行。每次构建记录具体提交、依赖锁文件和源码文件哈希，并公开固定正式证书签名的 APK、未签名 APK、`SHA256SUMS` 和 GitHub 来源证明。编译、独立正式签名、来源证明和发布分别在新 runner 上执行；签名秘密仅供独立签名步骤使用。全部验证成功后自动发布到 Releases，标记为正式发布。发布标题与说明使用英文，标题显示 APK 的实际应用版本；附件仅保留 APK、外层校验文件和完整证据 ZIP，来源证明、公开证书与元数据均包含在 ZIP 内。

在公开仓库的 **Actions → Public Android APK** 中查看日志、APK 哈希和校验命令，下载成功运行的 `android-public-…` 产物。启用方式、用户校验方法与正式发行说明见[公开构建与来源核验](docs/github-android-build.md)。

来源证明将文件绑定到仓库、工作流和具体源码提交；它不代表独立安全审计或已实现可复现构建。

## 钱包安全

普通私钥通过主密码派生密钥进行 AES-GCM 加密，并保存于系统安全存储。启用生物识别后，主密码保存于需要系统认证的安全存储条目；待激活账户的临时私钥由系统安全存储保护，保存钱包后转入常规加密存储。Passkey 钱包不在客户端保存资产私钥。

转账和 DApp 签名需要用户确认。代付交易会核对实际操作与手续费；第三方绑定会检查转账权限和链上额度是否符合确认内容。仅支持可验证的受限支付绑定，额外的通用合约操作会被拒绝，详见[绑定安全说明](docs/binding-security.md)。

导出私钥会显示明文，复制时会写入系统剪贴板，请妥善保管。浏览器连接按网站、账户与网络授权，仅在本次浏览器会话中保留；退出连接会撤销授权。持久 DApp 会话可在会话管理中撤销。

## 外部服务与隐私

本仓库包含钱包客户端，部分登录、内容、更新和代付能力依赖外部服务。客户端在本机保存资产私钥，签名交易和必要的请求数据会发送给相应服务。

| 接收方 | 相关数据 |
| --- | --- |
| RPC / 历史节点 | 账户、公钥反查、余额与历史请求、广播交易 |
| 行情服务 | 代币或交易对查询 |
| Google / Passkey 登录服务 | 登录授权、凭据注册和认证信息 |
| Android 扫码 SDK（Google ML Kit） | 设备与应用信息、安装标识、API 性能和使用诊断；识别输入与结果在设备上处理，见 [ML Kit 隐私说明](https://developers.google.com/ml-kit/terms) |
| 授权与代付服务 | 账户、授权设置、待签交易及签名结果 |
| 内容、图片与更新服务 | 网络请求、更新检查所需的平台与版本信息 |
| DApp / ESR / Anchor Link | 账户、公钥、签名结果及连接信息；持久会话消息通过转发服务传输 |

链上账户与交易是公开数据，外部服务也可能记录请求 IP 和时间。内置 DApp 在用户同意连接后向该 HTTPS 网站提供账户和公钥。兼容接口还提供语言、系统与应用版本，以及按网站生成的随机设备标识。

本节说明客户端的数据流，不代替所接入服务的隐私政策。

## 独立构建

独立发行时，请设置自己的应用标识、域名关联、构建配置和服务地址：

| 位置 | 配置内容 |
| --- | --- |
| `app.json` / `app.config.ts` / `eas.json` | 应用身份、原生权限和构建配置 |
| `src/passkey/constants.ts` | 登录、Passkey 和代付服务配置 |
| `src/chain/config.ts` | 网络、节点和合约配置 |
| `src/content/defaults.json` | 内置内容与链接 |
| `well-known/` | 域名与应用的关联声明 |

更换 Passkey 域名需要配套服务与应用关联配置，并考虑既有凭据的兼容性。[深链接入说明](docs/universal-links.md)介绍相关配置。

## 目录结构

```text
src/
├── chain/        链配置、钱包状态、资源与交易校验
├── crypto/       密钥生成与加密存储
├── passkey/      登录与 Passkey 签名
├── dapp/         DApp 协议与会话管理
├── content/      内容加载
├── net/          网络请求
├── update/       Android 更新
├── components/   公共组件
├── screens/      页面
├── navigation/   路由与深链
├── i18n/         多语言
└── theme.ts      样式
```

## 许可证

项目采用 [MIT 许可证](LICENSE)。第三方依赖与素材遵循各自的许可证和版权声明，见[第三方声明](THIRD_PARTY_NOTICES.md)。分发安装包时也需附带这些声明。
