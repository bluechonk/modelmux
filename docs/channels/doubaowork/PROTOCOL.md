# 豆包工作（DoubaoWork）协议规格

> 上游：豆包网页端 / 豆包工作账号（`www.doubao.com` + `accounts.doubao.com`）。
> 本文件是协议事实与证据等级的唯一落点；共享层规则见根 `AGENTS.md` 与 `docs/CONTRACT-TS.md`。
> 桌面端资源结构与 URL 解包结论见 [FINDINGS.md](./FINDINGS.md)。

## 0. 结论速查

| 环节 | 结论 | 证据等级 |
| --- | --- | --- |
| 登录 | 手机号 + 短信验证码，真实两跳 | [实测 2026-11-12] |
| 发码 | `POST https://accounts.doubao.com/passport/web/send_code/` | [实测] |
| 校验 | `POST https://accounts.doubao.com/passport/web/sms_login/` | [实测] |
| 表单编码 | 字段值按 UTF-8 字节异或 `0x05` 后转 hex | [实测] |
| 会话 | passport cookie jar（`sessionid` / `sid_guard` 等），非 Bearer token | [实测] |
| 账号信息 | `GET https://accounts.doubao.com/passport/account/info/v2/` | [实测] |
| 模型菜单 | `POST https://www.doubao.com/alice/slot/action_bar_v3/brief_list` | [实测] |
| 对话 | `POST https://www.doubao.com/chat/completion`，豆包事件流 | [实测] |
| 额度 | `POST /alice/commerce/sale/subscription/quota/summary/` | [实测] |
| 登录态刷新 | 无 refresh 端点，调账号信息端点做有效性探测 | [实测] |
| 客户端凭证 | 不读取豆包桌面客户端 cookie / DPAPI / assr | [实测] |

## 1. 登录链路

### 1.1 发码

```
POST https://accounts.doubao.com/passport/web/send_code/?aid=497858&language=zh&account_app_language=zh-CN&account_sdk_source=web&multi_login=1&device_platform=web&os_type=1&terminal_type=2&ts=<unix秒>
Cookie: <页面预热得到的匿名 cookie>
Content-Type: application/x-www-form-urlencoded

mix_mode=1&mobile=<编码手机号>&type=<编码的 "24">&is6Digits=1&fixed_mix_mode=1
```

- **字段值被 XOR 混淆**（踩坑最深的一条）：`mobile` 与 `type` 传的是**密文** —— 按 UTF-8 字节
  逐位异或 `0x05` 再转小写 hex：

  ```js
  const enc = (s) => {
    let out = "";
    for (const b of Buffer.from(s, "utf8")) out += (b ^ 0x05).toString(16).padStart(2, "0");
    return out;
  };
  const dec = (hex) =>
    Buffer.from(hex, "hex").toString("latin1").split("").map((c) =>
      String.fromCharCode(c.charCodeAt(0) ^ 5)).join("");

  enc("+86 13800138000") // → 2e3d332534363d353534363d353535
  enc("24")              // → 3731
  ```

  判据：**凡是 hex 形态、长度是原文两倍的参数，先试 XOR 0x05**。参数名对、值也对但服务端报
  `1204` / `3052` 时，先怀疑这一条。[实测]
- **手机号形态是 `+86 ` + 11 位**（中间有一个空格，抓包原文即如此）：渠道按这个形态编码。[实测]
- `type` 的明文是 `24`（网页端手机号登录）。
- **最小参数集**：只需 `mobile`（加密）+ `type`（加密）+ `mix_mode=1` + `is6Digits=1` +
  `fixed_mix_mode=1`，外加基础查询串（`aid` / `language` / `device_platform` / `account_sdk_source`）。
  实测**不需要** `a_bogus` / `account_sdk_source_info`（1898 字节加密设备指纹）/
  `sign` / `qs` / `msToken` / `fp` / `verifyFp`。[实测]
  - 判据：先用最小参数集打通，再按报错逐个加，不要一开始就抄全套。
- 页面预热 `GET https://www.doubao.com/chat/` 会下发匿名 cookie；全新匿名会话**不需要**
  `sign` / `a_bogus` / `msToken` 也能发码（实测成功）。
- 成功响应：`{"data":{"mobile_ticket":"...","retry_time":60},"message":"success"}`。

### 1.2 校验

```
POST https://accounts.doubao.com/passport/web/sms_login/?<与发码相同的 query>
Cookie: <发码阶段的 cookie jar>
Content-Type: application/x-www-form-urlencoded

mix_mode=1&mobile=<编码手机号>&code=<编码验证码>&login_only=false&fixed_mix_mode=1
```

- **两个参数缺一不可**：`login_only=false` 与 `fixed_mix_mode=1`；少了它们，参数加密全对
  也只会得到无描述的 `3052`。[实测]
- **必须同会话**：发码与校验用同一个 cookie jar，否则 `mobile_ticket` 对不上，报
  `1203 验证码过期`。[实测]
- **手机号格式两处相反**：`send_code` 要 `+86` 前缀；`sms_login` 的 `mobile` 字段是 `+86`
  编码后的密文，但拿裸 11 位明文试探会得到 `1003 手机号错误` —— 那是格式判据，不是手机号真错。[实测]
- 成功响应 `message:"success"`，同时通过 `Set-Cookie` 下发登录会话：
  `sessionid` / `sessionid_ss` / `sid_guard` / `sid_tt` / `uid_tt` / `passport_auth_status` 等。
  **登录态是 cookie，不是响应体 token。**

### 1.3 CSRF（部分接口需要）

```
GET https://accounts.doubao.com/passport/safe/csrf_token/?<查询串>
→ {"data":{"passport_csrf_token":"..."}}
   Set-Cookie: passport_csrf_token=...; passport_csrf_token_default=...
```

请求时带 `x-tt-passport-csrf-token: <值>`。

## 2. 凭据落盘与刷新

- 落点：`~/.modelmux/channels/doubaowork/credentials.json`（`0600`）。
- 字段：`cookieJar`（完整 passport cookie）、`accessToken`（`sessionid` 镜像，满足共享层契约）、
  `uid`、`nickname`、`phone`、`expiresAt`、`obtainedAt`、`source`。
- 未完成登录的中间态：`~/.modelmux/channels/doubaowork/state/login-pending.json`，保存发码 cookie 与 `mobile_ticket`。
- **无 refresh 端点**：`refresh()` 调账号信息端点验证 cookie；有效则保留，失效抛 `NotLoggedInError`。

## 3. 账号信息

```
GET https://accounts.doubao.com/passport/account/info/v2/?pc_version=3.45.3&version_code=20800&language=zh&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&use-olympus-account=1&region=CN&sys_region=CN&account_sdk_source=web&sdk_version=2.2.10&doubao_from=inject_html
Cookie: <cookie jar>
```

- 成功：`message:"success"`，`data.user_id_str` / `data.name` / `data.mobile`。
- 401/403 或非 success 视为会话失效。

## 4. 模型菜单

```
POST https://www.doubao.com/alice/slot/action_bar_v3/brief_list?<公共 query>
Cookie: <cookie jar>
Content-Type: application/json

{"language_code":"zh","bot_id":"7338286299411103781","conversation_id":"local_<随机>"}
```

- 公共 query：`aid=497858`、`real_aid=497858`、`device_platform=web`、`doubao_device_platform=web`、
  `pc_version=3.45.3`、`version_code=20800`、`region=CN`、`sys_region=CN`、
  `use-olympus-account=1`、`web_platform=browser` 等。
- 菜单在 `data.menu_conf_v2.mode_list.item_list[]`：
  - 对话模式 `mode_id=1`：`快速(0)` / `专家(3)`。
  - 工作任务模式 `mode_id=3`：`自动(9)`、`2.1 Lite(seed-lite-7b)`、`2.1 Pro(5)`、
    `person-deepseek-v4-1-flash-261017`、`person-glm-5-3-flash-261111` 等。
- 上游没有独立 `/models` 端点；渠道目录以菜单快照为准。

## 5. 对话

```
POST https://www.doubao.com/chat/completion?<公共 query + web_tab_id>
Cookie: <cookie jar>
Content-Type: application/json
Accept: text/event-stream
Agw-Js-Conv: str
x-flow-trace: <uuid>-<uuid>-01
last-event-id: undefined

{ "client_meta": {...}, "messages": [...], "option": {...}, "user_context": [], "ext": {...} }
```

- 每条请求新建 `local_conversation_id` 与 `unique_key`；多轮上下文由渠道把完整消息列表扁平化为一条 user 文本送入。
- **必须带客户端设备号**（`device_id`，网页端本地存储里那个 32 位随机 hex）：缺了会被下人机验证。[实测 2026-11-12：同一账号同一出口，只补这一项就从被拦变正常。]
- 模型选择在两处同时写：`option.model_config.model_item_key` 与
  `option.aggregate_params.model_item_key`；模式写 `mode_id` 与 `agent_mode`。
- 工作任务模型（`person-*`、`5`、`9`、`seed-lite-7b`）：`mode_id="3"`、`agent_mode=1`；
  对话模式：`mode_id="1"`、`agent_mode=2`。

### 5.1 响应事件

| 事件 | 语义 |
| --- | --- |
| `SSE_HEARTBEAT` | 心跳 |
| `SSE_ACK` | 建会话回执（含真实 `conversation_id`） |
| `FULL_MSG_NOTIFY` | 用户消息回执，**不能当回答** |
| `STREAM_MSG_NOTIFY` | 回答首段 + 后续内容块 |
| `STREAM_CHUNK` | 增量 patch |
| `CHUNK_DELTA` | 纯文本增量 |
| `STREAM_ERROR` | 业务错误帧 |
| `SSE_REPLY_END` | 正常终止（唯一成功终态） |

- 正文在 `content_block[].content.text_block.text`；思考容器是 `block_type=10040`，其子块为 `reasoning_content`。
- 渠道翻译器把首段与增量转成 OpenAI SSE，`SSE_REPLY_END` 后发 `finish_reason:"stop"` 与 `[DONE]`。
- `STREAM_ERROR` 必须转成错误帧；`710022004` 是语义风控 / 限流，不是 cookie 失效。

## 6. 额度

```
POST https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/?<公共 query>
Cookie: <cookie jar>
Content-Type: application/json

{"product_line":"membership"}
```

- 返回 `data.window_limit_section` / `data.incentive_quota_section` / `data.enterprise_window_limit_section`。
- 窗口字段：`window_type`（1=5 小时，2=周，3=活动赠送）、`used_percent`、`used_amount`、`total_amount`、`start_time`、`end_time`。
- 实测账号：活动赠送额度 `3900`，已用 `509`，剩余 `3391`。

## 7. 环境变量（运维面）

| 变量 | 用途 |
| --- | --- |
| `DOUBAOWORK_PHONE` | CLI 无界面登录的手机号 |
| `DOUBAOWORK_SMS_CODE` | 验证码（与手机号同批给出时直接完成校验） |
| `DOUBAOWORK_DEBUG_DUMP` | 调试转储开关 |

## 8. 使用与实测

### 怎么测这个渠道

```bash
mx login doubaowork
mx status doubaowork
mx model doubaowork
mx bill doubaowork
```

单渠道直连：

```bash
node packages/core/channels/doubaowork/dist/cli.js login
```

### 怎么抓真实请求（逆向用）

不要靠猜参数 —— 用 mitmproxy 抓一遍真实登录再照抄。

```sh
mitmdump -s sniff.py -p 8899
# 浏览器带代理
agent-browser --proxy "http://127.0.0.1:8899" --args "--ignore-certificate-errors" open "https://www.doubao.com/login/"
```

`sniff.py` 只要一个 `response` 钩子，按 URL 关键字过滤，把 method / url / headers / body
落 JSONL。抓完**第一件事是看 body 是不是 hex** —— 豆包的发码接口就是，不看这一点会一直
以为是签名问题。

### 排查清单

| 现象 | 先查 |
| --- | --- |
| `1204 验证码请求错误` | body 参数**没加密**（忘了 XOR 0x05），或手机号没带 `+86` |
| `1003 手机号错误` | 手机号格式不对（裸 11 位 / 多余字符） |
| `3052`（无描述） | `type` 场景码不对，或参数加密方式不对 |
| `16 该应用无权限` | `aid` 用错（网页 `497858`） |
| `1203 验证码过期` | 发码与校验**跨会话**了（cookie jar 不是同一个） |
| `400 / 500` | 缺基础查询串（`aid` / `language` / `device_platform` / `account_sdk_source`） |
| 登录成功但接口 401 | 漏带 `passport_auth_status` / `sid_guard`（passport 30 天会话核心 cookie） |
| 对话被人机验证拦 | 缺设备号（见 §5） |

判据总结：**看 body 是不是 hex → 是不是同会话 → 关键布尔参数齐不齐**。

### 端到端测试覆盖

- 手机号发码 → 验证码校验 → cookie 落盘。
- 账号信息探测（登录状态与 `refresh`）。
- 模型菜单（`brief_list`）与家族模型映射。
- 额度摘要（活动赠送额度）。
- 真实对话：`/chat/completion` 返回事件流，翻译器输出 OpenAI SSE 并以 `[DONE]` 收尾。

### 2026-11-12 端到端实测

- 手机号 `131****9411` 完成真实短信登录，账号 `bluechonk` / uid `1001000343446896`。
- 纯 HTTP 携带 cookie 调账号信息成功。
- 额度：活动赠送额度 `3391 / 3900`。
- 对话：`person-deepseek-v4-1-flash-261017` 返回 `OK`，OpenAI 帧正常收尾。
- 已知边界：网页端模型名与桌面端不完全一致；工作任务模式若需要本地工具执行，网关只转发文本，不模拟客户端工具运行时。

零浏览器、零客户端的纯 HTTP 闭环（同一批实测）：

```
1. GET  /chat/                           → 匿名 cookie（ttwid 等）
2. POST /passport/web/send_code/         → mobile_ticket
3. POST /passport/web/sms_login/         → 23 条 cookie，sessionid 到手
4. POST /alice/user/launch               → bot_id 7338286299411103781
5. POST /alice/slot/action_bar_v3/...    → 10 个模型
6. POST /alice/commerce/.../overview/    → 额度 3391/3900
7. POST /chat/completion                 → SSE 返回「收到」
```

## 9. 参考实现

| 仓库 | 学到了什么 | 许可证 |
| --- | --- | --- |
| `Wahwayhale/dsh-connect-doubao` | `/chat/completion` 请求体、豆包事件流字段、额度端点、模型菜单结构 | 见 [REFERENCES.md](../../REFERENCES.md) |

> 该参考项目用 CDP 复用桌面客户端 cookie；本渠道不复用客户端凭证，登录改为真实手机号短信链路。
