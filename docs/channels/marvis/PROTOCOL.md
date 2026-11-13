# Marvis 完整协议解剖

> 来源：`offline-pack/main/assets/*.js`（未字节化的 Vite 产物）
> 分析日期：2026-11-12

## 1. 请求基础设施（所有 API 共用）

### 1.1 基址

```js
function ua() {
  return isApiDev  ? "https://yybadaccess.sparta.html5.qq.com"
       : isApiTest ? "https://yybadaccesstest.3g.qq.com"
       :             "https://yybadaccess.3g.qq.com";   // 生产
}
function Fn() { return "https://yybadaccess.3g.qq.com"; }
```

### 1.2 签名算法

```js
const pp = (e) => md5(`${e.body}${e.timestamp}${e.accessKey}${e.nonce}`);
```

**四段拼接后 MD5**（不是 SHA-1 —— 源码里 `rp = Lr(np)`，`np` 是标准 md5 库）。
GET 请求的 `body` 取 URL 的 query 串。

### 1.3 accessKey 表

```js
zn = { marvis_client: "fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi" };
```

### 1.4 完整请求头（`xi()` 函数）

```js
POST {host}{path}
credentials: "include"

Content-Type:            application/json
Ual-Access-Businessid:   pc_yyb | marvis_client
Ual-Access-Timestamp:    Date.now()
Ual-Access-Nonce:        ~~(Math.random()*1e4)
Ual-Access-Signature:    md5(body + timestamp + accessKey + nonce)
Ual-Access-Requestid:    ~~(Math.random()*1e4)
Ual-Access-Guid:         <guid>
marvis-req-plat-id:      2 (macos) | 0 (其它)
marvis-req-is-intel-cpu: "1" | "0"

# needLogin 时才带：
Ual-Access-Access-Token: <accessToken>
Ual-Access-Login-Type:   <1=QQ | 2=WX | 7=macos?>
Ual-Access-Openid:       <openId>
```

## 2. 登录

### 2.1 拉起第三方授权

**QQ**：

```
https://graph.qq.com/oauth2.0/authorize
  ?which=Login
  &display=pc
  &response_type=code
  &client_id=1903794758
  &redirect_uri=<encodeURIComponent(回调)>
  &state=<random>
```

**微信**：

```
https://open.weixin.qq.com/connect/qrconnect
  ?appid=wxb650708317d56f88
  &redirect_uri=<回调>
  &response_type=code
  &scope=snsapi_login,snsapi_userinfo
  &fast_login=1
  &state=<guid>
  &self_redirect=true
  &href=data:text/css;base64,<样式>
#wechat_redirect
```

回调地址：

```js
at(t) {
  const n = isLoginDev ? "marvis_client_login_test" : "marvis_client_login";
  return `${Fn()}/${n}/marvis_oauth?login_type=${t}`;
}
// 即 https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=<QC|WX|WXAPP>
```

### 2.2 登录相关 API

| 用途 | 方法 | 路径 | 请求体 |
| --- | --- | --- | --- |
| 检查登录态 | POST | `/marvis_client/marvis_check_login` | 见下 |
| 取用户信息 | GET | `/marvis_client/marvis_get_user_info` | — |
| 刷新 token | POST | `/marvis_client/marvis_refresh_token` | 见下 |

**`marvis_check_login`**（走 `ie()`，businessId=`marvis_client`）：

```js
// 请求头额外带（不是 body）：
Ual-Access-Access-Token, Ual-Access-Login-Type, Ual-Access-Openid
```

**`marvis_refresh_token`**：

```json
{
  "userInfo": {
    "loginType": "WXAPP",
    "openId": "<wxappOpenId>",
    "accessToken": "<wxappAccessToken>",
    "refreshToken": "<wxappRefreshToken>",
    "guid": "<guid>"
  }
}
```

响应：`{ code: 0, user_info: { access_token, refresh_token, expires_in } }`

### 2.3 登录态存储

```js
localStorage:  accessToken / refreshToken / expiresIn / isWxApp
               wxapp_refreshtoken
               guid
cookie:        credentials: "include"（会话 cookie 随请求带）
```

## 3. 账号与设备

| 用途 | 路径 | 请求体 |
| --- | --- | --- |
| 设备信息 | `/v3/get_account_device_info` | `{loginType, openId, guid, platform}` |
| 绑定状态 | `/v3/marvis_query_bind_status` | — |
| 手机绑定 | `marvis_account_bound_phone` | — |
| 邀请码校验 | `/v3/marvis_invitecode_verify` | — |

`loginType` 映射：`QC`/`QQ` → 1，`WX` → 2，其它 → 0。
`platform`：macos → 7，其它 → 2。

## 4. 模型

| 用途 | 路径 | 说明 |
| --- | --- | --- |
| 自定义 LLM 提供方 | `/v3/marvis_list_custom_llm_provider` | 列出用户配置的模型源 |
| 能力声明 | `/v3/marvis_capabilities` | 账号可用能力 |
| 模拟模型 | `marvis_mock_model` | 调试用 |

模型列表**没有独立 `/models` 端点**——能力与模型从 `marvis_capabilities` 与
`marvis_list_custom_llm_provider` 组合获取。

## 5. 额度与计费

| 用途 | 路径 |
| --- | --- |
| Agent token 统计 | `/v3/marvis_list_agent_token_stats` |
| 订单列表 | `/v3/marvis_commerce_query_order_list` |
| 订单分页 | `marvis_order_list_page` |
| 活动 | `marvis_activity` |

## 6. 技能 / 案例

| 用途 | 路径 |
| --- | --- |
| 技能操作 | `/v3/skill_operate` |
| 案例列表 | `/v3/marvis_get_skill_cases` |
| 案例类型 | `/v3/marvis_get_skill_case_types` |
| 案例详情 | `/v3/marvis_get_skill_case_detail` |
| 案例评论 | `/v3/marvis_skill_case_comment` |
| 评论列表 | `/v3/marvis_skill_case_comment_list` |
| 评论点赞 | `/v3/marvis_skill_case_comment_like` |
| 评论删除 | `/v3/marvis_skill_case_comment_delete` |
| 发布案例 | `/v3/marvis_publish_skill_case` |
| 使用记录 | `/v3/marvis_save_skill_case_use_record` |
| 订阅知识 | `/v3/marvis_subscribe_knowledge` |

## 7. 定时任务

| 用途 | 路径 |
| --- | --- |
| 任务模板 | `/v3/marvis_scheduled_task_template` |
| AIGC 任务 | `/v3/marvis_scheduled_task_aigc` |

调用方式（`index-BbhaQai1.js`）：

```js
const ot = "/v3/marvis_scheduled_task_aigc";
const Kt = "/v3/marvis_scheduled_task_template";
const et = { bid: "marvis_client", accessKey: "<accessKey>", needLogin: true };
```

## 8. 会话与分享

| 用途 | 路径 |
| --- | --- |
| 创建会话分享 | `/v3/marvis_create_conversation_share` |
| 分享信息 | `/v3/marvis_get_share_info` |
| 分享短链前缀 | `https://marvis.qq.com/s/` |

`marvis_create_conversation_share` 响应 `{code, share_id}`，
最终分享地址 `${"https://marvis.qq.com/s/"}${share_id}`。

## 9. 系统消息与工具

| 用途 | 路径 |
| --- | --- |
| 系统消息列表 | `/v3/marvis_get_system_message_list` |
| 标记已读 | `/v3/marvis_system_message_read` |
| 工具标签页 | `/v3/marvis_get_tool_tab_list` |
| 推荐 MCP | `/v3/marvis_get_rec_mcps` |
| 安全策略 | `/v3/security_policy_manage` |
| 处理审批 | `/v3/marvis_handle_approval` |
| 反馈 | `/marvis/marvis_feedback_new` |
| 云盘订阅者移除 | `/v3/marvis_remove_cloud_drive_subcribers` |
| 微信 ticket | `/v3/get_pc_wx_ticket` |
| IOA 登录查询 | `/v3/marvis_ioa_login_query` |
| IOA 二次验证 | `/v3/marvis_ioa_2_fa` |
| IOA 验证提交 | `/v3/marvis_ioa_2_fa_verify` |
| Beta 信息 | `/v3/marvis_query_beta_info` |

## 10. 客户端配置与启动

```
GET https://marvis-client.yyb.qq.com/client/config/prod/marvis-win.config.json
GET https://down.marvis.qq.com/ping            ← 存活探测
GET https://static.marvis.qq.com/wupload/<id>.png
```

`MarvisHost/marvis-client.config.json`（本地）：

```json
{
  "galileo": { "fullReport": true, "channelWhitelist": ["715","716","718"],
               "guidWhitelist": ["bf83fe739a76122341615e69abe4d3f5-0"] },
  "push": { "enabled": true }
}
```

## 11. 完整调用示例

```js
// 调任意 v3 API
async function marvisApi(path, body, { needLogin = true } = {}) {
  const ts = String(Date.now());
  const nonce = String(~~(Math.random() * 1e4));
  const accessKey = "<accessKey>";   // 从客户端 bundle 提取
  const payload = JSON.stringify(body);
  const sig = md5(`${payload}${ts}${accessKey}${nonce}`);   // 关键：MD5

  return fetch(`https://yybadaccess.3g.qq.com${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Ual-Access-Businessid": "marvis_client",
      "Ual-Access-Timestamp": ts,
      "Ual-Access-Nonce": nonce,
      "Ual-Access-Signature": sig,
      "Ual-Access-Requestid": String(~~(Math.random() * 1e4)),
      "Ual-Access-Guid": guid,
      "marvis-req-plat-id": "0",
      "marvis-req-is-intel-cpu": "0",
      ...(needLogin && {
        "Ual-Access-Access-Token": accessToken,
        "Ual-Access-Login-Type": loginType,   // 1=QQ 2=WX
        "Ual-Access-Openid": openId,
      }),
    },
    body: payload,
  }).then((r) => r.json());
}
```

## 12. 与豆包工作的对比

| 维度 | Marvis | 豆包工作 |
| --- | --- | --- |
| 登录 | 微信/QQ OAuth（第三方授权码） | 手机号 + 短信验证码 |
| 签名 | MD5(body+ts+key+nonce) | 字段值 XOR 0x05 转 hex |
| 会话 | accessToken + cookie | 纯 cookie |
| 续期 | `/marvis_client/marvis_refresh_token` | 无 refresh，重登 |
| API 域 | `yybadaccess.3g.qq.com` | `www.doubao.com` |

## 13. 边界

- 主进程逻辑（`.cjsc` 字节码）未解，可能还有 native 侧端点。
- `MarvisAgent`（Python）的 MCP server 有独立协议，未展开。
- 服务端下发的动态地址不在静态清单内。
- 全部原始数据见 `marvis-urls.txt` / `marvis-by-host.json` / `api-context.json`。

## 14. 凭证落盘与实测（2026-11-12）

### 14.1 凭证落点

`~/.modelmux/channels/marvis/credentials.json`（0600）：

| 字段 | 说明 |
| --- | --- |
| `host` | `https://yybadaccess.3g.qq.com` |
| `accessKey` | `fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi` |
| `login` | `{ loginType, openId, nickname }` |
| `tokens` | `{ accessToken, refreshToken, expireAt }` |
| `device` | `{ guid, qimei36, platformType, systemVersion }` |
| `cookie` | 完整 cookie 串（含 `accesstoken` / `openid` / `logintype`） |

### 14.2 凭证来源

登录态存在**页面 cookie + localStorage**，可从
`https://marvis-client.yyb.qq.com/` 的 `document.cookie` 直接读出：

```
guid / qimei36 / platform_type / system_version /
refreshtoken / logintype / appid / openid / nickname /
scope / accesstoken / access_token_expire_time
```

获取方式：CDP 连该页面执行 `document.cookie`。

### 14.3 实测结果

| 接口 | 方法 | 结果 |
| --- | --- | --- |
| `/marvis_client/marvis_check_login` | POST + 签名 | 通过（`code:0`） |
| `/marvis_client/marvis_refresh_token` | POST + 签名 | 通过（`expires_in` 7200） |
| `/v3/marvis_list_agent_token_stats` | POST + 签名 | 通过（token 用量） |
| `/v3/marvis_get_system_message_list` | POST + 签名 | 通过 |
| `/v3/marvis_list_custom_llm_provider` | POST + 签名 | 通过（7 家供应商） |
| `/v3/marvis_get_tool_tab_list` | POST + 签名 | 通过 |
| `/v3/marvis_get_rec_mcps` | POST + 签名 | 通过 |
| `/v3/marvis_get_agent_team` | POST + 签名 | 通过（4 个 agent） |
| `/v3/marvis_get_agent_detail` | POST + 签名 | 通过（需 `agent_id`） |
| `/marvis_client/marvis_get_user_info` | GET + 头 | 失败 `RC_NO_AUTH_ERR`（需 bridge） |
| `/v3/marvis_query_bind_status` | POST | 失败 403 |

`check_login` 的参数嵌在 userInfo 里：

```json
{ "userInfo": { "openId": "...", "accessToken": "...", "loginType": "WX", "refreshToken": "..." } }
```

### 14.4 签名验证（决定性实验）

- 正确签名 → `200` + 业务码（如 `-109` 缺参数）
- 错误签名 → `403`

证明 `MD5(body + timestamp + accessKey + nonce)` 正确。

### 14.5 模型能力分布

Marvis 有**两层模型**：

1. **内置「省心组合」**（默认，`homeSelectedModel = "default"`）：按任务难度自动
   匹配模型，由服务端承载，用账号 token 额度计费。前端常量 `cs = "default"`、
   `Ll = "省心组合"`；对话时 `model_config` **留空**即为它。
2. **用户自配的第三方 provider**：`list_custom_llm_provider` 返回 7 家
   （腾讯云 / DeepSeek / 阿里云 / MiniMax / Kimi / 智谱 / 小米），标准 OpenAI 兼容
   `chat/completions`；以 `custom:<id>` 前缀作 config_id。

> 早期结论「Marvis 自身不提供模型」是**错的** —— 只查了第 2 层，
> 漏了 `agent.run` 这个不在 action 白名单里的对话入口（见 §18）。

对话走**本地 WebSocket**（`ws://127.0.0.1:<port>`，端口取自
`agent_port.ini`，默认 6161），由 `MarvisAgent`（Python）承载。

`get_agent_team` 返回 4 个内置 agent：

| agent_id | 名称 | 职责 |
| --- | --- | --- |
| `computer_agent` | 电脑管家 | 电脑系统运维 |
| `file_agent` | 文件管家 | 数字资产专家 |
| `app_agent` | 软件管家 | 软件与游戏助手 |
| `browser_agent` | 浏览器管家 | 网页交互专员 |

### 14.6 登录的本质

`Login` / `GetUserInfo` / `KeepAliveCheckLogin` 全走 **native bridge**
（`window.CallBridge.invokeMethod`，模块名 `cloginManager`），不经过 HTTP。

OAuth 授权在 iframe 里完成，结果通过 `postMessage`
（`pcyyb_login_result` / `qclogin_success`）回传，再由 native 写回客户端。

结论：**首次登录需要客户端**；**登录后 accessToken 可纯 HTTP 复用**（已实测）。

## 15. 本地 gateway 协议（2026-11-12 实测打通）

### 15.1 连接

```
1. native bridge 取 token：
   CallBridge.invokeMethod("AiStarter.GetGatewayToken", callbackId)
   回调签名：(callbackId, code, data, message)
   data = {"token":"<uuid>","port":10123}

2. 连 WebSocket（注意：**不要加 handler 参数**）：
   ws://127.0.0.1:<port>/?token=<token>

3. 端口复用 HTTP：
   GET /health?token=<token>  → {"code":0,"agent_ready":true}
```

WebSocket 握手成功即 101；**首帧不是 hello，直接发业务请求**。

### 15.2 帧格式（纯 JSON 文本）

```json
// 请求
{ "type": "request", "event": "<action>", "payload": {...}, "requestId": "<自定义>" }

// 成功应答
{ "type": "ack", "event": "<action>", "requestId": "...",
  "data": { "ok": true, "action": "<action>", "data": {...}, "request_id": "<服务端>" } }

// 失败应答
{ "type": "ack", "data": { "ok": false, "error": { "code": "bad_request", "message": "..." } } }

// 服务端主动事件
{ "type": "event", "event": "gateway.connected",
  "data": { "agentConnectionStatus": "Ready" } }
```

### 15.3 action 清单（服务端错误信息泄露）

```
blocking.resolve        browser.list          browser.login.open
browser.status          device.notify         feature.get
mcp.cancel / create / delete / disable / enable / get / list / update
persona.get             product.get           skills.notify
token.conversation_usage  token.conversations_usage
token.usage_logs        token.wallet          tool_calls.app...
```

### 15.4 实测结果

| action | 结果 |
| --- | --- |
| `feature.get` | 通过（功能开关） |
| `product.get` | 通过（产品列表） |
| `persona.get` | 通过（人设） |
| `token.wallet` | 通过（**额度**） |
| `token.usage_logs` | 通过（逐日用量） |
| `mcp.list` | 通过 |
| `device.notify` | 通过 |
| `token.conversation_usage` | 参数校验：需 `conversation_id` |
| `browser.list` / `browser.status` | 超时（需浏览器会话） |

### 15.5 额度实测值

```json
{ "avail_tokens": "10000000", "total_tokens": "10000000",
  "used_tokens": "0", "frozen_tokens": "0", "status": 1 }
```

**1000 万 tokens 可用**。这是 Marvis 自己的模型额度（区别于第三方 provider）。

### 15.6 踩坑记录

| 现象 | 原因 |
| --- | --- |
| 1005 立即关闭 | URL 多了 `handler=codeagent` 参数 |
| `missing field \`event\`` | 帧用 `name` 而非 `event` |
| `Unknown action` | 用了 `machines:list` 这类前端方法名，不是 gateway action |
| 103 字节错误帧 | 帧是**纯 JSON**，不是二进制 MVT1 |

`MVT1`/`CA2F` 双头二进制帧是**另一条协议**（页面与宿主之间），gateway WebSocket 用 JSON。

## 16. Agent 侧登录与 AK/SK（2026-11-12）

### 16.1 action 全清单（33 个）

```
user.login  user.logout  user.get_credentials
token.wallet  token.usage_logs  token.conversation_usage  token.conversations_usage
tool_calls.execute  tool_calls.approve  tool_calls.notify
tool_calls.download_app  tool_calls.get_app_status  tool_calls.pause_download
tool_calls.resume_download  tool_calls.stop_download  tool_calls.update_app
mcp.list  mcp.get  mcp.create  mcp.update  mcp.delete
mcp.enable  mcp.disable  mcp.cancel
browser.list  browser.status  browser.login.open
feature.get  product.get  persona.get  skills.notify
device.notify  blocking.resolve
```

### 16.2 user.login 的真实机制

源码（`marvis_agent.pyd` 内嵌文档字符串）：

```
1. 先从 SQLite 加载已有 AK/SK
2. SQLite 中没有匹配 → 调远程 API
   服务：cloud_asset_service.create_aksk
3. 创建成功后缓存到 AuthStore，并加密持久化到 SQLite
```

流程分支（源码注释）：

```
1. 有 user_switching 错误 → 拒绝
2. 无用户登录 → 创建 UserContext + 鉴权
3. 已有用户且 openid 不一致 → 自动登出当前用户并切换
   （openid 一致时直接走后续鉴权，不需重新激活）
```

必需参数（服务端原话）：

```
Ual-Access-Openid is required in login_args when no active user
```

### 16.3 AK/SK 表结构

```sql
CREATE TABLE IF NOT EXISTS aksks (
  aksk_id        TEXT PRIMARY KEY,
  login_source   TEXT NOT NULL DEFAULT '',
  openid         TEXT NOT NULL DEFAULT '',
  login_type     TEXT NOT NULL DEFAULT '',
  pc_openid      TEXT NOT NULL DEFAULT '',      -- PC 端登录标识
  pc_login_type  TEXT NOT NULL DEFAULT '',      -- 如 LOGIN_TYPE_PC_MARVIS
  access_key     TEXT NOT NULL,
  secret_key     TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  status         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

`aksk_id` 由 `auto-created by marvis-agent` 生成，`LoginInfo` 从
`from_query_params` 构造（`LOGIN_SOURCE_PC`）。

### 16.4 登录态判定

| 现象 | 含义 |
| --- | --- |
| `user.get_credentials` → `no_aksk` | Agent 侧尚未登录 |
| `user.login` → `login_args is required` | 未传登录参数 |
| `user.login` → `'NoneType' object has no attribute 'pc_openid'` | 参数形态不对，未解析出 `pc_openid` |

**Agent 登录与网页登录是两套**：网页登录只给 REST 用；Agent 需要额外的 AK/SK
（由 `cloud_asset_service.create_aksk` 创建）。

## 17. 测试

### 怎么测这个渠道

```bash
mx marvis status          # 凭据可用性
mx marvis bill            # 额度（走本地 gateway）
mx marvis models          # 第三方供应商清单
```

首次登录需在 Marvis 客户端完成，然后导入 cookie：

```bash
# 客户端登录后，用 CDP 读页面 cookie
node .tmp/probe-marvis/cdp-read.mjs 'document.cookie'
# 写入 ~/.modelmux/channels/marvis/credentials.json
```

gateway 地址配置（客户端运行时获取）：

```bash
node .tmp/probe-marvis/gw-token.mjs   # 输出 {"token":"...","port":10123}
# 写入 upstream.json 的 gatewayAddr
```

### 端到端测试覆盖

| 覆盖项 | 判据 |
| --- | --- |
| 凭据读取 | `credentials.json` 含 token / openId |
| 登录态 | `marvis_check_login` 返回 `code:0` |
| 令牌刷新 | `marvis_refresh_token` 返回 `code:0` + `expires_in` |
| 签名正确性 | 正确签名 `200`；错误签名 `403` |
| gateway 连接 | `/?token=` 可握手，收到 `gateway.connected` 事件 |
| 额度 | `token.wallet` 返回 `avail_tokens` |
| 用量 | `list_agent_token_stats` 返回逐日记录 |
| 供应商 | `list_custom_llm_provider` 返回 ≥1 家 |

实测（2026-11-12）：上述全部通过，额度 1000 万 tokens。

边界：**首次登录需客户端**（OAuth 走 native bridge）；模型对话未对外暴露可复用端点，
故本渠道不承载对话（`buildChatBody` 显式抛错）。

## 18. 模型对话协议（`agent.run`，2026-11-12 实测打通）

### 18.1 为什么容易漏掉

`agent.run` **不在 gateway 的 action 白名单里**（白名单只列 33 个 action），
所以从 `Unknown action` 的报错信息里看不出来。它挂在前端
`__WS_CONNECTION__` 的 `runAgent()` 上，用同一套 WebSocket 但独立的 `event` 名。

### 18.2 请求

```js
// 1. 先建会话
await call("conversations.create", {});
// → { conversation_id: "conv_...", status: "created" }

// 2. 发消息
await call("agent.run", {
  conversation_id,          // 上一步的 id
  message,                  // 用户文本
  response_id,              // 自定义 id，用于关联事件流
  attachments: [],          // 附件（可为空）
  mcp_manage_tools_enabled: true,
  // model_config 留空 = 用默认「省心组合」；
  // 指定时传 { config_id: "default" } 或 { config_id: "custom:<id>" }
});
// → { ok: true, conversation_id, response_id }
```

`agent.run` 的 ack 只表示**已受理**，正文靠后续事件推送。

### 18.3 响应：AG-UI 事件流

同一连接持续推 `ag_ui_event`：

| type | 含义 |
| --- | --- |
| `TEXT_MESSAGE_START` | 助手消息开始 |
| `TEXT_MESSAGE_CONTENT` | **正文增量**（`delta` 字段） |
| `TEXT_MESSAGE_END` | 消息结束 |
| `CUSTOM`（name=`message_complete`） | 完整消息 + token 用量 |
| `RUN_FINISHED` | 本轮终止（唯一成功终态） |

配套事件：`conversations.status_changed`（`in_progress` → `completed`）、
`gateway.agent_stats_changed`、`gateway.tick`。

正文取 `data.delta`；token 用量在 `CUSTOM.value.rawEvent.token_usage`
（`input_tokens` / `output_tokens` / `cached_tokens`）。

### 18.4 实测

```
buildChatBody → 槽位登记（本渠道无 HTTP 体）
prepareChat   → 1908ms（真跑 agent.run + 收齐 AG-UI 事件）
newTranslator → 4 帧
回复           → "收到。"

token 用量：input 26234 / output 2 / cached 24704
```

### 18.5 渠道实现要点

因为对话走 **WebSocket 事件流**而非 HTTP 响应体，共享层的 `chatUrl` 拿不到内容：

1. `chatUrl` 返回一个幂等只读的 REST 占位（`marvis_check_login`）。
2. `buildChatBody`（同步）只登记槽位。
3. `prepareChat`（异步）真跑 `conversations.create` + `agent.run`，
   收齐 `TEXT_MESSAGE_CONTENT.delta` 与 `RUN_FINISHED`，攒成 OpenAI SSE 帧。
4. `newTranslator` 从槽位把帧吐出去。

与 todayai 同一手法（占位端点 + `prepareChat` 内部完成 + 槽位取帧）。
