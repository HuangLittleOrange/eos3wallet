# 公开 Android 构建与来源核验

## 启用

将审查后的源码连同 `.github/workflows/android-build.yml`、`scripts/`、`patches/`、两个构建策略 JSON 和依赖锁文件提交到新的**公开仓库**的 `main`。不要提交 `exports/`、`.codex/`、备份或签名文件。这里没有固定 GitHub 用户名或仓库名，构建自动使用当前仓库身份。

在仓库 **Settings → Actions → General** 启用 GitHub Actions，并允许工作流中固定到提交 SHA 的官方 `actions/*`。若组织策略禁止 OIDC 或 artifact attestations，需要由仓库管理者调整相应策略。无需添加 EAS、npm 或生产签名凭据到 Secrets。

推送到 `main` 自动触发；也可在 **Actions → Public Android APK → Run workflow** 选择 `main`。从其他分支手动运行会跳过构建。每次输出保留不可变的完整提交 SHA、运行编号和重跑次数，以明确源码版本。

## 流程与公开内容

1. 编译：固定 Node 22.23.2、Temurin JDK 17.0.20.1+1（`setup-java` 使用该发行版的 Adoptium SemVer `17.0.20+101`），Android 工具版本来自 `native-build-policy.json`。按锁文件禁用安装脚本安装依赖，核验 npm 来源和补丁。公共原生依赖在无宿主凭据的联网沙箱准备，测试、类型检查和未签名 APK 编译在离线沙箱执行。
2. 测试签名：新 macOS runner 仅检出签名控制脚本和策略，下载本次运行的未签名产物，校验 SHA256、源码提交和运行编号。在独立离线沙箱生成临时测试密钥，验证签名和 16 KB 对齐，随后删除密钥。
3. 来源证明：新 GitHub 托管 runner 校验两组产物，只执行工作流中的校验步骤和固定版本的官方 Actions，不检出或执行钱包代码。只有这个作业获得 OIDC 和写入来源证明的权限。

**Actions 运行页面**公开源码提交、步骤日志、两个 APK 的 SHA256 和来源证明链接。编译完整日志另随产物保存。全部作业成功后的 `android-public-…` 包含：

| 文件 | 用途 |
| --- | --- |
| `wallet-review-test-signed.apk` | 可安装的测试签名 APK |
| `wallet-review-unsigned.apk` | 未签名 APK，供独立核验或受控签名 |
| `SHA256SUMS` | 下载文件的 SHA256 清单，包含 APK、说明与证明文件 |
| `provenance.jsonl` | GitHub OIDC 签发的来源证明 bundle |
| `build-info.json` / `sign-info.json` | 源码提交、构建 URL、版本、工具链、签名前后哈希和公开证书指纹 |
| `source-manifest.json` | 实际编译源码各文件的 SHA256；与干净检出再次核对 |
| `verification.json` / `wallet-review-test-signed.apk.json` | 隔离编译、签名和对齐验证结果 |
| `install.txt` / `build.txt` / `sandbox-probe.txt` / `java-version.txt` | 构建、测试和沙箱边界证据 |
| `LICENSE` / `THIRD_PARTY_NOTICES.md` | 随附的版权与依赖声明 |
| `third-party/` / `docs/dependency-security.md` | 完整第三方许可证文本、来源记录及补丁说明；按编译源码清单逐一核对 |

标准产物申请保留 90 天，实际期限受仓库策略限制；Actions 产物下载需要登录 GitHub。需要长期公开、免登录下载时，可将成功运行的**原样文件**及清单、证明放到对应提交的 GitHub Release，并再次核对哈希。不能把其他构建的 APK 与这次证明配对。失败构建仅保留诊断日志，不签发来源证明。

## 用户怎样验证

从可信仓库的 Actions 页面选择完整成功的运行，记下**该次完整提交 SHA**，下载 `android-public-…` 并解压。核对收到的 APK，不应仅相信发布者给出的哈希文本。

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

gh attestation verify wallet-review-test-signed.apk \
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

## 测试签名与正式发行

每次运行生成独立测试证书，私钥不会公开、上传或保留；公开证书指纹用于核对安装包身份。两次运行的测试 APK 不能相互覆盖升级，也不能覆盖正式签名安装。Passkey 后端或域名关联可能只认可正式证书，测试安装需对应的测试环境关联才能完成联调。

正式发行时，在受控签名环境签署核验后的未签名 APK，并公开正式证书指纹和**最终正式签名 APK**的 SHA256。签名后的文件改变，测试 APK 的证明不能用作正式 APK 的证明；正式产物需要另行绑定签名前后哈希并提供可验证的来源记录。当前流程不会自动创建 Release 或接触正式签名密钥。

## 能证明的范围

来源证明依赖 GitHub 的运行身份和仓库工作流，并不证明钱包逻辑、第三方依赖或后端服务没有恶意行为。建议保护 `main`，通过拉取请求审查源码、依赖策略和 Actions 固定 SHA，限制管理员绕过保护。仓库所有者仍可改工作流或删除记录，用户应保存已核验的提交与证明。

当前本机独立构建发现原生库含临时构建路径等差异，尚未做到逐字节可复现。固定工具链有助于核验，但 runner 系统镜像仍会更新。不能宣传为“任意人重建得到完全相同的 APK”或“已通过独立安全审计”。客户端代码、后端行为、真机安全和正式发行签名需分别核验。
