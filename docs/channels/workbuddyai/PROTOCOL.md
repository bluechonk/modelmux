# workbuddyai 协议规格（国际版 WorkBuddy 桌面端）

> 结论来源：`reference/ardeyouxipianyi_workbuddy2api-hub`（1576★）。
> 其中 `wb_identity.py` / `wb_fingerprint.py` 标注为 **2026-10-16 mitmproxy 对官方 5.8.4
> 桌面客户端的实测抓包**；标注「无抓包」的取值维持参考实现原值，不凭猜测改。

## 1. realm 与端点（身分换了，端点也要换）

| realm | chat 上游 | X-Domain |
| --- | --- | --- |
| intl（桌面端） | `https://www.workbuddy.ai` | `www.workbuddy.ai` |
| cn（桌面端） | `https://copilot.tencent.com` | `copilot.tencent.com` |

- `www.codebuddy.ai` 在实测网络里 **DNS 沉洞**（getaddrinfo 返回 0.0.0.1），
 国际版请求不得指向它 —— 凭据 `domain` 与落盘 `baseUrl` 必须同源推导。
- chat 路径为 `/v2/chat/completions`（`/plugin` 前缀实测 404）。

## 2. 官方身分头族（对话请求，缺任一可能触发渠道校验）

| 头 | 值 |
| --- | --- |
| X-Agent-Intent / X-Agent-Purpose / X-Agent-Type | `craft` / `conversation` / `main` |
| X-IDE-Name / X-IDE-Type | `WorkBuddy` / `WorkBuddy` |
| X-IDE-Version | intl `5.8.4`；cn `5.5.6`（无抓包） |
| X-Product / X-Private-Data | `SaaS` / `true` |
| User-Agent | intl `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`；cn `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`（次段**小写** `workbuddy-ai`：对话由客户端内置 CLI 子进程发出，别照抄 Electron 主进程的 UA） |
| X-User-Id / Authorization | 账号 uid / `Bearer <token>` |
| X-Conversation-ID | 带连字符 UUID；上游不按它存历史，每轮新生成即可 |
| X-Conversation-Request-ID = X-Root-Request-ID | **同一值**：一轮 user send 开始时生成、本轮所有请求复用（后台按它聚合） |
| X-Conversation-Message-ID = X-Request-ID | 32 位无连字符 hex（UUIDv7） |
| 链路族 | `traceparent: 00-<32hex>-<16hex>-01`、`b3: <trace>-<span>-1`、`X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled: 1`（`X-B3-ParentSpanId` 需要真实父子关系，不伪造）、`X-Trace-ID: <trace>`（官方客户端自家的 trace 头，取值同 trace id） |
| Accept / X-Requested-With | `application/json, text/plain, */*` / `XMLHttpRequest` |
| Origin / Referer | intl `https://www.workbuddy.ai`（+`/`）；cn `https://www.codebuddy.cn`（+`/`）—— **前台域名**，chat 上游仍按 §1 的 realm 表 |
| X-CodeBuddy-Request | `1` |
| Accept-Language | intl `en-US`；cn `zh-CN` |

> **浏览器语义头是渠道校验的一部分**（实测）：只有身分头族而没有
> `Origin` / `Referer` / `X-CodeBuddy-Request` 时，对话仍被 11128 拒绝，而带这组
> 的计费请求畅通 —— 参考 hub 的 `account.headers("chat")` 同源结论。
> **chat 请求不带 X-Machine-ID / X-Session-ID**：官方桌面端只在反馈上报时发它们，
> 对话带恒定派生值反而是「网关特征」（hub v1.7.12 明文注释）。

## 3. 设备指纹（防关联口径）

- 官方客户端「一进程一设备」；网关一进程服务多账号，**machineId / sessionId 必须按
 账号 uid 加盐派生**（幂等、账号间互不相同），照进程维度取值会把账号池串成同源设备。
- 形态按 5.8.4：machineId / sessionId 为带连字符 UUID；请求 id 为 32 位无连字符 hex。

## 4. 错误码 `11128` 的两个独立来源

1. **缺身分头族**（本文件 §2）—— 上游按整组头判定「是否官方客户端」，缺员回
 `400 code=11128 request illegal`；反复触发后可升级 `11140`（账号被限制，需换号）。
2. **请求体指纹串误杀** —— 内容审核对样板文本逐字精确匹配；需把命中文本改写为等价表述
 （实现见 `src/upstream.ts` 的 `rewriteFingerprint`）。

## 5. 请求体归一化管线（`src/upstream.ts::buildChatBody`）

顺序不可乱 —— 后一步依赖前一步的结果（与 hub 的 `build_upstream_body` 对齐）：

| 步 | 动作 | 不做的后果 |
| --- | --- | --- |
| 1 | `developer` → `system` | `code=11128`（角色枚举不含 developer） |
| 2 | 指纹改写（正文 / `reasoning_content` / 工具实参） | `code=11128` |
| 3 | DeepSeek 思考链回填 | DeepSeek 多轮带思考时 400 |
| 4 | 首条消息补 system | `400 first message is not system prompt` |
| 5 | 相邻并行 `tool_calls` 合并 | `code=11148 tool_call_sequence_broken` |
| 6 | `tool` 结果挪到对应 assistant 之后 | 同上 |
| 7 | 孤立 `tool` 结果剔除 | 同上 |
| 8 | `max_completion_tokens` → `max_tokens` | 上游不认新字段，输出长度失控 |
| 9 | `tool_choice` 归一化 | 对象形态 → `code=11101`（Go 类型不匹配） |
| 10 | `tools` 归一化（顶层形态补 `function` 包装） | 工具定义被忽略 / 解析失败 |
| 11 | `stop` 归一化（字符串包成数组） | `code=11101` |
| 12 | 强制 `stream:true` + `stream_options.include_usage` | `400 Non-stream chat request is currently not supported` |

`tool_choice` 的细节（`wb_proxy.py::normalize_tool_choice`）：

- 字符串 `"none"` / `"auto"` / `"required"` 原样保留，**且不清空 `tools`** ——
  删 `tools` 会让 Agent 陷入「发 DSML 文本冒充工具调用」的死循环；
- `{"type":"none"|"auto"|"required"}` → 对应字符串；
- `{"type":"function","function":{"name":"x"}}` → `"x"`；
- 其他对象一律删除该字段（宁可当自动，也不要 400）。

## 6. 模型目录端点（`/v3/config`，不是窄表）

| 端点 | 内容 | 实测 |
| --- | --- | --- |
| `/v2/enterprises/personal/models` | 连接配置（`endpoint` / `authentication`）+ 窄表 `data.models` | 18 条，以 `default-model` 这类前端路由别名开头 |
| `/v3/config` | **桌面端选择器的真实目录**：`agents[].models` 裸 id 列表 + `models[]` 元数据 | 27 条，含 `deepseek-v4.1-flash` |

- 目录端点受 UA 门禁：只有三段式 CLI UA 能拿到完整目录，未知 UA 直接 `400 code=12403`
  （hub `remote_config_headers` 注释）；故用 `buildChatHeaders()` 那套桌面端身分。
- 拉到的目录落盘到 `<MODELMUX_HOME>/workbuddyai/cache/models.json`（共享层 `catalog-cache.ts`），
  `mx model workbuddyai --refresh` 与登录后的 `fetchModels` 都会触发。

## 7. 测试对照

渠道**不写单元/集成测试**（参见 `AGENTS.md` 的「测试规则」第 1 条）。

- 临时验证脚本（抓包核对端点、跑通修复）放在项目根 `.tmp/`，**用真实账号、真实请求**快速验证；
  任务结束前删除，不入库，不写 fixture；禁止编写虚构请求头/凭证（`AGENTS.md` 的「测试规则」第 2 条）。
- 上游约束（§2 头族、§4 错误码、§5 归一化管线）的正确性由**代码审查 +
  归一化前后 diff 人工核验**保障，不靠运行时发任何请求去「验证修复」——
  发畸形请求本身就是一次风控事件。
- 渠道是否跑得通的**唯一判据**是端到端测试：由 Agent 跑 `reasonix-mx-test` skill，
  通过 Reasonix CLI 直连 `http://127.0.0.1:4412/v1`，用 `<渠道>/<模型>` 池 id 发
  **正确的** OpenAI 兼容请求（普通文本对话、合法 tool_calls 往返、流式/非流式）。

---

## 使用与实测

### 登录

`mx login workbuddyai` 走浏览器设备授权（申请链接 → 打开浏览器 → 轮询令牌），
全程只有「在浏览器点一下授权」需要人工；国际版 realm 端点见 §1（`www.workbuddy.ai`）。

`--realm` 参数在本渠道被忽略（保留仅为兼容共享层 CLI 的签名）。国内版（腾讯 CodeBuddy）
是**独立渠道** `workbuddy`，见 [`workbuddy/PROTOCOL.md`](../workbuddy/PROTOCOL.md)：
两者共用同一套网关，但账号、凭证落点、模型池各自独立 —— 账号在哪个域就用哪个渠道登录。

### 存储与配置

全部落点在统一存储根 `~/.modelmux/` 下按渠道分层：凭证在
`~/.modelmux/workbuddyai/credentials.json`（权限 0600），不要提交到 git。
`MODELMUX_HOME` 可把整个存储根指到别处，便携/测试用；本渠道只读写
`~/.modelmux/workbuddyai/`，不读其它顶层目录或旧环境变量。
`mx path --all` 可只读列出全部落点。

国内版数据在 `~/.modelmux/workbuddy/`，与本渠道不共享 —— 混用会跨产品串号。

### 模型目录

- **对外名 = 上游模型名**（`/v3/config` 的 `agents[].models`，如 `deepseek-v4.1-flash`）
- 目录三档优先级：**远端缓存**（`<MODELMUX_HOME>/workbuddyai/cache/models.json`）
  → 随包快照（渠道根 `models.json`）→ 内置兜底；`mx model workbuddyai --refresh` 强制重拉
- 短名 `deepseek-flash` 仍能解析，但不出现在 `/v1/models` 里
- 未识别的模型名原样透传

### 已知限制（实测）

- **SSE 里空的 `tool_calls: []` 必须剔除**：上游每个 delta 都带它，
  而 ZCode 的解析器判定 `tool_calls != null` 就结束思考块 ——
  不剔除会让每个 reasoning token 被切成独立的「思考」块。

### 怎么测这个渠道

- 登录入池：`mx login workbuddyai`（浏览器设备授权）
- 目录刷新：`mx model workbuddyai --refresh`；状态与额度：`mx status workbuddyai` /
  `mx bill workbuddyai`
- 端到端：由 Agent 跑 `reasonix-mx-test` skill，用 Reasonix CLI 直连
  `http://127.0.0.1:4412/v1`，按 `workbuddyai/<模型>` 池 id 发正确的 OpenAI 兼容请求
  （最小对话 / 工具往返 / 流式 SSE）

### 2026-10-19 端到端实测

Reasonix CLI 直连 `http://127.0.0.1:4412/v1`（`workbuddyai/hy3`，倍率 0）：

- 冒烟通过，模型正常回话（网关 access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增，多轮链路完整。
- 倍率 0：测试前后 `mx bill workbuddyai` 剩余额度无变化。
- 注意：`workbuddyai` 免费档模型有 `hy3` / `step-5-preview` / `deepseek-v4.1-flash` 三个，
  测例优先用倍率 0 的，其余模型倍率最高到 6.67（`gpt-6-astra`），勿用于自动化测试。

---

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 主参照（1576★，mitmproxy 5.8.4 实测）：`wb_identity.py` 官方身分头族（X-Agent-* / X-IDE-* / 会话头族 / B3 链路）与 UA、realm 端点表（国际版 `www.workbuddy.ai`，`www.codebuddy.ai` 已 DNS 沉洞）、`wb_fingerprint.py` 按账号派生 machineId/sessionId 的防关联口径 |
| [Tom6814/WorkBuddy2API](https://github.com/Tom6814/WorkBuddy2API) | WorkBuddy / CodeBuddy 逆向 API（97★，Docker 部署） |
| [ckldy/workbuddy2api](https://github.com/ckldy/workbuddy2api) | WorkBuddy 转服务的对照样本 |
