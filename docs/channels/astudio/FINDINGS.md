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

# 3. 渠道缺口清单（交接）

> **给下一个接手的 Agent**：本文是 AStudio 渠道的功能缺口清单。
> 协议事实（端点、字段、状态码）见 [PROTOCOL.md](./PROTOCOL.md)；
> 逆向方法与完整实跑记录见 [FINDINGS.md §1](./FINDINGS.md#1-逆向方法论可复用) 与 [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627)。
> **动手前先读 `AGENTS.md`**（尤其「测试规则」：渠道不写单测，只做端到端）。
>
> 审计时间：2026-10-26 · 审计方式：只读代码审计（`packages/core/channels/astudio/` + 共享层消费链路 + UI 显示链路）

---

## 0. 总览

| # | 需求 | 审计时 | 现状（2026-10-26 实现后） |
| --- | --- | --- | --- |
| 1 | 登录链接（手机号 + 验证码） | **未实现** | **已实现**（结论反转，见 §0.1） |
| 2 | 登录回调链接 + 成功判据 | **部分实现** | **已收敛**：无 OAuth 回调（手机号验证码 / 会话文件两条路），判据统一 |
| 3 | 账号信息 + name 显示在 web 账号池 | **部分实现** | **已修复**：`/userInfo` 补全 + 显式回落 + 契约字段补齐 |
| 4 | refresh / 重授权 URL | **部分实现** | **已修复**：`relogin` 死结已解（渠道侧 `force`） |
| 5 | 登出 / 销毁凭证 | **未实现** | **已实现**：`cred.logout()` + `mx logout <cid>` |
| 6 | 模型列表 + 上下文/输出/档位/倍率 | **部分实现** | **已修复**：档位透出；倍率只给实测值 |
| 7 | 真实模型请求 chat url | **已实现** | 不变 |
| 8 | 每日签到逻辑 | **已实现**（但当时判成「无端点」是错的） | **已修复**：真签到（`init-app` 发奖 + 关横幅 + 下载奖励），`signin: true` |

### 0.1 第 1 项：登录端点可以**云端直连**

云端账号 API 的路径**不带** `/api/astron-auth/*` 前缀 —— 那是桌面应用
**本地服务代理层**的前缀。按带前缀的路径探测，就会误判成「架构上无法独立调用」。

依据：参考实现
`packages/core/channels/astudio/reference/2951461586_AStudio2API/internal/astron/login.go`
（逆向自官方客户端 bundle 的 `createAstronAccountGateway`）+ 本仓实测：

| 端点（**无前缀**） | 直连云端结果 |
| --- | --- |
| `GET /chat/gee-captcha` | `200 code=0` —— 真实 GeeTest v3 配置 |
| `POST /login/mobile/send-verify-code` | `200 code=20009 geetest verify failed`（端点可达，captcha 未解） |
| `POST /login/phone-quick-login` | `200 code=10501002 验证码无效，请重新获取并验证`（端点可达、参数正确，验证码是假的） |

**唯一拦路虎是 GeeTest v3 滑块** —— 它本来就该由**浏览器**解，
而 Web 控制台正是浏览器（加载官方同款 `gt.js`，初始化参数严格对齐官方客户端）。

**实现**：走共享层新增的 `requestInput` 通道（`kind: "captcha"`），
前端 `packages/ui/src/components/GeetestCaptcha.tsx` 解滑块 → 回传三字段 →
渠道发码 → 问验证码 → 换 session → 补 `modelBearerToken` → 落盘。
细节见 [PROTOCOL.md](./PROTOCOL.md) §5。

**仍然堵死的只有本地服务那条路**（应用进程内存里的活会话，外部进不去），
而它现在是**兜底**：CLI 没有界面 → 走「读桌面应用会话文件」那条路。

### 0.2 实现落点（按文件）

| 文件 | 内容 |
| --- | --- |
| `packages/core/channels/astudio/src/cred.ts` | 手机号+验证码登录（云端直连）；`force` 重读（解 `relogin` 死结）；`/userInfo` 补全（尽力而为）；显式回落展示名；补 `domain`/`accessToken` 契约字段；`banned` 抛错；`logout()`；支持 `pasteCode` |
| `packages/core/channels/astudio/src/upstream.ts` | 新增 `userInfoUrl()` / `fetchUserInfo()`；**新增认证链路**：`fetchGeetestConfig()` / `sendSmsCode()` / `loginWithSms()` / `fetchTenantState()` / `fetchPointsBalance()`（multipart 构造 + 信封解析 + `uid` 归一化） |
| `packages/core/channels/astudio/src/catalog.ts` | `modelSpec()` 透出 `effort` 与 `multiplier`；倍率表改为**只填实测值**（5 个未知） |
| `packages/core/gateway/src/runtime/channel.ts` | `LoginUi.requestInput` 已在；`LoginInputRequest` 增 `kind: "captcha"` 与 `captcha` 参数；`CredModule` 增可选 `logout?()`；`modelSpec?` 契约增 `effort`/`multiplier`；`login()` options 增 `requestInput` / `force` |
| `packages/core/gateway/src/pool/pool-targets.ts` | 倍率四层回落增 `spec` 层（**不走跨渠道** —— 那是渠道自己的计费口径） |
| `packages/core/gateway/src/auth/auth-flow.ts` | `force` 透传给 `cred.login()` |
| `packages/core/gateway/src/runtime/account-pool.ts` | `purgeCredentials` 探测顺序修正（先探后删，否则永远报「本来就没有」） |
| `packages/core/gateway/src/app/cli/channel.ts` | `logout` 动词（接上 `purgeCredentials`） |
| `docs/MODEL-SPECS.md` | 不登记渠道章节 —— 该文件只描述全局规格文件（`model-specs.json`）与取值链；astudio 的逐型号规格落在 `catalog.modelSpec()` |

### 动手前必须先定的两个前提

**前提 A：渠道允许依赖 AStudio 桌面应用常驻吗？**

AStudio 的本地服务（`127.0.0.1:<动态端口>`）是 `desktop-managed-local` 策略，
只认**应用自己建立的活会话**（`synara_session_<port>` cookie，不落盘）。
所以：

- **允许依赖** → 登录 / 登出可走本地服务代理（`/api/astron-auth/*`），
  端口从 `userdata/server-runtime.json` 读（**每次启动会变，不能硬编码**）。
  代价：用户必须先开 AStudio。
- **不允许依赖** → 只能直连云端 `agent.xfyun.cn/xingchen-studio`。
  但实测（PROTOCOL §3.2）直连云端的 `/api/astron-auth/*` **回 404**，
  登录端点根本不在云端可达路径上 → **这条路走不通**。

→ **结论：1、5 两项只能走「依赖桌面应用」路线。** 若产品要求「不依赖桌面应用」，
  则 1、5 只能降级为「读用户手动提供的凭据」，需另行确认。

**前提 B：会话文件是唯一可用的凭据来源吗？**

当前 `cred.ts` 的全部凭据来自 `%LOCALAPPDATA%\Programs\AStudio Data\userdata\astron-session.json`。
若前提 A 允许依赖桌面应用，可考虑**改为经本地服务拿**（更活、更准），
但那要求本地服务已登录 —— 与前提 A 是同一个前提。

---

## 1. 登录链接（手机号 + 验证码）— 已实现（2026-10-26）

> **状态（2026-10-26 实现后）**：已实现。以下「现状」保留的是**审计时（未实现）**的记录，
> 实现细节见 [PROTOCOL.md](./PROTOCOL.md) §5 与本文 §0。

### 现状

`packages/core/channels/astudio/src/cred.ts:251-292` 的 `login()` **没有任何 HTTP 登录请求**，
只是打印提示 + 轮询本地会话文件：

```ts
onStatus?.("AStudio cannot be driven to log in from here: its local service only trusts the " +
  "desktop app's own live session.");
options.onUrl?.(base);          // ← 传的是账号 API 基址，不是登录页
const deadline = Date.now() + 5 * 60 * 1000;   // 轮询会话文件，最多 5 分钟
```

全仓 grep `send-verify-code|phone-quick-login|gee-captcha|check-account|qr-poll`
在 `packages/` 下**只命中 `packages/core/channels/astudio/src/cred.ts:242-243` 的注释**，无任何 `fetch`。
渠道内仅两处 `fetch`：`packages/core/channels/astudio/src/upstream.ts:209`（`/bot/models/configs`）、`packages/core/channels/astudio/src/billing.ts:103`（`/usage`）。

### 误导性 UI（顺带要修）

`packages/core/channels/astudio/src/cred.ts:273` 的 `options.onUrl?.(base)` 传的是
`DEFAULT_BASE_URL = "https://agent.xfyun.cn/xingchen-studio"`（`packages/core/channels/astudio/src/cred.ts:49`）。
Web 端 `packages/ui/src/components/LoginModal.tsx:58,130-150` 会把它当「授权链接」渲染 ——
用户点开是 API 基址，不是登录页。**这一条无论走哪条路线都要修**（别给假链接）。

### 上游端点（PROTOCOL §3.1，A 级 = asar 源码提取）

经**本地服务代理**（`127.0.0.1:<port>/api/astron-auth/*`）：

| 步骤 | 方法 | 路径 | 请求体 |
| --- | --- | --- | --- |
| 1 取极验配置 | GET | `chat/gee-captcha` | — |
| 2 发短信验证码 | POST | `login/mobile/send-verify-code` | FormData：`mobile` / `countryCode=86` / captcha 字段 |
| 3 短信登录 | POST | `login/phone-quick-login` | FormData：`mobile` / `verifyCode` / `countryCode=86` |
| 备选：密码登录 | POST | `login/check-account` | FormData：`accountName` / `accountPwd` / captcha 字段 |
| 备选：微信扫码 | — | `qr-code` / `qr-poll` / `qr-bind` | — |

### 要做什么

1. 读本地服务端口：`userdata/server-runtime.json` 的 `port` 字段（**每次启动变，别硬编码**）。
2. 实现发码 + 验码（表单形态、`countryCode=86`、captcha 参数）。
3. 登录成功 → 拿 `account_id` / `token` / `ssoSessionId` / `uid` / `mobile`，
   组装成渠道的 `Credentials` 并 `save()`。
4. 拿到 `modelBearerToken`：登录响应可能不含它（源码 `completeLogin` 里是**另一次**请求
   `bot/models/configs` 取 `api_key`）—— 见第 4 项的 `upstream.fetchModelBearerToken()`，可直接复用。
5. `onUrl` 改成**真实可打开的链接**（本地服务的登录页 URL），或干脆不给。

### 验收判据

- `mx login astudio` 能走完「发码 → 输码 → 成功入池」；
- 过程中 Web 端不出现假授权链接；
- 登录成功后 `~/.modelmux/astudio/credentials.json` 各字段齐全（见第 3 项的字段清单）。

---

## 2. 登录回调链接 + 如何判断登录成功 — 部分实现

### 现状

**没有回调 URL / 回调服务器**：
- `packages/core/channels/astudio/src/cred.ts:234-237` 的 `LoginOptions` 只有 `onUrl` / `onStatus`，
  **连共享层契约里的 `pasteCode` 都没有**（对比 `packages/core/gateway/src/runtime/channel.ts:115-125`）
  → Web 端「粘贴回调链接」输入框对 astudio **永远无用**。
- 共享层的 `startCallbackServer`（`packages/core/gateway/src/auth/login-flow.ts:33`）完全没用到。

**轮询机制有，但轮询本地文件**：`packages/core/channels/astudio/src/cred.ts:276-288`，每 3 秒读会话文件，最多 5 分钟。

**代码里的成功判据**（`packages/core/channels/astudio/src/cred.ts:153-173` `fromSessionFile()`）：

```ts
const modelBearerToken = str(raw["modelBearerToken"]).trim() || str(raw["token"]).trim();
if (!modelBearerToken) throw new NotLoggedInError("AStudio session file has no usable token");
```

**文档里的判据未实现**：PROTOCOL §3.1 记录上游 `completeLogin` 的判据 ——
响应必须**同时**有 `account_id` 与 `token`（或 `ssoSessionId`），
否则抛 `Astron login response is incomplete`。渠道代码**不解析任何登录响应**（因为压根不发登录请求）。

### 要做什么

1. **成功判据统一**：登录响应判据用文档那套（`account_id` + `token`/`ssoSessionId`），
   会话文件路径判据用「有 `modelBearerToken`」—— 两条路径要分别处理，别混。
2. 若走「本地服务代理」路线：登录响应带的是 `Set-Cookie` 还是 JSON？**需实测**。
   若带 Cookie，要从响应头取出会话 cookie 存起来。
3. `LoginOptions` 补 `pasteCode`（共享层契约已有），让 Web 端的粘贴框对 astudio 可用
   —— 若登录需要用户在浏览器完成某一步，粘贴回调是唯一出路。
4. 或者：用**轮询**代替回调（每 2s 查一次登录态），避免引入回调服务器。

### 验收判据

- 登录成功后能明确判定「成功」并落盘；
- 失败时能明确判定「失败」并给出原因（不是「超时」这种含糊文案）；
- Web 端若有粘贴框，astudio 登录能真的用上它。

---

## 3. 账号信息 + name 正确显示在 web 账号池 — 部分实现（2 个实质缺陷）

### 现状

**`nickname` 恒空**：
- `packages/core/channels/astudio/src/cred.ts:158` `const nickname = str(raw["nickname"]).trim();`
- 而 `str()` 只接受 string（`packages/core/gateway/src/auth/login.ts:26-28`），null → `""`
- 实测会话文件**根本没有 nickname 键**（只有 `accountId,uid,token,ssoSessionId,banned,modelBearerToken,loginMethod,loggedInAt,mobile`）
- 唯一能拿到 nickname 的 `GET /userInfo`（PROTOCOL §4.2，实测 `nickname: null`）**渠道代码从不调用**
  （只在历史探针脚本里被调；脚本按仓库规则不入库）

**池层 name/label 怎么来的**（`packages/core/gateway/src/runtime/account-pool.ts`）：

- `NAME_FIELDS`（`:85-103`）按序 `nickname, nickName, name, displayName, …, email, phone, mobile, phoneNumber`；
  `hint()`（`:137-143`）取第一个非空字符串
- `captureActive()`（`:325-331`）：`const name = hint(raw, NAME_FIELDS);`
  → nickname 空 → 命中 **`mobile`**；`label` 也等于 mobile
- `refreshLabels()`（`:253-273`）每次 `listAccounts` 都从 `accounts/<key>.json` 原始凭据重算

**UI 最终显示哪个字段**（`packages/ui/src/components/AccountCard.tsx:174-189` `displayName()`）：

```ts
const name = account.name?.trim() ?? "";
if (name) return name;                 // ← 命中直接原样返回，不脱敏
const label = account.label?.trim() ?? "";
... /^\d{11}$/.test(raw) → `${raw.slice(0,3)}****${raw.slice(-4)}`   // 只有回落路径才脱敏
```

渲染处 `packages/ui/src/components/AccountCard.tsx:440-442` 用 `displayName(account)`。

**链子**：`cred.mobile` → 池 `name` → `displayName()` 第一分支。
**不是** label（虽然值恰好相同），**不是** nickname。

### 缺陷 A：显示的是明文手机号，不是昵称

上游 nickname 本就为 `null`，回落手机号是唯一可行方案 —— 但代码里**没有显式的
「nickname 空 → mobile」回落逻辑**，而是靠池层通用字段表**巧合**命中 `mobile`。
这意味着：哪天池层 `NAME_FIELDS` 顺序变了，astudio 的显示名就变了。

### 缺陷 B：与 UI 自身的承诺矛盾

`packages/ui/src/components/AccountCard.tsx:151` 注释明写「页面上不出现任何完整账号 id / 昵称 / 邮箱」，
但 `name` 分支**不做任何脱敏**（脱敏只在 label 回落路径）。
真实数据下 AStudio 账号会以**明文 11 位手机号**显示。

### 附带缺失

`Credentials`（`packages/core/channels/astudio/src/cred.ts:76-97`）**缺共享层 `Credential` 契约要求的字段**：
- `domain`（缺 → 池里 `domain` 恒 `""`，`accountKey` 退化为 `sha256(""+uid)`，`packages/core/gateway/src/runtime/account-pool.ts:171-176`）
- `accessToken`（缺 → 池层部分逻辑可能取不到）
- `banned` 字段被读取了但**从不暴露给池/UI**

### 要做什么

1. **显式回落**：在 `cred.ts` 里明确「nickname 空 → 用 mobile 回落」，
   而不是靠池层字段表巧合。
2. **脱敏**：确认 UI 该显示什么。建议 `name` 字段**存脱敏后的值**
   （如 `138****0000`），让 `displayName()` 命中 `name` 分支时也是脱敏的 ——
   这样才与 `packages/ui/src/components/AccountCard.tsx:151` 的承诺一致。
   注意别和池层 `label` 的既有语义打架（label 本来就是脱敏形态）。
3. **拉账号信息**：调用 `GET /xingchen-studio/userInfo`（Cookie 认证，PROTOCOL §4.2），
   拿 `uid` / `mobile` / `nickname`（实测为 null）/ `avatarColor` 等，落进 `Credentials`。
   —— 顺带解决「会话文件没有 nickname 键」的问题。
4. **补 `domain` / `accessToken`** 字段，让 `accountKey` 与其它渠道一致。
5. **`banned` 上报**：封禁状态该在账号池页可见（上游 `tenant-app/v2/init-app` 返回 `banned`）。

### 验收判据

- Web 账号池页显示的是**脱敏**的名字（`138****0000` 这类），不是明文手机号；
- 与 `packages/ui/src/components/AccountCard.tsx:151` 的注释承诺一致；
- demo 数据与真实链路形态一致；
- `credentials.json` 含 `domain` / `accessToken` / `banned`。

---

## 4. refresh / 重授权 URL — 部分实现

### 现状：refresh 有真实现

`packages/core/channels/astudio/src/cred.ts:304-329`：

```ts
fresh = await upstream.fetchModelBearerToken(c);
const next = { ...c, modelBearerToken: fresh, obtainedAt: nowIso(), source: "astudio-model-configs-refresh" };
await save(next);
```

Cookie 失效（`UpstreamUnauthorized`）→ 抛 `NotLoggedInError`，**绝不假装成功**（`packages/core/channels/astudio/src/cred.ts:313-320`）。

`packages/core/channels/astudio/src/upstream.ts:202-231` `fetchModelConfigs()`：
`GET https://agent.xfyun.cn/xingchen-studio/bot/models/configs`，
Cookie = `ssoSessionId; sso_sessionid; account_id; token`（`packages/core/channels/astudio/src/upstream.ts:161-171`）；
`packages/core/channels/astudio/src/upstream.ts:239-260` `pickModelBearerToken()` 按 `is_current → is_default → data[0]` 取 `api_key`。

**但它不是「换发新 token」**：PROTOCOL §7 实测刷新拿到的 `api_key` 与磁盘 `modelBearerToken`
**完全一致** → refresh 实际是「确认凭据仍有效 + 取回最新值」。

**失效判据**（`packages/core/channels/astudio/src/upstream.ts:181-184`）：HTTP 401/403 **或** body 含业务码 `80000`。

**触发点**（共享层，astudio 无需改）：
- 网关 401/403 → `packages/core/gateway/src/http/chat/auth.ts:88-99` 调 `cred.refresh()` 并原账号重试一次
- 启动探测失败 → `packages/core/gateway/src/auth/auth-flow.ts:91-108` refresh，失败则 `unlinkSync(credentialsPath(cid))` 并提示重登

**astudio 没实现 `upstream.refreshIfExpired`** → 无「到期前主动续期」。

### 现状：重授权流程实际是死结
- `packages/core/channels/astudio/src/cred.ts:255-262` `login()` 第一步就 `load()`，成功则
  `onStatus?.("reusing the existing AStudio credentials")` 并**直接返回旧凭据**
- 共享层 `packages/core/gateway/src/app/lifecycle/headless.ts:374-400`：
  `mx relogin astudio` 的 `force=true` 只跳过 headless 自己的「已有凭据」短路，
  随后 `packages/core/gateway/src/auth/auth-flow.ts:33-45` `ensureLogin` 又 `cred.load()` 成功 → **根本不调用 `cred.login()`**
- **结论：只要本地 `credentials.json` 还在，`relogin` 就是空操作。**
  唯一能触发重读会话文件的是「凭据缺失」或「refresh 失败触发 unlink」。

### 要做什么

1. **修死结**：给「强制重读」开一条路。两种做法：
   - a) 渠道侧：`cred.login()` 接受一个「强制重读」信号（如 `options.force` 或独立方法
     `relogin()`），由共享层在 `force=true` 时调用；
   - b) 共享层侧：`ensureLogin` 在 `force=true` 且渠道声明「可重读外部凭据」时，跳过
     `cred.load()` 短路直接调 `cred.login()`。
   共享层改动影响所有渠道，**优先选 a**。
2. **实现 `upstream.refreshIfExpired`**：让凭据在到期前主动续期
   （`cred.ts` 的 `expiresAt` 目前恒 `null` —— 会话文件没有到期字段，
   只能靠「定期探测 /usage 或 models/configs 是否 401」判断）。
3. **重授权 URL**：若走本地服务代理路线，`/api/astron-auth/login/*` 之外的
   「重新授权」入口需要实测确认（源码里 `loginWithSsoSession` 暗示存在微信 SSO 重授权路径）。

### 验收判据

- `mx relogin astudio` **真的重新读一次会话文件**（不是空操作）；
- 凭据失效后能自动恢复，或明确提示「请重新登录」而不是静默失败。

---

## 5. 登出 / 销毁凭证 — 已实现（2026-10-26）

### 现状

**渠道有登出代码**：`packages/core/channels/astudio/src/cred.ts` 的 `logout()`（删本地
`credentials.json`），并由 `channel.ts` 接线到共享层的 `mx logout <cid>`。

**上游登出端点存在但不可用**（PROTOCOL §9）：`POST /api/astron-auth/logout`（经本地服务代理，需活会话）；
源码 `logoutAstron` → 删除会话文件 + 清 `config.toml` 的 bearer。
文档自己写明「该端点需活会话，渠道**不实现登出**；渠道侧『登出』= 删除自己的 `credentials.json`」。

**共享层有 `logout` 命令**：
`packages/core/gateway/src/app/cli/channel.ts` 的 `CHANNEL_VERBS` =
`status/login/relogin/logout/model/bill/acct/path/log`，**含 `logout`**
（`bill` 现支持 `[--accounts]`）；仍**无 `checkin` / `claim`**
（签到由网关启动时的自动签到链路执行，不经 CLI 动词）。

**本地凭证销毁的实际路径**（`packages/core/gateway/src/runtime/account-pool.ts`）：

| 函数 | 行为 | 是否被调用 |
| --- | --- | --- |
| `removeAccount()`（`:454-481`） | 删 `accounts/<key>.json`；**若删的是生效账号，同时 `rmSync(credentialsPath(cid))`**（`:470`）→ 事实上的「本地登出」 | Web「删除生效账号」按钮 → `http/console/web-command-handler.ts:174-178` |
| `purgeCredentials()`（`:493-507`） | 清 `credentials.json` + 池内全部账号 | `mx logout <cid>` 动词（`runLogoutVerb`） |
| 鉴权失败路径 | `auth/auth-flow.ts:98-102` refresh 失败时 `unlinkSync(credentialsPath(cid))` | |

**上游 token 不会被吊销**：删本地文件后，AStudio 桌面应用里的会话与云端
`token` / `ssoSessionId` 仍然有效（桌面应用自己会继续用它），`modelBearerToken` 也未在上游注销。

### 要做什么

1. **上游登出**：走本地服务代理 `POST /api/astron-auth/logout`（需前提 A 成立）。
   副作用：会同时删掉 AStudio 桌面应用的会话 —— 这是**期望行为**（用户要登出）。
   需实测：登出后能否再登录（会不会把应用也踢出登录态）。
2. **（已完成）本地凭证销毁**：渠道提供「销毁本渠道凭据」的能力（`cred.logout()`），
   `purgeCredentials()` 已由 `mx logout <cid>` 接线（不再是死代码）。
3. **（已完成）共享层加 `logout` 动词**：`CHANNEL_VERBS` 现含 `logout`，Web 端按钮走 `removeAccount` 仍有等价效果。
4. **区分两种登出**：
   - 「只从 modelmux 移除这个账号」（现状：删 `accounts/<key>.json`）—— 不动上游
   - 「彻底登出这个渠道」（删除 + 吊销上游会话）—— 需要显式区分，别让用户误伤桌面应用

### 验收判据

- 有一个明确的「登出」动作（`mx logout <cid>`），且语义清晰（是否影响 AStudio 桌面应用）；**已达成**
- 登出后本地 `credentials.json` 与池账号都被清理；**已达成**
- （若实现上游吊销）上游 token 确实失效 —— 上游吊销**未实现**（§9：登出端点需活会话，外部拿不到）。

---

## 6. 模型列表 + 上下文窗口 / 最大输出 / 思考档位 / 倍率 — 已修复（2026-10-26）

### 现状：静态表 + `modelSpec()` 已透出全部字段

`packages/core/channels/astudio/src/catalog.ts:43-114` 的静态表 `MODELS`（7 条）：

| id | upstreamId | multiplier | contextWindow | maxOutputTokens | efforts | defaultEffort |
| --- | --- | --- | --- | --- | --- | --- |
| `auto` | `astronclaw-auto` | 未知 | 262144 | 100000 | none, high | high |
| `spark-x2.6` | `spark-x2.6` | 未知 | 262144 | 100000 | none, high | high |
| `spark-x2.6-lite` | `spark-x2.6-4b` | 未知 | 1048576 | 110000 | none, high, max | high |
| `spark-x2.5` | `spark-x2.5` | 未知 | 262144 | 100000 | none, high | high |
| `glm-5.2` | `xopglm52` | 2 | 1048576 | 100000 | none, high, max | high |
| `deepseek-v4-pro` | `xopdeepseekv4pro` | 2 | 1048576 | 100000 | none, high, max | high |
| `deepseek-v4-flash` | `xopdsv4flash0731in` | 未知 | 1048576 | 100000 | none, high, max | high |

（`multiplier` 为 `未知` = 云端没有对应行，渠道**省略该字段**（`undefined`），不编造 `1`；
只有 `glm-5.2` / `deepseek-v4-pro` 云端实测 `point_multiplier` = x2.0。）

来源（`packages/core/channels/astudio/src/catalog.ts:32-42` 注释 + PROTOCOL §6.2）：

- `id` / `name` / `efforts` / `defaultEffort` ← 应用内置目录 `provider-model-catalog-v1.json`（B 级实测）
- `upstreamId` / `multiplier` ← 云端 `GET /xingchen-studio/bot/models/configs`（B 级实测）
- `contextWindow` / `maxOutputTokens` ← 应用内置 `model-gateway/catalog-<hash>.json`（B 级实测）

| 字段 | 对外是否生效 | 机制 |
| --- | --- | --- |
| contextWindow | | `packages/core/channels/astudio/src/catalog.ts` 的 `modelSpec()` → 池层 `facts.spec?.contextWindow` → `/v1/models` 的 `context_window`，`meta_sources="spec"` |
| maxOutputTokens | | 同上 → `max_output_tokens` |
| **思考档位** | | `modelSpec()` 返回 `effort` → 池层 `facts.spec?.effort`（`packages/core/gateway/src/pool/pool-targets.ts` 读 `spec?.effort`） |
| **倍率** | | `modelSpec()` 返回 `multiplier` → 池层 `facts.spec?.multiplier`（`packages/core/gateway/src/pool/pool-targets.ts` 读 `spec?.multiplier`） |

### 缺口 1（已修，2026-10-26）：思考档位曾对外恒 `null`

**结论：已修。** `modelSpec()` 现在返回 `effort`，池层读 `facts.spec?.effort`，
`/v1/models` 的 `effort` 已透出。以下保留当时的诊断：

- `packages/core/channels/astudio/src/catalog.ts` 的 `modelSpec()` **当时只返回 `{contextWindow, maxOutputTokens}`，不返回 `effort`**
- 共享层契约其实允许：`packages/core/gateway/src/pool/pool-targets.ts:461-466` 的 `ChannelFacts["spec"]` 类型是
  `effort?: { supportedLevels: string[]; defaultLevel: string }`，
  `pool-targets.ts:609,644` 也会读 `facts.spec?.effort`
- 但 astudio **又没有目录缓存条目**（从不 `writeCatalogCache`）→ `entry = null` → `facts.effort = null`
- **结果**：`/v1/models` 的 `effort` 恒 `null`、`meta_sources.effort = "default"`，
  Web 控制台**没有「思考模式」列**（仪表盘模型清单只显示模型名 / 平均 TPS / 输入模态，
  见 `packages/ui/src/pages/Dashboard.tsx` 的 `modelRows`）
- 跨渠道兜底也救不了：档位取交集需要兄弟渠道的 `effort` 也非空，而 traecn 的 `efforts`
  来自上游 `reasoning_effort_config`（`packages/core/channels/traecn/src/catalog.ts:329-338`），
  未登录/无端点时为空 → 交集 null。astudio 独有的 `auto` / `spark-x2.5` / `spark-x2.6` /
  `spark-x2.6-lite` 更无兄弟渠道。

**档位在渠道内部是生效的**：`packages/core/channels/astudio/src/upstream.ts:307-324` `buildChatBody` 用
`catalog.modelEffortLevels(upstreamModel)` 校验 `reasoning_effort`，
非法则**静默删除**（避免上游回 400）。这条链路是通的 —— 当时只是**不对外透出**，现已透出。

### 缺口 2（已修，2026-10-26）：倍率曾对外恒 `null`

**结论：已修。** `catalog.ts` 的 `modelSpec()` 现在返回 `multiplier`，池层
`packages/core/gateway/src/pool/pool-targets.ts` 读 `facts.spec?.multiplier`，倍率已透出到
`/v1/models`。以下保留当时的诊断依据：

- 池层 `packages/core/gateway/src/pool/pool-targets.ts`：`multiplier: entry ? firstNumber(entry, MULTIPLIER_KEYS) : null`
  —— 当时**只从目录缓存条目读**（`MULTIPLIER_KEYS` = `price_factor` / `multiplier` /
  `effective_multiplier` / `effectiveMultiplier` / `cost_multiplier`，是**目录缓存条目**的字段名约定）
- astudio **从不 `writeCatalogCache`** → `entry` 恒 `null` → multiplier 恒 `null`
- `packages/core/channels/astudio/src/catalog.ts` 的 `modelMultiplier()` **全仓库无调用方**（grep 只有定义处）
  —— 同 `modelDefaultEffort()` 也无调用方；两者保留给需要单独取值的调用方，倍率改由 `modelSpec()` 透出
- **当时的结果**：`/v1/models` 的 `multiplier` 恒 `null`；
  `mx model astudio` 的倍率列恒 `-`（`app/cli/model.ts`）；
  控制台 `model_info[...].multiplier` 恒 `null` → **1/2 两个数字被完全丢弃**
- 文档当时也承认：`docs/channels/astudio/PROTOCOL.md` 写着「倍率 `-`（未知，免费档）」

### 缺口 3（已消解）：规格事实源改为渠道代码

`docs/MODEL-SPECS.md` 现在只描述**全局规格文件**（`~/.modelmux/model-specs.json`）的设计与
取值链（§4 与渠道 spec 表的关系），**通篇不含任何渠道的逐型号规格表**。
astudio 的规格落在自己的 `catalog.modelSpec()`（`packages/core/channels/astudio/src/catalog.ts`），
与其它渠道同级 —— 不再是「游离在唯一事实源之外」。

### 要做什么

1. **（已完成）让 effort 与 multiplier 透出到池层**：走路线 a 的推广 ——
   `runtime/channel.ts` 的 `modelSpec?` 契约同时带上 `effort?` 与 `multiplier?`，
   池层 `packages/core/gateway/src/pool/pool-targets.ts` 读 `facts.spec?.effort` / `facts.spec?.multiplier`。
   （路线 b「让 astudio 写目录缓存」与路线 c「新增目录元数据钩子」均未采纳。）
   **倍率已核实**：云端 `/bot/models/configs`
   只有 `xopglm52` / `xopdeepseekv4pro` 两行有 `point_multiplier`（均 x2.0），
   其余 5 个云端没有对应行 → 一律**省略**（`undefined`，不编造 1）。见 [PROTOCOL.md](./PROTOCOL.md) §6.2。
2. **（已消解）补 `docs/MODEL-SPECS.md` 的 astudio 章节** —— 该文件只描述全局规格
   文件与取值链（§0 / §4），逐型号规格落在渠道 `catalog.modelSpec()`，无需在此登记。
3. **`reasoning` / `thinking` 别名**：上游也接受这两个（PROTOCOL §6.1），
   但 `buildChatBody` 只校验 `reasoning_effort` → 客户端发这两个会**原样透传**，
   不受档位表约束（行为上大概率没问题，但不受控）。

### 验收判据

- `GET /v1/models` 里 astudio 的 7 个模型，`effort` 不再是 `null`；**已达成**
- 倍率要么是实测值、要么如实显示「未知」，**不能是编造的 1**；**已达成**（5 个省略、2 个实测 x2.0）
- `docs/MODEL-SPECS.md` 不登记 astudio 章节 —— 规格落点在渠道代码，无需登记

---

## 7. 真实模型请求 chat url

### 现状

- `chatUrlForModel(model)`（`packages/core/channels/astudio/src/upstream.ts`）→
  **按模型**取云端配置里那行的 `base_url` + `/chat/completions`
  （共享层新增的可选钩子 `UpstreamModule.chatUrlForModel?`）。
- 固定主机名 `https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/chat/completions`
  实测**对所有模型 404**（`API endpoint not found`）。
  真正的主体是 `maas-api.cn-huabei-1.xf-yun.com/v2`（9 个模型里 8 个走它，
  只有 `spark-x` 走 `spark-api-open.xf-yun.com/agent/v1`）。详见 PROTOCOL §6.1。
- `buildHeaders()` → **只发** `Authorization: Bearer <modelBearerToken>`
  （不发 Cookie / `token` 头 —— 那是账号 API 的形态，模型网关不认）
- `buildChatBody()` → 换 `model`、校验 `reasoning_effort`、`stream` 恒 true
- `WIRE = "openai"` → 网关**纯透传不翻译**
  （`http/chat/channel.ts` `isCustomWire()` 全 false；
  `http/chat/stream.ts` 直接 `relay`；
  `newTranslator()` 是恒等翻译器且**不会被调用**）

实测已通过（PROTOCOL §6.1）：非流式 200、流式 SSE、工具调用 `finish_reason:"tool_calls"`、
`reasoning_effort` / `reasoning` / `thinking` 都被接受。
**2026-10-26 端到端复测**：`astudio/auto`、`astudio/glm-5.2`、`astudio/deepseek-v4-pro`
三个模型各一句，全部 200。

### 小缺口

1. `reasoning` / `thinking` 别名不在档位表约束内（见第 6 项）。
2. 档位表是 2026-10-26 的**静态快照** → 上游改档位不更新，
   客户端发新档位会被**静默丢弃**（不报错，用户看不到原因）。
   → 建议：静默删除时给 `onStatus` 之类的提示，或至少在文档里写明这个行为。

---

## 8. 每日签到逻辑

### 现状

`packages/core/channels/astudio/src/billing.ts` 的 `signin` 是**真签到**：

```ts
status() → 积分余额摘要 + 套餐 + 待领弹窗明细
claim()  → ① POST /tenant-app/v2/init-app（发奖动作）
           ② 关闭奖励横幅（client-popups/complete，只关不发）
           ③ 领客户端下载奖励（一次性）
           并用**余额差**报「+N 积分」
```

`packages/core/channels/astudio/src/channel.ts`：
`capabilities: { billing: true, signin: true }`。

**为什么容易判成「无签到端点」**：路径前缀的坑 ——
`/api/astron-auth/*` 与 `/api/astron-client-popups/*` 是**本地服务代理层**的路径，
云端账号 API 的路径**没有这些前缀**（同 §5）。

云端直连实测（2026-10-26）：

| 端点 | 结果 |
| --- | --- |
| `POST /tenant-app/v2/init-app` | `200 code=0`（`banned: false`）—— **这才是发奖动作** |
| `GET /client-popups/pending` | `200 code=0`，返回 `DAILY_LOGIN_REWARD_V1` 横幅 |
| `POST /client-popups/complete` | 关横幅（**不发积分**） |
| `POST /client-download-reward/claim` | 一次性下载奖励 |

弹窗类端点**必须带客户端头**（`clientType: 21` / `studioVersion: 3.4.4` /
`User-Agent: AStudio/3.4.4`），否则回 `code=11001001 客户端平台、版本或构建号无效`。

### 缺口

1. **Web UI 完全没有签到展示**（非 astudio 独有，是全仓现状）：
   `channel_caps`（`http/console/console.ts`）**只有 `billing` 字段，没有 `signin`**；
   `packages/ui/src/` 搜 `signin` / `签到` **零命中**。
   → 签到状态在 UI 上**无任何呈现**（`mx status <cid>` 的签到摘要可见，UI 侧不可见）。
   这属于**共享层 + UI 的问题**，不是 astudio 独有 —— 接手时要注意改动面。
2. **「今天是否已领」的判据不够硬**：待处理弹窗 `DAILY_REWARD_DIALOG` 的内容是
   「**今日登录积分已到账**」—— 它是**到账通知**不是待领奖单，
   所以**不能**凭「有没有横幅」判今天领没领。
   现在 `claim()` 用**余额变动**（`init-app` 前后对比）确认，`status()` 的
   `claimedToday` 给 `null`（判不了就说不知道，不猜）。
   → 想更准，得找一个上游的「今日已领」字段（暂未找到）。

---

## 附：相关文件清单

**渠道实现**
- `packages/core/channels/astudio/src/cred.ts` —— 凭据（load/save/login/refresh）
- `packages/core/channels/astudio/src/upstream.ts` —— 端点、鉴权头、错误判据
- `packages/core/channels/astudio/src/catalog.ts` —— 静态模型表、`modelSpec()`
- `packages/core/channels/astudio/src/billing.ts` —— `fetchCredits()` / `signin`
- `packages/core/channels/astudio/src/channel.ts` —— `config`（含 `capabilities`）

**共享层消费点**
- `packages/core/gateway/src/pool/pool-targets.ts`（`:490-528` `channelFacts`、
  `:604-613` `buildCrossModelIndex`、`:635-684` `metaFromFacts` 四层回落、`:655` multiplier 读法）
- `packages/core/gateway/src/runtime/account-pool.ts`（`:85-103` `NAME_FIELDS`、
  `:253-273` `refreshLabels`、`:325-331` `captureActive`、`:454-481` `removeAccount`、
  `:493-507` `purgeCredentials`）
- `packages/core/gateway/src/runtime/channel.ts`（`:312-342` `CatalogModule`、
  `:391-394` `SigninModule`、`:406-443` `BillingModule`、`:446-488` `capabilities`）
- `packages/core/gateway/src/auth/auto-signin.ts`（`:83` capability gate）
- `packages/core/gateway/src/auth/auth-flow.ts`（`:33-45` `ensureLogin`、`:91-108` refresh+unlink）
- `packages/core/gateway/src/app/lifecycle/headless.ts`（`:374-400` relogin 流程、
  `:238-256` `snapshot()`、`:650-666` 模型轮询）
- `packages/core/gateway/src/http/chat/auth.ts`（`:88-99` 401 后 refresh 重试）
- `packages/core/gateway/src/app/cli/model.ts`（`:78` builtin 目录、`:148` 倍率显示）
- `packages/core/gateway/src/app/cli/channel.ts`（`:33-47` 动词表）

**UI 显示链路**
- `packages/ui/src/components/AccountCard.tsx`（`:151` 脱敏承诺、`:174-189` `displayName()`、
  `:440-442` 渲染）
- `packages/ui/src/pages/Dashboard.tsx` 的 `modelRows`（模型清单：模型名 / 平均 TPS / 输入模态）
- `packages/ui/src/components/LoginModal.tsx`（`:58,130-150` 授权链接渲染）
- `packages/ui/src/lib/types.ts`（`:63-81` `ModelInfo` 类型，即 `UiSnapshot.models[].meta`）

**逆向记录**
- [FINDINGS.md §1](./FINDINGS.md#1-逆向方法论可复用) —— 通用方法论与 AStudio 参数映射
- [FINDINGS.md §2](./FINDINGS.md#2-完整实跑记录2026-10-2627) —— 一次完整实跑记录

---

## 附：动手时的纪律

- 渠道**不写单元测试**（`AGENTS.md`「测试规则」第 1 条），只做端到端
  （`dsh-mx-test` 技能）。
- 探测脚本放项目根 `.tmp/` 并保留复用（全局规则「临时文件」）。
- 只发**正确形态**的请求；**绝不**拿真实账号去「故意发错、验证归一化是否会修」。
- 实测结论要落 `docs/channels/astudio/PROTOCOL.md`。
- 改完：`npm run build` → `mx restart` → `mx status --json` 确认 `stale_build=false`。
- 推送前：`npm test` 全绿 + `npm run gate`（推送门禁）绿 + PR 走 CI 双绿后 squash 合并。

