# Raccoon 逆向结论（已移除路径备查）

本文汇总**本仓已移除、但协议事实仍有留档价值**的三条路径：手机号 AES-128-CFB 加密、
短信验证码登录、阿里云验证码（原 PROTOCOL.md §2.3 / §2.5 / §2.6，已归并为一段）。
当前实现的**唯一登录路径**（授权码网页登录）见 [PROTOCOL.md](./PROTOCOL.md) §2.4。

证据等级：`[实测]`（真机跑通）/ `[参考]`（第三方参考实现所载）/ `[代码]`（本仓实现事实）/
`[推断]`（静态推理，未真机验证）。

---

## 已移除的三条路径（协议事实，无实现路径，仅备查）

> ⚠ 三条路径**本仓均无实现**（`encryptPhone` / `sendSms` / `loginWithSms` 与本地登录页
> 都已删除），也不构成第二条登录路径。保留它们是为了将来若要恢复短信路径时有据可依；
> **恢复前必须先解决 `captcha_param`（阿里云滑块产物）的来源问题**。

### 2.3 手机号 AES-128-CFB 加密

> ⚠ 本节描述的是**已移除的短信登录**所需的加密形态（算法形状与业务码是实测结论，
> 有留档价值），**本仓已无任何实现**（`encryptPhone` 等函数已删）。保留它是为了
> 将来若要恢复短信路径时有据可依；恢复前必须先解决 §2.5 的 `captcha_param` 来源问题。

算法照抄客户端（渲染层模块 68284 的 `yv()`）`[实测]`：

```
key   = 16 字节公开常量（来自参考实现 / 客户端内嵌 bundle；本文档不落值）
       ⇒ 16 字节 ⇒ AES-128
iv    = 随机 16 字节
mode  = CFB, padding = NoPadding
输出  = Base64(iv ‖ ciphertext)
```

密钥：**16 字节的公开常量**（客户端硬编码在前端 bundle 里，不是安全边界）——
本文档不落其值，实现侧也已无引用。

-  **公开常量**（客户端把它硬编码在前端 bundle 里），
  只用于防止手机号明文出现在日志/代理里，**不是安全边界**
-  必须**显式**写 `aes-128-cfb`：密钥是 16 字节，写成 `aes-256-cfb` 会因长度不足而抛错
-  填充语义已实测：CFB 是流密码，`setAutoPadding(true/false)` 输出**完全一致**
- Python 等价：`cryptography.hazmat.primitives.ciphers` 的
  `Cipher(algorithms.AES(key), modes.CFB(iv))`；或 `pycryptodome` 的
  `AES.new(key, AES.MODE_CFB, iv, segment_size=128)`

**不加密的后果**：`send_sms` 回 `100003 params_encryted_error` `[实测]`。

### 2.5 短信验证码登录

> ⚠ 本节**没有实现**（`sendSms` / `loginWithSms` 已删）。保留协议形态与业务码备查。

**为什么删**（四条判据，逐条可核对）：

1. **零实测记录**：授权码路径有 2026-10-19 的端到端实测（见「使用与实测」），短信路径**一条都没有**。
2. **结构上跑不通**：`send_sms` 的 `captcha_param` **必需**，而本仓**没有任何代码能产出阿里云滑块产物**
   （旧 vendor 包里的本地登录页不在本仓，见 §2.6）⇒ 连第一步都发不出可用请求。
3. **三份参考实现零背书**：agent2api 与 xiaohuanxiong2api 全树检索 `send_sms` / `login_with_sms` /
   `aes-128-cfb` **零命中** —— 两家都只实现授权码一条 `[参考]`。
4. **历史唯一的「验证」是本机假服务替身**：渠道引入时的 selftest 用 `http://127.0.0.1:<fakePort>`
   的假上游跑过 `sendSms`，`loginWithSms` 连一条测试都没有 —— 正是仓库「测试红线」禁止的形态。

**协议形态（备查）**：

**第 1 步** 发短信：
```
POST https://xiaohuanxiong.com/api/web/auth/v1/send_sms
body: {
 "captcha_param": "<阿里云滑块产物>",
 "nation_code": "86",
 "phone": "<AES-128-CFB 加密后 base64>"
}
```
`captcha_param` **必需**（否则 `100006 captcha_verify_error`）`[实测]`。

**第 2 步** 登录：
```
POST /api/web/auth/v1/login_with_sms
body: { "nation_code": "86", "phone": "<加密后>", "sms_code": "<6位>" }
→ { code: 0, data: { access_token, refresh_token, office_identity } }
```

### 2.6 阿里云验证码

> ⚠ 旧 vendor 包的本地登录页（`raccoon-login-page.ts`）不在本仓；本仓**不加载**官方脚本。

脚本与参数（来自旧实现）`[参考]`：

```
script src = https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
sceneId   = '1pkmy0x3'
prefix    = 'hk1r5l'
mode      = 'popup'
slideStyle= { width: 320, height: 40 }
language  = 'cn'
```

脚本未加载（离线/被拦截）时**退化为直接提交**（`captchaParam: ''`），
让服务端报明确原因。
