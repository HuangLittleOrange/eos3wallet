# wallet.eos3.app 首页

此目录保存 2026-10-22 从现有生产站点读取并更新的首页模板、脚本、样式和 TestFlight 二维码。既有品牌图片仍位于生产站点的 `assets/`，本次没有复制或修改。

- iOS 安装：`https://testflight.apple.com/join/BJrMV91r`，Public Beta 群组，版本号由后台发布配置自动同步。二维码编码同一 Apple 公开邀请链接。
- 首页入口：`https://wallet.eos3.app/#ios-install`。中英切换均包含安装步骤，最低 iOS 16.4。
- 生产模板目录：`/var/www/wallet.eos3.app/current`。
- 实际首页：`/var/lib/eos3-wallet-mirror/public/index.html`，由已有的 Android 版本同步任务使用模板生成。部署时须同时更新模板并重新生成实际首页，不能只改后者。
- 使用已有 `/usr/local/lib/eos3-wallet-mirror/sync_releases.py` 的 `render_page` / `publish_page`，保留从当前 `latest.json` 生成的 Android 下载和核验信息；无需重新下载或编译 Android 包。
- 旧 iOS 安装页通过 [Nginx 配置](../../docs/ios-install-nginx.conf) 转到 TestFlight；旧 IPA、清单和二维码文件继续保留。

线上发布记录和验证截图：`exports/wallet-testflight-site/`。本目录不包含任何 Apple API 私钥或签名凭据。

## iOS 版本自动同步

- `server/eos3-wallet-ios-site.timer` 每小时检查一次后台已启用、构建号最高的 iOS 版本；上线时立即检查一次。新版本确认可安装后在后台发布，官网通常在一小时内更新。
- 版本来自公开更新接口 `https://eos3.app/api/app-update/check?platform=ios&versionCode=0`；不读取尚在审核的构建。版本名用于显示，构建号只用于校验，不显示在官网。
- `server/sync_ios_release.py` 保存经过校验的 `public/ios-latest.json` 并原子生成首页。请求失败保留上次成功结果；无启用版本时显示通用安装文案。
- 中英文共用页面内嵌的 `ios-release-data`。访客无需额外请求版本接口；Android 镜像重新生成页面时也保留最新 iOS 版本。
- 当前自动同步面向现有 TestFlight 公开邀请渠道。后台安装地址须与首页和二维码一致；邀请地址变更或迁移到 App Store 时，需先一并更新入口和二维码，避免展示与实际安装渠道不符的版本。
- 服务器程序以此目录 `server/` 中的源码为准；旧 `exports/website/eos3-wallet-intro/server/` 仅为历史记录。

验证命令：

```sh
python3 -B -m unittest discover -s website/home/server/tests -p 'test_*.py' -v
node website/home/server/tests/ios-copy.mjs
```

安装 `server/*.py` 至 `/usr/local/lib/eos3-wallet-mirror/`，安装 service/timer 至 `/etc/systemd/system/`，更新静态模板与脚本后执行：

```sh
systemctl daemon-reload
systemctl start eos3-wallet-ios-site.service
systemctl enable --now eos3-wallet-ios-site.timer
systemctl list-timers eos3-wallet-ios-site.timer
journalctl -u eos3-wallet-ios-site.service -n 10 --no-pager
```

新 iOS 同步与原 Android 镜像共用 `sync.lock`，以现有 `eos3-wallet-mirror` 无登录权限账户运行，不需要新增凭据。
