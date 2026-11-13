# AStudio 逆向结论汇总

> 对象：AStudio（讯飞桌面 Agent）。**协议事实**（端点、字段、状态码、怎么用）以
> [PROTOCOL.md](./PROTOCOL.md) 为准；本文汇总「逆向出了什么」+ 证据等级、可复用方法论、
> 完整实跑记录与渠道缺口清单。
>
> 结构：§1 方法论（可复用）· §2 一次完整实跑 · §3 渠道缺口与交接。

---

# 1. 逆向方法论（可复用）

> 状态：方法论记录。协议事实以 [PROTOCOL.md](./PROTOCOL.md) 为准；
> 一次完整实跑记录见 [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627)。

本文件是**可复用的工作流**：换一个 Agent 应用（桌面端 / 移动端 / 任何带私有协议的客户端），
按同样的阶段走一遍，就能从「什么都不知道」到「能用脚本复现任意请求」。
AStudio 的具体产物（端点、字段、坑）在 [PROTOCOL.md](./PROTOCOL.md) —— 那是本方法论的**一次应用结果**，
不是方法论本身。**方法论的完整实跑记录**（真实命令、脱敏输出、踩坑与推理现场）在
[FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627) —— 读方法论觉得抽象时看它，每个 Stage 都有对应的实操小节。

## 0. 心法：四条证据链

| 链 | 手段 | 回答的问题 | 局限 |
| --- | --- | --- | --- |
| **静态链** | 应用解包 + 字符串采矿 | 它**会**发什么（端点、参数、鉴权逻辑都在代码里） | 死代码、懒加载、服务端下发配置会误导 |
| **动态链** | 抓包（流量拦截） | 它**实际**发了什么（真实请求的形状） | 证书固定、加密载荷会挡住；只能看到触发过的路径 |
| **行为链** | 自己拼请求复现 | **我**能不能发（脱离原应用独立调用） | 需要真实凭据；发错载荷会撞风控 |
| **参考链** | 别人的反代/2api 项目 | 交叉验证与补漏 | **不是源头** —— 别人的结论也是前三条链来的；盲信等于把别人的过时认知变成自己的 |

三条主链的关系：**静态给候选，动态给真相，行为给定论**。
参考链只做一件事 —— 在你三条链走完之前帮你缩小搜索范围，走完之后当交叉验证。

铁律（每条链都适用）：

1. **不打印令牌原文**。脚本输出只给「前几位 + 长度 + 指纹」。
2. **只发正确形态的请求**。复现是为了验证「正常调用能不能通」，不是「故意发错看会怎样」——
   拿真实账号发畸形载荷就是撞风控，轻则 429，重则封号封 IP。
3. **结论标注证据等级**：A = 源码静态提取，B = 真机实测，C = 推断（写明依据）。
   不臆造端点：每个写进文档的端点要么源码里见过，要么实测打过。

## 1. Stage 0 —— 定目标

动手前先列**协议问题清单**，它决定每条链挖多深：

- 登录 / 鉴权：登录态怎么建立？凭据有几种、各打哪个面？
- 对话：端点在哪、什么协议形态（OpenAI 兼容 / 私有）、流式怎么编码？
- 模型：清单从哪来（远端拉取 / 内置目录）、id 有几套、倍率/额度在哪？
- 运营面：签到、积分、套餐、通知类端点有哪些？

## 2. Stage 1 —— 应用解包（静态链）

### Electron 应用（Agent 桌面应用最常见）

**定位**：安装目录 `resources/app.asar`（主进程 + 渲染层 bundle，**明文容器，直接可搜**）。

**解包两选一**：

```bash
# 官方工具整包解开（适合系统性地读源码）
npx @electron/asar extract app.asar app-src/

# 零依赖直接搜原文件（适合快速采矿 —— asar 头部是 JSON 索引 + 明文拼接，grep 就中）
grep -aob "https\?://[a-z0-9.-]*" app.asar | head -50
```

**挖什么（按价值排序）**：

1. **端点路径**：正则 `/api/[a-zA-Z0-9/_-]+`、`/v[0-9]/[a-zA-Z0-9/_-]+`、裸域名清单。
   同一路径的不同前缀（如 `/api/xxx/...` vs `/xxx/...`）要分清 —— 代理层前缀与云端真实路径经常不一致。
2. **鉴权拼装函数**：搜 `Authorization` / `Bearer` / `Cookie` / `sign` / `token` /
   `createXxxGateway` / `buildXxxHeader` —— 鉴权头是拼出来的，找到拼装点就找到了全部凭据字段。
3. **请求封装层**：fetch/axios 的统一 client（拦截器里常塞客户端头：平台、版本、构建号、设备指纹）。
4. **配置常量**：clientId、appVersion、协议版本号 —— 服务端校验「客户端身份」时必需。
5. **本地落盘**：`userdata/`、`%APPDATA%` 下的 json / leveldb / sqlite ——
   会话文件经常**明文**存着 token（登录态白捡）。
6. **日志开关**：找 `debugDump`、`verbose`、`log level` —— 应用自带的诊断日志是动态链的免费起点。

**渐进策略**：grep 全貌 → mine 局部（命中行前后几百字符）→ extract 整段（关键函数全文）。
一上来就整包 extract 会淹死在 bundle 里。
（AStudio 实操：裸域名正则被 161 条许可证链接淹没 → 域名分组降噪 → authBaseUrl 三环境，
见 [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627) §1。）

### 非 Electron

- **Tauri**：前端 assets 在安装目录（WebView 加载的 html/js），Rust 侧逻辑要反编译 —— 先挖前端。
- **原生 / 打包加固**：`strings` 扫可见字符串 → 反编译（IDA/Ghidra，超出本方法论范围时明确标注）。
- **通用兜底**：Stage 2 的动态链不依赖解包 —— 解不开就纯抓包。

## 3. Stage 2 —— 抓包（动态链）

**由易到难的手段梯度，先便宜后贵**：

### 2.1 应用自带日志（零成本）

`userdata/logs/`、安装目录 log —— 主进程/本地服务常打印 upstream URL、状态码、错误体。
先翻日志，很多「神秘端点」直接写在里面。

### 2.2 开发者工具（Electron 专属捷径）

应用若保留了 devtools（菜单或快捷键能唤出），Network 面板就是**现成的抓包**：
过滤 Fetch/XHR，把每条请求的 URL / 头 / 体复制下来。这是最快路径，优先试。

### 2.3 HTTP 中间人（标准抓包）

```bash
# mitmproxy（Web UI 版更直观）
mitmweb --listen-port 8888
```

**挂代理**（按应用形态选）：

- Electron/Chromium 内核支持命令行旗标：`应用.exe --proxy-server=127.0.0.1:8888`；
- 应用走系统代理：Windows 设置 → 代理，或 `netsh winhttp set proxy`；
- 应用直连不走系统代理：用 **Proxifier** 等按进程名强制转发到 8888。

**证书**：Electron 的网络栈是 Chromium，信任系统证书库 —— 把 mitmproxy 的 CA
（`http://mitm.it` 下载）装进「受信任的根证书颁发机构」即可解密 HTTPS。

**证书固定（pinning）挡住时**，按序尝试：

1. `NODE_EXTRA_CA_CERTS=<mitm-ca.pem>` 环境变量 —— Electron 主进程是 Node，多数实现会追加信任；
2. 补丁渲染层 bundle（把 `rejectUnauthorized: true` 改 false）—— 改完要重打包 asar；
3. 都不行就**放弃解密**，退回 2.4 + 静态链：知道连了谁、什么时候连，配合源码推断载荷。

**记录什么**（每条请求）：方法、完整 URL、请求头（**重点鉴权头**的形态与来源）、
请求体形状、响应形状、状态码。抓完对照静态候选 —— 见 Stage 3。

### 2.4 流量层兜底（不解密，只看连接）

```powershell
Get-NetTCPConnection -OwningProcess <pid> | Select RemoteAddress, RemotePort
```

操作应用的同时轮询，拿到真实对端 IP → 反向解析域名 → 与静态链挖出的域名比对。
IP 对不上代码里的域名，说明还有没挖到的配置源（服务端下发、CDN、本地代理层）。
（AStudio 实操：主进程诊断日志四条实拍与静态推导逐条对上；对话流量不在主进程 =
渲染层直连，见 [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627) §2。）

### 抓包纪律

- 只抓**自己的账号、自己的流量**；
- 抓到的请求**不重放、不篡改** —— 验证走 Stage 3 的行为链（正确载荷）；
- 令牌在笔记里只落指纹，原文不进文档。

## 4. Stage 3 —— 证据合并与复现（行为链）

### 3.1 交叉表

把两条链对齐成一张表：

| 端点（静态候选） | 抓包实拍？ | 结论 |
| --- | --- | --- |
| 有且实拍过 | 是 | 高置信，直接进复现队列 |
| 有但没实拍 | 待确认 | 可能是死代码/懒加载 —— **触发对应 UI 动作再抓**（点签到按钮、切模型、开新会话） |
| 实拍过但静态没搜到 | 待确认 | 服务端下发配置或动态拼 URL —— 回静态链找拼装函数 |

### 3.2 probe 脚本复现

每个端点写最小复现：**读凭据 → 自拼鉴权头 → 发正确形态请求 → 脱敏打印响应**。

- 探针脚本按仓库规则**不入库**，放项目根 `.tmp/` 并保留复用；命名说清用途（`xxx-probe.mjs`），
  头部写「干什么 / 怎么跑 / 依赖什么」；
- 一个脚本管一族端点（会话 / 模型 / 对话 / 运营面），不要每个端点一个脚本；
- 复现顺序：**只读端点先打**（查询类，零风险），变更类端点最后打、且只打一次成功。

### 3.3 鉴权链倒推

从「已登录态」倒推「登录态怎么来的」：

1. 盘点手里的凭据字段（token / session / api_key …），各打哪个面（账号 API vs 推理网关）；
2. 在静态链找每个凭据的**签发点**（登录响应里的字段名）；
3. 顺藤摸到登录端点 → 还原前置条件（验证码、滑块、短信、设备注册）；
4. 分清「代理层路径」与「云端真实路径」—— 桌面应用常有本地服务转发，前缀是代理加的；
5. 结论：哪些凭据可以**独立获取**（短信登录）、哪些必须借助原应用（扫码/会话文件）。

### 3.4 证据落级

每条结论标 A / B / C；同一事实多来源时取**最低**等级（源码见过但实测 404 的端点，按 404 记）。
（AStudio 实操：静态零命中的推理主机由「拉服务端配置」破案、probe 404 现场与修复，
见 [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627) §3。）

## 5. Stage 4 —— 沉淀

- **结论** → 渠道 `PROTOCOL.md`（证据等级 + 实测表）—— 文档是资产，脚本只是工具；
- **探针脚本** → 项目根 `.tmp/`（不入库，保留复用，下次同类问题改改就能用）；
- **方法论修正** → 回写本文件（走了一遍发现步骤缺项/顺序不对，改的是这里）。

## 6. AStudio 参数映射

方法论五阶段在 AStudio 上的已验证参数（新应用逆向时逐格替换）：

| 阶段 | AStudio 的参数 |
| --- | --- |
| Stage 0 目标 | 登录（短信+滑块）/ 对话（OpenAI 兼容）/ 模型清单与倍率 / 积分与签到 |
| Stage 1 解包 | `resources/app.asar`（~131MB 明文）；userdata 下有会话文件与内置目录（见下表） |
| Stage 2 抓包 | devtools 可用；本地服务日志在 `userdata/logs/`；TCP 对端用流量层观察 |
| Stage 3 复现 | 探针脚本六个子命令（`session` / `account` / `models` / `usage` / `chat` / `local`）；凭据两种（Cookie 打账号 API、Bearer 打模型网关） |
| Stage 4 沉淀 | 结论 → [PROTOCOL.md](./PROTOCOL.md)；过程 → [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627) |

### 6.1 落点

```bash
ls "/c/Users/$USER/AppData/Local/Programs/AStudio/resources/app.asar"
ls "/c/Users/$USER/AppData/Local/Programs/AStudio Data/userdata/"
```

| 位置 | 内容 |
| --- | --- |
| `resources/app.asar` | 主进程 + 渲染层 bundle（明文可搜） |
| `userdata/astron-session.json` | 会话与凭据（`token` / `modelBearerToken`） |
| `userdata/server-runtime.json` | 本地服务端口 |
| `userdata/provider-model-catalog-v1.json` | 应用内置模型目录（档位） |
| `userdata/model-gateway/catalog-<hash>.json` | 模型规格（上下文窗口 / 最大输出） |
| `userdata/logs/` | 主进程日志（`server-child.log` 有 upstream 诊断） |

### 6.2 采矿与实测

**先 grep 全貌，再 mine 局部，最后 extract 整段** —— 不要一上来就 extract（会淹没有效信息）。

历史探针脚本按仓库规则不入库；需要复现时按本文件 Stage 1–3 重写，或从本机保留的
历史探针脚本取用。脚本自己读会话文件、自己拼 Cookie、自己脱敏，**不要另写脚本重复这些**。

### 6.3 已知的坑

1. **本地服务端口会变**（`38051` → `16051/16083/16084`）。永远从
   `userdata/server-runtime.json` 读当前端口，不要硬编码。
2. **本地服务不提供可独立调用的登录**：策略是 `desktop-managed-local`，
   只认应用自己的活会话（`synara_session_<port>` cookie，不落盘）。
   登录只能由用户在桌面应用里完成 —— **或走云端直连**（见坑 3）。
3. **`/api/astron-auth/*` 只在本地服务代理层**，直连云端回 404；
   云端真正的账号 API 是 `{studioBaseUrl}/<path>`（带 Cookie）。
   这是方法论「分清代理层路径与云端真实路径」的典型样本：端点没变，变的是前缀。
4. **两个凭据分工不同**：`token` 打账号 API（Cookie 形态），
   `modelBearerToken` 打模型网关（Bearer 形态）。源码里 `modelBearerToken` 优先。
5. **503 不等于账号问题**。`chat/completions` 回 503 时先看
   `/userInfo` / `/bot/models/configs` / `/usage` 是否还正常 —— 正常则说明是上游容量问题。
6. **模型 id 有两套**：应用内置目录的 slug（`spark-x2.6-4b`）与网关配置里的
   `model` 字段（`xopglm52`）。网关实测只接受后者那一族，接入前逐个探。

## 7. 与 modelmux 渠道的衔接

渠道包在 `packages/core/channels/astudio/`（7 文件契约），实现要点见
[PROTOCOL.md](./PROTOCOL.md) §10。改渠道时遵守仓库 `AGENTS.md`：
渠道不写单测，端到端按 `dsh-mx-test` 技能跑。

---

# 2. 完整实跑记录（2026-10-26/27）

> 归档说明：本文是 2026-10-26/27 的实跑记录。协议事实以 [PROTOCOL.md](./PROTOCOL.md) 为准；
> 文中出现的采矿 / 探针脚本按仓库规则不入库（研究代码），命令仅作过程记录。

本文是 [FINDINGS.md §1](./FINDINGS.md#1-逆向方法论可复用) 五阶段工作流的**实跑记录**：目标是在
**不参考任何反代项目**的前提下，只靠「解包 + 日志 + 实测」三条链，从零推导出
AStudio 的上游 API。每一步都是真实执行过的命令与输出（令牌已脱敏）。
执行日期：2026-10-26/27（协议事实的权威版见 [PROTOCOL.md](./PROTOCOL.md)，
本文只回答「这些结论是怎么来的」）。

## 0. 出发点：要回答的问题

> 「AStudio 客户端把请求发到哪里？登录态怎么建立？对话走哪个主机？」
> —— 以及最关键的：**推理对话的主机在安装包里根本搜不到，它从哪来？**

## 1. Stage 1 静态链：解包采矿（A 级证据）

### 1.1 裸域名正则被噪音淹没 → 换问法

第一刀 `https://[host]\.(com|cn|net)` 挖出 161 条，几乎全是开源许可证链接
（github / stackoverflow / mozilla…）。**教训： bundle 里大量第三方代码自带 URL，
裸域名正则的信噪比极低** —— 改为「只提域名 + 按频次分组 + 排除已知开源域名」：

```bash
node asar-grep.mjs "$A" "https://[a-zA-Z0-9.-]+(?:com|cn|net)" 800 \
  | grep -oE "https://[a-zA-Z0-9.-]+" | sort | uniq -c | sort -rn \
  | grep -vE "github|stackoverflow|mozilla|w3\.org|npmjs|..."
```

降噪后业务信号浮出：`sso.xfyun.cn`（讯飞 SSO）、`static.geetest.com`（滑块 SDK）、
`agent.xfyun.cn`（讯飞 agent 域）。

### 1.2 域家族聚焦 → 三环境配置结构

对 `xfyun.cn` / `xf-yun.com` 两个讯飞域家族定向 grep，拿到：

| 主机 | 出现形态 | 推断 |
| --- | --- | --- |
| `agent.xfyun.cn/xingchen-studio/` | 6 次，与 `pre-agent` 成对 | **生产账号 API 基址** |
| `pre-agent.xfyun.cn/xingchen-studio/` | 6 次，与 `agent` 成对 | 预发环境 |
| `dev-agent.xfyun.cn/...` | 在 `authBaseUrl:` 赋值里 | 开发环境 |
| `astronstudio-api-volces-prod/pre.xf-yun.com` | 2+2 次 | 应用配置的 API 网关默认值 |
| `astroncode-otlp-prod.xf-yun.com/v1/logs` | 4 次 | OTLP 遥测 |

`authBaseUrl` 的三处赋值直接给出三环境常量（生产 = `agent`，A 级）：

```text
authBaseUrl: "http://dev-agent.xfyun.cn/xingchen-studio/"
authBaseUrl: "https://pre-agent.xfyun.cn/xingchen-studio/"
authBaseUrl: "https://agent.xfyun.cn/xingchen-studio/"
```

### 1.3 挖鉴权拼装函数 → 前缀之谜的答案

`createAstronAccountGateway`（asar-mine 全文切出）两段关键代码：

**Cookie 拼装**（凭据字段的权威来源）：

```js
`account_id=${session.accountId}`, `token=${session.token}`
  .filter(...).join("; ")        // 加上 ssoSessionId 同形态，共 4 个 Cookie 键
```

**路径拼装**（本文最重要的一处推理）：

```js
const requestAuth = async (path, ...) => {
  const response = await requestReadWithRetry(new URL(path, options.authBaseUrl), ...)
}
const initializeTenantApp = async (session) => {
  const data = await requestAuth("tenant-app/v2/init-app", { method: "POST", ... })
}
```

→ 业务路径 `tenant-app/v2/init-app` **不带任何前缀**直接拼在 `authBaseUrl` 上。
渲染层发的 `/api/astron-auth/init-app` 是**本地服务代理层**的前缀，转发时被剥掉。
（此前「直连云端 404」的误判就是把代理层前缀当成了云端路径 —— 反过来复现 404 现场即可自证：
`GET https://agent.xfyun.cn/api/astron-auth/init-app` → 404。）

### 1.4 静态链的天花板：推理主机零命中

```bash
node asar-grep.mjs "$A" "maas-api[a-zA-Z0-9./_-]*"
# → 去重 0 条
```

**131 MB 的安装包里，真正承载对话的 `maas-api.cn-huabei-1.xf-yun.com` 一次都没出现。**
静态链在此到顶：推理主机不是硬编码，必然来自运行时（服务端下发 / 动态拼装）。
静态链回答不了「从哪来」，但把问题收敛成了一道单选题 —— 下一步去**运行时证据**里找。

## 2. Stage 2 动态链：应用日志里的实拍（B 级证据）

### 2.1 主进程诊断日志（零成本抓包）

源码里有 `onRequestDiagnostics` 钩子（Stage 1 挖到），主进程把每次**它自己**发出的
上游请求打成 JSON 行 —— `userdata/logs/server-child.log`：

```json
{"requestId":"<uuid>","upstreamPath":"/xingchen-studio/login/phone-quick-login",
 "upstreamHost":"agent.xfyun.cn","method":"POST","responseStatus":200, ...}
{"requestId":"<uuid>","upstreamPath":"/xingchen-studio/tenant-app/v2/init-app",
 "upstreamHost":"agent.xfyun.cn","method":"POST","responseStatus":200, ...}
{"requestId":"<uuid>","upstreamPath":"/xingchen-studio/userInfo",            ..., "responseStatus":200}
{"requestId":"<uuid>","upstreamPath":"/xingchen-studio/bot/models/configs",  ..., "responseStatus":200}
```

**交叉表闭合**：静态推导的「`{authBaseUrl}/<无前缀路径>`」与动态实拍逐条一致 ——
登录、签到（init-app）、账号信息、模型配置四个端点双向确认（A 静态 × B 动态）。

### 2.2 对话流量不在主进程 → 定位到渲染层直连

日志里 `model-gateway` 只出现在「目录失效」事件里，**没有任何 chat 请求**。
结论：对话由渲染层直接发往推理主机，不经主进程网关 —— 所以主进程日志抓不到它。
要看到对话的明文流量只剩两条路：**mitmproxy 中间人**（本机已装 11.0.2，需带
`--proxy-server` 旗标重启应用 + 信任 CA）或 **TCP 对端观察**（只读零干扰）。
本次执行时桌面应用未运行，TCP 观察无流量可看 —— 如实记录，转向行为链。

## 3. Stage 3 行为链：把最后一跳复现出来（B 级证据）

### 3.1 拉「服务端下发的配置」—— 推理主机的来源

`/bot/models/configs` 在静态链里是账号 API 的一个普通端点、在动态链里被实拍过 200。
**自己打它**（probe 脚本，Cookie 自拼）：

```text
200 GET /bot/models/configs，9 行：
  astronclaw-auto   base_url=https://maas-api.cn-huabei-1.xf-yun.com/v2       provider=maas     multiplier=-
  xsparkx2agent     base_url=https://maas-api.cn-huabei-1.xf-yun.com/v2       provider=maas     multiplier=x2.0
  spark-x           base_url=https://spark-api-open.xf-yun.com/agent/v1       provider=iflytek  multiplier=x0.5
  xopglm52          base_url=https://maas-api.cn-huabei-1.xf-yun.com/v2       provider=maas     multiplier=x2.0
  ...（共 8 行 maas + 1 行 iflytek）
```

**谜底：对话主机是账号 API 下发的每模型 `base_url`**。静态零命中 ↔ 动态配置下发，
两条链在这里咬合。

### 3.2 404 现场与修复（踩坑即教学）

probe 脚本最初用静态源码里的 `astronstudio-api-volces-prod` 主机打对话 → **404**
（该主机只承载应用内部端点，不承载模型推理 —— 静态配置默认值 ≠ 可用推理主机）。
改脚本按模型取服务端下发的 `base_url` 后：

```text
=== 流式（https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions）===
HTTP 200 text/event-stream
  SSE 帧数 9
  末帧 data: [DONE]
=== 工具调用 ===
HTTP 200
  finish_reason = tool_calls
  tool_calls = [{"function":{"arguments":"{\"city\":\"北京\"}","name":"get_weather"}, ...}]
```

行为链闭环：**脱离 AStudio 应用**，用自拼的 Cookie / Bearer + 服务端下发的 base_url，
流式与工具调用全部复现成功。

## 4. 三链证据总表

| 结论 | 静态（A） | 动态（B） | 行为（B） |
| --- | --- | --- | --- |
| 账号 API 基址 = `agent.xfyun.cn/xingchen-studio/` | 是（authBaseUrl 常量） | 是（日志 upstreamHost） | 是（probe 200） |
| 业务路径无 `/api/astron-*` 前缀 | 是（`new URL(path, authBaseUrl)`） | 是（日志 upstreamPath） | 是（probe 200） |
| Cookie 四键形态 | 是（拼装函数） | 未记录（日志不打头） | 是（probe 200） |
| 凭据两种（Cookie / Bearer） | 是（字段 + Bearer 头构造） | — | 是（对话 200） |
| **推理主机 = 服务端下发 base_url** | 零命中（本身即证据） | 待确认（对话不经主进程） | 是（configs 响应 + chat 200） |
| 对话端点形态（OpenAI 兼容 SSE / tools） | 是（WIRE 常量） | — | 是（9 帧 SSE + tool_calls） |

方法论的核心论断在这张表里兑现：**参考实现能给的，三条链全都能独立推导出来；
而三条链给出的「为什么」（服务端下发、代理层前缀、渲染层直连），参考实现给不了。**

---

# 3. 仍成立的缺口

> 审计时间 2026-10-26（只读代码审计）。下列为**尚未解决**的项；已解决的历史条目不再保留。

| # | 缺口 | 影响 | 判据 / 出处 |
| --- | --- | --- | --- |
| 1 | **无「到期前主动续期」**：渠道未实现 `upstream.refreshIfExpired`，`expiresAt` 恒 `null` | 凭据只能靠「定期探测是否 401」被动发现失效 | PROTOCOL §7 |
| 2 | **重授权入口未确认**：本地服务代理路线下，`/api/astron-auth/login/*` 之外的「重新授权」路径需实测 | `mx relogin` 目前靠 `force` 重读会话文件 | PROTOCOL §7 |
| 3 | **`reasoning` / `thinking` 别名不受档位表约束**：`buildChatBody` 只校验 `reasoning_effort`，这两个别名原样透传 | 行为上大概率没问题，但不受控 | PROTOCOL §6.1 |
| 4 | **档位表是静态快照**：上游改档位不会更新，客户端发新档位会被**静默丢弃** | 用户看不到原因 | PROTOCOL §6.1 |
| 5 | **Web UI 无签到展示**：`channel_caps` 只有 `billing`，UI 搜 `signin`/`签到` 零命中 | 签到状态只能在 `mx status <cid>` 看 | 全仓现状，非 astudio 独有 |
| 6 | **「今天是否已领」判据不硬**：待处理弹窗是「到账通知」不是待领奖单；现用余额差确认 | 判不了就说不知道（`claimedToday: null`），不猜 | PROTOCOL §8 |
| 7 | **上游 token 不会被吊销**：删本地文件后，桌面应用与云端的会话仍有效 | 「登出」只影响 modelmux 侧 | PROTOCOL §9 |
| 8 | **依赖桌面应用**：本地服务是 `desktop-managed-local` 策略，只认应用自己的活会话 | 登录只能由用户在桌面应用里完成（或走云端直连） | PROTOCOL §5 |
