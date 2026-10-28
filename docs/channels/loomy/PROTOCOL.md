# Loomy 协议规格（讯飞）

实现见 `packages/core/channels/loomy/src/`；微信扫码与账号密码两条**本仓不实现**登录路的逆向结论见
[FINDINGS.md](./FINDINGS.md)（仅作参考，别照着重写）。

---

## 登录路径：手机验证码（唯一）

`mx login loomy` **只有手机验证码一条路**，两步协议。输入来源有两条，**都通**：

| 入口 | 手机号怎么来 | 验证码怎么来 |
|---|---|---|
| **Web 控制台**（登录弹窗） | 弹窗里的输入卡（渠道调 `options.requestInput({kind:"phone"})`） | 发码后再弹一张输入卡（`kind:"code"`），**一次走完** |
| **CLI**（`mx login loomy`） | 环境变量 `LOOMY_PHONE` | 环境变量 `LOOMY_SMS_CODE` + `LOOMY_SMS_MSGID`（见下表） |

| CLI 步骤 | 触发条件 | 行为 |
|---|---|---|
| 第一步 | `LOOMY_PHONE=<手机号>` | 发码，把 `msgid` 打进错误信息里 |
| 第二步 | 再加 `LOOMY_SMS_CODE=<验证码>` + `LOOMY_SMS_MSGID=<上一步的 msgid>` | 换 14 天 session 并落盘 |

> 契约要求（`docs/CONTRACT-TS.md` §5.1.1）：**先试 `requestInput`，拿不到再回落环境变量**。
> 只做前者 → 终端用户卡在等一个永远不来的输入框；只做后者 → 控制台用户无处可填。

```
1. POST https://account.xfinfr.com/login/phone/sendMsgCode
   body { ccode: "86", phone, expire: 300 }            → { msgid }
2. POST https://account.xfinfr.com/login/phone/checkCode
   body { ccode, phone, mcode, msgid, expire: 1209600 } → { session, userid, phone }
```

⚠ **`msgid` 是两步之间的强绑定**：`checkCode` 不带第一步的 `msgid` 必失败，
所以发码结果必须回传给用户（控制台走输入卡，CLI 打进错误信息里），不能吞掉。验证码有效期 300 秒。

用户取消输入 / 关弹窗 → 渠道抛「已取消短信登录」，不再报「登录失败」。

**为什么只留这一条**（历史判据见 [FINDINGS.md](./FINDINGS.md)）：

1. **微信扫码**在无浏览器环境下注定别扭 —— 授权页每次加载都生成新 uuid（扫错就永远等不到），
   回调页 `loomy.xunfei.cn/oauth/wechat/callback` 线上还是 404，只能靠用户从地址栏粘回 code。
2. **账号密码**要求用户先在讯飞账号中心设置密码（客户端没有设 / 改密入口），
   且要长期保存明文密码 —— 换来的只是「不用收短信」，不值得。
3. **手机验证码**是唯一**单路径就能闭环**的方式：一步发码、一步校验，无浏览器、无粘贴、无额外前置条件。

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

**本渠道只使用下面两条**（其余端点属于本仓不实现的登录路，见 [FINDINGS.md](./FINDINGS.md)）：

| 用途 | 方法 | 完整 URL | 端点路径 | param | 认证 |
|---|---|---|---|---|---|
| **手机验证码发码** | POST | `https://account.xfinfr.com/login/phone/sendMsgCode` | `/login/phone/sendMsgCode` | `{ "ccode": "86", "phone", "expire": 300 }` | HMAC-SHA1 |
| **手机验证码换 session** | POST | `https://account.xfinfr.com/login/phone/checkCode` | `/login/phone/checkCode` | `{ "ccode": "86", "phone", "mcode", "msgid", "expire": 1209600 }` | HMAC-SHA1 |

**没有 refresh 端点**（`packages/core/channels/loomy/src/cred.ts`）：`session` 是登录时声明 14 天得来的，
过期只能**重新走登录流程**（再收一次短信）。
故 `isLoomyRefreshable` **恒返回 false** —— 诚实标记，不是遗漏。

超时：业务请求 60s，模型目录 30s（对应 `LOOMY_REQUEST_TIMEOUT_MS = 60_000`）。

### 业务成功/错误码（`packages/core/channels/loomy/src/upstream.ts:39-41`）

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

### 2.1 登录路径

`login()` **只有手机验证码一条路**（两步）：

| 环节 | 端点 | 输入来源 | 状态 |
|---|---|---|---|
| **验证码发码** | `POST /login/phone/sendMsgCode` | 控制台输入卡 / `LOOMY_PHONE` | `[实测]` 2026-10-22 真机跑通（返回 `msgid`） |
| **验证码换 session** | `POST /login/phone/checkCode` | 控制台输入卡 / `LOOMY_SMS_CODE` + `LOOMY_SMS_MSGID` | `[实测]` 2026-10-22 真机跑通（入池 + 额度 4999） |

输入来源两条路（渠道先试 `options.requestInput`，拿不到再回落环境变量）：

| 变量 | 第一步 | 第二步 | 说明 |
|---|---|---|---|
| `LOOMY_PHONE` | 必填 | 必填 | CLI 用；控制台从输入卡拿 |
| `LOOMY_SMS_CODE` | — | 必填（6 位验证码） | CLI 用；控制台从输入卡拿 |
| `LOOMY_SMS_MSGID` | — | 必填（第一步输出） | CLI 用；**控制台不需要** —— 同一次调用里 `msgid` 在内存里 |

发码失败的常见原因：手机号格式不对（要 11 位大陆号）、发码过于频繁（上游限流）。
`msgid` 有效期与验证码同步（300 秒），超时需重新发码。

> **本仓不实现的两条路**（微信扫码 / 账号密码）的端点、签名与踩坑记录见
> [FINDINGS.md](./FINDINGS.md) —— 那里是**参考记录**，代码里已经没有对应实现，
> 不要照着重写（尤其别再引入 `LOOMY_PASSWORD` / `LOOMY_LOGIN_ID`）。

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
| `X-Loomy-Request-Purpose` | — | 否（服务端积分归属记账） | — | **本渠道不做**：17 个取值的语义需先对照参考实现枚举（§9） |
| `ChatId` / `MsgId` / `TurnId` | — | 否（会话关联） | — | **本渠道不做**（§9） |

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

### 2.3 凭据字段（`packages/core/channels/loomy/src/cred.ts:74-89`）

| 字段 | 必需 | 说明 |
|---|---|---|
| `access_token` | 是 | 讯飞 `session`，**32 位小写 hex** |
| `userid` | 是 | 讯飞用户 id，**18 位数字串** |
| `phone` | 是 | 绑定的手机号（11 位） |
| `nickname` | 否 | Loomy 无昵称接口，缺省时 UI 回退到账号 id |
| `expires_at` | 否 | **毫秒时间戳字符串**，由登录时刻 + 14 天**本地推算** |

`access_token` 字段名**必须**是这个。

### 2.4 账户请求信封（`packages/core/channels/loomy/src/cred.ts:224-236`）

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

### 2.5 登录流程：手机验证码（两步）

```
1. sendPhoneLoginCode(phone)  → { msgid }
2. loginByPhoneCode(phone, mcode, msgid) → session + userid + phone
```

| 步骤 | URL | param |
|---|---|---|
| 1 | `/login/phone/sendMsgCode` | `{ "ccode": "86", "phone", "expire": 300 }` |
| 2 | `/login/phone/checkCode` | `{ "ccode": "86", "phone", "mcode", "msgid", "expire": 1209600 }` |

**两步的绑定关系**：第 2 步必须带第 1 步返回的 `msgid`（上游用它把「这次发的码」和「这次校验」配对）。
故本渠道把发码结果打进错误信息里交给用户（CLI 下不能吞掉，否则第二步无从下手）。
`expire: 300` 是验证码有效期；`expire: 1209600` 是**要申请的 session 有效期**（14 天）。

`session` 是唯一的凭据（32 位小写 hex），响应里还会带 `userid` 与 `phone`。

### 2.6 本仓不实现的登录路（参考）

微信扫码与账号密码两条路**本仓不实现**（判据见 §2.1）。
它们的完整逆向结论（授权页 uuid 提取、长轮询状态机、粘贴兜底、`bind` 四步、
`getPuKey` + `byPwd` 的 RSA 加密形态）见 [FINDINGS.md](./FINDINGS.md)，
**仅作参考** —— 不要据此重写实现。

### 2.7  签名算法（`packages/core/channels/loomy/src/cred.ts:168-216`）—— 逐字节复刻客户端

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

#### 密钥来源（`packages/core/channels/loomy/src/cred.ts:39-42`）

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

### 5.4 兜底静态模型表（9 条，`packages/core/channels/loomy/src/catalog.ts:53-63`）

来源：2026-10-19 实测 `GET /api/v1/models`，取 `type === 'chat'` 的 9 条
（含 `DeepSeek-V4.1-Flash`）。

| id | name | contextWindow |
|---|---|---|
| `DeepSeek-V4.1-Flash` | DeepSeek V4.1 Flash · x2.0 | 1_048_576 |
| `deepseek-v4-flash-0731` | DeepSeek V4 Flash 0731 · x3.0 | 1_048_576 |
| `MiniMax-M3` | MiniMax M3 · x4.0 | 1_048_576 |
| `Kimi-k2.6` | Kimi k2.6 · x6.5 | 262_144 |
| `qwen-3.8-max` | Qwen 3.8 Max · x12.0 | 1_000_000 |
| `GLM-5.3-Flash` | GLM 5.3 Flash · x0.8 | 1_048_576 |
| `qwen3.8-flash` | qwen 3.8 flash · x0.8 | 1_000_000 |
| `spark-x` | Spark-X2.5 · x0.0 | 1_048_576 |
| `mimo-v2.5` | MiMo V2.5 · x3.3 | 1_048_576 |

全部 9 条的 `efforts` 都是 `['none','low','medium','high','xhigh']`，兜底 `defaultEffort = 'high'`。

`spark-x` 是**已知分歧**：远端声明 1048576，而 **Loomy 客户端**用本地表
`MODEL_CONTEXT_OVERRIDES = { 'spark-x': 262144 }` 强制降到 262144
—— ⚠ 该符号是**客户端**的，**本仓没有** `[参考]`。
本表**先采信远端**；若实测长上下文被拒，改为 262144。
倍率以**远端为准**，本表只作离线兜底。

### 5.5 缓存策略（`packages/core/channels/loomy/src/catalog.ts:311-345`）

原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成「已加载」记下，
于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩兜底模型。
改为：**只缓存真实远端目录**，兜底表每次现算，并用冷却闸门挡住「每模型重试一次」的放大。

---

## 6. 额度查询

### 6.1 两个积分池（`packages/core/channels/loomy/src/billing.ts:6-12`）

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

### 6.3 每日额度重置（写，幂等）—— 本渠道的「签到」

```
POST https://loomyad.xunfei.cn/api/v1/points/first-login
Accept: application/json
token: <session>
Content-Type: application/json
body: {}
→ data: { alreadyProcessed, currentBalance, permanentBalance, dailyBalance,
         dailyQuota, dailyConsumed, dailyCycleDate, registerReward, ... }
```

**`dailyQuota` 只在 `first-login` 的响应里**，`points/records` 不返回它（实测后者
`dailyQuota=undefined`）—— 故 `mx bill` 的「每日赠送」总量在日常查询里取
`dailyBalance + dailyConsumed` 兜底，**不要硬编码 5000**。

**幂等判据是响应体的 `alreadyProcessed`**，故已处理映射成 `already-claimed`
而**不是** `completed`。语义是「触发每日额度重置」，**不是「+5000 积分」**：
`dailyBalance = dailyQuota - dailyConsumed`，消耗后不回补。

**2026-10-22 实测**：`dailyQuota=5000`、`dailyConsumed=4022`、`dailyBalance=978`；
连调两次前后 `points/records` 完全一致（**幂等已验**）。

**谁调它（两个入口，都不需要手动命令）**：

| 入口 | 时机 | 失败处理 |
|---|---|---|
| 登录成功 | `cred.login()` 第二步换到 session 后顺手调一次 | 仅 warn，不影响登录结果 |
| **自动签到调度器** | 网关 running 后启动一轮 + 每 30 分钟一轮（`auth/auto-signin.ts`） | 计一次失败，连续 3 次当日熔断 |

签到**没有 CLI 动词**：它是内置能力，`mx start` 起来就自动跑；台账（`state/signin.json`）
保证一天只打一次，结果在 `mx status` 的「签到（本地记录）」一行可见。

**按账号执行**（2026-10-28 起）：本渠道声明 `signin.perAccount = true` —— 奖励是**按账号**
独立的（每日赠送、一次性新手任务各自一份），故调度器会**逐个账号**用各自的凭据调用
`claim({ credential })`，门禁用**账号级**台账、熔断也按账号计数。
⚠ 早期只对「当前生效账号」执行、台账按渠道记 → 一旦某账号领过就把同渠道其余账号当天
全部跳过（实测：4 个账号里 3 个的新手任务一直没领）。

**`ok` 判据 = 两件事都成**：每日额度重置成功**且**新手任务那步没抛错。
早期 `ok` 只看每日重置 → 新手任务瞬时失败也被记成「今天已处理」，当天不再重试、
白丢一次性 10000 分（2026-10-28 实测：4 个账号里有 1 个这样漏掉，单独重跑立刻成功）。

### 6.4 新手任务（`packages/core/channels/loomy/src/billing.ts:35-46`）

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

上游 `/api/v1/models` **逐型号下发** `context_length` 与 `max_output_tokens`（[实测] 2026-10-23）——
渠道两个都读上游；上游没给的字段才回落公开规格表 `MAX_OUTPUTS`。

| 型号 | 上游上下文 | 上游最大输出 |
|---|---|---|
| `spark-x2.6` | 1048576 | 131072 |
| `spark-x` | 1048576 | 65536 |
| `deepseek-v4.1-flash` | 1048576 | 384000 |
| `minimax-m3` | 1048576 | 512000 |
| `glm-5.3-flash` / `mimo-v2.5` | 1048576 | 131072 |
| `kimi-k2.6` | 262144 | 65536 |
| `qwen-3.8-max` / `qwen3.8-flash` | 1000000 | 65536 / 131072 |

思考强度：上游 `reasoning_efforts` = `[none,low,medium,high,xhigh]`（远端 `default_reasoning_effort=low`，
渠道**刻意不采信**，见 `src/catalog.ts`）。

⚠ **已知分歧**：`spark-x` 的**上下文**上游声明 1048576，而讯飞官方规格是 262144 ——
**以上游为准**（这条渠道实际能吃多少以它自己为准），分歧记在
[MODEL-SPECS.md](../../MODEL-SPECS.md) §6。

数值与来源见 [MODEL-SPECS.md](../../MODEL-SPECS.md)（唯一事实源）；上游没给字段的型号回落渠道表
`src/catalog.ts` 的 `MAX_OUTPUTS`（公开规格）。

---

## 使用与实测

### 登录方式

`mx login loomy` **只有手机验证码一条路**，两步（详见 §2.1）：

```powershell
# 第一步：发码（CLI 会把 msgid 打在输出里）
$env:LOOMY_PHONE = "138xxxxxxxx"
mx login loomy
#   → SMS code sent to 138xxxxxxxx. Re-run with LOOMY_SMS_CODE=<code> LOOMY_SMS_MSGID=<msgid> ...

# 第二步：带验证码 + msgid 重跑（验证码 300 秒内有效）
$env:LOOMY_SMS_CODE = "123456"
$env:LOOMY_SMS_MSGID = "<上一步输出的 msgid>"
mx login loomy
#   → [login] done: 登录成功，账号已入池。
```

> 第一步「失败」是设计的一部分：发码本身成功，只是需要第二步才能换到 session。
> 环境变量只在当前终端有效；开新终端要重新设置。

### 推荐模型

| 模型（池 id） | 结论 | 等级 |
| --- | --- | --- |
| `loomy/spark-x` | **倍率 0（免费）** —— chat 首选；注意它是**思考型**模型，冷启动首字慢（见下） | `[实测]` |
| `loomy/qwen3.8-flash` / `loomy/GLM-5.3-Flash` | 倍率 0.8 | `[实测]` |
| `loomy/qwen-3.8-max` | 倍率 12.0 —— **禁用于自动化测试** | `[实测]` |

### ⚠ spark-x 的延迟构成（2026-10-22 实测）

`spark-x` 是思考型模型，`upstreamMs`（= **上游首字耗时**）差异极大：

| 场景 | 首字耗时 |
|---|---|
| 冷启动（首次带工具集，DSH 的 61 工具 / 38,915 prompt tokens） | **24,921 ms** |
| 同一 payload 走 `catpaw/longcat-2.0` 对照 | 4,788 ms |
| 热（同工具集、前缀缓存命中） | 3,352–4,295 ms |

**结论**：慢在上游 prefill，不在网关（网关侧从首字到流结束约 3.4s）。
工具集或上下文一变缓存即失效，会重新吃 ~25s 冷启动。
**交互式对话建议换 `workbuddyai/deepseek-v4.1-flash`（首字 1.3–1.9s，同样免费）**；
spark-x 适合不在乎延迟的批量任务。

另注：`max_tokens` 太小时（如 64）正文可能为空 —— 思考 token 把预算吃光了，
`finish_reason` 会是 `length`，属正常行为不是缺陷。

### 已知限制

- **池内账号少**：账号被判 `error` 后**没有备选可切** —— 网关日志记
  `all pool candidates failed (loomy/spark-x, tried loomy)`，直接回 503 `not_authenticated`。
  此时需要重新 `mx login loomy` 收码入池才能恢复。
- **session 14 天到期**：无 refresh 端点，到期只能重新收码登录。

### 积分经济性（**倍率会烧每日池**）

每日池 **5000 分/天**（`dailyQuota=5000`，见 §6.3），**按模型的倍率扣**。
额度周期由 `billing.quotaPeriod()` 声明（Web 账号池卡片直接显示「每天送 5000 积分，本地 0 点刷新」）；
用完 → 账号进**冷却**（`health: "cooldown"`，次日 0 点自动恢复），不再显示「不可用」。

| 模型 | 倍率 | 5000 分能跑多久 |
|---|---|---|
| `loomy/spark-x` | **0** | **不扣分**（可无限跑） |
| `loomy/glm-5.3-flash` / `loomy/qwen3.8-flash` | 0.8 | 约 6250 单位 |
| `loomy/deepseek-v4.1-flash` | **2** | 约 2500 单位 |
| `loomy/qwen-3.8-max` | **12** | 约 417 单位（**禁用于测试**） |

⚠ **交互式客户端（DSH）默认上下文很大**（带工具时可达 3.9 万 prompt token），
倍率 2 的模型几轮就能烧掉几千分 —— 2026-10-22 实测当天 `dailyConsumed=4022`（就是 DSH
跑 `deepseek-v4.1-flash` 烧的）。**要免费就把交互式会话切到 `loomy/spark-x`。**

### 怎么测这个渠道

端到端由 Agent 跑 `opencode-mx-test` skill（opencode CLI 直连 `http://127.0.0.1:4412/v1`）：

```bash
mx login loomy           # 登录入池（手机验证码两步，见上）
mx status loomy          # 状态与凭据
mx model loomy --refresh # 目录刷新
mx bill loomy            # 额度与倍率（测试后核对是否扣费）
```

### 端到端测试覆盖

登录入池 / `mx model loomy --refresh` / 最小对话 / 工具调用往返 / 流式 SSE。

## 参考实现

clone 到 `reference/` 的学习材料（不入库）；结论进本文件。
下表与 `packages/core/channels/loomy/reference/` 下实际 clone 的目录逐条对应。

| 仓库 | 关键文件 | 用途 |
| --- | --- | --- |
| [Patrick130306/loomy2api](https://github.com/Patrick130306/loomy2api) | `loomy2api/account.py`、`loomy2api/signer.py`、`docs/PROTOCOL.md` | 主参照（31★）：额度转 OpenAI 兼容 API；**本渠道手机验证码登录（`/login/phone/*`）的端点与签名依据** |
| [xingluoyuankong/loomy2api](https://github.com/xingluoyuankong/loomy2api) | `loomy2api/account.py`、`loomy2api/wechat.py`、`docs/CLIENT-LOGIN.md` | **历史参照**：多账号池 + Web 面板 + 防风控；其 `docs/CLIENT-LOGIN.md`（客户端 asar 实抓）曾是微信扫码登录的对照源 —— 微信路已于 2026-10-22 移除，此仓库现仅作逆向结论存档 |
| [xxhhlk/loomy2api](https://github.com/xxhhlk/loomy2api) | `README.md` | 接口结构参考：端点、鉴权形状、请求/响应结构 |
| [wangliangdong/loomy2api](https://github.com/wangliangdong/loomy2api) | `auth_browser.py`、`credit.py` | 反面对照样本（13★）：容器内 Chromium + noVNC 走**网页**登录（手机号 + 短信），抓 `loomy_web_session` **Cookie** —— 是**另一族凭据**（Cookie 而非 account API 的 session），本渠道不采纳；其「Loomy 不签发 refresh token、失效只能重登」的结论与本渠道 §2.3 一致 |

## 已知边界

参考实现有、但本渠道**明确不做**的能力（各自原因）：

| 能力 | 原因 |
|---|---|
| 账号密码登录（`/login/account/getPuKey` + `byPwd`） | **本渠道不实现**：要长期保存明文密码，且需先在讯飞账号中心设密码（参考实现注明**没有设 / 改密端点**）；换来的只是「不用收短信」，不值得。逆向结论存 [FINDINGS.md](./FINDINGS.md) |
| 微信扫码登录（授权页 + 长轮询 + `bind/*` 四步） | **本渠道不实现**：无浏览器环境下注定别扭（授权页每次加载新 uuid、回调页线上 404 只能粘回）。逆向结论存 [FINDINGS.md](./FINDINGS.md) |
| 导入桌面客户端已登录 session（`auth-session.json`） | 依赖本机客户端安装目录与本地文件，越出「本渠道自持凭据」的边界 |
| 浏览器自动化扫码（驱动 Chromium 拿 code） | 需要本机浏览器；短信路已实测跑通，无此必要 |
| `/embeddings`、`/images/generations`、`/search/tencent` | 上游有，但本渠道定位是 **OpenAI 兼容对话网关**；我们是否可用、返回形状均未验证 |
| 多账号加权调度（按额度加权 / 会话粘性 / 在途租约 / 模型级冷却） | 共享层目前只有简单轮换 + 连续失败 3 次标 error；本渠道不扩共享层 |
| 思考开关 `enable_thinking` / `chat_template_kwargs.enable_thinking` | 当前用 `reasoning_effort` 表达档位；上游对未知字段静默忽略，语义需真机确认 |
| 积分兑换码（`/points/redemption-codes/redeem`）/ 邀请码绑定（`/points/activation`） | 属运营玩法；且需 campus 设备号 `deviceId`（promotions 侧） |
| 积分流水翻页 + 每模型实际单价统计 | 当前额度只取第一页余额字段；翻页聚合是面板级需求 |
| `X-Loomy-Request-Purpose` 归属头（17 取值） | 取值语义需先对照参考实现的完整枚举（影响服务端积分归属记账） |
| `ChatId` / `MsgId` / `TurnId` 会话关联头 | 需先确认网关是否要求成对下发 |
| `pet-work` 平台每日任务（`/api/v1/pet-work`） | 与 `onboarding/tasks` 并存的另一套任务体系，未验证 |
| Anthropic 兼容端点（`/v1/messages`） | 网关只做 OpenAI 兼容 |

**待真机复核清单**（由统一验证流程执行）：

- `traceparent` / `loomy-version` 是否真为必需（`[参考]` 说缺失会挂死到超时，本仓未发也跑通）→ A/B 对照；
- `Accept: text/event-stream`（本仓）vs `application/json`（参考）是否影响上游行为；
- `points/records` 的 `recordType`（本仓）vs `record_type`（参考）命名分歧；
- session 自然过期后的真实表现（业务码 `100002` 还是 HTTP 401/403）；
- 发码频率上限（连续发码是否触发上游限流）。
