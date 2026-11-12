---
name: doubaowork-reverse
description: 豆包工作（DoubaoWork，www.doubao.com）的纯 HTTP 接入方法。用户要接入豆包、实现手机号验证码登录、排查豆包「非法请求 / 缺少参数 / 3052」类错误、或需要逆向另一个字节系客户端（参数被混淆、需要抓真实请求）时使用。也用于解释「为什么参数看着对却一直报错」——通常是请求体被 XOR 混淆了。
---

# 豆包工作纯 HTTP 接入

目标：**零浏览器、零客户端**。给手机号 + 验证码，自己拿到 cookie，之后全部请求走 HTTP。

端点与字段的现行事实见
[docs/channels/doubaowork/PROTOCOL.md](../../../docs/channels/doubaowork/PROTOCOL.md)。

## 0. 最重要的一条：请求体被 XOR 混淆

**这是踩坑最深的地方。** 参数名对、值也对，但服务端一直报 `1204 验证码请求错误` 或 `3052`，因为**值是加密过的**。

抓包看到的真实 body：

```
mix_mode=1
&mobile=2e3d3325343634313335333c313434    ← 不是手机号，是密文
&type=3731                                ← 不是 24，是密文
&is6Digits=1
&fixed_mix_mode=1
```

解密规则极简单：**逐字符 XOR 0x05，再转 hex**。

```js
const enc = (s) => Buffer.from([...s].map((c) => c.charCodeAt(0) ^ 5)).toString("hex");
const dec = (hex) =>
  Buffer.from(hex, "hex").toString("latin1").split("").map((c) =>
    String.fromCharCode(c.charCodeAt(0) ^ 5)).join("");

enc("+8613146069411") // → 2e3d3325343634313335333c313434
dec("2e3d3325343634313335333c313434") // → +8613146069411
enc("24")             // → 3731
```

判据：**凡是 hex 形态、长度是原文两倍的参数，先试 XOR 0x05**。

手机号必须带国家码（`+86`）。裸 11 位会被判「手机号错误」（`1003`）。

## 1. 哪些「看起来很必要」的东西其实不需要

我一开始照网页版请求抄了一整套查询参数，全部带上反而失败。实测**不需要**：

- `a_bogus`
- `account_sdk_source_info`（1898 字节的加密设备指纹）
- `sign` / `qs` / `msToken`
- `fp` / `verifyFp`

**发码只需要**：`mobile`（加密）+ `type`（加密）+ `mix_mode=1` + `is6Digits=1` + `fixed_mix_mode=1`，外加基础查询串（`aid` / `language` / `device_platform` / `account_sdk_source`）。

判据：先用最小参数集打通，再按报错逐个加，不要一开始就抄全套。

## 2. 发码流程

```sh
POST https://accounts.doubao.com/passport/web/send_code/?<基础查询串>
Content-Type: application/x-www-form-urlencoded
Origin: https://www.doubao.com
Referer: https://www.doubao.com/

body:
  mix_mode=1
  &mobile=<enc("+86" + 手机号)>
  &type=<enc("24")>
  &is6Digits=1
  &fixed_mix_mode=1
```

成功返回：

```json
{"data":{"mobile":"131******11","mobile_ticket":"mobile_ticket_...","retry_time":60},"message":"success"}
```

`retry_time: 60` 是重发冷却。

**前置**：先 `GET https://www.doubao.com/` 拿匿名 cookie（`ttwid` 等），否则可能被判异常。

## 3. 校验验证码（`sms_login`）

```
POST https://accounts.doubao.com/passport/web/sms_login/?<与发码相同的 query>
Content-Type: application/x-www-form-urlencoded
Cookie: <发码阶段同一个 cookie jar>      ← 必须同会话

mix_mode=1
&mobile=<enc("+86" + 手机号)>            ← 加密
&code=<enc(验证码)>                       ← 加密
&login_only=false                        ← 缺这个必 3052
&fixed_mix_mode=1                        ← 缺这个必 3052
```

**两个参数缺一不可**，这是我卡最久的坑：`login_only=false` 与 `fixed_mix_mode=1`。
少了它们，参数加密全对也只会得到无描述的 `3052`。

另两个陷阱：

- **必须同会话**：发码与校验用同一个 cookie jar，否则 `mobile_ticket` 对不上，报 `1203 验证码过期`。
- **手机号格式两处相反**：`send_code` 要 `+86` 前缀，`sms_login` 的 `mobile` 字段虽然也是 `+86` 编码后的密文，
  但裸 11 位明文试探会得到 `1003 手机号错误` —— 那是格式判据，不是手机号真错。

成功响应 `message:"success"`，登录会话通过 **`Set-Cookie`** 下发
（`sessionid` / `sessionid_ss` / `sid_guard` / `sid_tt` / `uid_tt` / `passport_auth_status` 等）。
**登录态是 cookie，不是响应体 token。**

## 3.1 CSRF（部分接口需要）

```sh
GET https://accounts.doubao.com/passport/safe/csrf_token/?<查询串>
→ {"data":{"passport_csrf_token":"..."}}
   Set-Cookie: passport_csrf_token=...; passport_csrf_token_default=...
```

请求时带 `x-tt-passport-csrf-token: <值>`。

## 4. 抓真实请求的方法（本技能的核心手段）

不要靠猜参数。**用 mitmproxy 抓一遍真实登录**，然后照抄。

```sh
mitmdump -s sniff.py -p 8899
# 浏览器带代理
agent-browser --proxy "http://127.0.0.1:8899" --args "--ignore-certificate-errors" open "https://www.doubao.com/login/"
```

`sniff.py` 只要一个 `response` 钩子，按 URL 关键字过滤，把 method / url / headers / body 落 JSONL。

抓完**第一件事是看 body 是不是 hex**。豆包的发码接口就是，不看这一点会一直以为是签名问题。

## 5. 排查清单

| 现象 | 先查 |
| --- | --- |
| `1204 验证码请求错误` | body 参数**没加密**（忘了 XOR 0x05），或手机号没带 `+86` |
| `1003 手机号错误` | 手机号格式不对（裸 11 位 / 多余字符） |
| `3052`（无描述） | `type` 场景码不对，或参数加密方式不对 |
| `16 该应用无权限` | `aid` 用错（网页 `497858`，桌面 `1044603`） |
| `7 访问太频繁` | 触发限流，等冷却 |
| `2035 非法请求` | 缺 `x-tt-passport-csrf-token` 头，或 UA 不对 |
| 参数看着都对但一直失败 | **先怀疑 XOR 混淆** |

## 6. 资源解包：URL 从哪来

**先破除一个误解**：没有 `.assr` 文件。精确搜 `(?<![A-Za-z0-9])assr(?![A-Za-z0-9])`、`.assr`、`app.asar`
在安装目录里都不命中；`DoubaoWork.dll` 里出现的 `assR` 只是 `ClassRegExp`、`PassRequest` 之类子串。

真实来源是四条：

| 来源 | 说明 |
| --- | --- |
| Chromium DataPack v5 | `resources.pak` / `biz.pak` / `doubao_office.pak`，按资源表逐条读，压缩条目试 Brotli |
| 本地 Web 资源 | `local_webcontents/apps`、`biz`、`extensions/ai-views` 下的 js/json/html |
| 原生二进制内嵌串 | `DoubaoWork.dll`、`liblark.dll`，扫可打印 ASCII 与 UTF-16LE |
| 运行时包 | `task-mode-resource/runtime-bundle/packages/*.tar.zst`，用 Node 内置 zstd 解后遍历 tar |

还要做一步**模板拼接还原**：JS 里常见「常量基址 + 模板变量」拼路径，字面量里看不到完整端点。
把基址常量找出来，与 `${}` 变量拼一遍，才能补出真正在用的 URL。

规模参考（2.36.11 实测）：扫 3828 个文件、DataPack 24679 条有效资源、去重 URL 9702 条、
其中业务相关 1626 条、可信 API 路径 4021 条。

判据：**URL 数量大不代表都要用**。先按主机分组（`www.doubao.com` / `accounts.doubao.com` /
`api-normal.doubao.com` / `feishu.*`），再按业务动词筛，最后用 mitmproxy 抓真实流量确认哪些真的被调用。

## 7. 登录后各接口

| 用途 | 端点 |
| --- | --- |
| 账号信息 / 登录态探测 | `GET https://accounts.doubao.com/passport/account/info/v2/` |
| 模型菜单 | `POST https://www.doubao.com/alice/slot/action_bar_v3/brief_list` |
| 对话 | `POST https://www.doubao.com/chat/completion` |
| 额度摘要 | `POST /alice/commerce/sale/subscription/quota/summary/` |
| 会话安全心跳 | `POST /passport/doubao/security_token_beat/` |
| Token 心跳 | `GET /passport/token/beat/web/` |

**没有 refresh 端点**。`refresh()` 的做法是调账号信息端点验证 cookie：有效则保留，失效抛未登录。

模型菜单在 `data.menu_conf_v2.mode_list.item_list[]`（注意是 `menu_conf_v2`，不是 `active_switch_conf`）。
工作任务模式 `mode_id=3` + `agent_mode=1`；对话模式 `mode_id=1` + `agent_mode=2`。

对话正文在 `content_block[].content.text_block.text`；思考容器 `block_type=10040`。
`SSE_REPLY_END` 是唯一成功终态，`FULL_MSG_NOTIFY` 只是用户消息回执，**不能当回答**。

## 8. 与桌面客户端的关系

桌面版（CEF + `sscronet.dll`）有独立端点族（`/passport/user/biz_auth/`、DPoP），但那套只用于 **token 续期**。

**日常请求（对话 / 模型 / 额度 / 账号）只需要 cookie**，不需要任何签名。所以：

- 登录：用本文的手机号方案（纯 HTTP）
- 日常：cookie 直接打
- 续期：37 天一次，届时重新登录即可

判据：**「登录」和「日常运行」分开评估**。前者可能要签名，后者通常只要 cookie。

## 9. 可复用脚本

落在仓库 `.tmp/probe-doubao/`（已忽略，保留复用）：

| 脚本 | 用途 |
| --- | --- |
| `pure-login.mjs` | 纯 HTTP 发码 + 验证（XOR 0x05） |
| `mitm/sniff.py` | mitmproxy 抓包钩子 |
| `final-test.mjs` | cookie 拿到后验证模型 / 额度 / 对话 |

## 10. 设备号（对话必需）

对话请求必须带：

```
device_id=<14 位数字>
fp=verify_<同一个 id>
```

缺了会收到 HTTP 200 + SSE 错误帧 `error_code: 710022004` + `shark_admin`（人机验证滑块）。

来源：客户端 `Local State` 的 `aha.device.device_id`。同一账号同一出口，只补这一项就从被拦变正常。

## 11. 实测闭环（2026-11-12）

零浏览器、零客户端，全程纯 HTTP：

```
1. GET  /chat/                           → 匿名 cookie（ttwid 等）
2. POST /passport/web/send_code/         → mobile_ticket
3. POST /passport/web/sms_login/         → 23 条 cookie，sessionid 到手
4. POST /alice/user/launch               → bot_id 7338286299411103781
5. POST /alice/slot/action_bar_v3/...    → 10 个模型
6. POST /alice/commerce/.../overview/    → 额度 3391/3900
7. POST /chat/completion                 → SSE 返回「收到」
```

期间踩过并已定位的坑，按耗时排序：

1. **参数没 XOR 加密** —— 报 `1204`，最容易误判成签名问题
2. **`sms_login` 缺 `login_only=false` + `fixed_mix_mode=1`** —— 报无描述的 `3052`
3. **发码与校验跨会话** —— 报 `1203 验证码过期`
4. **`send_code` 手机号要 `+86`、`sms_login` 试裸 11 位会报 `1003`** —— 是格式判据不是真错
5. 误以为要 `a_bogus` / `account_sdk_source_info` —— 实际都不需要

判据总结：**看 body 是不是 hex → 是不是同会话 → 关键布尔参数齐不齐**。这三步能在几分钟内定位绝大多数失败。
