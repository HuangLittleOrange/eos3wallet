# eoseyes Chat 账户验证 TAPOS 报错分析

核验日期：2026 年 10 月 18 日（北京时间）  
涉及页面：[eoseyes Chat](https://eoseyes.com/chat)  
提交对象：eoseyes 前端与钱包集成维护者

## 结论与建议

当前部署的 TokenPocket 钱包通道包含一段使用真假值检查参考区块字段的 eosjs 实现。Chat 账户验证主动构造参考区块字段为 `0/0` 的不广播交易，这两个数字会被该实现误判为参数缺失，触发与用户截图完全相同的错误：

```text
Required configuration or TAPOS fields are not present
```

网站可修复实际打包进 TokenPocket / Scatter 通道的依赖或其 TAPOS 校验。当前钱包侧也已实施兼容处理，允许数字零通过字段检查，同时保留服务器挑战所要求的原始交易内容及 `broadcast: false`；具体实现与验证状态见“钱包侧处理状态”。

这一判断依据是线上部署代码、官方历史源码和钱包的现有适配流程。尚未取得本次手机运行的完整调用栈，也未验证网站后端验签结果；维护者可按下文断点步骤确认实际传入值。报告不据此认定所有钱包或所有交易都会受影响。

## 用户现象与预期行为

用户在 iPhone 的 EOS³ 钱包内置浏览器打开 Chat 页面，连接账户后，页面显示“Verify account ownership”，随后出现上述错误。截图只记录到报错，未提供钱包安装包版本、iOS 版本或完整控制台日志。

预期行为是：网站构造账户归属验证交易，钱包展示签名确认，经用户同意后返回签名和对应交易字节，由网站提交到 `/ai/auth/verify`。该流程不应广播交易。

这里的“网站”指 eoseyes.com 的网页及其 JavaScript 依赖；“钱包浏览器”指 EOS³ 钱包中承载网页、提供 Scatter / TokenPocket 接口和原生签名确认的 WebView。两者不是同一个组件。

## 线上代码证据

### 账户验证明确使用零参考区块

在[账户验证脚本](https://eoseyes.com/_next/static/chunks/008v55u7apwgh.js)中，可以确认：

- 通过 `/ai/auth/challenge?actor=...` 获取 `expiration`。
- 构造交易时明确写入 `ref_block_num: 0`、`ref_block_prefix: 0`。
- action 为 `eoseyespower::noop`，授权采用当前账户与权限，action data 为空。
- 调用会话的 `transact`，并设置 `broadcast: false`。
- 获得签名后，将签名与返回交易的打包字节提交给 `/ai/auth/verify`。

因此，当前网页在构造阶段并非遗漏这两个字段，而是有意传入数字零。零值可以被交易格式编码，也可以参与签名；这不等于该交易可通过链上 TAPOS 校验。本报告讨论的是不广播的账户验证路径。

### TokenPocket 通道加载 Scatter 协议

[钱包插件脚本](https://eoseyes.com/_next/static/chunks/0e560sfys7lh1.js)导出 `WalletPluginTokenPocket`，其登录、退出与签名逻辑会动态加载 Scatter 协议。加载目标包含：

```text
/_next/static/chunks/0bzi1ekxzg_.d.js
```

这说明仅更新主应用直接使用的另一份 eosjs，并不一定能修复问题；需要核对这一动态加载通道最终解析和打包的实际实现。

### 报错由网页 API 在签名回调之前抛出

在[协议脚本](https://eoseyes.com/_next/static/chunks/0bzi1ekxzg_.d.js)中，`hasRequiredTaposFields` 的压缩实现读取过期时间、参考区块号和参考区块前缀，最后执行：

```js
!!(t && r && n)
```

其中 `r`、`n` 对应两个参考区块字段。任何一个为数字零，这个表达式都会返回 `false`。

同一脚本的 `transact` 在这个校验失败时抛出截图中的错误。该位置位于此 API 获取交易 ABI、序列化并调用 `signatureProvider.sign` 之前。该脚本同时包含以下调用关系：

1. 通过 Scatter 创建 connector，并传入脚本自带的 eosjs `Api` 类。
2. 把 WharfKit 已解析的交易编码，再由 connector 反序列化。
3. 调用 `connector.transact(decoded, { broadcast: false })`。
4. 取得签名结果后，重新解析返回的交易，交还 WharfKit 会话。

可读的[官方协议源码](https://raw.githubusercontent.com/wharfkit/protocol-scatter/master/src/index.ts)也展示了这条 connector 调用关系。该地址跟随 master；本报告的部署行为以线上协议脚本为准。

## 为什么称为旧校验实现

官方 [eosjs v20.0.0-beta3](https://raw.githubusercontent.com/EOSIO/eosjs/v20.0.0-beta3/src/eosjs-api.ts) 的 `hasRequiredTaposFields` 使用：

```js
return !!(expiration && ref_block_num && ref_block_prefix);
```

官方 [eosjs v22.1.0](https://raw.githubusercontent.com/EOSIO/eosjs/v22.1.0/src/eosjs-api.ts) 已改为检查两个参考区块字段是否为数字类型，因此不会仅因为值为零就拒绝。

可以确认的是：网站产物中存在与该历史版本一致的真假值校验逻辑。不能仅凭这一函数确定网站安装的确切版本，也不能排除间接依赖、复制代码或定制构建。请结合锁文件、依赖树及最终构建产物确定来源。v22.1.0 在这里用于证明官方实现已发生变化，不代表已替网站选定升级目标。

## 钱包适配行为与故障边界

EOS³ 钱包当前的 eosjs2 适配方式是：接收网页传入的 `Api` 类及配置，替换 `signatureProvider` 后创建实例。其余交易处理交给网页提供的 API。成功进入签名回调后，钱包才通过原生桥接收交易，执行交易解码、链检查、用户确认和签名。

据此，故障关系可表述为：

```text
Chat 构造 0/0 挑战交易
  → TokenPocket 插件调用 Scatter 协议
  → connector 使用网页自带的 eosjs API
  → 旧真假值检查拒绝 0
  → 抛出 TAPOS 错误
  → 该 API 的 signatureProvider.sign 尚未调用
```

这是当前代码能够解释的报错路径。它不证明钱包所有兼容行为都没有问题，也不证明其他钱包会采用相同的 API 处理方式。钱包可以增加兼容逻辑，但覆盖网页库的内部方法会增加维护耦合，网站侧修复依赖更直接。

## 最小复现与现场确认

下面的独立示例只复现校验缺陷，不连接钱包、不签名、不广播，也不等同于后端登录成功：

```js
const tx = {
  expiration: new Date(Date.now() + 120000).toISOString().slice(0, 19),
  ref_block_num: 0,
  ref_block_prefix: 0,
};

const oldCheck = t =>
  !!(t.expiration && t.ref_block_num && t.ref_block_prefix);

const presenceCheck = t =>
  !!t.expiration &&
  typeof t.ref_block_num === 'number' &&
  typeof t.ref_block_prefix === 'number';

console.log(oldCheck(tx));      // false
console.log(presenceCheck(tx)); // true
```

`presenceCheck` 仅用于说明“存在”和“非零”的区别，不是完整交易校验器。

建议维护者在实际页面验证时：

1. 选择 TokenPocket 通道，连接钱包，发起 Chat 账户验证。
2. 在动态加载的协议脚本中搜索完整错误文本，在抛错处断点。
3. 在 `connector.transact` 前检查反序列化交易的 `expiration`、两个参考区块值及其类型。
4. 确认两个参考区块字段为数字零时，当前校验返回 `false`。
5. 在 `signatureProvider.sign` 或钱包签名桥入口设置断点，确认此次失败未到达该入口。
6. 修复网页后，在不增加钱包补丁的情况下重复操作，确认能够进入签名确认并完成服务器验签。

## 网站侧修复建议

优先追踪 TokenPocket 插件到 Scatter 协议再到 eosjs 的实际依赖来源。npm 项目可先执行：

```sh
npm ls eosjs @wharfkit/protocol-scatter @wharfkit/wallet-plugin-tokenpocket
```

根据项目实际包管理器检查间接依赖和多版本安装。选择与现有 WharfKit、Scatter 接口兼容的修复版本，重新构建并检查动态加载的协议产物，确认不再使用零值即缺失的判断。

若上游升级暂不可行，可在网站维护的依赖补丁中修正该检查：验证字段存在、类型正确，并在适当层校验整数范围、时间格式及其他交易约束。数字零不能被当成字段缺失。补丁应进入可追踪的源代码与构建流程。

不要仅为消除报错而随意将参考区块改成 1、增加会重建交易头的配置，或改为广播交易。过期时间、参考区块和 action 都参与签名摘要；任何交易变化都需要与后端挑战校验规则一致。当前前端会把返回交易的字节提交验签，后端是否接受特定修改仍需检查服务端实现。

## 修复验收清单

| 场景 | 验收要求 |
| --- | --- |
| 参考区块 0/0、过期时间存在 | 不因零值而报字段缺失，进入用户签名确认 |
| 只有一个参考区块字段为零 | 不因零值而误拒绝 |
| 缺少字段或类型不正确 | 明确拒绝，不通过真假值判断混淆原因 |
| 常规完整交易 | 保持原有序列化、签名和广播选项行为 |
| 用户拒绝签名 | 正确取消，不建立已验证登录状态 |
| 账户或链不匹配 | 继续按既有规则拒绝 |
| Chat 验证使用 broadcast false | 返回签名与对应交易字节，不推送链上交易 |
| 后端验签 | 接收同一笔已签交易，正确处理有效、过期或篡改的挑战 |
| 构建部署 | TokenPocket 动态加载产物实际包含修复，旧产物缓存不再被页面引用 |

“可编码并签名的零值”和“可广播交易所需的有效参考区块”应分别测试。不能为支持登录挑战而取消常规交易的 TAPOS 检查。

## 钱包侧处理状态

当前已按钱包维护者决定，在 `scatter.eos()` 创建的网页 API 实例上兼容 `hasRequiredTaposFields`：过期时间字段须为非空字符串，参考区块号须为 0 至 65535 的整数，参考区块前缀须为 0 至 4294967295 的整数。API 不暴露该方法时保留原有实例行为。兼容处理不重建交易头，不修改原始交易字节或广播选项；实际签名前仍经过原生交易解码、链校验、过期时间校验和用户确认。

注入层、原生浏览器签名流程和交易解码相关测试共 72 项通过，类型检查通过。新增用例验证零参考区块、整数边界、缺失或非法字段、用户拒绝，以及原生确认后产生对应原始零参考区块交易的有效签名。源码修复尚未打包发布，也未完成手机与网站后端的联合验证；测试通过不代表网站部署产物已升级。

## 部署产物指纹

核验时间：2026-10-18T22:28:56.314402+08:00。以下指纹针对该次 HTTP 请求取得的文件字节；网站重新部署或响应内容变化后，地址和指纹可能改变。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| 账户验证 008v55u7apwgh.js | 80672 | `fd26f7ec89f020fb6c8c9c64d07fa23ac04bdc692ce47210853f166374a6388d` |
| 钱包插件 0e560sfys7lh1.js | 43359 | `d3bfc6cffbcfb13b0476f3e77fa7068071ab8e8330b17773138123b4be3990e0` |
| Scatter 协议 0bzi1ekxzg_.d.js | 201905 | `d5146bfab3725be9376adf254579d5ce0508aa8cea0d8afe96ca9a8593373f53` |

以上只读取了公开静态脚本和官方源码。分析过程中没有向网站提交登录验证、调用真实钱包签名或广播交易。

