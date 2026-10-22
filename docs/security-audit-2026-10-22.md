# EOS³ Wallet 安全测试报告

- 测试对象：`github.com/HuangLittleOrange/eos3wallet`
- 代码版本：`4960b399a67929445326f0dda20c8f6522f392d1`（`fix: recover stale dapp sessions without replaying transactions`）
- 测试日期：2026-10-22
- 测试方式：源码审计（读代码 + 依赖源码核对 + 离线 PoC），未编译 App、未上真机、未发主网交易
- 结论：**未发现可直接远程盗取私钥、或无需用户确认即可签名/转账的严重漏洞**。发现 1 个已用真实依赖复现的中危“确认内容 ≠ 签名内容”问题、1 条“内容服务 → 节点目录 → 单节点安全检查”的中危信任链，以及若干低危与加固项。

> 说明：本仓库已有 2026-10-11 至 2026-10-18 的多轮安全修复记录（`docs/runtime-security-review.md`、`docs/reverse-security-*.md` 等）。本轮以当前 HEAD 为基线做独立复核，重点放在既有报告未完全覆盖的“展示与签名一致性”“信任锚”“服务端字段语义”三类问题上。

---

## 0. 风险总览

| 编号 | 级别 | 外部攻击者可独立触发？ | 问题 | 建议处置 |
| --- | --- | --- | --- | --- |
| F1 | 中 | **是**（恶意/有 bug 的 DApp） | `requestSignature` 展示的 action data 与实际签名字节不一致（`Name` 静默改写）；已 PoC | **立即修** |
| F6 | 低 | **是**（第三方 iframe，iOS 已确认 `onShouldStartLoadWithRequest` 对子框架也回调） | ESR 链接未绑定发起 frame，弹窗归属顶层站点 | 建议修（1 行） |
| F7 | 低 | **是**（任意网页/二维码/深链） | `esr:` 解压无上限，可 OOM | 建议修（几行） |
| F12 | 低 | **是**（恶意 DApp） | 确认页未过滤 bidi/零宽字符 | 建议修（几行） |
| F5 | 低 | 否（Sponsor 是自家服务） | 意图校验跳过空授权 action | 顺手修（几行） |
| F11 | 低 | **是**（任意网页可触发深链） | `device-key-authorized` 自动导入并切换账户 | 已修复（导入前展示账户并点选确认） |
| F4 | 中 | 否（需 `eos3.app` 响应被控或出 bug） | 管理 action 的 `permission`/`botIdHash` 未与链上交叉校验 | 已修复（双内置节点核对 + `deleteauth` 排除系统权限） |
| F2 | 中 | 否（需内容接口被控） | 远程目录可按 id 静默替换 RPC | 可缓；低成本加固 |
| F3 | 中 | 否（需节点 + `eos3.app` 同时被控） | 设备密钥/绑定的安全检查用单节点 | 可缓；纵深防御 |
| F8 | 低 | 需用户手动添加 http 节点 | 自定义 RPC 允许明文 | 可缓；建议 https-only |
| F9 | 低 | 否（已连接的 dApp 才能推） | Link 会话未绑定账户/链、确认页无来源 | 可缓；UX/防钓鱼 |
| F10 | 低 | 否（需内容服务被控） | iOS 更新按钮可打开任意 https | 可缓 |
| F13 | 信息 | 否（需本机写权限/系统损坏） | Vault 加固项 | 仅 F13.3 建议加保护 |
| F14 | 信息 | — | 依赖告警以构建期为主 | 维持现有流程 |

### 0.1 按威胁模型分诊（2026-10-22 补充）

如果威胁模型**只包含外部攻击者**（不把 `eos3.app` 被外部攻破、也不把项目方作恶算进来），上表可以压缩成三档：

1. **真正要修**：F1。它不是“服务端作恶”，而是任意 DApp 都能触发的展示/签名分离，且已用真实依赖复现。
2. **低成本、外部面能触发，建议顺手修**：F6（1 行 `r.isTopFrame` 判断）、F7（解压上限）、F12（过滤 bidi/零宽）、F5（拒绝空授权）、F11（深链改为需用户点击）。
3. **服务端/节点被控时的纵深防御，可按优先级缓办**：F2、F3、F4、F8、F9、F10、F13、F14。

需要明确区分两件事：

- **“项目方作恶”**：项目方自己拿用户密钥/改收款人——这不是客户端能防的，也不在本报告范围。
- **“服务端被外部攻破”**：`eos3.app` 的内容接口、权限概览、`/account/build`、`/sponsored-transactions` 被第三方控制。F2/F3/F4/F10 的前提是这一种，不是第一种。这个钱包本来就把服务端当作“不可信输入”来设计（Sponsor 字节核对、绑定 action 本地重建、权限 `updateauth` 常量比对都是为此），所以这几项属于“现有纵深防御里的缺口”，而不是“没有设防”。

若连“服务端被外部攻破”也不在当前威胁模型内，F2/F3/F4/F10 应从“漏洞”降为“加固项”，报告中它们的中危标记不再适用。

---

## 1. 测试范围与方法

### 1.1 覆盖的代码

| 模块 | 文件 |
| --- | --- |
| 密钥保管 | `crypto/vault.ts`、`crypto/keys.ts`、`crypto/systemAuthentication.ts`、`crypto/secretClipboard.ts` |
| 交易与签名 | `chain/transact.ts`、`transactionSafety.ts`、`txIntentCheck.ts`、`signingAbi.ts`、`sponsor.ts`、`eos3Sign.ts`、`useSigningGuard.ts`、`signers.ts` |
| 权限/绑定 | `chain/permissions.ts`、`bindAuthorize.ts`、`bindIntent.ts`、`importAccount.ts`、`deviceKey.ts`、`anchorDeviceImport.ts`、`anchorDeviceReview.ts` |
| DApp / ESR | `dapp/esr.ts`、`useEsrFlow.ts`、`injected*.ts`、`accessGuard.ts`、`linkCrypto.ts`、`linkSessions.ts`、`linkSocket.ts`、`LinkSessionProvider.tsx`、`actionRequest.ts`、`decodeTx.ts` |
| 冷钱包 | `chain/coldSigning.ts`、`coldSigningProtocol.ts`、`walletPluginCold.ts`、`anchorWeb.ts` |
| Passkey | `passkey/webauthnSigning.ts`、`nativePasskey.ts`、`eos3Api.ts` |
| 网络/节点 | `net/*`、`chain/trustedRpc.ts`、`client.ts`、`nodeFailover.ts`、`nodeCatalog.ts`、`NodeCatalogContext.tsx`、`customNodes.ts` |
| 更新/深链 | `update/appUpdate.ts`、`AppUpdateSheet.tsx`、`navigation/RootNavigator.tsx`、`esr-links.ts`、`parseQr.ts` |
| 原生 | `modules/anchor-authorization/android/**`、`app.json`、`.github/workflows/*` |

### 1.2 方法

1. 从不可信输入出发（页面 `postMessage`、ESR 链接、二维码、relay 推送、后端 JSON、RPC 响应、深链）追踪到签名/广播/存储调用。
2. 对照锁定依赖的真实源码验证关键行为（`@wharfkit/antelope@1.2.0`，与 `package-lock.json` 一致）。
3. 对高风险点写离线 PoC（见附录 A）。
4. 运行 `npm audit --package-lock-only` 做依赖面检查。
5. 复核既有安全报告中的修复是否仍成立，并寻找其未覆盖的旁路。

### 1.3 限制

- 未安装 App 依赖、未编译、未在 Android/iOS 真机运行；原生 Keystore/Keychain、Passkey 面板、WebView 子框架行为依据源码与平台文档判断。
- 未做链上交易、未使用真实助记词/私钥。
- `eos3.app` 后端、paylimit/代付合约实现不在本仓库，未做服务端与合约审计。
- 严重程度以“客户端代码在当前威胁模型下可被利用的程度”评估，不替代独立渗透测试与真机验收。

---

## 2. 详细发现

> F1、F4、F5、F6、F7、F11、F12 已在本轮修复，下面的问题描述保留为修复前的状态；具体改动见第 5 节。

### F1【中】DApp `requestSignature` 的确认内容与实际签名字节不一致

**一句话**：DApp 通过 Scatter / TokenPocket 兼容接口提交的 action `data` 被原样展示，但真正上链时由 `Name.from()` 按“非法字符→`.`”静默改写；因此确认页上的收款人可以和链上实际收款人不同，且现有的字节回环校验抓不到。

**位置**

- `src/dapp/actionRequest.ts:29-45`：`data = a.data ?? a.args ?? {}`，随后 `JSON.parse(JSON.stringify(data))` 原样保留；只对 `account`、`name`、`actor`、`permission` 做了 `Name.from` 往返校验，**没有校验 data 内部的 `name` 类型字段**。
- `src/components/ConfirmTxSheet.tsx:200-207`：逐字段 `String(v)` 渲染，展示的就是原始 `"alice-smith"`。
- `src/chain/transact.ts:199-205`：`data: a.data` 交给 wharfkit 用链上 ABI 编码，`name` 字段走 `Name.from()`。
- `src/chain/transactionSafety.ts:38`：`Action.from({ ...expected, authorization }, abi).data.hexString !== actual.data.hexString` —— 两边都由**同一个原始值**编码，所以永远相等，抓不到这种“有损转换”。
- TokenPocket 路径同样受影响：`src/dapp/injected-token-pocket.ts:100-126`（`pushEosAction` / `eosTokenTransfer`）。

**根因**：`@wharfkit/antelope@1.2.0` 的 `stringToName()` 对 `a-z1-5` 之外的字符一律返回 0，而 0 在 `nameToString()` 里还原成 `.`。`Name.from()` 不做格式校验，因此：

| 确认页显示 | 实际编码 |
| --- | --- |
| `alice.smith` | `alice.smith` |
| `alice-smith` | `alice.smith` |
| `alice smith` | `alice.smith` |
| `alice_smith` | `alice.smith` |
| `alice0smith` | `alice.smith` |

**PoC（使用与 lockfile 相同的 `@wharfkit/antelope@1.2.0`，见附录 A）**

```
{"shown":"alice-smith","encodedAs":"alice.smith","hex":"0000000000855c34...044100000000000000"}
{"shown":"alice.smith","encodedAs":"alice.smith","hex":"0000000000855c34...044100000000000000"}
IDENTICAL SIGNED BYTES FOR DIFFERENT DISPLAYED RECIPIENTS: true
```

即：确认页显示 `alice-smith`，实际签名/广播的 `to` 是 `alice.smith`，两者 action 字节完全相同。

**影响**

- 恶意 DApp（或合法 DApp 中被注入的参数）可以让用户确认一个“看起来像正常账户/商户名”的收款人，资金实际进入攻击者预注册的带点账户。
- 典型场景：DApp 自己的界面显示 `alice-smith`（用户以为带连字符的账户合法），钱包确认页也显示 `alice-smith`，链上却打给 `alice.smith`。
- 对“钱包确认页是最后一道防线”的承诺是直接违反；ESR 路径和 `signTransaction`（页面给已序列化字节）路径不受影响，因为它们是从**待签字节**反解展示的。

**前置条件**：用户连接该 DApp 并点确认；攻击者控制被改写后的带点账户。

**修复建议**

1. 通用做法：在 `assertResolvedActionsMatch` 里增加“**从待签字节反解 → 与确认数据逐字段比较**”，而不是只做“同一份原始数据重新编码再比较”。这样任何有损转换（name 截断、大小写、数字精度）都会被拦截。
2. 快速做法：在 `prepareActionRequest` 里按 ABI 检查 `data` 中所有 `name` 类型字段，要求 `String(Name.from(value)) === value`，否则拒绝；`asset`/`int` 等同样做往返校验。
3. 展示侧：像 `decodeVisibleAction` 一样从编码后的字节生成确认内容，保证“展示的就是要签的”。

> 本轮实现采用了第 2 种的 ABI 遍历版本：在 `assertResolvedActionsMatch` 里遍历 ABI（含嵌套 struct、`name[]`、`name$`），对展示值做 `Name.from` 往返校验，再执行原有字节比较。这样 DApp、Send、资源、权限等所有走 `transact()` 的路径都覆盖，且不改动展示层。

---

### F2【中】内容接口可静默把已选 RPC 换成任意主机

**一句话**：`https://eos3.app/api/app-nodes` 返回的节点目录会**整体替换**内置节点列表；客户端按 `id` 匹配并把当前节点 URL 换成目录里的 URL，没有任何提示或确认。默认节点也直接取目录第一项。

**位置**

- `src/chain/NodeCatalogContext.tsx:25-30`：启动/前台/每 5 分钟拉取 `/api/app-nodes`，`parseNodeCatalog` 通过后写入内存与 AsyncStorage；响应**没有签名或版本锁定**。
- `src/chain/nodeCatalog.ts:15-27`：只校验 `id` 唯一、URL 是 https、无 userinfo/query/hash；**不校验主机名是否属于内置白名单**，也不校验 `id` 与主机名的对应关系。
- `src/chain/WalletContext.tsx:135`：默认节点 = `catalog[DEFAULT_CHAIN].rpc[0]`。
- `src/chain/WalletContext.tsx:302-311`：目录更新后 `next.rpc.find(n => n.id === node.id)`，URL 变了就 `setNodeState(rpc)` + `persistSession(...)`，**没有 UI 提示**。

**攻击路径**

1. 攻击者控制 `eos3.app` 内容接口（或该域名的 CDN/DNS/发布流程）。
2. 返回 `{ id: "greymass", name: "Greymass", url: "https://attacker.example" }`。
3. 客户端把用户当前节点（或默认节点）静默切到攻击者主机，顶栏仍显示 “Greymass”。
4. 之后所有 `w.node` 读操作（余额、权限、资源、TAPOS、广播、绑定状态、设备密钥权限）都由攻击者主机应答。

**为什么这比“普通只读节点被控”严重**

`readTrustedRpc()`（`chain/trustedRpc.ts`）只用 `CHAINS[chainId].nodes` 的内置主机做双节点仲裁，**不读远程目录**，所以导入账户/ABI 校验仍安全。但以下安全决策直接使用 `w.node`（用户当前节点）：

- `chain/bindAuthorize.ts:67-94`（绑定前的链上权限/额度状态）
- `chain/anchorDeviceImport.ts:50-58`（设备密钥 `updateauth` 的当前 `active` 权限）

也就是说，F2 把一个“需要同时攻破 eos3.app 和内建节点”的攻击，降级成“只攻破 eos3.app 即可”，与 F3 组成完整的账户接管链。

**前置条件**：`eos3.app` 内容接口被控（或 HTTPS 终止点被控）。普通网络攻击者无法在 TLS 下篡改，但该接口是中心化、无签名、可远程更新的信任源。

**修复建议**

- 安全相关读取（导入校验、绑定状态、设备密钥）一律使用内置 `CHAINS` 主机的双节点仲裁，不跟随用户所选/远程目录节点。
- 节点 URL 与 `id` 做绑定：内置 `id` 只允许内置 URL；远程目录只能新增自定义 `id`，不能改写内置条目。
- 若必须允许远程调整，至少弹出“节点地址已变更”的显式确认，并保留旧 URL 的信任记录。
- 给目录响应加签名（Ed25519），公钥硬编码在客户端。

---

### F3【中】设备密钥导入与绑定授权的安全检查依赖“单一用户节点”

**一句话**：两条会修改账户权限的流程，用当前选中 RPC 的 `get_account` / `get_table_rows` 结果来证明“这次签名是安全的”；节点说谎时，客户端本地的安全检查会放行一个更危险的交易。这与 `importAccount.ts` 已经采用的双节点仲裁不一致。

#### F3a 设备密钥导入：`updateauth` 的现有权限来自单节点

- `src/chain/anchorDeviceImport.ts:50`：`read('/v1/chain/get_account', ...)` 经 `ReadNodePool`（以用户当前节点为首）读取。
- `src/chain/anchorDeviceImport.ts:52-58`：用该响应的 `active.required_auth` 作为 `current` 传给 `validateDeviceKeyReview`。
- `src/chain/anchorDeviceReview.ts:18-22`：`deviceUpdateData()` 复制 `current.required_auth.keys`，只追加设备公钥。
- `src/chain/anchorDeviceReview.ts:36-37`：要求 `eos3.app /account/build` 返回的 `updateauth` 字节，**等于用这份 `current` 重建出来的字节**。

因此，若节点把 `active` 伪造成“已经包含攻击者 key/account”，而 `eos3.app` 的构建接口按这份伪造权限生成交易，客户端会认为“只是加了一把设备钥匙”，实际却把攻击者权限写进 `active`。反向（节点说谎 + 服务端诚实）会因字节不一致而失败，所以完整利用需要节点与服务端同时被控；但 F2 恰好提供了“只控服务端就能选节点”的捷径。

对比：`src/chain/importAccount.ts:59-66` 的 `verifiedPermissions()` 已经用 `readTrustedRpc()` 做双主机仲裁，设备密钥这条路径没有复用。

#### F3b 绑定授权：是否允许省略 `updateauth` 由单节点决定

- `src/chain/bindAuthorize.ts:67-94`：`readBindState()` 用 `opts.node`（用户当前节点）读 `get_account`、`botauth`、`assetlimit`、`actionallow`。
- `src/chain/bindAuthorize.ts:113-114`、`133`：`assertBindTxSafe` 的 `state` 来自这份单节点数据。
- `src/chain/bindIntent.ts:157-205`：`transfer` 权限是否“安全”（只含 `paylimit1111@eosio.code`、parent=active）由 `state.permissions` 判断；若交易里没有 `updateauth`，就完全依赖这个判断。

若节点谎称一个“已存在但含攻击者 key 的 `paytransfer` 权限”是安全权限，而构建响应省略了 `updateauth`，客户端会签下 `linkauth`，把该权限接到 `transfer` 上，绕过 paylimit 限额。反向（节点谎称不安全）最多让流程失败，不影响安全。

**修复建议**

- 这两处都改用 `readTrustedRpc`（≥2 个不同内置 HTTPS 主机一致）读取权限/表状态；失败即拒绝，不回退到用户节点。
- 对 `paytransfer` 权限，除链上状态外，再校验 `get_account` 返回的 authority 与本地期望的常量结构逐字节一致（不只依赖节点）。
- 在确认页明确展示“本次会修改/新增哪个权限”，而不是只显示 action 列表。

---

### F4【中】授权应用管理 action 的目标字段直接取自后端，未做语义校验

**一句话**：`resettotal` / `delasset` / `deleteauth` / `setlimit` 的目标 `bot_id_hash` 与 `permission` 都来自 `eos3.app` 的“已授权应用”响应；响应被控或出错时，UI 说的“撤销应用 A”可能实际操作应用 B、甚至 `active`/`owner` 权限。

**位置**

- `src/chain/permissions.ts:84-88`：`botIdHashOf(app)` 只做非空裁剪。
- `src/chain/permissions.ts:91-120`：`buildResetUsageActions` / `buildRemoveAssetActions` 原样使用 `opts.app.botIdHash`。
- `src/chain/permissions.ts:173-192`：`buildRevokeActions` 用 `opts.app.permission` 生成 `eosio::deleteauth`，**没有排除 `owner`/`active`**。
- `src/chain/authorizedAppsCache.ts:6-18`：`valid()` 只检查字段类型，不校验 `permission` 是否属于该账户、是否是自定义权限、`botIdHash` 是否与链上 `botauth` 记录一致。
- `src/screens/PermissionDetailScreen.tsx:139-143`：直接把这些 action 交给 `transact`。

**影响**

- 后端被控/出 bug 时：`deleteauth(account, "active")` 可移除账户的 active 权限（若链上允许，账户将无法正常使用）；`resettotal` 可清零**另一个** bot 的已用额度，恢复其消费能力；`delasset` 可删除另一个应用的限额配置。
- 确认页会展示原始 action（`eosio::deleteauth` + `permission`），但普通用户很难从 `@eosio + data` 看出“这不是我刚点的那个应用”。

**前置条件**：`eos3.app` 权限概览接口被控或返回错误数据；用户在该页执行撤销/重置。

**修复建议**

- 对每个 `app`，用链上 `get_account` + paylimit 表核对：`permission` 必须是该账户下的自定义权限（排除 `owner`/`active`/`eosio.code`），`bot_id_hash` 必须对应同一 `owner` 且 `permission` 一致。
- `deleteauth` 前额外要求 `permission !== 'owner' && permission !== 'active'`。
- 确认页把“应用名 / 权限名 / bot 哈希”三者一起展示，并高亮与用户点选行不一致的情况。

---

### F5【低】Sponsor 意图校验跳过“空授权” action

**位置**：`src/chain/txIntentCheck.ts:95-100`

```ts
for (const act of tx.actions) {
  const auths = act.authorization;
  if (!auths.some((l) => String(l.actor) === opts.actor)) {
    // 保留 Sponsor 自己授权的附加 action。它们不在本校验的保护范围内。
    continue;
  }
  ...
```

**问题**：注释的意图是“跳过 Sponsor 自己授权的 action”，但判断条件是“授权列表里没有当前用户”。于是：

- `authorization: []` 的 action 也被当成 Sponsor action 直接跳过。EOS 允许没有授权的 action；只要目标合约不 `require_auth`，它就会执行。恶意 Sponsor 可以在交易里塞一条用户完全没见过的 action。
- 这不是直接盗币（需要存在无需授权且有害的合约 action），但违反了“只允许用户确认过的 action + Sponsor 自己的 action”的不变式。

**修复**：显式区分 `authorization.length === 0`（拒绝，或仅允许白名单空 action），以及“授权 actor 属于 Sponsor 账户集合”（需要把 Sponsor 账户作为参数传入，而不是用 `!== user` 推断）。

**附**：`txIntentCheck.ts:110-135` 的代付费豁免只允许一次，但若用户确认的 action 本身就是“向 `eos3powerup1` 转正好等于报价的金额”，可被复制一份当作代付费，形成一条隐藏的重复转账。目前唯一调用方是资源修复，action 固定，实际不可达；建议同时把“代付费 action 不能与已确认 action 相同”作为显式条件。

---

### F6【低】ESR 链接拦截未绑定发起 frame/origin

**位置**

- `src/dapp/use-browser-esr.ts:16-33`：`interceptUrl()` 只要 `isEsrLink(url)` 就 `flow.open(url)`；`onOpenWindow` 同样不区分 frame。
- `src/screens/DappBrowserScreen.tsx:831-845`：`onShouldStartLoadWithRequest` 里对 ESR 的拦截在 `r.isTopFrame` 判断之前；`isTopFrame` 只用于是否重置 origin 状态。
- `src/dapp/esr-flow-overlay.tsx:30`：确认弹窗的 `origin` 是顶层页面的 host。

**影响**：在支持子框架导航回调的平台（尤其 iOS `decidePolicyForNavigationAction`），一个嵌在正规站点里的第三方 iframe / `window.open` 可以触发 ESR 登录或签名确认框，而归属于顶层正规域名。用户仍需确认 action，但“来源域名”这一关键提示可被误导。

**修复**：ESR 拦截只接受 `r.isTopFrame !== false`（iOS 子框架显式为 false；Android 的 `onShouldStartLoadWithRequest` 不带该字段，保持原有顶层行为）；`onOpenWindow` 记录 opener frame 的 origin 并展示，无法确定时拒绝。

---

### F7【低】`esr:` 载荷解压无输出上限（zlib bomb）

**位置**

- `src/dapp/esr.ts:33-38,97`：`SigningRequest.from(esr, zlibOpts)` 内部用 `pako.inflateRaw` 解压。
- `src/dapp/esr-links.ts`、`src/chain/parseQr.ts`：对 `esr:` 字符串长度没有上限。
- `DappBrowserScreen.tsx:232` 对 bridge 消息限制 1 MB，但那是**压缩后**的大小。

**影响**：几十 KB 的 deflate 载荷可膨胀到数百 MB/GB，导致 JS 线程 OOM、App 崩溃。仅拒绝服务，不涉及密钥。

**修复**：解压前限制输入长度（本轮取 16 KB），并用分块 `inflateRaw` 把输出上限设为 256 KB，超限立即抛错。

---

### F8【低】自定义 RPC 节点允许明文 `http://`

**位置**：`src/screens/NodeScreen.tsx:35` `const isValidUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s.trim());`，`:134-155` 直接保存并 `w.setNode(node)`。

**影响**：用户添加 `http://…` 后，该节点承载余额/权限读取、TAPOS 和广播；同一网络的攻击者可读交易、返回伪造的账户/权限状态。配合 F3 的单节点信任可放大。内置节点全部是 https，但 UI 没有对 http 给出任何风险提示。

**修复**：自定义节点只允许 https；如必须兼容 http，至少强提示并要求二次确认，且 http 节点不得用于任何签名前安全校验。

---

### F9【低】Anchor Link 会话未绑定账户/链，推送请求缺少来源标识

**位置**

- `src/dapp/linkSessions.ts:14-25`：会话记录里有 `account`、`chainId`，但 `isKnownLinkSession()` / `authorizeLinkSession()` 只按 `requestKey` 判断。
- `src/dapp/LinkSessionProvider.tsx:44-62`：只校验 `sealed.from` 是否在会话表，不校验当前账户/链是否与会话建立时一致。
- `src/dapp/useEsrFlow.ts:120`：随后用**当前** `w.account`、`w.chainId` 解析请求。
- `src/dapp/EsrRequestHost.tsx:20`：`<EsrFlowOverlay flow={flow} />` 不传 `origin`；`ConfirmTxSheet` 对主网也不显示链名（`testnet ? ... : null`）。

**影响**：用户在 Jungle4 建立的会话，切到 Vaulta 后仍然有效；推送来的请求确认页没有会话名、没有来源域名、主网也没有链标签，只有 DApp 自报的 `scope`。用户仍要确认 action，但缺少判断“这是谁、在哪个网络”的依据。

**修复**：会话绑定 `account + chainId`，不匹配时拒绝并要求重新登录；确认页展示会话名/来源/链名；`linkSessions` 记录并在 UI 中展示 `scope` 的不可信标注。

---

### F10【低】iOS 更新按钮可打开任意 https 地址

**位置**

- `src/update/appUpdate.ts:85-89`：只校验 `https:`、有 hostname、无 userinfo。
- `src/components/AppUpdateSheet.tsx:74`：`Linking.openURL(release.apkUrl)`（iOS 走系统浏览器/商店，不安装）。

**影响**：内容服务被控时，可把“更新”按钮指向任意 https 钓鱼页。不会安装任意代码（Android 侧有原生签名/包名校验，见第 3 节），但会损害更新入口的可信度。

**修复**：iOS 只允许固定域名（`eos3.app` / TestFlight 邀请链接白名单）；Android 同样对下载域名做白名单或校验发布元数据签名。

---

### F11【低】`device-key-authorized` 深链可自动导入并切换账户

**位置**

- `src/navigation/RootNavigator.tsx:101-109`：`DeviceKeyImport: 'device-key-authorized'`，前缀含 `eos3wallet://`、`aurorawallet://`、`https://eos3.app`。
- `src/screens/DeviceKeyImportScreen.tsx:302-307`：只要存在 `pending` 且未恢复过，就自动 `void check(true)`。
- `:218-243`：`check()` 读取链上候选账户 → `importPendingDeviceKey` → `w.reloadWallets()` → `w.setAccount(account)` → 重置到首页。

**影响**：本机存在待授权设备密钥时，任意网页/应用触发该深链即可让钱包导入并切换到一个已授权该公钥的账户，无需密码。若攻击者事先把自己的账户加入该公钥，用户可能被引导向攻击者账户充值。账户名会在成功弹窗中出现，但自动切换本身不是用户发起的。

**修复**：深链只恢复界面状态，导入/切换必须由用户点击确认，并展示账户名与链。

---

### F12【低】确认页未过滤 Unicode 双向控制字符

**位置**

- `src/screens/DappBrowserScreen.tsx:397`：`arbitrarySignature` 只排除 `\u0000-\u0008`、`\u000e-\u001f`，**允许** `\u0009-\u000d`、`\u007f` 以及 `U+202A–U+202E`、`U+2066–U+2069`、`U+200B–U+200F`。
- `src/components/ConfirmTxSheet.tsx:180-183,200-207`：文本/memo 原样渲染。

**影响**：RTL override / 零宽字符可在确认页把签名文本或 memo 视觉重排，制造“看到的内容 ≠ 实际签名的内容”。金额和账户是独立字段，影响有限，但属于同类展示完整性问题。

**修复**：展示前把 `Cc`（除 `\n\t`）、`Cf`（含 bidi 控制、零宽）与 `U+FEFF` 渲染成可见的 `⟨U+XXXX⟩` 转义；`arbitrarySignature` 直接拒绝这些字符，保证显示文本与签名文本一致。

---

### F13【信息】Vault 加固项

1. **信封没有槽位绑定（无 AAD）**：`crypto/vault.ts:89-95,216-226,663-664`。所有信封用同一密码派生密钥，salt/nonce 各自独立，但没有把 `id` 作为 AAD。能写 SecureStore 的攻击者（root/备份恢复）可以把 A 的信封搬到 B 的槽位。签名前 `localSigner` 会校验解出的公钥与 `wallet.publicKey` 一致（`chain/signers.ts:20`），所以**不会签错**，但可造成“钱包打不开/签名失败”的混淆。建议 v2 信封把槽位 id 纳入 AAD。
2. **`env.iterations` 无上限**：`vault.ts:258` 直接使用信封里的迭代次数。被篡改的信封可让 PBKDF2 跑极长时间（本地 DoS）。建议限制在 `[100_000, 2_000_000]`。
3. **`setMasterPassword` 覆盖前不校验旧密码**：`vault.ts:749-751` → `saveSecret(MASTER_ID, ...)`，而 `saveSecret` 对 `MASTER_ID` 跳过旧密码校验。正常 UI 只在 `hasMasterPassword() === false` 时进入；读取抛错时 `ImportScreen.tsx:43-47` 只是不跳转，不会误判为“未设置”。但如果主密码槽位或 generation 标记丢失/损坏（部分恢复、Keystore 重置等）而钱包索引仍在，用户会被引导“设置主密码”，新密码会覆盖验证器，旧 generation 下的密文从此无法在 UI 中解密。建议：设置前若 `listWallets()` 非空且不存在主密码槽位，拒绝并提示恢复；或保留旧验证器槽位。
4. **资源修复期间签名者驻留内存**：`components/ResourceRepairSheet.tsx:76-91` 把含明文私钥的 `signer` 存进 React state，最长 60 秒（`:69`）。这是为了复用刚解开的密钥、避免再次认证；但与 `chain/signers.ts` “用完即弃”的设计相悖。建议维修流程重新弹一次认证，或只保留一个一次性回调。

---

### F14【信息】依赖审计

`npm audit --package-lock-only`（2026-10-22）结果：**123 条告警（0 critical，111 high，5 moderate，7 low）**，其中绝大多数通过 `@expo/cli` / `metro` / `jest` 等**构建期工具链**传递，不进入 App 运行时；`elliptic` 的 low 告警已被 `patches/elliptic-6.6.1.json` 处理（项目自带 `check:dependencies` 校验）。

建议：保留现有的 lockfile + patch + `npm audit signatures` 流程；对真正进入 bundle 的依赖（`@wharfkit/*`、`@noble/*`、`expo-*`、`react-native-webview`）单独维护运行时 SCA，不要把构建期告警和运行时风险混在一起看。

---

## 3. 已核查为安全/未发现可利用问题的关键路径

以下是本轮重点验证、**未发现**可绕过的问题（供后续回归参考）：

### 3.1 密钥保管

- 私钥：PBKDF2-HMAC-SHA256 600k + 16 字节随机 salt + AES-256-GCM + 12 字节随机 nonce；每条信封记录自己的 `iterations`，旧记录仍可解（`vault.ts:137-269`）。
- 保存前校验主密码；写完立即读回解密比对，失败删除（`vault.ts:188-233`）。
- 改密码：先解密全部必需条目并在新 generation 下重加密，再原子切换 generation；失败不删旧 generation（`vault.ts:768-822`）。
- 生物识别：不直接加密私钥，只把主密码存进 `requireAuthentication: true` 的 SecureStore 条目；Android 对应 `setUserAuthenticationRequired(true)`，iOS 对应 `biometryCurrentSet`（Expo 文档核实）。签名前仍会校验解出的公钥。
- 导入/设备密钥：最终保存前用 `readTrustedRpc` 双主机核对账户权限（`importAccount.ts`）；A1 类“恶意节点污染收款账户”已修复。
- 秘密剪贴板：显式复制、串行化、退出/后台清理、失败不报成功（`secretClipboard.ts`）。
- 未发现把私钥/助记词写入 AsyncStorage、日志或网络的代码路径；`fromPrivateKey` 的错误信息已去敏。

### 3.2 交易与签名

- 确认前对 action 做深拷贝快照，签名时校验数量/顺序/合约/action/授权，并用链上 ABI 逐字节回编码（`transact.ts:186-207`、`transactionSafety.ts:27-41`）。
- 拒绝 context-free action、transaction extensions、非零 delay、空 action、过期/超 10 分钟交易（`transactionSafety.ts:6-15`）。
- 非核心合约 ABI 至少两个内置 RPC 一致才使用（`trustedRpc.ts` + `signingAbi.ts`）。
- Sponsor：报价收款人固定为 `eos3powerup1`、费用上限 0.05、签名前按“用户确认的 action + 报价”字节核对，服务端无法夹带（`sponsor.ts:238-341`、`txIntentCheck.ts`）。
- 绑定授权：本地重建 `setbot`/`setlimit`/`delasset`/`updateauth`/`linkauth`/`clearacts` 并与服务端字节比较；`paytransfer` authority 必须是固定常量结构（`bindIntent.ts`）。
- 冷签名：QR 结果必须对原始 digest 和独立核验过的公钥验签，返回的交易只用于比对、不用于广播（`coldSigningProtocol.ts:41-61`）。
- Passkey：校验 challenge、RP ID 哈希、UP+UV 标志、credential ID、`crossOrigin !== true`，并用 `p256.recoverPublicKey` 确认签名对应钱包公钥（`webauthnSigning.ts:45-98`）。

### 3.3 DApp / ESR

- bridge 消息需要 `bridgeToken`（`Crypto.randomUUID()`）+ `documentId` + 原生 `e.nativeEvent.url` origin 三者匹配；account API 只接受 https（`accessGuard.ts`）。
- 请求 id 绑定 epoch/document，断开连接永久作废未完成请求；重连/复用 id 不会复活旧授权（`accessGuard.ts`、`dappDisconnectSecurity.test.ts`）。
- ESR：链 ID 必须匹配；identity 证明有效期由本机时间限制为 5 分钟；回调只允许 https、无 userinfo、无 `{}`、`redirect: 'error'`、`credentials: 'omit'`；`esrRequest` 之外不把 http 页面接入 provider。
- 只签文本：限制 512 字符并排除大部分 C0 控制字符；签名对象是 `sha256(UTF-8(text))`，无法与含高位字节 chain_id 的交易摘要混淆。
- Anchor Link：校验和基于 ECDH + nonce；会话撤销即时 abort；重放按 `(from, nonce)` 去重；relay 响应只用于触发，账户/交易以链上为准（`anchorWeb.ts:142-167`）。

### 3.4 更新与供应链

- Android 更新：无 JS 回退；原生 `WalletUpdateVerification` 校验包名、`versionCode == 期望值 > 已安装`、签名证书集合完全一致，并把文件限制在私有 cache 内（`WalletUpdateVerificationModule.kt`、`UpdatePackagePolicy.java`）。任意 APK/降级/换签名均被拒绝。
- CI：`android-build.yml` 只由 `v*` tag 触发，`main-tests.yml` 只由 `main` push 触发，**没有 `pull_request_target`**，PR 代码无法接触签名密钥。

### 3.5 深链

- 只注册 `BindAuthorize: 'tgbind'` 与 `DeviceKeyImport: 'device-key-authorized'`，没有“打开导入页/导出私钥/改权限”的深链；签名仍需密码/生物识别/Passkey。

---

## 4. 修复优先级建议

> 以下为报告初稿时的建议；本轮已按此完成 F1、F5、F6、F7、F12 与 F4 的入口校验，状态见第 6 节。

1. **F1**（本周内）：给 `assertResolvedActionsMatch` 增加“从字节反解后与确认数据比较”，或对 data 做 ABI 级往返校验。改动小、直接消除“显示≠签名”。
2. **F2 + F3**（同一轮）：安全相关的链上读取全部切到 `readTrustedRpc`；节点目录与内置 id 解耦，或加签名。
3. **F4**：管理 action 目标与链上状态交叉校验；`deleteauth` 排除系统权限。
4. **F5/F6/F7**：小改动，建议一并合入。
5. **F8–F12**：按 UX/威胁模型排序；F8 至少加 http 警告，F9 给确认页补来源，F10/F11 收紧入口。
6. **F13**：在下一个信封格式版本中做 AAD 绑定；其余按需。

---

## 5. 本轮修复记录（2026-10-22）

已在本仓库实现（本次提交），处理了 F1、F5、F6、F7、F12、F4 与 F11：

| 编号 | 状态 | 改动 |
| --- | --- | --- |
| F1 | **已修复** | `chain/transactionSafety.ts` 新增 `assertExactDisplayedNames`：遍历 ABI（含嵌套 struct、`name[]`、`name$`、typedef 别名），要求确认页展示的每个 name 经 `Name.from` 往返不变；在逐字节回编码比较之前执行。覆盖 Scatter `requestSignature` 与 TokenPocket `pushEosAction`/`eosTokenTransfer`。新增 `chain/__tests__/transactionSafety.test.ts` 4 项。 |
| F5 | **已修复** | `chain/txIntentCheck.ts` 在“跳过 Sponsor 自有 action”之前显式拒绝 `authorization.length === 0`。`txIntentCheck.test.ts` 新增 1 项。 |
| F6 | **已修复** | `screens/DappBrowserScreen.tsx` 的 ESR 导航拦截改为 `r.isTopFrame !== false`：iOS 明确为子框架的导航不再触发；Android 的 `onShouldStartLoadWithRequest` 不带该字段，行为保持不变（Android 本身只回调顶层导航）。`window.open` 路径仍依赖浏览器的用户手势限制，作为残余风险保留。 |
| F7 | **已修复** | 新增 `dapp/esrZlib.ts`：压缩输入上限 16 KB、解压输出上限 256 KB；`dapp/esr.ts` 与 `chain/anchorWeb.ts` 共用该 zlib 实现，并在 `parseEsr` 增加 64 K 字符的 URI 上限。新增 `dapp/__tests__/esrZlib.test.ts` 3 项（含 deflate bomb）。 |
| F12 | **已修复** | 新增 `components/displayText.ts`：把 bidi override、零宽空格、C0/C1 控制符渲染成 `⟨U+XXXX⟩` 可见转义（保留 `\n\t` 与 emoji 的 ZWJ/ZWNJ）；`ConfirmTxSheet` 的 message 与所有 action data 值都经过它。`arbitrarySignature` 路径改为直接拒绝这些字符，确保“显示文本 = 签名文本”。新增 `components/__tests__/displayText.test.ts` 3 项。 |
| F4 | **已修复** | `chain/permissions.ts` 新增 `verifyManagedApp`：管理操作前用 `readTrustedRpc`（两个内置 RPC 主机一致）读取 `get_account` 与 paylimit `botauth` 表，要求权限存在、非系统权限，且 bot 行的 `owner` / `permission` / `bot_id_hash` 与响应完全匹配；表响应被截断（`more`）直接拒绝。`PermissionDetailScreen` 在构建 action 前调用它。`buildRevokeActions` 另拒绝 `owner`/`active` 与非法权限名。新增 `permissionsOnChain.test.ts` 6 项、`permissions.test.ts` 3 项。 |
| F11 | **已修复** | `screens/DeviceKeyImportScreen.tsx` 的 `check()` 现在只把链上候选账户放进 `accountChoices`，不再自动导入 `accounts[0]`；页面逐条列出账户名，用户点选后才执行 `importPendingDeviceKey` 并切换。深链/冷启动自动恢复仍然保留到“展示候选账户”这一步，但切换必须是一次明确点击。`deviceKeyImport.test.ts` 与 `passkeyCreate.test.ts` 已按新交互更新。 |
| F2 / F3 / F8 / F9 / F10 / F13 / F14 | **未改** | 按第 0.1 节保留为服务端/节点被控时的纵深防御或本地攻击面；未纳入本轮“外部攻击者可独立触发”的修复范围。 |

**验证结果**

- `tsc --noEmit`：通过。
- 全量 Jest：`117 suites / 1277 tests` 全部通过（含新增 20 项回归）。
- 相关子集（交易、Sponsor、ESR、绑定、设备密钥、DApp 断开、权限、确认页）：`19 suites / 286 tests` 通过。
- 未运行：`npm test` 内置的 `check-source`（Node 在沙箱内 spawn `git` 返回 EPERM，环境限制）与 `dependency-policy`（Windows CRLF 检出的 `package-lock.json` 哈希与策略文件的 LF 哈希不一致，属既有环境问题，未改动策略文件）。

---

## 6. 残余风险（不在本次结论内，但应知晓）

- 已解锁的私钥会进入 JS/原生内存；被 root/jailbreak、恶意运行时依赖或系统级工具控制时，应用层加密无法阻止读取。
- 导出私钥会进入系统剪贴板与剪贴板历史；复制后无法撤回已被其他应用读取的内容。
- `eos3.app` 仍是 Passkey 开户、设备授权、内容、代付、绑定、权限概览的中心化信任源。F2/F3 说明：**服务端被控时，客户端的防护应默认失败关闭**，而不是依赖服务端返回的字段。F4 已加链上权限/bot 交叉校验，但“这个 bot 展示成哪个应用”的语义仍来自服务端。
- Android/iOS 真机上的 Keystore/Keychain、Passkey 面板、WebView 子框架行为未在本轮验证；`expo-secure-store` 文档也明确指出模拟器不会真正要求生物识别。
- 依赖告警以构建期为主，但运行时依赖仍应持续跟踪。
- 链上合约（paylimit、代付、passkey 相关）与 `eos3.app` 后端未审计；本报告不能证明它们安全。

---

## 附录 A：F1 复现脚本

依赖：`@wharfkit/antelope@1.2.0`（与 `package-lock.json` 锁定版本一致）。脚本只做本地编码，不联网、不需要私钥。

```js
const { ABI, Action, Name, Serializer } = require('@wharfkit/antelope');

const abi = ABI.from({
  version: 'eosio::abi/1.1',
  structs: [{ name: 'transfer', base: '', fields: [
    { name: 'from', type: 'name' },
    { name: 'to', type: 'name' },
    { name: 'quantity', type: 'asset' },
    { name: 'memo', type: 'string' },
  ] }],
  actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
  types: [], ricardian_clauses: [], error_messages: [], abi_extensions: [], variants: [],
});

function encode(to) {
  // 与 src/dapp/actionRequest.ts 一致：data 原样来自页面
  const data = { from: 'alice', to, quantity: '1.0000 A', memo: '' };
  const action = Action.from(
    { account: 'core.vaulta', name: 'transfer', authorization: [{ actor: 'alice', permission: 'active' }], data },
    abi
  );
  const decoded = Serializer.objectify(action.decodeData(abi));
  return { shown: to, encodedAs: String(decoded.to), hex: action.data.hexString };
}

for (const shown of ['alice.smith', 'alice-smith', 'alice smith', 'alice_smith', 'alice0smith', 'Alice.smith']) {
  console.log(JSON.stringify(encode(shown)));
}
const a = encode('alice-smith');
const b = encode('alice.smith');
console.log('IDENTICAL:', a.hex === b.hex, '| displayed:', a.shown, '| encoded:', a.encodedAs);
```

输出（节选）：

```
{"shown":"alice-smith","encodedAs":"alice.smith","hex":"0000000000855c34...044100000000000000"}
{"shown":"alice.smith","encodedAs":"alice.smith","hex":"0000000000855c34...044100000000000000"}
IDENTICAL: true | displayed: alice-smith | encoded: alice.smith
```

> 复现环境中的 `node_modules` 与 npm 缓存已在测试结束后删除；源码与报告保留。

---

## 附录 B：主要检查命令

```bash
git rev-parse HEAD            # 4960b399a67929445326f0dda20c8f6522f392d1
npm audit --package-lock-only # 123 advisories, 0 critical
# F1 PoC（附录 A）：先在一个临时目录安装与 lockfile 相同的依赖
# npm i @wharfkit/antelope@1.2.0 && node coerce.js
# 修复后的回归：
# node node_modules/jest/bin/jest.js src/chain/__tests__/transactionSafety.test.ts --runInBand
```

---

*本报告基于 2026-10-22 的源码快照，不代表对已发布 APK/IPA 的二进制审计，也不构成独立第三方安全认证。*
