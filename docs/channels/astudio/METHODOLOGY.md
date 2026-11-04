# AStudio 逆向方法论

> 状态：方法论记录。协议事实以 [PROTOCOL.md](./PROTOCOL.md) 为准；
> 一次完整实跑记录见 [WALKTHROUGH.md](./WALKTHROUGH.md)。

本文件是**可复用的工作流**：换一个 Agent 应用（桌面端 / 移动端 / 任何带私有协议的客户端），
按同样的阶段走一遍，就能从「什么都不知道」到「能用脚本复现任意请求」。
AStudio 的具体产物（端点、字段、坑）在 [PROTOCOL.md](./PROTOCOL.md) —— 那是本方法论的**一次应用结果**，
不是方法论本身。**方法论的完整实跑记录**（真实命令、脱敏输出、踩坑与推理现场）在
[WALKTHROUGH.md](./WALKTHROUGH.md) —— 读方法论觉得抽象时看它，每个 Stage 都有对应的实操小节。

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
见 [WALKTHROUGH.md](./WALKTHROUGH.md) §1。）

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
渲染层直连，见 [WALKTHROUGH.md](./WALKTHROUGH.md) §2。）

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
见 [WALKTHROUGH.md](./WALKTHROUGH.md) §3。）

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
| Stage 4 沉淀 | 结论 → [PROTOCOL.md](./PROTOCOL.md)；过程 → [WALKTHROUGH.md](./WALKTHROUGH.md) |

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
