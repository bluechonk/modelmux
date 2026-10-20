# Loomy 逆向结论（微信扫码链路）

本文是 [PROTOCOL.md](./PROTOCOL.md) §2 的逆向结论层：微信扫码链路的实测发现与踩坑记录
（原 PROTOCOL.md §2.6.1）。**协议规格**（端点、请求头、签名、额度、模型目录）仍以
PROTOCOL.md 为准，本文不重复。

证据等级：`[实测]`（真机跑通）/ `[参考]`（第三方参考实现所载）/ `[代码]`（本仓实现事实）/
`[推断]`（静态推理，未真机验证）。

---

## 2.6.1 授权页与二维码是**两个不同的会话**（2026-10-20 实测，最易踩的坑）

**授权页每次加载都重新生成 uuid** `[实测]` —— 同一个 `state` 连开两次，得到两个不同 uuid：

```
state = b2ed69d326c74802b024021530f8
load#1 {"status":200,"len":42888,"uuid":"091LPsaL1Z1Pkl2W"}
load#2 {"status":200,"len":42888,"uuid":"011p4kpw1256ll2R"}
same uuid across loads? DIFFERENT
```

长轮询认的是 **uuid**，不是 state `[实测]`。故：

- 正确：把**本进程这次加载**抽出的 uuid 渲染成二维码（`/connect/qrcode/<uuid>`）给用户扫
  → 微信确认的正是这个 uuid → 长轮询收到 405 → 自动收尾。
- 错误：把**授权页 URL**（`/connect/qrconnect?...`）丢给用户让他「打开去扫」
  → 浏览器那次加载生成的是**另一个 uuid** → 用户在手机上确认了，本进程的长轮询**永远等不到**，
  表现为「手机上确认了但流程一直卡住」。

**qrcode 图片端点不校验 Referer** `[实测]`（实测带/不带都是 `200 image/jpeg` 约 46KB），
故 CLI 可以直接把该图片 URL 打给用户，让他打开图片用微信扫。

**兜底路径（长轮询拿不到时）**：用户自己开授权页扫码 → 微信 302 到
`https://loomy.xunfei.cn/oauth/wechat/callback?code=…&state=…`（线上 404 页，正常）
→ 把地址栏整条链接粘回 CLI（CLI 收 stdin 一行；Web 端收 `pasteCallback` 命令）。

**粘贴兜底在代码里的落点**（与 `codearts` / `lobsterai` 同一形态）`[代码]`：

| 位置 | 职责 |
|---|---|
| 共享层 `packages/core/gateway/src/auth/auth-flow.ts:62` | 把 `ui.takePastedCallback` 包成 `pasteCode()` 传给渠道 |
| 渠道 `LoginOptions.pasteCode`（`packages/core/channels/loomy/src/cred.ts` 的 `WechatWaitOptions`） | **声明**该回调（`wechatObtainCode` 每轮轮询取一次） |
| `wechatObtainCode` → `parseWechatCallback` | 解析粘回的内容（整条 URL / 只有 query / 裸 code 三种形态），转成微信 code 继续 `bind/auth` |

即：**用户即使浏览器回调打不到本机**（远程 / 无头 / 容器），把地址栏那条链接粘回终端
也能把登录走完 —— 走的是**同一条** `bind/auth` 链路，不是第二条登录路径。

**uuid 提取**（两条路径互为兜底，无需执行 JS）`[代码]`：
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

**404 / 405 的语义（极易读反）** `[实测]`：404 = 已扫码待确认（继续轮询）；405 = **已确认**，
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

**本地弹窗页**（本仓实现，非上游协议）：
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
