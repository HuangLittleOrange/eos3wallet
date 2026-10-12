# 第三方声明

本项目代码使用根目录的 MIT 许可证。第三方代码、字体、图标和商标遵循其各自条款。

## 依赖

锁定依赖的许可证与版权文本保存在 [npm-notices.txt](third-party/npm-notices.txt)。完成 `npm ci` 后可运行 `npm run licenses` 重新生成；未找到许可证或安装版本与锁文件不一致时，生成命令会失败。部分 npm 包未附许可证文件，其上游原文及来源保存在 [upstream-licenses.json](third-party/upstream-licenses.json)。

`patches/` 中记录 elliptic 与 node-forge 的本地安全修改；保留其原许可证与版权声明，修改范围及来源见[依赖安全维护](docs/dependency-security.md)。公开 P521 测试密钥来自该文档链接的上游漏洞复现，禁止用于真实钱包或接收资产。

WharfKit Session 使用带有非军事使用限制的 BSD 条款；这项限制不会因本项目采用 MIT 许可证而消失。MPL 依赖的源文件及其修改仍受 MPL 约束。分发二进制时，应保留所包含依赖的声明，并提供相应受约束源码的获取方式。

其中 `fast-base64-decode`、`structured-headers` 和旧版 `tr46` 没有可获取的独立版权文本，随附记录保留了发布版本的 MIT 声明、作者元数据和标准条款。

原生加密依赖的随附 SIMD / BLAKE3 / ncrypto 声明已一并收录；OpenSSL 3.6.2 的原文见 [OpenSSL 许可证](third-party/OpenSSL-3.6.2-LICENSE.txt)。原生构建从 Maven / CocoaPods 解析的组件还需随最终发行配置核对。

Android 构建解析的依赖、声明来源与尚缺的声明记录在 [android-runtime-licenses.json](third-party/android-runtime-licenses.json)，实际 AAR/JAR 中随附的文本见 [android-artifact-notices.txt](third-party/android-artifact-notices.txt)。其中 Google Play Services、ML Kit 等使用服务/SDK 条款，不能按项目 MIT 再授权；见 [ML Kit 条款和隐私](https://developers.google.com/ml-kit/terms)、[Google API 条款](https://developers.google.com/terms)。本清单的依赖解析结果包括 SDK/构建中的间接组件，不表示每个组件都在应用中被调用。

## 字体与图标

图标通过 `@expo/vector-icons` 提供，其适配代码使用 MIT 许可证。实际图标字体的条款如下：

| 图标字体 | 来源与条款 | 随附声明 |
| --- | --- | --- |
| Ionicons | Ionic，MIT | [许可证](third-party/ionicons-LICENSE.txt) |
| Material Community Icons | Pictogrammers / Material Design Icons，字体 Apache 2.0，集合中的个别图标适用自身条款 | [集合声明](third-party/material-design-icons-LICENSE.txt)、[Apache 2.0](third-party/Apache-2.0.txt) |
| Font Awesome 4.7 | Dave Gandy / Fort Awesome，字体 SIL OFL 1.1 | [字体许可证](third-party/SIL-OFL-1.1.txt)、[来源声明](third-party/font-awesome-LICENSE.html) |

应用其他文字使用平台系统字体；本仓库没有单独分发正文文字字体。上游来源固定信息见 [sources.json](third-party/sources.json)。

## 公开测试向量

`src/dapp/__tests__/linkCrypto.test.ts` 的两把固定测试私钥、消息和期望密文来自 Greymass `anchor-link` 的公开 `test/aes.ts`，仅用于协议兼容性测试，禁止用于实际钱包或接收资产。其版权和完整条款保存在 [anchor-link-LICENSE.txt](third-party/anchor-link-LICENSE.txt)，包括非军事使用限制。其他密钥测试使用进程内随机生成的密钥或明确无效的占位数据。

## 品牌与图片

EOS、Vaulta、USDT、USDC、Google、TokenPocket、Scatter、Anchor 等名称及标识属于各自权利人。协议兼容或在界面中标识资产、服务，不表示获得其背书。项目 MIT 许可证不授予第三方商标使用权。

仓库中的项目品牌 PNG、插画和代币 PNG 没有附可核实的原始来源及授权材料。不能将本声明当作这些图片的再分发授权；独立分发前应取得来源及许可，或替换为有明确许可的素材。
