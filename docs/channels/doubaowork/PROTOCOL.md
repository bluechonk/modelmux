# 豆包工作（DoubaoWork）上游协议

豆包工作网页/客户端（`www.doubao.com`）的登录、模型目录、对话与额度协议。
证据等级：**实测**（2026-11-12，本机 Windows 11、Chrome 147、账号已登录）为主，
反代项目源码对照为辅（见文末「参考实现」）。

## 1. 域名与身份

| 用途 | 域 |
| --- | --- |
| 对话、模型目录、额度 | `https://www.doubao.com` |
| 登录、账号信息、登录态心跳 | `https://accounts.doubao.com` |

两个域**不能混用**：把 `passport/*` 打到 `www` 或把 `alice/*` 打到 `accounts` 都是 404。

`aid`（应用 id）也分两套：

- 登录域 `aid=497858`（`real_aid=497858`）。
- 对话域 `aid=1044603`（`real_aid=1044603`）。

## 2. 登录：手机号 + 短信验证码

登录页 `https://www.doubao.com/login/`。表单提交到 **`accounts.doubao.com`**：

```
POST https://accounts.doubao.com/passport/web/send_code/
POST https://accounts.doubao.com/passport/web/sms_login/
```

两个请求都带一大组查询参数（`passport_jssdk_version`、`is_from_ttaccountsdk`、
`account_sdk_source`、`account_sdk_source_info`、`sign`、`qs`、`msToken`、
**`a_bogus`** 等）。其中 `a_bogus` 由页面里的 `webmssdk` 生成，`account_sdk_source_info`
是打包过的设备指纹。

结论：**纯 HTTP 复现不可行**。渠道实现走真实浏览器（Playwright）完成表单，
让字节自己的 JS 生成签名，再回收 Cookie。同目录 `cred.ts` 的 `runBrowserLogin`
就是这条路径。

登录成功的判据是 Cookie 里出现 `sessionid`（或 `sessionid_ss`）。

## 3. 登录态与续期

```
GET https://accounts.doubao.com/passport/token/beat/web/?...
```

返回 `{"data":{"error_code":0,...}}` 表示仍有效。**上游没有续期接口** ——
Cookie 到期只能重新登录。`cred.probeSession` 只做有效性探测，
`cred.refresh` 在失效时抛 `NotLoggedInError`，绝不伪造「刷新成功」。

## 4. 设备号（关键风控条件）

对话请求必须带：

```
device_id=<14 位数字>
fp=verify_<同一个 device_id>
```

缺失时 `/chat/completion` 回 HTTP 200 + SSE 错误帧：

```
event: STREAM_ERROR
data: {"error_code":710022004,"error_msg":"rate limited",
       "extra":{"decision":"{...\"from\":\"shark_admin\",\"subtype\":\"slide\"...}"}}
```

这是**人机验证（滑块）**，不是真的限流。实测：同一 Cookie、同一出口，
只补上 `device_id` 就从被拦变为正常回答（2026-11-12 复现两次）。

设备号只在客户端配置文件里：

```
%LOCALAPPDATA%\DoubaoWork\User Data\Local State   →  aha.device.device_id
```

Cookie 与协议都不下发它。`cred.readDeviceId` 读这个文件；读不到时登录会给出警告
（对话大概率被拦），但不会阻断登录。

## 5. 模型目录

```
POST https://www.doubao.com/alice/user/launch
  → data.assistant_bot_id（实测 7338286299411103781）

POST https://www.doubao.com/alice/slot/action_bar_v3/brief_list
  body: {"language_code":"zh","bot_id":"<assistant_bot_id>"}
```

`brief_list` 的 `data.entry_list[].active_switch_conf.menu_conf.item_list[]` 是模型项，
每项字段：

| 字段 | 含义 |
| --- | --- |
| `model_item_key` | 上游模型 id，发对话用（如 `person-deepseek-v4-1-flash-261017`） |
| `name` | 展示名 |
| `default_mode` / `mode_id` | 模式 id（`3` = 工作任务） |
| `agent_mode` | 任务模式（实测全部为 `1`） |
| `menu_type` / `item_id` | 思考档位基值 |
| `model_extra_params` | 原样回传给上游的 JSON |

`pc_version` 缺了会返回**空菜单**（实测）。渠道固定发 `2.33.5`。

## 6. 对话

```
POST https://www.doubao.com/chat/completion?<查询串>
```

查询串必须含 `device_id` + `fp`（见 §4），另有 `aid=1044603`、`samantha_web=1`、
`web_platform=desktop`、`client_platform=pc_client`、`runtime=web`、
`runtime_version=3.42.2`、`pc_version`、`use-olympus-account=1` 等。

请求体关键字段：

```jsonc
{
  "client_meta": { "local_conversation_id": "local_<16 位数字>", "bot_id": "<bot>", ... },
  "messages": [{ "local_message_id": "<uuid>", "content_block": [ /* block_type 10000 文本块 */ ] }],
  "option": {
    "need_create_conversation": true,
    "need_deep_think": 0,
    "agent_mode": 1,
    "model_config": { "model_item_key": "<model>", "model_extra_params": {} },
    "aggregate_params": { "mode_id": "3", "model_item_key": "<model>", "agent_mode": "1" },
    "general_task_param": { /* agent_mode 1/2 时需要 */ }
  },
  "ext": { "use_deep_think": "0", "agent_mode": "1", "is_finish": "1" }
}
```

### 响应事件（`text/event-stream`）

| event | 内容 |
| --- | --- |
| `SSE_HEARTBEAT` | 心跳，忽略 |
| `SSE_ACK` | 建会话回执，含 `conversation_id` |
| `FULL_MSG_NOTIFY` | 完整消息（`user_type == 2` 是助手） |
| `STREAM_MSG_NOTIFY` | 消息块更新（`content.content_block`） |
| `CHUNK_DELTA` | 增量文本（`text` 字段） |
| `STREAM_CHUNK` | 补丁式更新（`patch_op[].patch_value.content_block`） |
| `STREAM_TIMEOUT_CONTROL` | 上游控制帧，忽略 |
| `SSE_REPLY_END` | 本轮结束 |
| `STREAM_ERROR` | 错误（见 §4 的风控码） |

正文统一在 `content_block[].content.text_block.text` 里。渠道的翻译器把上述事件
转成 OpenAI `chat.completion.chunk`。

## 7. 额度

```
POST https://www.doubao.com/alice/commerce/sale/subscription/overview/
  body: {"product_line":"membership"}

POST https://www.doubao.com/alice/commerce/sale/subscription/entry/config/
  body: {}
```

`overview` 的额度分两块：

1. **窗口限额**：`data.window_limit_section.window_limit_groups[].window_limits[]`，
   `window_type` 1 = 5 小时、2 = 近 7 天、4 = 其他周期。
   企业账号看 `enterprise_window_limit_section`。
2. **活动赠送**：`data.incentive_quota_entitlements[]`，字段是
   `total_amount` / `used_amount` / `total_used_percent` / `end_time`。
   **不在** `quota_package_section` 里（该字段实测为 `null`）。

`entry/config` 给套餐展示名（`profile` / `membership_display_name`）。

豆包工作**没有签到端点** —— 活动额度由上游按活动规则自动发放，
渠道的 `billing.signin` 如实回报「无签到」，不伪装成领取成功。

## 8. 账号信息

```
GET https://www.doubao.com/passport/account/info/v2/?aid=497858&device_platform=web&...
```

给 `user_id` / `user_id_str` / `name` / `avatar_url` 等。登录域 `aid=497858` 同样可用。

## 9. 测试

### 怎么测这个渠道

#### 登录

```sh
mx doubaowork login
```

浏览器打开后填手机号，验证码由界面/终端输入。成功后 Cookie 落到
`~/.modelmux/channels/doubaowork/credentials.json`（0600）。

若未装客户端（没有 `Local State`），登录会给出设备号警告；此时对话大概率被
人机验证拦下 —— 先装一次豆包工作客户端并登录，或把设备号写进
`~/.modelmux/channels/doubaowork/device.json` 的 `deviceId` 字段。

#### 各接口单测

```sh
mx doubaowork status          # 登录态 + 设备号 + 模型数
mx doubaowork models          # 模型目录（--refresh 强制重拉）
mx doubaowork bill            # 额度（窗口限额 + 活动赠送）
mx doubaowork chat "你好"     # 对话
```

### 端到端测试覆盖

渠道不写单测（见根 `AGENTS.md` 的「测试」节），验证走端到端：

| 覆盖项 | 判据 |
| --- | --- |
| 手机号 + 验证码登录 | 登录后 `credentials.json` 里有 `sessionid` |
| 登录态探测 | `passport/token/beat/web/` 返回 `error_code: 0` |
| 设备号生效 | 带 `device_id` 时 `/chat/completion` 不返回 `710022004` |
| 模型目录 | `brief_list` 解析出 ≥1 个模型，`bot_id` 非空 |
| 对话 | SSE 里出现 `CHUNK_DELTA` 或 `STREAM_MSG_NOTIFY`，翻译层产出 `content` |
| 额度 | `overview` 解析出窗口限额或活动赠送明细 |

实测（2026-11-12）：登录、探测、目录（10 个模型）、对话（回复「收到」）、
额度（3391/3900 积分）全部通过。

## 10. 参考实现

| 项目 | 用途 | 与本文的关系 |
| --- | --- | --- |
| `ProvidersPlugin/Agent2Providers` | Rust 反代，`doubaowork` provider | 设备号风控结论、模型目录解析、额度字段名 |
| `Fullstop000/doubao-cli` | Headless CLI | 查询串参数集、`account/info/v2` 校验 |
| `lianjiexu08-ui/doubao_reg` | Dola（国际版）逆向 | 短信登录端点族（`send_code` / `mobile_code_login`） |

三个项目都用 **Cookie 复用**，本文的登录路径（真实浏览器 + 手机号）由本仓库实现。
