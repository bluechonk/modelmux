# AStudio 逆向实操记录 —— 方法论的一次完整执行

本文是 [METHODOLOGY.md](METHODOLOGY.md) 五阶段工作流的**实跑记录**：目标是在
**不参考任何反代项目**的前提下，只靠「解包 + 日志 + 实测」三条链，从零推导出
AStudio 的上游 API。每一步都是真实执行过的命令与输出（令牌已脱敏）。
执行日期：2026-10-26/27（协议事实的权威版见 [PROTOCOL.md](PROTOCOL.md) 与
`docs/channels/astudio/PROTOCOL.md`，本文只回答「这些结论是怎么来的」）。

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
| 账号 API 基址 = `agent.xfyun.cn/xingchen-studio/` | ✅ authBaseUrl 常量 | ✅ 日志 upstreamHost | ✅ probe 200 |
| 业务路径无 `/api/astron-*` 前缀 | ✅ `new URL(path, authBaseUrl)` | ✅ 日志 upstreamPath | ✅ probe 200 |
| Cookie 四键形态 | ✅ 拼装函数 | —（日志不打头） | ✅ probe 200 |
| 凭据两种（Cookie / Bearer） | ✅ 字段 + Bearer 头构造 | — | ✅ 对话 200 |
| **推理主机 = 服务端下发 base_url** | ❌ 零命中（本身即证据） | ⚠️ 对话不经主进程 | ✅ configs 响应 + chat 200 |
| 对话端点形态（OpenAI 兼容 SSE / tools） | ✅ WIRE 常量 | — | ✅ 9 帧 SSE + tool_calls |

方法论的核心论断在这张表里兑现：**参考实现能给的，三条链全都能独立推导出来；
而三条链给出的「为什么」（服务端下发、代理层前缀、渲染层直连），参考实现给不了。**
