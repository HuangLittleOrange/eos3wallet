# 依赖安全维护

当前锁文件包含两项本地安全补丁，保留原依赖版本和钱包协议接口：

| 依赖 | 本地修改 | 来源 |
| --- | --- | --- |
| elliptic 6.6.1 | 生成 RFC 6979 nonce 时保留原始字节宽度，避免前导零被 BN 丢弃后错误截断；自定义 nonce 回调行为保持不变。 | [上游问题](https://github.com/indutny/elliptic/issues/321)、[公开复现](https://github.com/indutny/elliptic/pull/322#issuecomment-2463004218) |
| node-forge 1.4.0 | 验证 RSA PKCS#1 v1.5 签名时，检查嵌套 DigestAlgorithm 的元素数量，拒绝额外内容。 | [上游补丁](https://github.com/digitalbazaar/forge/pull/1152) |

补丁位于 `patches/`。脚本校验原始和修改后的 SHA-256，不认识的版本或源码会导致失败，需重新审查后才能更新。Metro 构建配置和测试也校验补丁；未来调整构建配置时应保留该检查。

## 安装脚本与来源检查

`.npmrc` 默认启用 `ignore-scripts=true`，包括项目自身的安装钩子也不会运行。已移除自动 postinstall，改为明确执行项目维护的补丁脚本：

```bash
npm run install:safe
```

只运行 `npm ci` 后，需要手动执行：

```bash
npm run patch:dependencies
npm run check:dependencies
```

`install:safe` 同时执行来源签名核验，失败就停止。标准 EAS 构建通过项目维护的 `eas-build-pre-install` 检查策略，在 `eas-build-post-install` 核验来源并应用补丁；这些是 EAS 明确执行的项目步骤，不放开第三方安装脚本。自定义 EAS 构建需要显式调用同等步骤，见 [EAS 生命周期说明](https://docs.expo.dev/build-reference/npm-hooks/)。本次没有运行云端构建。

当前锁文件中唯一标记安装脚本的依赖是可选的 `fsevents@2.3.3`；其脚本也被禁用，不存在安装脚本放行列表。不要用 `--ignore-scripts=false` 绕过限制。显式 `npm run`、构建和应用运行仍会执行代码；禁用安装钩子不构成运行时沙箱。[npm 安装脚本说明](https://docs.npmjs.com/cli/v11/commands/npm-ci/#ignore-scripts)

`dependency-policy.json` 固定已审查锁文件的 SHA-256、安装脚本清单和容器镜像摘要。检查要求所有依赖使用 npm 官方 HTTPS 仓库并带有 SHA-512 完整性校验，拒绝本地链接、其他来源和未经审查的锁文件变化，也拒绝 npm 环境配置重新启用安装脚本或重定向仓库。修改校验值不是完成安全审查：升级时还需审核新增、间接依赖和源码差异，验证钱包签名兼容性后才能批准。

核验下载包的仓库签名及可用的来源证明：

```bash
npm run verify:provenance
```

该命令需要联网；校验失败不能作为成功继续发布。有些旧包没有来源证明，应与无效签名区分。签名证明发布来源和内容身份，不证明实现安全；`npm audit` 只覆盖已知漏洞。[npm 来源核验说明](https://docs.npmjs.com/cli/v11/commands/npm-audit/#audit-signatures)

## 不提供构建凭据的容器验证

安装 Docker 后执行：

```bash
npm run verify:isolated
```

入口仅使用 Node.js 标准库和 Git 建立公开源码快照，先运行源码检查，拒绝符号链接。快照排除 Git 历史、所有环境文件、原生生成目录、本机工具、备份、导出、凭据及常见签名文件，不复用宿主机 `node_modules`、npm 配置或依赖缓存。

容器镜像使用不可变摘要。容器使用非 root 用户、只读根文件系统、移除 Linux capabilities、禁止新增权限；仅挂载只读源码快照、一次性依赖卷和当前运行的公开输出目录，不挂载宿主机主目录、钥匙串、Docker socket 或发布密钥，也不传入宿主机环境变量。安装阶段联网下载依赖，强制禁用安装脚本，核验签名后结束；另一无网络容器应用补丁、运行测试和类型检查、核对 Expo 版本兼容性并导出 Android / iOS JavaScript 包。结束时删除依赖卷与临时快照。失败不会自动回退到本机构建。

报告与包位于 `exports/isolated-review/<运行标识>/`。容器前后检查源码快照一致性。此流程不执行 Android/iOS 原生编译、应用签名、EAS 构建或商店提交。既有 `npm run android` / `ios` 和 EAS 配置仍是原来的开发与构建入口，不具备这里的容器隔离保证。

Android 原生编译与测试签名现在提供独立的 macOS 沙箱入口，见[原生构建与签名](native-build-security.md)。正式发行时仍需受控的发行签名步骤；iOS 根据平台要求使用受隔离作业与受限凭据。不要把生产凭据放进依赖安装、配置插件和测试作业。分离签名不能证明待签产物没有恶意逻辑。

## 回归检查与剩余风险

```bash
npm run test:dependencies
npm test -- --runInBand
npm run typecheck
```

检查覆盖公开 nonce 复现、K1/R1 签名兼容性、异常 RSA 签名结构拒绝、正常 Expo 证书签名，以及补丁重复安装和异常源码拒绝。公开复现中的密钥仅用于测试，禁止接收资产或用于真实钱包。

本地补丁不会改变 npm 漏洞数据库中的版本判断，所以 `npm audit` 仍可能报告这些包；不能把扫描告警隐藏或把补丁当作整套钱包已通过独立审计。升级到上游正式修复版后，应验证回归并移除对应本地补丁。

- 已审查版本仍可能包含未知恶意代码；签名、来源证明、校验值和测试不替代关键依赖审查。
- 容器限制构建代码读取本机凭据与联网，不阻止恶意依赖生成有害应用。普通私钥在客户端解锁、导入或签名时仍可能被同一运行环境中的恶意代码接触。
- Docker、操作系统、镜像、npm、原生 Maven/CocoaPods 依赖和工具链也属于供应链；这里的 npm 核验没有完整覆盖原生依赖。
- 源码扫描只能识别指定形式的秘密；错误地写入源码或以其他名称保存的数据仍需人工审核。
- 本机普通开发、iOS 原生编译、EAS 作业和最终发行签名需要另行落实同等隔离；Android 仅使用新入口时受其沙箱约束。尚未执行真机联调及独立钱包安全审计。
