# 公开 Android 构建与来源核验

## 启用

将审查后的源码连同 `.github/workflows/android-build.yml`、`scripts/`、`patches/`、构建与签名策略 JSON 和依赖锁文件提交到新的**公开仓库**的 `main`。不要提交 `exports/`、`.codex/`、备份或签名文件。这里没有固定 GitHub 用户名或仓库名，构建自动使用当前仓库身份。

在仓库 **Settings → Actions → General** 启用 GitHub Actions，并允许工作流中固定到提交 SHA 的官方 `actions/*`。若组织策略禁止 OIDC 或 artifact attestations，需要由仓库管理者调整相应策略。不需要 EAS 或 npm 令牌。固定正式签名使用独立的 `android-production-signing` Environment：只允许 `v*` 版本标签部署（规则类型 tag），在该环境内配置 `ANDROID_RELEASE_KEYSTORE_BASE64`（PKCS12 密钥文件的 Base64）和 `ANDROID_RELEASE_STORE_PASSWORD`。不要配置为编译任务可见的变量；秘密仅注入签名步骤，SDK 安装及产物下载步骤没有这些秘密。通过 `gh secret set --env android-production-signing` 的标准输入录入，避免写入命令参数、日志或源码。

推送到 `main` 自动触发测试；正式发布通过推送版本标签触发。每次输出保留完整提交 SHA、版本标签、运行编号和重跑次数，以明确源码版本。

## 开发与版本标签

普通 `main` 推送只触发 `.github/workflows/main-tests.yml`，以固定镜像、无宿主凭据容器执行来源检查、单元测试、类型检查和 Expo 兼容性检查。依赖联网安装但禁用安装脚本；包代码只在断网容器执行。不会生成 APK、读取签名秘密或发布版本。也可在 Main tests 中手动运行 main 的检查。

`.github/workflows/android-build.yml` 只接受 `push` 到 `v*` 标签，不提供分支或手动正式发行入口。前置只读 API 校验严格接受 `vMAJOR.MINOR.PATCH`，无前导零、不接受 RC/beta 后缀；标签解析到的提交必须与运行提交相同，必须是 main 的相同或祖先提交，且标签版本匹配该提交的 app.json 应用版本。支持附注/轻量标签，拒绝强制移动、删除、已发布版本和不匹配输入。前置作业没有源码执行、写权限、正式签名秘密或 OIDC。

准备版本时更新应用版本和 Android versionCode，推送 main 并等 Main tests 通过，再为该提交创建并推送标签。例如 `git tag -a v1.0.3 FULL_REVIEWED_COMMIT_SHA -m "EOS3 Wallet 1.0.3"`，然后 `git push origin v1.0.3`。示例版本必须先与 app.json 一致。本文配置不会替你创建标签，不改变应用/Expo SDK 版本。

正式签名环境使用自定义部署规则，只允许类型为 `tag`、名称为 `v*` 的引用；不再允许 main 分支。主分支日常测试作业没有签名权限。前置校验、实际 APK 版本校验和发布时标签校验共同约束发行来源。标签一旦公开发布就不得移动；下一个发行应使用新版本。

## 流程与公开内容

编译前先在独立 Ubuntu 作业核对版本标签、源码归属与 app.json，不再自动创建内部构建标签。分支前进不会改变这次发行的已选提交，发布始终绑定实际版本标签和完整 SHA。

1. 编译：固定 Node 22.23.2、Temurin JDK 17.0.20.1+1（`setup-java` 使用该发行版的 Adoptium SemVer `17.0.20+101`），Android 工具版本来自 `native-build-policy.json`。按锁文件禁用安装脚本安装依赖，核验 npm 来源和补丁。公共原生依赖在无宿主凭据的联网沙箱准备，测试、类型检查和未签名 APK 编译在离线沙箱执行。
2. 正式签名：新 macOS runner 仅检出签名控制脚本、公开证书和策略，下载本次运行的未签名产物，校验 SHA256、源码提交和运行编号。使用环境秘密中的固定密钥，在独立且禁止全部网络的沙箱签名；核对密钥证书、最终 APK 证书指纹及 16 KB 对齐，随后删除临时密钥副本。编译任务、来源证明任务和发布任务均没有签名秘密。
3. 来源证明：新 GitHub 托管 runner 校验两组产物，只执行工作流中的校验步骤和固定版本的官方 Actions，不检出或执行钱包代码。只有这个作业获得 OIDC 和写入来源证明的权限。
4. 正式发布：前三个作业全部成功后，在另一台 GitHub 托管 runner 下载最终产物，重新核对完整清单、源码提交、运行编号及两组 APK 和元数据的来源证明。该作业仅获得 `contents: write`，不检出或执行钱包代码，也不持有 OIDC 或签名密钥。先上传草稿并核对服务端附件 SHA256，再以正式版本公开；失败时不会公开草稿。

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

Android、iOS 构建或 main 分支检查结束后（成功、失败或取消均包含），独立的 **Build cache cleanup** 工作流自动整理当前 `android-public-downloads-v1-` 依赖下载缓存。按稳定版本号比较，只保留最高版本的一份缓存，同版本重复缓存保留创建时间最新的一份；重跑旧版本不会淘汰更高版本。兼容正常标签引用及 GitHub 缓存列表中的 `refs/heads/refs/tags/v…` 引用。其他键、分支和 PR 缓存不会被这个规则删除。iOS 流程目前不上传这类依赖缓存。

收尾任务从默认分支运行，只通过 GitHub API 查询构建和缓存、删除明确的旧缓存；它不检出或执行触发构建的源码，不安装依赖，不接触签名秘密、正式安装包、Releases 或构建证据。只有这个独立任务具有 `actions: write` 权限，构建与签名任务的权限保持原样。检测到尚在排队、等待或运行的原生构建时暂缓清理，后续构建结束会重新触发；删除前再次检查。并行构建期间可能暂存多份缓存；单份缓存若超过 GitHub 免费额度，此规则也不能保证零超额。

在 **Actions → Build cache cleanup** 查看保留版本、删除数量和释放空间。也可手动执行；预演命令为 `gh workflow run cache-cleanup.yml --ref main -f dry_run=true`，实际清理去掉 `-f dry_run=true`。每次运行的摘要直接保存在 Actions，不额外上传清理产物。清理旧缓存后，重建历史版本可能需要重新下载依赖；原有发布包和核验材料继续保留。

npm 下载连接数限制为八个，对明确的网络超时、连接重置、临时 DNS 或服务端 5xx 错误最多执行三次 `npm ci`，各次使用相同锁文件和沙箱下载缓存，日志实时显示；联网依赖准备步骤总限时 30 分钟。包完整性、认证、TLS、策略或未知错误立即停止，不切换镜像、不使用 `--force`、不跳过来源签名检查，也不重试编译、签名或发布。

安装、测试和 Gradle 任务实时显示在当前 Actions 步骤，原始日志仍随产物保留。Gradle 使用普通文本输出并开启最多四个 worker 的项目并行，不缩减目标架构或跳过测试。第三方输出期间使用每次随机生成且不注入子进程的令牌暂停 Actions 工作流指令解析；固定正式签名保持独立、断网且不输出秘密诊断。

标准产物申请保留 90 天，实际期限受仓库策略限制；Actions 产物下载需要登录 GitHub。构建、签名和来源证明全部成功后，工作流自动创建对应提交的 GitHub **正式版本**，使用用户推送的版本标签（例如 `v1.0.3`），成功公开时设为 Latest。不同版本标签对应独立发行，不覆盖已有公开版本；构建证据另记录运行编号与次数。不能把其他构建的 APK 与这次证明配对。编译、签名或核验失败时不会公开正式版本；最后发布步骤失败时，之前成功生成的原始 APK 和来源证明仍保留在 Actions 产物中。

发布阶段直接使用创建接口返回的 Release ID 上传附件和公开草稿，不依赖新建草稿立即出现在列表或按标签查询中。已有草稿只续传缺少且已核验的附件，已公开版本不覆盖。附件元数据短暂延迟时最多读取六次，每次间隔两秒；哈希错误立即停止，未齐全时保持草稿，创建、上传和公开操作均不盲目重试。

Releases 标题使用 APK 中的实际应用版本，例如 `EOS³ Wallet v1.0.2 · Android`。编译产物打包阶段使用 Android SDK 的 aapt2 读取 APK 的 versionName、versionCode 和包名，并与同一提交的 app.json 核对；版本写入经过来源证明的 build-info.json。发布标题与说明使用英文；标题不使用提交短码，完整提交和构建编号保留在详情及不可变标签中。历史发布的既有源码标签保留，防止破坏源码绑定与下载链接。

Releases 只上传三个附件：`wallet-release.apk`、下载校验文件 `SHA256SUMS` 和完整核验包 `android-release-evidence.zip`。外层 `SHA256SUMS` 只核对 APK 与 ZIP 两个下载文件；ZIP 内保留最终 Actions 产物的所有原始文件，包括内层完整 `SHA256SUMS`、来源证明、公开证书、策略、构建/签名元数据、源码清单、未签名 APK、日志和第三方声明。先核对下载文件，再将 ZIP 解压到单独目录，以内层原始清单核验全部材料；两个校验文件用途不同。证据 ZIP 自身的 SHA256 另列在发布说明中。发布任务保持已签名 APK 原样，不重新签名；正式发布标记不改变原始产物，也不代表独立安全审计或真机验证。手动补发历史成功运行时，同样只发布核验通过的原始产物，并将标签绑定到该次源码提交。

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
TAG='v1.0.3'

gh attestation verify wallet-release.apk \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/android-build.yml" \
  --signer-digest "$COMMIT" --source-ref "refs/tags/$TAG" --source-digest "$COMMIT" \
  --deny-self-hosted-runners

gh attestation verify wallet-review-unsigned.apk \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/android-build.yml" \
  --signer-digest "$COMMIT" --source-ref "refs/tags/$TAG" --source-digest "$COMMIT" \
  --deny-self-hosted-runners
```

上述命令用于新的标签构建；TAG 必须取自实际发行。历史从 main 构建的安装包应继续使用其原始 `refs/heads/main` 来源约束，不得将旧证明的分支改成新标签。上述命令从 GitHub 获取来源证明。也可在同样的身份、分支和提交限制下添加 `--bundle provenance.jsonl`，使用随产物保存的 bundle。完全断网验证还需预先准备可信根，并通过 `--custom-trusted-root` 指定，见 CLI 文档。预期仓库、工作流路径和提交应来自可信发布记录，不应直接接受未知 APK 附带的配置。

SHA256 验证文件是否被替换。来源证明验证文件与指定仓库、工作流和源码提交对应的 GitHub 运行是否一致。用户还应查看**该提交版本**的工作流和构建脚本，确认检出、安装、编译和上传步骤符合预期。仅核对仓库名称、忽略工作流和提交会减弱验证。

## 固定证书与正式发布

正式证书指纹记录在 `android-signing-policy.json`，公开证书位于 `docs/android-release-certificate.der`，工作流另固定相同 SHA256。签名控制器先校验公开证书与策略，再核对密钥内的证书及最终 APK 证书；来源证明和发布任务再次核对指纹、签名模式和编译源码中的策略。签名产物使用 `productionSigning: true`；未签名编译记录仍为 `false`，因为编译阶段完全没有接触发行密钥。

同一证书签名的后续 APK 可覆盖升级。之前使用临时测试证书的 APK 无法直接覆盖；不要卸载尚未备份的钱包。公开证书及 SHA256 不包含私钥，可用于核对安装包身份。可使用 Android SDK 的 `apksigner verify --verbose --print-certs wallet-release.apk` 核对签名，并将证书 SHA256 与可信源码中的固定值比较。

密钥和密码必须在源码以外妥善备份，备份恢复时核对公开证书指纹；不得在每次构建中重新生成。GitHub Environment 加密保存签名秘密，但有权修改工作流及环境配置的管理员仍能使用该密钥；环境引用限制不能代替工作流变更审查。应限制维护权限、审查签名脚本和工作流，并保留一份离线备份。密钥丢失或泄漏会影响发行身份及后续升级。

Passkey 或 Android App Links 服务若校验证书指纹，需要把固定证书指纹加入域名的 Digital Asset Links 配置，再进行真机联调。此配置只改变 APK 的签名和发布流程，没有修改钱包功能、Expo、应用标识或后端设置。

## 能证明的范围

来源证明依赖 GitHub 的运行身份和仓库工作流，并不证明钱包逻辑、第三方依赖或后端服务没有恶意行为。建议保护 `main`，通过拉取请求审查源码、依赖策略和 Actions 固定 SHA，限制管理员绕过保护。仓库所有者仍可改工作流或删除记录，用户应保存已核验的提交与证明。

当前本机独立构建发现原生库含临时构建路径等差异，尚未做到逐字节可复现。固定工具链有助于核验，但 runner 系统镜像仍会更新。不能宣传为“任意人重建得到完全相同的 APK”或“已通过独立安全审计”。客户端代码、后端行为、真机安全和正式发行签名需分别核验。
