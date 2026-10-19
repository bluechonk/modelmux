# Loomy 协议规格（讯飞）

提取自 `dsh-our-free-model/vendor/channel-pack/src/loomy*.ts`。

---

## 1. 端点与确切 URL

业务基址 `https://loomyad.xunfei.cn`（API 前缀 `/api/v1`），账号基址 `https://account.xfinfr.com`。

### 1.1 业务域（模型网关）

| 用途 | 方法 | 完整 URL | 端点路径 | query / body | 认证 |
|---|---|---|---|---|---|
| 对话 | POST | `https://loomyad.xunfei.cn/api/v1/chat/completions` | `/api/v1/chat/completions` | **无 query**；`model` / `messages` / `stream` 全在 body（`stream` 恒 `true`） | `Authorization: Bearer <session>` + `token: <session>` |
| 模型列表 | GET | `https://loomyad.xunfei.cn/api/v1/models` | `/api/v1/models` | **无 query** | `token: <session>` |
| 积分明细（只读） | GET | `https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all` | `/api/v1/points/records` | `pageNo` / `pageSize` **必须 camelCase**（上游只认 camelCase，snake_case 被静默忽略，`[参考]`）；`recordType` 与参考实现的 `record_type` 命名分歧 → **待真机确认** | `token` |
| 每日额度初始化（写） | POST | `https://loomyad.xunfei.cn/api/v1/points/first-login` | `/api/v1/points/first-login` | body 固定 `{}` —— **无 body 参数**；参考实现可带 `inviteCode` + `deviceId`（成对出现），本渠道未启用 | `token` |
| 新手任务列表 | GET | `https://loomyad.xunfei.cn/api/v1/onboarding/tasks` | `/api/v1/onboarding/tasks` | **无 query** | `token` |
| 完成单个任务 | POST | `https://loomyad.xunfei.cn/api/v1/onboarding/tasks/complete` | `/api/v1/onboarding/tasks/complete` | body `{key}`（**只有 key**） | `token` |

### 1.2 账号域（登录，全部 HMAC-SHA1 签名）

| 用途 | 方法 | 完整 URL | 端点路径 | param | 认证 |
|---|---|---|---|---|---|
| 微信授权码换 rcode | POST | `https://account.xfinfr.com/login/thirdAccount/bind/auth` | `/login/thirdAccount/bind/auth` | `{ "tcode": { "code": "<微信code>" }, "type": "wx" }` | HMAC-SHA1 |
| 微信绑定发短信 | POST | `https://account.xfinfr.com/login/thirdAccount/bind/sendMsg` | `/login/thirdAccount/bind/sendMsg` | `{ "rcode", "phone", "ccode": "86", "expire": 300 }` | HMAC-SHA1 |
| 微信绑定校验（拿 session） | POST | `https://account.xfinfr.com/login/thirdAccount/bind/checkCode` | `/login/thirdAccount/bind/checkCode` | `{ "rcode", "mcode", "msgid", "expire": 1209600 }` | HMAC-SHA1 |
| 微信已绑定直接登录 | POST | `https://account.xfinfr.com/login/thirdAccount/bind/skip` | `/login/thirdAccount/bind/skip` | `{ "rcode", "expire": 1209600 }` | HMAC-SHA1 |

> 参考实现另有**手机号独立登录**端点（`/login/phone/sendMsgCode`、`/login/phone/checkCode`）
> 与**密码登录**端点（`/login/account/getPuKey`、`/login/account/byPwd`）—— 本渠道**不使用**，
> 原因见 §2.1 与 §9。

**没有 refresh 端点**（loomy.ts:195-205）：`session` 是登录时声明 14 天得来的，
过期只能**重新走登录流程（微信扫码）**。故 `isLoomyRefreshable` **恒返回 false** —— 诚实标记，不是遗漏。

超时：业务请求 60s，模型目录 30s（对应 `LOOMY_REQUEST_TIMEOUT_MS = 60_000`）。

### 业务成功/错误码（loomy.ts:36-42）

```
LOOMY_OK_CODE         = '000000'   业务成功
LOOMY_AUTH_ERROR_CODE = '100002'   登录失效 —— 收到它不得重试
LOOMY_BAD_REQUEST_CODE= '100001'   参数错误（如未知 task key）
```

**Loomy 的业务失败恒返回 HTTP 200**，成败只能读 body 的 `code`。
只看状态码会把「登录已失效」误判成成功。

响应信封：`{ code, desc | message, data }`（`desc` 优先于 `message`）。

---

## 2. 认证

### 2.1 唯一登录路径

**微信扫码是本渠道唯一的登录路径**（`mx login loomy`）。手机号 + 验证码**不是**登录入口，
只是「微信未绑手机号」时的**绑定子步骤**。

| 环节 | 端点 | 输入来源 | 状态 |
|---|---|---|---|
| 扫码取 code | `open.weixin.qq.com` 授权页 + 长轮询 | 纯 HTTP（uuid → 二维码图片 → 长轮询），详见 §2.6 | `[实测]` 已跑通 |
| code → rcode | `POST /login/thirdAccount/bind/auth` | 微信 code（**只用一次**） | `[实测]` 已跑通 |
| rcode → session（已绑手机号，`bind=1`） | `POST /login/thirdAccount/bind/skip` | rcode | `[实测]` 已跑通 |
| rcode → session（未绑手机号，`bind=0`） | `POST /login/thirdAccount/bind/sendMsg` + `/bind/checkCode` | **`LOOMY_PHONE` + `LOOMY_SMS_CODE` 环境变量** | ⚠ **未验证**（全仓无该分支的实测记录；请求形态已与参考实现逐字段核对一致，见下） |

**`bind=0` 分支的参考实现核对（2026-10-20，结论：形态一致，但仍标「未验证」）**：

`reference/xingluoyuankong_loomy2api/loomy2api/account.py:501-550` 与
`reference/xingluoyuankong_loomy2api/docs/CLIENT-LOGIN.md:96-99` 逐字给出四个端点与
字段，本仓库实现（`packages/core/channels/loomy/src/cred.ts:607-661`）**逐字段一致**：

| 端点 | 参考实现的 param | 本仓库实现 | 一致 |
|---|---|---|---|
| `/login/thirdAccount/bind/auth` | `{tcode:{code}, type:"wx"}` | 同 | ✅ |
| `/login/thirdAccount/bind/sendMsg` | `{rcode, phone, ccode:"86", expire:300}` | 同 | ✅ |
| `/login/thirdAccount/bind/checkCode` | `{rcode, mcode, msgid, expire:1209600}` | 同 | ✅ |
| `/login/thirdAccount/bind/skip` | `{rcode, expire:1209600}` | 同 | ✅ |

差异只有两处，且都不影响请求形状：参考实现的 `bind/auth` 在配置了
`wechat_authconf` 时多带一个 `authconf` 字段（本渠道没有该配置，不发）；
参考实现返回体另有 `isnew` / `headpic`（本渠道不用）。

⚠ **「未验证」标注保留**：形态一致 ≠ 能跑通 —— 该分支**全仓仍无任何实测记录**，
`bind=0` 时的短信能否真收到、验证码是否被上游接受，都还是未知数。

**判据（为什么只保留微信扫码）**：

1. 只有微信扫码**实测跑通**（2026-10-17 真机扫码；2026-10-19 端到端 `loomy/spark-x` 冒烟 + 工具往返）。
2. 官方客户端**对外只有一个授权页**（微信扫码）；密码与短信登录都是**客户端内部 API 调用**，
   没有任何外部页面（`[参考]`）。
3. 手机号在参考实现里是**两义**的：既能独立登录（`/login/phone/*`），又是微信绑定的子步骤
   （`/login/thirdAccount/bind/*`）。本渠道只取后者 ——
   **不要把绑定子步骤当成第二条登录路径**。
4. 密码路不采纳：需要用户在讯飞账号中心先设过密码（参考实现自己注明**没有设 / 改密端点**），
   且要长期保存明文密码。

**`LOOMY_PHONE` / `LOOMY_SMS_CODE` 的定位**：**只服务于 `bind=0` 绑定分支**，不是独立登录入口。

### 2.2 必需请求头清单

#### 2.2.1 chat 端点（`POST /api/v1/chat/completions`）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
|---|---|---|---|---|
| `Authorization` | `Bearer <session>` | **是**（chat 只认它） | session 过期后重新登录（**无 refresh 端点**） | `Bearer ` 前缀**必需**，实测无前缀回 `100002 缺少 token` |
| `token` | `<session>` | **是**（业务端点只认它；chat 两个都发） | 同上 | 官方客户端在 session 模式下也是两个都发 |
| `Accept` | 常量 `text/event-stream` | 否 | — | `[参考]` 实现发的是 `application/json` → **待真机确认** |
| `Content-Type` | 常量 `application/json` | 否 | — | — |
| `traceparent` | `00-<32 hex>-<16 hex>-01`，**每请求新生成** | 否（链路追踪） | 每请求 | `[参考]` 标注为**必需**（缺失会挂死到超时）；本仓 2026-10-19 端到端**未发也跑通** → **待真机 A/B 复核** |
| `loomy-version` | 常量（官方客户端版本号） | 否（网关只检查它存在） | — | `[参考]` 同上，**待真机 A/B 复核** |
| `X-Loomy-Request-Purpose` | — | 否（服务端积分归属记账） | — | **本轮不做**：17 个取值的语义需先对照参考实现枚举（§9） |
| `ChatId` / `MsgId` / `TurnId` | — | 否（会话关联） | — | **本轮不做**（§9） |

#### 2.2.2 账号端点（HMAC-SHA1 签名）

| 头名 | 值来源 | 是否鉴权 | 刷新时机 | 备注 |
|---|---|---|---|---|
| `Authorization` | `account {akId}:{sig}` | **是** | 每请求 | 前缀是 `account`，**不是** `Bearer` |
| `Date` | UTC 字符串 | **是（参与签名）** | 每请求 | 必须与签名串里的是**同一个字符串** |
| `Nonce` | uuid4 | **是（参与签名）** | 每请求 | 同上 |
| `Content-Type` | `application/json` | **是（参与签名）** | — | — |
| `Content-MD5` | `base64(md5(body 的 utf8 字节))` | **是（参与签名）** | 每请求 | **body 为空则不发该头**，且签名串该段为空串 |

**两套认证头（本渠道最容易踩的坑）**：

- 业务端点（`/models`、`/points/*`、`/onboarding/*`）只发 `Accept: application/json` + `token`；
- chat 端点两个都发（`Authorization: Bearer` + `token`）。

`/chat/completions` 只认 `Authorization: Bearer`，而 `/models`、`/points/*`、
`/onboarding/*` 只认 `token`。实测交叉验证：带错的那个 → HTTP 200 + `{"code":"100002","desc":"缺少 token"}`。

`Bearer ` 前缀**必需**：实测无前缀同样回 `100002 缺少 token`。
chat 端点两个都发是因为官方客户端在 session 模式下也是两个都发。
业务端点**不发** `traceparent` / `loomy-version`（本仓 2026-10-19 实测目录刷新正常）。

### 2.3 凭据字段（loomy.ts:54-70）

| 字段 | 必需 | 说明 |
|---|---|---|
| `access_token` | 是 | 讯飞 `session`，**32 位小写 hex** |
| `userid` | 是 | 讯飞用户 id，**18 位数字串** |
| `phone` | 是 | 绑定的手机号（11 位） |
| `nickname` | 否 | Loomy 无昵称接口，缺省时 UI 回退到账号 id |
| `expires_at` | 否 | **毫秒时间戳字符串**，由登录时刻 + 14 天**本地推算** |

`access_token` 字段名**必须**是这个。

### 2.4 账户请求信封（`buildLoomyAccountBody`）

```json
{
  "base": {
    "appid": "GM3LOOMY",
    "modelid": "Web",
    "version": "1.0.0",
    "devid": "web",
    "ua": "Loomy|Desktop|Electron|macOS",
    "traceid": "<32 位 hex = uuid4 去连字符>"
  },
  "param": { ... }
}
```

`ua` 硬编码 `Loomy|Desktop|Electron|macOS`，**客户端在 Windows 上发的也是这个值，照抄不要改**。
`traceid` 每次调用重新生成。

`LOOMY_SESSION_TTL_SECONDS = 1_209_600`（14 天）：服务端只声明有效期，响应不带到期时间戳，
凭据的 `expires_at` 由本地按此推算。

### 2.5 登录流程：微信扫码（四步强制绑手机号）

```
1. bindAuthThirdAccount(code) → { bind, rcode, isnew, nickname, headpic }
    - bind=1 已绑手机号 → 直接 bindSkip 拿 session
    - bind=0 未绑       → 弹绑定 UI，走 bindSendMsg + bindCheckCode
2. bindSendMsg({ rcode, phone })          → { msgid }
3. bindCheckCode({ rcode, mcode, msgid }) → session + userid + phone
4. bindSkip({ rcode })                    → session + userid
```

微信 code **只在第 1 步用一次**；后续三步只用 `rcode`。

| 步骤 | URL | param |
|---|---|---|
| 1 | `/login/thirdAccount/bind/auth` | `{ "tcode": { "code": "<微信code>" }, "type": "wx" }` |
| 2 | `/login/thirdAccount/bind/sendMsg` | `{ "rcode", "phone", "ccode": "86", "expire": 300 }` |
| 3 | `/login/thirdAccount/bind/checkCode` | `{ "rcode", "mcode", "msgid", "expire": 1209600 }` |
| 4 | `/login/thirdAccount/bind/skip` | `{ "rcode", "expire": 1209600 }` |

`bind` 缺失时**归为 0**（走绑定流程）：保守方向。
`rcode` 缺失必须明确报错。

⚠ 第 2/3 步（`bind=0` 绑定分支）**尚未验证**：全仓没有该分支的实测记录，
它只是**微信链路的子步骤**，不是独立登录入口（§2.1）。

### 2.6 微信扫码的完整链路（纯 HTTP 路线）

**为什么不能用官方的 Electron 做法**：官方客户端用 `BrowserWindow` 的 `will-redirect`
事件在**导航发生前**截获微信回调里的 `code`，`event.preventDefault()` 后关窗
—— **从不真的加载回调页**。那个回调页实测 **404**。

**本实现走「纯 HTTP」路线**（2026-09-26 实测打通）：

```
1. GET https://open.weixin.qq.com/connect/qrconnect
    ?appid=wx18d60be432287cf8
    &redirect_uri=<URL编码的 https://loomy.xunfei.cn/oauth/wechat/callback>
    &response_type=code&scope=snsapi_login&state=<32位随机串>
    #wechat_redirect
  → HTML 里**内嵌 uuid**（正则直接提取，无需执行 JS）
2. GET https://open.weixin.qq.com/connect/qrcode/<uuid>
  → 二维码图片（实测 **JPEG**，约 47KB，可转 data URL 渲染）
3. GET https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>[&last=<prev>]&_=<毫秒时间戳>
  → 长轮询状态机
```

**关键常量**：
- `LOOMY_WECHAT_APP_ID = 'wx18d60be432287cf8'`
- `LOOMY_WECHAT_REDIRECT_URI = 'https://loomy.xunfei.cn/oauth/wechat/callback'`
- `LOOMY_WECHAT_POLL_TIMEOUT_MS = 40_000`

**redirect_uri 必须用官方地址**：实测换成 `http://127.0.0.1:<port>/callback` 或任意域名，
微信直接返回 **872 字节**的「redirect_uri 参数错误」页；用官方地址才返回 **42KB** 的正常授权页。
微信校验域名白名单，故**不能**用本地回调服务器收 code。

#### 2.6.1 授权页与二维码是**两个不同的会话**（2026-10-20 实测，最易踩的坑）

**授权页每次加载都重新生成 uuid** —— 同一个 `state` 连开两次，得到两个不同 uuid：

```
state = b2ed69d326c74802b024021530f8
load#1 {"status":200,"len":42888,"uuid":"091LPsaL1Z1Pkl2W"}
load#2 {"status":200,"len":42888,"uuid":"011p4kpw1256ll2R"}
same uuid across loads? DIFFERENT
```

长轮询认的是 **uuid**，不是 state。故：

- 正确：把**本进程这次加载**抽出的 uuid 渲染成二维码（`/connect/qrcode/<uuid>`）给用户扫
  → 微信确认的正是这个 uuid → 长轮询收到 405 → 自动收尾。
- 错误：把**授权页 URL**（`/connect/qrconnect?...`）丢给用户让他「打开去扫」
  → 浏览器那次加载生成的是**另一个 uuid** → 用户在手机上确认了，本进程的长轮询**永远等不到**，
  表现为「手机上确认了但流程一直卡住」。

**qrcode 图片端点不校验 Referer**（实测带/不带都是 `200 image/jpeg` 约 46KB），
故 CLI 可以直接把该图片 URL 打给用户，让他打开图片用微信扫。

**兜底路径（长轮询拿不到时）**：用户自己开授权页扫码 → 微信 302 到
`https://loomy.xunfei.cn/oauth/wechat/callback?code=…&state=…`（线上 404 页，正常）
→ 把地址栏整条链接粘回 CLI（CLI 收 stdin 一行；Web 端收 `pasteCallback` 命令）。

**粘贴兜底在代码里的落点**（与 `codearts` / `lobsterai` 同一形态）：

| 位置 | 职责 |
|---|---|
| 共享层 `packages/core/gateway/src/auth/auth-flow.ts:67` | 把 `ui.takePastedCallback` 包成 `pasteCode()` 传给渠道 |
| 渠道 `LoginOptions.pasteCode`（`packages/core/channels/loomy/src/cred.ts` 的 `WechatWaitOptions`） | **声明**该回调（`wechatObtainCode` 每轮轮询取一次） |
| `wechatObtainCode` → `parseWechatCallback` | 解析粘回的内容（整条 URL / 只有 query / 裸 code 三种形态），转成微信 code 继续 `bind/auth` |

即：**用户即使浏览器回调打不到本机**（远程 / 无头 / 容器），把地址栏那条链接粘回终端
也能把登录走完 —— 走的是**同一条** `bind/auth` 链路，不是第二条登录路径。

**uuid 提取**（两条路径互为兜底，无需执行 JS）：
- 主路径：`<img class="js_qrcode_img" src="/connect/qrcode/<uuid>"/>`
  → 正则 `/connect/qrcode/([A-Za-z0-9_\-=+/]+)`
- 兜底：`var fordevtool = "…/connect/l/qrconnect?uuid=<uuid>"`
  → 正则 `l/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)`
- 字符集校验：`^[A-Za-z0-9_\-=+/]{6,64}$`

**长轮询状态机**（ 语义以微信授权页内嵌 JS 为准 —— `switch(window.wx_errcode)`）：

| errcode | 含义 | 本实现返回 |
|---|---|---|
| 408 | 待扫码（常态） | `waiting` |
| 404 | **已扫码待确认**（继续轮询） | `scanned` |
| 405 | **已确认**，`wx_code` 就在这一帧 | `confirmed` |
| 403 | 用户取消 | `cancelled` |
| 402 | 二维码失效 | `expired` |
| 其它/未知 | 保守归 `waiting`（绝不误判成功） | `waiting` |

**404 / 405 的语义（极易读反）**：404 = 已扫码待确认（继续轮询）；405 = **已确认**，
`wx_code` 就在这一帧。读反的后果：实现按 404 分支去等一个「带 code 的 404」，
**永远等不到** → 流程卡在「已扫码」，凭据落盘永不执行 → 账号池里的凭据始终为空。

**响应体解析**（正则，非 JSON）：
```
errcode = /wx_errcode\s*=\s*(\d+)/
code    = /wx_code\s*=\s*'([^']*)'/
```

**405 但 `wx_code` 为空时不判成功**：保守判 `scanned`（继续轮询）。
网络异常返回 `error` 状态而**不抛错**。

**请求头**：`User-Agent` 用桌面 Chrome UA，`Referer: https://open.weixin.qq.com/`。

**二维码图片**：实测 **JPEG**（不是 PNG）—— 故 PNG / JPEG / GIF 三种都认，
且字节数 < 200 视为错误页。

**本地弹窗页**：
```
GET  /wechat/qr        → 弹窗页：内联二维码 + 前端轮询 + 绑定手机号表单
GET  /wechat/poll      → 前端轮询：长轮询微信，返回状态
POST /wechat/complete  → 提交微信 code（或手机号+验证码）完成登录
```
- 绑 `127.0.0.1` 随机端口
- 整个扫码 + 绑定超时 `5 * 60 * 1000`
- `/wechat/complete` 的 `action` 取值：`send_sms` / `verify_sms`
- 单步失败**不终止**整个流程
- 前端轮询间隔 1200 ms

### 2.7  签名算法（`loomy-sign.ts`）—— 逐字节复刻客户端

**Python 标准库完全可以实现**（`hashlib` / `hmac` / `base64` / `uuid` / `email.utils`，无需第三方）。

#### 签名字符串（9 段，`\n` 连接）

```
{METHOD}\n{ESCAPED_PATH}\n{ESCAPED_QUERY}\n{Content-MD5}\n
{Content-Type}\n{Date}\n{Nonce}\n{SignedHeaders}\n{CanonicalizedHeaders}
```

**后两段在本项目恒为空串**，故最终字符串**以两个换行结尾**。
这是 `join('\n')` 在 9 个元素上的自然结果，**不要「顺手」去掉尾随换行**。

#### 各段构造规则

1. **`{METHOD}`**：大写（`POST`）
2. **`Content-MD5`**：`base64(md5(body_utf8_bytes))`
   **空 body 返回空串**（而不是空串的 md5）
3. **`ESCAPED_PATH`**：
   - 补前导 `/`；若长度 > 1 且以 `/` 结尾则剥掉末尾 `/`
   - 按 `/` 切段，**逐段**做 RFC3986 转义，再拼回
   - 空段保留为空（不丢弃）
4. **RFC3986 转义**：`encodeURIComponent` + 补转 `! ' ( ) *`
   - Python 等价：`urllib.parse.quote(seg, safe='')` —— **完全一致**
5. **`ESCAPED_QUERY_STRING`**：
   - `key=value` 用 `&` 连接，**不排序**（保持传入顺序）
   - key 与 value **都**转义
   - `null` / `undefined` 值转成空串
   - 无 query 时为空串
6. **`Content-Type`**：`application/json`（默认值）
7. **`Date`**：**UTC 字符串**
   - Python：`email.utils.formatdate(usegmt=True)` → `Wed, 08 Oct 2026 12:34:56 GMT`
8. **`Nonce`**：**UUID** —— 带连字符的 `str(uuid.uuid4())`
9. **`SignedHeaders` / `CanonicalizedHeaders`**：本项目**恒 `''`**
   - ⚠ 这只在「账号端点**不发任何 `x-*` 自定义头**」时成立。
     参考实现是**通用**的：收集全部 `x-` 前缀头 → 小写排序 → `SignedHeaders` 用 `;` 连接，
     `CanonicalizedHeaders` 拼成 `k:v\n` 行并去掉尾部换行。
     **将来给账号端点加 `x-*` 头时，必须同步实现 canonical 化，否则签名失配。**

#### 签名与请求头

```python
signature = base64.b64encode(
   hmac.new(secret.encode('utf-8'), string_to_sign.encode('utf-8'), hashlib.sha1).digest()
).decode('ascii')
```

请求头：
```
Authorization: account {accessKeyId}:{signature}     ← 前缀是 account，不是 Bearer
Date: <与签名时同一个 UTC 字符串>
Nonce: <与签名时同一个 UUID>
Content-Type: application/json
Content-MD5: <base64 md5>                            ← 仅当 body 非空时才带
```

**认证头前缀是 `account`**（`account {ak}:{sig}`），**不是** `Bearer`。

**body 必须先序列化一次，签名与发送共用该字符串**：二次序列化会改变字节
（键序、空格），签名随即失效。Python 对应做法：
```python
body_str = json.dumps(body, separators=(',',':'))
# 签名用 body_str；发送时直接传 body_str.encode()，不要让 requests 重新序列化 dict
```

#### 密钥来源（loomy-product.ts:123-127）

```
accessKeyId     = <讯飞 AccessKey id>
accessKeySecret = <讯飞 AccessKey secret>
appId           = 'GM3LOOMY'
```

取值见 `src/cred.ts`（随客户端分发 + AES 混淆的公开常量），本文件不复制取值。

**AccessKey 的定位**：它只用于**讯飞账号**端点的 HMAC-SHA1 签名（登录链路）。
业务与推理端点用的是用户登录后的 `session`，与 AccessKey 无关。
故 AccessKey 泄露不涉及任何用户数据（官方也只是「随客户端分发 + AES 混淆」）。

---

## 3. 对话请求

### 3.1 请求体

```json
{
  "model": "<模型 id，如 spark-x>",
  "messages": [ ... ],
  "stream": true,
  "max_tokens": <number>,
  "temperature": <number>,
  "stop": [ ... ],
  "reasoning_effort": "<档位>",
  "tools": [ { "type": "function", "function": { "name", "description", "parameters" } } ]
}
```

- `system` 提示词拼为 `messages[0]` 的 `{role:'system', content}`
  （ 必须**先拼再放进对象**，不要依赖「后面的键覆盖前面」的隐式行为）
- 所有可选字段用**条件展开**（`undefined` 时不发该键），不是发 `null`

### 3.2 必需请求头

```
Accept: text/event-stream
Content-Type: application/json
Authorization: Bearer <session>
token: <session>
```

完整清单（含 `traceparent` / `loomy-version` 与账号端点表）见 **§2.2**。

### 3.3 特殊约束

**① `reasoning_effort` 必须校验档位在该模型的 `efforts` 内**

-  **不能靠 HTTP 状态码判断该字段是否生效**：实测传 `reasoning_effort` /
   `reasoningEffort` / `thinking` 三种名字**都返回 200** —— 服务端对未知字段静默忽略
- 校验不过时**静默不下发**（退回服务端默认档）
- DSH 会把用户选的档位直接透传，给一个远端不认的值比不给更糟

**② 思考档位表来自远端**（`GET /models` 下发 `reasoning_efforts` +
`default_reasoning_effort` + `reasoning_catalog_version`）

-  档位缺失时**不写这两个键**（而不是写空数组）
- 档位 id → 中文展示名映射（**必须与官方 IDE 一致**；Loomy 基于 **opencode** 构建）：
  `none→关闭思考`、`minimal→最小`、`low→低`、`medium→中`、`high→高`、`xhigh→极高`、`max→最大`
-  **默认档位用本插件自己的 `high`，不采信远端的 `default_reasoning_effort`（它声明的是 `low`）**
-  默认档必须落在该模型的 `efforts` 内

**③ 图片输入**

- 能力来自远端 `capabilities.input_modalities` 含 `image`
-  **过滤判据是 `type === 'chat'`，不能看 `input_modalities`**
- 兜底表不声明图片能力（宁可少报）

---

## 4. 流式响应（标准 OpenAI 兼容）

（2026-09-26 实测）：`data:` 帧 + 空 `data:` 终止帧，
思考在 **`delta.reasoning_content`**，**无加密、无信封、无格式转换**。

**业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回**。

空闲超时：首 token / chunk 间隔各 120_000 ms。

---

## 5. 模型目录

### 5.1 拉取

```
GET https://loomyad.xunfei.cn/api/v1/models
Accept: application/json
token: <session>
```

**必须用 `token` 头**（业务端点），不是 Bearer —— 带错会得到 `100002 缺少 token`，
表现为「模型列表永远停在兜底表」。超时 30_000 ms。

### 5.2 响应字段名

| 远端字段 | 用途 |
|---|---|
| `id` | 模型 id |
| `name` | 展示名（三种括号风格混用，需规范化） |
| `type` | 过滤判据，只保留 `'chat'` |
| `context_length` | 上下文窗口 |
| `capabilities.reasoning` | 是否支持思考（`=== true`） |
| `capabilities.input_modalities` | 小写化后判含 `image` |
| `reasoning_efforts` | 档位数组（去重、丢弃非法项） |
| `default_reasoning_effort` | 远端声明的默认档位 |
| `reasoning_catalog_version` | catalog 版本哈希 |

### 5.3 倍率在 `name` 字符串里

**没有独立字段**（实测搜 `credit`/`multiplier`/`price`/`factor`/`rate` 全部 0 命中），
且三种括号风格混用，必须规范化。实测三种：

```
MiniMax M3 （x4.0）        ← 全角括号 + 空格
Qwen 3.8 Max (x12.0)      ← 半角括号
GLM 5.3 Flash(x0.8)       ← 括号紧贴
```

`splitLoomyRate` 认**两种**形态：
1. 末尾括号：`^(.*?)\s*[（(]\s*(x\s*[\d.]+)\s*[)）]\s*$`（忽略大小写）
2. 已规范化：`^(.*?)\s*·\s*(x\s*[\d.]+)\s*$`（忽略大小写）

只认**末尾**的倍率（中间的括号属于模型名本身）。
本函数**幂等**（单测锁死）。 主体为空（畸形数据）时原样保留。
最终展示名：`{name} · {rate}`（无倍率时不追加分隔符）。
倍率必须拼进 `name`（**不是** `description`）。

### 5.4 兜底静态模型表（8 条，loomy-product.ts:104-113）

来源：2026-09-26 实测 `GET /api/v1/models`，取 `type === 'chat'` 的 8 条。

| id | name | contextWindow |
|---|---|---|
| `deepseek-v4-flash-0731` | DeepSeek V4 Flash 0731 · x3.0 | 1_048_576 |
| `MiniMax-M3` | MiniMax M3 · x4.0 | 1_048_576 |
| `Kimi-k2.6` | Kimi k2.6 · x6.5 | 262_144 |
| `qwen-3.8-max` | Qwen 3.8 Max · x12.0 | 1_000_000 |
| `GLM-5.3-Flash` | GLM 5.3 Flash · x0.8 | 1_048_576 |
| `qwen3.8-flash` | qwen 3.8 flash · x0.8 | 1_000_000 |
| `spark-x` | Spark X2.5 · x0.1 | 1_048_576 |
| `mimo-v2.5` | MiMo V2.5 · x3.3 | 1_048_576 |

全部 8 条的 `efforts` 都是 `['none','low','medium','high','xhigh']`，兜底 `defaultEffort = 'high'`。

`spark-x` 是**已知分歧**：远端声明 1048576，而 Loomy 客户端用本地表
`MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144。
本表**先采信远端**；若实测长上下文被拒，改为 262144。

⚠ 上表的**倍率**是 2026-09-26 的快照：`spark-x` 当时是 `x0.1`，而 2026-10-19 的实测
远端已改成**倍率 0（免费）**（见「2026-10-19 端到端实测」）。倍率以**远端为准**，
本表只作离线兜底。

### 5.5 缓存策略（loomy-adapter.ts:264-286）

原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成「已加载」记下，
于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩兜底模型。
改为：**只缓存真实远端目录**，兜底表每次现算，并用冷却闸门挡住「每模型重试一次」的放大。

---

## 6. 额度查询

### 6.1 两个积分池（loomy-credits.ts:4-15）

- **永久积分**：注册奖励 5000 + 新手任务 10000（`balance`）
- **每日赠送池**：每天 5000，**消耗后不回补**（`dailyBalance`）

实测（2026-09-26）：
```
balance: 15000            ← 永久
dailyBalance: 4992        ← 每日池余额 = dailyQuota(5000) - dailyConsumed(8)
availableBalance: 19992   ← 两者之和
```

### 6.2 查余额（**只读**）

```
GET https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all
Accept: application/json
token: <session>
→ data: { balance, dailyBalance, availableBalance, dailyQuota?, dailyConsumed?, dailyCycleDate? }
```

**用 `points/records` 而不是 `first-login`**：后者是**写**端点，
在「打开面板」这种高频路径上调用会意外触发签到。

`balance` 是核心字段：没有它就说明响应形状不对，不编造数字，返回 `null`。
`total` 用 `availableBalance`，缺失则 `permanent + daily`。

### 6.3 一键签到（写，幂等）

```
POST https://loomyad.xunfei.cn/api/v1/points/first-login
Accept: application/json
token: <session>
Content-Type: application/json
body: {}
→ data: { alreadyProcessed, currentBalance, permanentBalance, dailyBalance,
         dailyQuota, dailyConsumed, dailyCycleDate, ... }
```

**`dailyQuota` 只在 `first-login` 的响应里**，`points/records` 不返回它。
故未签到时该字段缺省 —— **不要硬编码 5000**。

**幂等判据是响应体的 `alreadyProcessed`**，故已处理映射成 `already-claimed`
而**不是** `claimed`。

语义是「触发每日额度重置」，**不是「+5000 积分」**：
`dailyBalance = dailyQuota - dailyConsumed`，消耗后不回补。

本函数**不抛错**（失败也返回 `failed`）。

### 6.4 新手任务（loomy-onboarding.ts）

```
GET  /api/v1/onboarding/tasks            → { tasks: {8个key: bool}, earned, total }
POST /api/v1/onboarding/tasks/complete   body { key } → { alreadyCompleted, balance }
```

上报 body **只有 `key`** —— 无设备指纹、无版本号、无渠道号。

**服务端不校验前置行为（决定性实测）**：2026-09-26 用本机账号对 8 个任务逐个发
`POST /complete`，全部返回 `{"code":"000000","data":{"alreadyCompleted":false,"balance":N}}`，
余额 0 → 10000，**没有真的发对话、没有真的生成 PPT、没有真的装技能**。
完成条件全部在**客户端本地判定**，服务端只做「幂等置位 + 加分」。
故本实现是**纯 API 直领**，一个模型 token 都不花。

**不采信服务端 `earned`**，按本地表现算。

**任务 key → 积分**（顺序即执行顺序）：

| key | 积分 | 标题 |
|---|---|---|
| `first_message` | 500 | 发送你的第一条消息 |
| `pick_skill` | 1000 | 试试选择一个技能 |
| `generate_ppt` | 1500 | 生成第一份 PPT |
| `set_schedule` | 1000 | 设置定时任务 |
| `install_skill` | 1500 | 在技能广场安装一个技能 |
| `configure_remote` | 1000 | 配置远程控制 |
| `create_soul` | 1500 | 创建你的第一个搭子 |
| `share_soul` | 2000 | 把搭子分享给朋友 |

合计 10000。领取**串行**逐个完成；已完成的**跳过不发请求**；
任一任务收到 `100002` 时**立即抛出**，不再对后续任务发请求。

---

## 7. 特殊机制

- **`refresh()` 语义与其余 provider 根本不同**：Loomy 没有任何 refresh 端点，
  故 `refresh()` / `refreshAccountCredential()` 只做**有效性探测**（调一次轻量只读端点），
  失效时抛 `RefreshTokenExpiredError` 让 UI 显示「凭证过期，请重新登录」，**不假装续期成功**
- **探测端点选 `GET /points/records?pageNo=1&pageSize=1&recordType=all`**：
  它是最便宜的只读端点（不消耗积分、不产生任何副作用）；
  `pageNo` / `pageSize` **必须 camelCase**（上游只认 camelCase）
- **刻意不使用 `RefreshScheduler`**：那个调度器的存在意义是「在凭据过期前提前触发续期」。
  Loomy 无法续期，武装它只会得到「1 小时后触发 → 探测 → 必然抛错 → 调度器停止」这一串无意义动作
- **`refreshAll` 只探测已过期的账号**，但仍做一次有效期对账
  —— 账号池的 `expiresAt` 是 UI 唯一的显示依据，若不更正，明明有效的账号会一直挂着红字「已过期」
- **登录后立即调 `POST /points/first-login`**（唯一登录路登录后即调，失败仅 warn）
  失败**不影响登录**
- 账号端点的鉴权错误码与业务端点不同（实测 `020002` 也是登录态问题），
  对本模块而言都是「这次调用失败」，直接透传 `desc` 即可

## 8. 模型窗口规格

上游目录**不下发**最大输出（[实测]）—— 网关 `/v1/models` 只能给兜底值 4096，
客户端按 4096 截断会把每次回答砍到 4k。本渠道按**公开规格**补齐：

| 模型 | 最大输出 |
|---|---|
| `deepseek-v4.1-flash` / `deepseek-v4-flash` | 393216 |
| `minimax-m3` / `qwen-3.8-max` / `qwen3.8-flash` / `glm-5.3-flash` / `mimo-v2.5` | 131072 |
| `kimi-k2.6` | 32768（官方只给 `max_tokens` 默认值级证据） |
| `spark-x`（讯飞星火 X2.5） | 262144（官方写 `< 256K`） |

⚠ **已知分歧**：`spark-x` 的**上下文**上游声明 1048576，而讯飞官方规格是 262144 ——
**以上游为准**（这条渠道实际能吃多少以它自己为准），分歧记在
[MODEL-SPECS.md](../../MODEL-SPECS.md) §6。

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源），渠道表在
`src/catalog.ts` 的 `MAX_OUTPUTS`。

---

## 9. 已知边界（本轮明确不做）

参考实现有、但本渠道**明确不做**的能力（各自原因）：

| 能力 | 原因 |
|---|---|
| 密码登录（`/login/account/getPuKey` + `byPwd`，可无人值守重登） | 要长期保存明文密码；参考实现自己注明**没有设 / 改密端点**（用户得先在讯飞账号中心设密码） |
| 手机号独立登录（`/login/phone/sendMsgCode` + `checkCode`） | 手机号在本渠道只作**绑定子步骤**；官方客户端对外也只有微信一个授权页（§2.1） |
| 导入桌面客户端已登录 session（`auth-session.json`） | 依赖本机客户端安装目录与本地文件，越出「本渠道自持凭据」的边界 |
| 浏览器自动化扫码（驱动 Chromium 拿 code） | 需要本机浏览器；本仓走「二维码图片 + 用户粘回调链接」的纯 HTTP 路线，已实测跑通 |
| `/embeddings`、`/images/generations`、`/search/tencent` | 上游有，但本渠道定位是 **OpenAI 兼容对话网关**；我们是否可用、返回形状均未验证 |
| 多账号加权调度（按额度加权 / 会话粘性 / 在途租约 / 模型级冷却） | 共享层目前只有简单轮换 + 连续失败 3 次标 error；本轮不扩共享层 |
| 思考开关 `enable_thinking` / `chat_template_kwargs.enable_thinking` | 当前用 `reasoning_effort` 表达档位；上游对未知字段静默忽略，语义需真机确认 |
| 积分兑换码（`/points/redemption-codes/redeem`）/ 邀请码绑定（`/points/activation`） | 属运营玩法；且需 campus 设备号 `deviceId`（promotions 侧） |
| 积分流水翻页 + 每模型实际单价统计 | 当前额度只取第一页余额字段；翻页聚合是面板级需求 |
| `X-Loomy-Request-Purpose` 归属头（17 取值） | 取值语义需先对照参考实现的完整枚举（影响服务端积分归属记账） |
| `ChatId` / `MsgId` / `TurnId` 会话关联头 | 需先确认网关是否要求成对下发 |
| `pet-work` 平台每日任务（`/api/v1/pet-work`） | 与 `onboarding/tasks` 并存的另一套任务体系，未验证 |
| Anthropic 兼容端点（`/v1/messages`） | 网关只做 OpenAI 兼容 |

**待真机复核清单**（改动 `traceparent` / `loomy-version` 后由统一验证流程执行）：

- `traceparent` / `loomy-version` 是否真为必需（`[参考]` 说缺失会挂死到超时，本仓未发也跑通）→ A/B 对照；
- `Accept: text/event-stream`（本仓）vs `application/json`（参考）是否影响上游行为；
- `points/records` 的 `recordType`（本仓）vs `record_type`（参考）命名分歧；
- `bind=0` 绑定分支（发码 → 校验 → 落盘）端到端；
- session 自然过期后的真实表现（业务码 `100002` 还是 HTTP 401/403）。

---

## 使用与实测

### 登录方式

**微信扫码一条路**（`mx login loomy`），本渠道**唯一**的登录路径 —— 详见 §2.1。
**未绑手机号**时的绑定环节需要 `LOOMY_PHONE` / `LOOMY_SMS_CODE` 环境变量
（这两个变量**只服务于绑定分支**，不是独立登录入口；该分支**尚未验证**）。
扫码链路（纯 HTTP 路线、二维码 uuid 提取、长轮询状态机）见 §2.6。

### 已知限制

- **池内账号少**：账号被判 `error` 后**没有备选可切** —— 网关日志记
  `all pool candidates failed (loomy/spark-x, tried loomy)`，直接回 503 `not_authenticated`。
  此时需要重新 `mx login loomy` 微信扫码入池才能恢复。

### 怎么测这个渠道

端到端由 Agent 跑 `reasonix-mx-test` skill（Reasonix CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login loomy           # 登录入池（微信扫码，唯一登录路）
mx status loomy          # 状态与凭据
mx model loomy --refresh # 目录刷新
mx bill loomy            # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model loomy --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

### 2026-10-19 端到端实测

Reasonix CLI 直连网关（`loomy/spark-x`，倍率 0）：

- 冒烟通过（access 日志 `status: 200`、`stream: true`）。
- 工具往返（写文件 → 读回 → 执行命令）通过，同会话 `messageCount` 递增。
- 倍率 0：测试前后 `mx bill loomy` 剩余额度无变化。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。

| 仓库 | 用途 |
| --- | --- |
| [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api) | 主参照（31★）：额度转 OpenAI 兼容 API |
| [xingluoyuankong/loomy2api](https://github.com/xingluoyuankong/loomy2api) | 多账号池 + Web 面板 + 防风控；该仓库内的 `docs/CLIENT-LOGIN.md`（客户端 asar 实抓 + 对照实验）是本渠道微信扫码登录修复的一手依据，也是 `bind=0` 分支请求形态的对照源（见 §2.1） |
| [xxhhlk/loomy2api](https://github.com/xxhhlk/loomy2api) | 接口结构参考：端点、鉴权形状、请求/响应结构 |
| [wangliangdong/loomy2api](https://github.com/wangliangdong/loomy2api) | 反面对照样本（13★）：容器内 Chromium + noVNC 走**网页**登录（手机号 + 短信），抓 `loomy_web_session` **Cookie** —— 是**另一族凭据**（Cookie 而非 account API 的 session），本渠道不采纳；其「Loomy 不签发 refresh token、失效只能重登」的结论与本渠道 §2.3 一致 |
