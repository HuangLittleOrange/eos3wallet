# 公开 Android 构建与来源核验

## 启用

将审查后的源码连同 `.github/workflows/android-build.yml`、`scripts/`、`patches/`、构建与签名策略 JSON 和依赖锁文件提交到新的**公开仓库**的 `main`。不要提交 `exports/`、`.codex/`、备份或签名文件。这里没有固定 GitHub 用户名或仓库名，构建自动使用当前仓库身份。

在仓库 **Settings → Actions → General** 启用 GitHub Actions，并允许工作流中固定到提交 SHA 的官方 `actions/*`。若组织策略禁止 OIDC 或 artifact attestations，需要由仓库管理者调整相应策略。不需要 EAS 或 npm 令牌。固定正式签名使用独立的 `android-production-signing` Environment：只允许 `main` 部署，在该环境内配置 `ANDROID_RELEASE_KEYSTORE_BASE64`（PKCS12 密钥文件的 Base64）和 `ANDROID_RELEASE_STORE_PASSWORD`。不要配置为编译任务可见的变量；秘密仅注入签名步骤，SDK 安装及产物下载步骤没有这些秘密。通过 `gh secret set --env android-production-signing` 的标准输入录入，避免写入命令参数、日志或源码。

推送到 `main` 自动触发；也可在 **Actions → Public Android APK → Run workflow** 选择 `main`。从其他分支手动运行会跳过构建。每次输出保留不可变的完整提交 SHA、运行编号和重跑次数，以明确源码版本。

## 流程与公开内容

编译前在独立 Ubuntu 作业中使用 `contents: write` 核对并预留本次提交和运行编号的标签，校验目标仍是 `main` 当前提交。标签权限失败或分支已经前进时立即停止，不启动耗时编译。此作业不检出源码，不执行依赖，不接收签名秘密或 OIDC 权限，也不创建 Releases。这样后续推送改变工作流时，本次发布仍使用已固定的源码标签，不在编译后重新创建或移动标签。失败构建可能留下源码标签；标签本身不代表 APK 已通过测试或已发布，只有全部核验成功后才创建公开预发布版。

1. 编译：固定 Node 22.23.2、Temurin JDK 17.0.20.1+1（`setup-java` 使用该发行版的 Adoptium SemVer `17.0.20+101`），Android 工具版本来自 `native-build-policy.json`。按锁文件禁用安装脚本安装依赖，核验 npm 来源和补丁。公共原生依赖在无宿主凭据的联网沙箱准备，测试、类型检查和未签名 APK 编译在离线沙箱执行。
2. 正式签名：新 macOS runner 仅检出签名控制脚本、公开证书和策略，下载本次运行的未签名产物，校验 SHA256、源码提交和运行编号。使用环境秘密中的固定密钥，在独立且禁止全部网络的沙箱签名；核对密钥证书、最终 APK 证书指纹及 16 KB 对齐，随后删除临时密钥副本。编译任务、来源证明任务和发布任务均没有签名秘密。
3. 来源证明：新 GitHub 托管 runner 校验两组产物，只执行工作流中的校验步骤和固定版本的官方 Actions，不检出或执行钱包代码。只有这个作业获得 OIDC 和写入来源证明的权限。
4. 测试预发布：前三个作业全部成功后，在另一台 GitHub 托管 runner 下载最终产物，重新核对完整清单、源码提交、运行编号及两组 APK 和元数据的来源证明。该作业仅获得 `contents: write`，不检出或执行钱包代码，也不持有 OIDC 或签名密钥。先上传草稿并核对服务端附件 SHA256，再公开标记为预发布测试版；失败时不会公开草稿。

**Actions 运行页面**公开源码提交、步骤日志、两个 APK 的 SHA256 和来源证明链接。编译完整日志另随产物保存。全部作业成功后的 `android-public-…` 包含：

| 文件 | 用途 |
| --- | --- |
| `wallet-release.apk` | 固定正式证书签名的 APK |
| `wallet-review-unsigned.apk` | 未签名 APK，供独立核验或受控签名 |
| `SHA256SUMS` | 下载文件的 SHA256 清单，包含 APK、说明与证明文件 |
| `provenance.jsonl` | GitHub OIDC 签发的来源证明 bundle |
| `build-info.json` / `sign-info.json` | 源码提交、构建 URL、版本、工具链、签名前后哈希和公开证书指纹 |
| `android-signing-policy.json` / `android-release-certificate.der` | 固定发行身份的公开策略与证书，包含在源码及证据清单中，不含私钥 |
| `source-manifest.json` | 实际编译源码各文件的 SHA256；与干净检出再次核对 |
| `verification.json` / `wallet-release.apk.json` | 隔离编译、签名和对齐验证结果 |
| `install.txt` / `build.txt` / `sandbox-probe.txt` / `java-version.txt` | 构建、测试和沙箱边界证据 |
| `LICENSE` / `THIRD_PARTY_NOTICES.md` | 随附的版权与依赖声明 |
| `third-party/` / `docs/dependency-security.md` | 完整第三方许可证文本、来源记录及补丁说明；按编译源码清单逐一核对 |

编译任务缓存经过过滤的公开下载：已校验的 Gradle ZIP、`modules-2` 依赖及 npm `_cacache`。缓存键绑定 runner 系统/架构、Node/JDK、锁文件、工具链和依赖策略、应用配置、补丁及原生 worker；不接受非精确匹配，不使用旧键回退。联网准备成功后即保存，原生编译失败不会丢掉已准备的下载缓存。每次仍重新检出源码、安装及检查依赖、生成工程并离线编译；不缓存 APK、编译任务输出、已安装代码或签名材料。签名、来源证明和发布作业不恢复这个缓存。首次构建和缓存失效时仍需完整下载，原生编译时间取决于 runner 性能，不能保证固定提速比例。

npm 下载连接数限制为八个，对明确的网络超时、连接重置、临时 DNS 或服务端 5xx 错误最多执行三次 `npm ci`，各次使用相同锁文件和沙箱下载缓存，日志实时显示；联网依赖准备步骤总限时 30 分钟。包完整性、认证、TLS、策略或未知错误立即停止，不切换镜像、不使用 `--force`、不跳过来源签名检查，也不重试编译、签名或发布。

安装、测试和 Gradle 任务实时显示在当前 Actions 步骤，原始日志仍随产物保留。Gradle 使用普通文本输出并开启最多四个 worker 的项目并行，不缩减目标架构或跳过测试。第三方输出期间使用每次随机生成且不注入子进程的令牌暂停 Actions 工作流指令解析；固定正式签名保持独立、断网且不输出秘密诊断。

标准产物申请保留 90 天，实际期限受仓库策略限制；Actions 产物下载需要登录 GitHub。构建、签名和来源证明全部成功后，工作流自动创建对应提交的 GitHub **测试预发布版**，标签为 `android-prerelease-完整提交SHA-运行编号-重跑次数`，不会标记为正式 Latest 版本。每次构建的附件与标签独立，不替换其他发布版本。不能把其他构建的 APK 与这次证明配对。失败构建仅保留诊断日志，不签发来源证明或发布预发布版。

发布阶段直接使用创建接口返回的 Release ID 上传附件和公开草稿，不依赖新建草稿立即出现在列表或按标签查询中。已有草稿只续传缺少且已核验的附件，已公开版本不覆盖。附件元数据短暂延迟时最多读取六次，每次间隔两秒；哈希错误立即停止，未齐全时保持草稿，创建、上传和公开操作均不盲目重试。

Releases 提供可直接下载的测试 APK、原样 `SHA256SUMS`、`provenance.jsonl`、构建与签名元数据及源码清单；`android-release-evidence.zip` 包含最终 Actions 产物的全部原样文件（含未签名 APK、日志和完整第三方声明）。解压证据 ZIP 后，原始 `SHA256SUMS` 可核对全部文件；证据 ZIP 自身的 SHA256 另列在发布说明中。发布任务保持已签名 APK 原样，不重新签名；预发布标记与正式签名证书是两回事，也不代表完成真机测试。手动补发历史成功运行时，同样只发布核验通过的原始产物，并将标签绑定到该次源码提交。

## 用户怎样验证

从可信仓库的 Releases 页面下载 `android-release-evidence.zip`，或从 Actions 页面选择完整成功的运行、下载 `android-public-…` 并解压。记下**该次完整提交 SHA**。核对收到的 APK，不应仅相信发布者给出的哈希文本。

```bash
# Linux
sha256sum -c SHA256SUMS
# macOS
shasum -a 256 -c SHA256SUMS
```

使用支持 artifact attestations 的 [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify)，将占位内容换成可信的仓库和运行页面中的完整提交。运行摘要会自动生成对应的完整命令。

```bash
REPOSITORY='YOUR_ACCOUNT/YOUR_REPOSITORY'
COMMIT='FULL_COMMIT_SHA_FROM_THE_SUCCESSFUL_RUN'

gh attestation verify wallet-release.apk \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/android-build.yml" \
  --signer-digest "$COMMIT" --source-ref refs/heads/main --source-digest "$COMMIT" \
  --deny-self-hosted-runners

gh attestation verify wallet-review-unsigned.apk \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/android-build.yml" \
  --signer-digest "$COMMIT" --source-ref refs/heads/main --source-digest "$COMMIT" \
  --deny-self-hosted-runners
```

上述命令从 GitHub 获取来源证明。也可在同样的身份、分支和提交限制下添加 `--bundle provenance.jsonl`，使用随产物保存的 bundle。完全断网验证还需预先准备可信根，并通过 `--custom-trusted-root` 指定，见 CLI 文档。预期仓库、工作流路径和提交应来自可信发布记录，不应直接接受未知 APK 附带的配置。

SHA256 验证文件是否被替换。来源证明验证文件与指定仓库、工作流和源码提交对应的 GitHub 运行是否一致。用户还应查看**该提交版本**的工作流和构建脚本，确认检出、安装、编译和上传步骤符合预期。仅核对仓库名称、忽略工作流和提交会减弱验证。

## 固定证书与预发布

正式证书指纹记录在 `android-signing-policy.json`，公开证书位于 `docs/android-release-certificate.der`，工作流另固定相同 SHA256。签名控制器先校验公开证书与策略，再核对密钥内的证书及最终 APK 证书；来源证明和发布任务再次核对指纹、签名模式和编译源码中的策略。签名产物使用 `productionSigning: true`；未签名编译记录仍为 `false`，因为编译阶段完全没有接触发行密钥。

同一证书签名的后续 APK 可覆盖升级。之前使用临时测试证书的 APK 无法直接覆盖；不要卸载尚未备份的钱包。公开证书及 SHA256 不包含私钥，可用于核对安装包身份。可使用 Android SDK 的 `apksigner verify --verbose --print-certs wallet-release.apk` 核对签名，并将证书 SHA256 与可信源码中的固定值比较。

密钥和密码必须在源码以外妥善备份，备份恢复时核对公开证书指纹；不得在每次构建中重新生成。GitHub Environment 加密保存签名秘密，但有权修改 `main` 工作流及环境配置的管理员仍能使用该密钥；环境分支限制不能代替工作流变更审查。应限制维护权限、审查签名脚本和工作流，并保留一份离线备份。密钥丢失或泄漏会影响发行身份及后续升级。

Passkey 或 Android App Links 服务若校验证书指纹，需要把固定证书指纹加入域名的 Digital Asset Links 配置，再进行真机联调。此配置只改变 APK 的签名和发布流程，没有修改钱包功能、Expo、应用标识或后端设置。

## 能证明的范围

来源证明依赖 GitHub 的运行身份和仓库工作流，并不证明钱包逻辑、第三方依赖或后端服务没有恶意行为。建议保护 `main`，通过拉取请求审查源码、依赖策略和 Actions 固定 SHA，限制管理员绕过保护。仓库所有者仍可改工作流或删除记录，用户应保存已核验的提交与证明。

当前本机独立构建发现原生库含临时构建路径等差异，尚未做到逐字节可复现。固定工具链有助于核验，但 runner 系统镜像仍会更新。不能宣传为“任意人重建得到完全相同的 APK”或“已通过独立安全审计”。客户端代码、后端行为、真机安全和正式发行签名需分别核验。
