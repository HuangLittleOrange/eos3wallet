# wallet.eos3.app 首页

此目录保存 2026-10-22 从现有生产站点读取并更新的首页模板、脚本、样式和 TestFlight 二维码。既有品牌图片仍位于生产站点的 `assets/`，本次没有复制或修改。

- iOS 安装：`https://testflight.apple.com/join/BJrMV91r`，Public Beta 群组，当前 1.0.12（37）。二维码编码同一 Apple 公开邀请链接。
- 首页入口：`https://wallet.eos3.app/#ios-install`。中英切换均包含安装步骤，最低 iOS 16.4。
- 生产模板目录：`/var/www/wallet.eos3.app/current`。
- 实际首页：`/var/lib/eos3-wallet-mirror/public/index.html`，由已有的 Android 版本同步任务使用模板生成。部署时须同时更新模板并重新生成实际首页，不能只改后者。
- 使用已有 `/usr/local/lib/eos3-wallet-mirror/sync_releases.py` 的 `render_page` / `publish_page`，保留从当前 `latest.json` 生成的 Android 下载和核验信息；无需重新下载或编译 Android 包。
- 旧 iOS 安装页通过 [Nginx 配置](../../docs/ios-install-nginx.conf) 转到 TestFlight；旧 IPA、清单和二维码文件继续保留。

线上发布记录和验证截图：`exports/wallet-testflight-site/`。本目录不包含任何 Apple API 私钥或签名凭据。

每次 TestFlight 新版本开放后，须同步更新 `index.html` 的中文 `iosDescription`、`app.js` 的英文文案和 HTML 中 `app.js?v=` 的内容哈希，再按上述步骤重新生成生产首页。
