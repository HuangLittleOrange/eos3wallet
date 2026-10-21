# GitHub Actions iOS Ad Hoc 打包

默认通过 [iOS IPA 工作流](../.github/workflows/ios-build.yml)生成 Ad Hoc IPA：GitHub 托管 Mac 编译，再由独立作业导出签名 IPA。不使用 EAS，不上传 TestFlight，不需要 App Store Connect API Key。本机无需升级 macOS 或安装 Xcode。

## 凭据

GitHub Environment `ios-production-signing` 只允许 `main` 分支部署。需要：

| 配置 | 类型 | 内容 |
|---|---|---|
| `IOS_DISTRIBUTION_P12_BASE64` | Secret | Apple Distribution 证书及私钥的 P12，Base64 编码 |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Secret | P12 密码 |
| `IOS_AD_HOC_PROFILE_BASE64` | Secret | `com.eos3.wallet` 的 Ad Hoc 描述文件，Base64 编码 |
| `APPLE_TEAM_ID` | Variable | 十位 Team ID |

描述文件必须匹配应用、团队和 P12 证书，包含待安装设备的 UDID，且尚未过期。Development、Enterprise 和 App Store Connect 描述文件不能代替 Ad Hoc 文件。不要把真实描述文件、证书私钥或设备列表提交到源码。

增加设备后，先在 Apple Developer 登记设备，再重新生成描述文件，更新 Secret 并重新打包：

```bash
base64 -i /absolute/path/adhoc.mobileprovision | gh secret set IOS_AD_HOC_PROFILE_BASE64 --env ios-production-signing
```

## 触发与交付

在 **Actions → iOS IPA → Run workflow** 选择 `main`，`distribution` 保持默认 `ad-hoc`，填写递增的 `build_number`，保持 `upload_to_testflight` 关闭。Ad Hoc 即使勾选上传，该作业也不会执行；上传控制脚本同样拒绝 Ad Hoc IPA。

```bash
gh workflow run ios-build.yml --ref main -f distribution=ad-hoc -f build_number=34 -f upload_to_testflight=false
```

`34` 是首次迁移时的示例（当时本地最高已知构建号为 33）；后续继续递增。版本名取自 `app.json`，流程不改变 Android 版本号。

成功后，从 `ios-signed-<run_id>-<attempt>` Artifact 下载 `wallet.ipa`、`dSYMs.zip`、`build-info.json` 和 `SHA256SUMS`。原始归档另存于 `ios-unsigned-<run_id>-<attempt>`。

IPA 只允许描述文件中的设备安装。可在 Mac 上使用 Apple Configurator 等设备管理工具安装；若需在 iPhone 上点链接安装，应在受控 HTTPS 分发服务中托管 IPA 和安装清单，再提供 `itms-services` 入口。GitHub Artifact 页面或裸 IPA 下载地址本身不是 iPhone OTA 安装页面。工作流只交付签名 IPA，不自动发布到网站或修改钱包后台。

### 扫码安装页

已签名的 IPA 可以直接生成独立的安装页，无需重新编译或使用 EAS。先将签名产物中的 `wallet.ipa`、`build-info.json`、`SHA256SUMS` 保存到同一个发布目录，再运行：

```bash
python3 scripts/prepare-ios-install.py \
  --release exports/ios-ad-hoc/1.0.10-34 \
  --output exports/ios-install/1.0.10-34 \
  --base-url https://wallet.eos3.app/ios-install/
```

脚本核对 IPA 和构建信息的校验值、包内应用身份、Ad Hoc 分发方式及描述文件有效期；使用项目已有的 `qrcode` 依赖生成二维码，不增加依赖。输出 `public/<版本-构建号-随机路径>/` 下的安装页、样式、二维码、图标、IPA 和 XML 安装清单。实际页面地址记录于输出目录的 `deployment.json`，二维码指向 HTTPS 页面，页面按钮通过 `itms-services` 触发安装。脚本拒绝覆盖已有目录，避免改变已发出的链接。

将 `public/` 中生成的目录上传到 HTTPS 站点。现有 Nginx HTTPS server 可包含 [安装分发路由](ios-install-nginx.conf)，将 `/ios-install/` 映射到独立目录 `/var/lib/eos3-wallet-ios/public/`。部署前备份配置，执行 `nginx -t`，通过后平滑 reload；不需要重启钱包或 API。新版本使用新路径，旧链接保持对应原安装包。

安装链接持有人可以下载安装包。不要把真实链接、IPA、设备列表或签名材料提交到公开源码，也不要将安装页加入公开首页或站点索引。随机路径用于限制链接被猜测，不代替设备登记或登录鉴权；需要更严格的访问控制时应使用独立的鉴权分发服务。IPA 内仍包含 Apple 的设备限制，未登记设备扫码后也无法安装。二维码只简化分发，不会自动登记设备。描述文件过期、设备变化或重新签名后，必须重新准备对应安装包。

验证上线时核对 HTTPS 页面、清单和全部资源的响应类型及校验值，检查 IPA 支持 Range 请求，并解码线上二维码确认地址。iPhone 用户使用相机扫码，在 Safari 中打开页面、点击安装并按系统提示确认；如要求开发者模式，按提示开启。网页和服务器校验不能替代已登记 iPhone 上的实际安装验证。

编译作业使用不含 Apple 身份的临时 ad hoc 代码签名保留 Associated Domains；独立签名作业才使用真实分发证书、Ad Hoc 描述文件和 Xcode `release-testing` 导出可安装 IPA。最终核对签名、设备名单、Bundle ID、版本、Team ID 和关联域权限。构建信息仅记录设备数量，不展开 UDID。

产物保留 90 天（也受仓库策略约束），请将最新 IPA、归档、dSYMs 和报告保存到稳定发布目录。临时钥匙串、凭据、依赖安装和构建中间文件在结束时清理。已有 TestFlight 环境保留，未来需要时参照 [TestFlight 配置](github-ios-testflight.md)选择 `app-store-connect` 并补齐凭据。

参考：[Apple Ad Hoc 描述文件](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/)、[Expo SDK 57 工具链要求](https://docs.expo.dev/versions/v57.0.0/)。
