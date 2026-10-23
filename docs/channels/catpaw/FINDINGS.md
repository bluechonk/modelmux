# 结论汇总（FINDINGS）

本文把凭据逆向的实测与代码读取结论集中在一处，逐条标注证据等级。
证据等级定义见 [PROTOCOL.md](PROTOCOL.md#证据等级约定)。

> ⚠ **本文是历史快照，不是现行实现说明。** 下列 §2–§5 来自对妙手桌面客户端
> （`app.asar`）的凭据逆向；**本仓不读桌面端任何文件**，现行登录只走真实 URL 链路
> （见 [PROTOCOL.md](PROTOCOL.md)）。协议事实（端点、请求头、请求体、实测结论）以 PROTOCOL.md
> 为唯一事实源，本文不重复。

---

## 2. 凭据落点

userData 目录：`%APPDATA%\catpaw-moon`；CLI 目录：`%USERPROFILE%\.meituan-catpaw`

| 文件 | 大小 | 承载凭据 | 加密 | 键 / 角色 | 等级 |
| --- | --- | --- | --- | --- | --- |
| `catx-credential.json` | 326 B | **是** | **是**（AES-256-GCM） | `ssoTokenEnc` —— 本课题主目标 | `[实测]` |
| `.meituan-catpaw\auth.json` | 442 B | **是** | 否（明文） | `auth` / `account` / `scopeSuffix` / `updatedAt` —— 交叉验证来源 | `[实测]` |
| `catx-enterprise-token.json` | 92 B | 是（本机为空） | 复用同一原语 | `epToken` / `entId` / `activeEntId` / `sessions` / `refreshJournal` | `[实测]` |
| `catx-auth-provider.json` | 38 B | 否 | — | `activeProvider`（本机为 `catx-passport…`） | `[实测]` |
| `catx-scope-pointer.json` | 43 B | 否 | — | `lastActiveScopeSegment`：多租户存储 scope 指针 | `[实测]` |
| `catpaw-uuid` | 57 B | 否 | — | 设备 UUID（**不是**密钥材料） | `[实测]` |
| `Local State` | 490 B | 否 | — | `os_crypt`（Electron safeStorage 元数据）——本产品**未**用这条通道存 token | `[实测]` |
| `catpaw-memory-<scope>.db` | 33.2 MiB | 否 | — | SQLite：`conversations` / `sessions` / `memory_chunks_fts` … | `[实测]` |
| `catpaw-memory-anon.db` | 224 KiB | 否 | — | 同上（匿名 scope） | `[实测]` |

**关键判断**：这条产品线**没有**走 Electron `safeStorage`（即没有 DPAPI/Keychain 包裹），
而是自己实现了一套基于机器码的密钥派生 —— 这既降低了提取门槛，也决定了它的强度边界：
**只要知道机器码就能解密**。 `[代码]`

### 明文 auth.json 的结构 `[实测]`

```jsonc
{
  "auth":    { "loginType": "passport", "accessToken": "<152 字符>", "tokenType": "Bearer" },
  "account": { "uid": "<10 位>", "loginName": "<8 字符>", "name": "<8 字符>", "entId": "" },
  "scopeSuffix": "<11 字符>",
  "updatedAt":   1760000000000          // 毫秒时间戳
}
```

**可解析性判据**（什么算一份合法的 CLI 明文登录态）： `[实测]`

| 约束 | 值 |
| --- | --- |
| `loginType` | `passport` 或空串；其它取值一律判为不可用 |
| `accessToken` | 非空、长度 ≤ 8192 |
| token 字符集 | 单行可打印，不含 `\r` / `\n` / `\0` |
| 顶层形状 | 嵌套（`{auth:{…}, account:{…}}`，实测形态）或扁平（`{loginType,…}`，兼容分支 `[推断]`） |

> token 是**单行可打印文本**（可直接放进 HTTP 头），不是二进制或多行结构。 `[实测]`

---

## 3. 存储加密方案（核心）

从 `app.asar` 里读到的实现（minified 后函数名为 `Ze` / `Oe` / `re`）： `[代码]`

```js
// 密钥派生（带进程内缓存）
function Ze() {
  let t = ''
  try { t = machineIdSync(true) }            // node-machine-id，true = 原始值不哈希
  catch { warn('Failed to read machine id, falling back to salt-only key') }
  return createHash('sha256').update(`${t}:catpaw-desk-token-v2`).digest()
}

// 加密
function Oe(payload) {
  const iv = randomBytes(12)
  const c  = createCipheriv('aes-256-gcm', Ze(), iv)
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
}

// 解密
function re(encoded) {
  const raw = Buffer.from(encoded, 'base64')
  const iv  = raw.subarray(0, 12)            // IV
  const tag = raw.subarray(12, 28)           // auth tag（16 字节）
  const ct  = raw.subarray(28)               // 密文
  const d = createDecipheriv('aes-256-gcm', Ze(), iv)
  d.setAuthTag(tag)
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'))
}
```

归纳：

| 项 | 值 | 等级 |
| --- | --- | --- |
| 对称算法 | `aes-256-gcm`（AEAD，带 16 字节认证标签） | `[代码]` |
| 密钥派生 | `SHA-256( UTF-8( \`${machineId}:catpaw-desk-token-v2\` ) )` → 32 字节 | `[代码]` |
| 密钥材料 | 机器码本身（无迭代、无随机盐、无 KDF 成本参数） | `[代码]` |
| 信封 | `base64( IV[12] ‖ authTag[16] ‖ ciphertext )` | `[代码]` + `[实测]`（长度 227 = 12 + 16 + 199 自洽） |
| 明文 | `{ access_token: string, modified_at: number }` | `[实测]` |
| 落盘 | `catx-credential.json` → `ssoTokenEnc` | `[代码]` |

### 静态检索锚点（可复现）

在 `app.asar` 里定位这套凭据逻辑，用的是一组**字面量锚点**：按块流式扫描归档，
命中后截取命中点前后各一段窗口作证据（minified 代码压成一行，片段里标出命中位置）。 `[代码]`

| 锚点字面量 | 指向 |
| --- | --- |
| `catpaw-desk-token-v2` | 密钥派生盐串 |
| `ssoTokenEnc` | 存储键名 |
| `catx-credential` | 凭据 store 名称 |
| `machineIdSync` | 机器码来源（`node-machine-id`） |
| `aes-256-gcm` | 对称算法 |
| `Failed to decrypt SSO token` | 解密失败分支 |

**注意**：`aes-256-gcm` 这类算法名在归档里**不唯一**（首个命中点属于另一个子系统），
所以「扫到算法名」只说明归档里出现过这个算法；**方案判定以凭据模块自身
`Ze()/Oe()/re()` 那段实现为准**。 `[代码]`

### 为什么能确认切分是 12 / 16 而不是猜的

1. `re()` 里直接写死 `subarray(0,12)` / `subarray(12,28)` / `subarray(28)` `[代码]`
2. 本机实测字节数 227 = 12 + 16 + 199，其中 199 正好等于明文 JSON 的 UTF-8 字节数
   （`{"access_token":"<152>","modified_at":<13>}` → 199），GCM 无填充，长度可精确对上 `[实测]`

---

## 4. 密钥材料：机器码

`node-machine-id` 的 `machineIdSync(true)`（从 `app.asar` 里读到的该包实现）： `[代码]`

| 平台 | 来源 | 归一化 |
| --- | --- | --- |
| Windows | `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` | 取 `REG_SZ` 之后的部分 → 去掉所有空白 → **转小写** |
| Linux | `/etc/machine-id`，读不到则回退 `/var/lib/dbus/machine-id` | 去空白、转小写 |
| macOS | `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` | 去空白、转小写 |

归一化必须与 `node-machine-id` **逐字一致**：任何一步偏差（漏去空白、漏转小写、
取错 `REG_SZ` 之后的部分）都会派生出另一把密钥，表现为 GCM 认证标签校验失败，
而不是"解出一堆乱码"—— 这是排查解密失败时的第一嫌疑点。 `[代码]`（归一化规则来自实现）

本机实测：机器码长度 36（8-4-4-4-12 的 UUID 文本），指纹 `d20a9bd137d17584`，
派生出的 32 字节密钥指纹 `9c27a3668e2599d4`。 `[实测]`

**安全含义** `[推断]`：

- 这是一套**确定性**密钥：同一台机器上密钥恒定，不依赖任何进程态或用户态秘密。
- 强度上限 = 机器码的可获得性。机器码不是秘密（本机任意进程可读），
  所以**任何能读到该用户文件系统的进程都能解密 token**。
- 反过来说，换机 / 重装系统 / 改注册表后旧密文即不可解 —— 这也解释了为什么
  桌面端重新登录会直接覆盖 `ssoTokenEnc`。

---

## 5. 解密验证结果

| 项 | 值 | 等级 |
| --- | --- | --- |
| 密文 base64 长度 | 304（→ 227 字节） | `[实测]` |
| 密文熵 | 6.9466 bit/byte（样本仅 199 B，短样本熵估计天然偏低） | `[实测]` |
| 解密结果 | `{ access_token, modified_at }`，明文 token 152 字符 | `[实测]` |
| token 指纹 | `cd04187a3ce0a820` | `[实测]` |
| `modified_at` | 2026-10-03T15:17:17.758Z | `[实测]` |
| 与 CLI 明文 `auth.json` 比对 | 长度一致、**sha256 指纹完全一致** | `[实测]` |
| 加解密往返 | 用自己的实现重新加密再解密，指纹一致 | `[实测]` |

> 交叉验证是这套结论最有力的一环：**两条彼此独立的落点**（加密的 `ssoTokenEnc` 与
> 明文 `auth.json`）解出同一个 token，说明密钥派生与信封切分都还原正确了。

**交叉验证的判定分支**（两条落点对不上时按此读，不靠猜）：判定规则是验证程序的
固定分支 `[代码]`；本机实际命中的是第一支 `[实测]`。

| 明文 vs 密文 | 判读 |
| --- | --- |
| 长度一致、sha256 指纹一致 | 同一份 access_token —— 密钥派生与信封切分都还原正确 |
| 长度一致、指纹不同 | 凭据已在本机轮换，密文与明文**不同步**（重登只覆盖了其中一侧） |
| 长度与指纹都不同 | 两者来自**不同账号或不同 scope** |

**「这个字段到底有没有加密」不靠熵判断，而看首字节**：真信封的首字节是随机 IV，
几乎不可能是 `{` / `[` / `"`；明文 JSON 落盘则必然以它们开头。本样本首字节不是
JSON 起始符，可排除「未加密」这一支。 `[实测]`
