# payload 日志的行格式与解码规则

`~/.modelmux/logs/payload/<日期>/payload.log` —— 每行一条 JSON 记录，
记录一次请求在某个**相位**（client / upstream）的**原始请求体**。

## 1. 行结构

```jsonc
{
  "ts": "2026-11-07T15:22:43.819Z",   // 落盘时刻
  "seq": 20,                           // 进程内自增序号
  "id": "req_5aeed578ce224028",        // 与 access 日志的 request id 同源
  "phase": "client",                   // client = 客户端原样；upstream = 网关发往上游
  "attempt": 0,                        // 候选尝试序号（换渠道重试时递增）
  "cid": "traecn",                     // phase=client 时可能缺席（那一刻还没选渠道）
  "model": "deepseek-v4.1-flash",      // phase=client 是池模型名；upstream 是渠道上游名
  "stream": false,
  "bytes": 4720463,                    // 原始字节数（截断前）
  "truncated": false,                  // 是否因超 10MB 被头尾保留
  "bodyEnc": "zstd",                   // 存储形态：缺省(plain) / zstd / gzip
  "bodyChunks": ["KLUv/..."],          // 压缩后字节分块的 base64
  "bodyChunkLens": [65536]             // 各块原始长度（定位用）
}
```

## 2. 三种存储形态

| 形态 | 判据 | 怎么解 |
| --- | --- | --- |
| **plain** | 无 `bodyEnc`、有 `body` 字符串 | 直接 `Buffer.from(body, "utf8")`。只在「合法 UTF-8 且 < 4KB」时用 |
| **zstd** | `bodyEnc: "zstd"` | `bodyChunks` 各自 base64 解码 → 拼接 → `zstdDecompressSync` |
| **gzip** | `bodyEnc: "gzip"` | 同上，用 `gunzipSync` |

`extract-context.mjs` 的 `bodyOf()` 已把这三态统一 —— **不要自己拼**，容易漏掉
「合法 UTF-8 但 ≥ 4KB 也走压缩」这条规则。

## 3. 为什么分块

单条记录压缩后仍可能上 MB，base64 后更大。分块（默认 64KB）让：
- 写入不必一次拼完整个大 Buffer；
- 读取端能按块定位（`readPayloadSlice` 的字节窗口语义）。

**分块边界会劈开多字节字符**：所以每块必须**按字节**处理（base64 不解释内容），
拼齐后**一次性** `TextDecoder` 解码。分块后各自解码再拼字符串会在接缝处产生替换符
（U+FFFD）—— 这是 2026-11 前的已知缺陷，已修。

## 4. 字节无损与 `invalidBytes`

客户端可能发**非 UTF-8 字节**（Windows GBK 控制台输出被原样塞进 JSON、GBK argv）。
网关不试图修它，而是：
1. 原样保存字节（压缩分支存的就是原始字节，不做 `toString("utf8")`）；
2. 统计无效字节数，写在记录的 `invalidBytes` 字段里。

读到 `invalidBytes > 0` 的记录，说明**乱码是源头带的**，不是你解析错了。
`extract-context.mjs` 用 `Buffer.toString("utf8")` 呈现（无效字节变 U+FFFD 显示），
但要拿真字节得自己按 §2 解。

## 5. 轮转与保留

| 项 | 值 | 说明 |
| --- | --- | --- |
| 单文件上限 | 10MB | 超了轮转成 `payload.log.1.log`（序号越大越旧） |
| 单条正文上限 | 10MB | 超了头尾保留、中间插省略标记，`truncated: true` |
| 保留期 | 跟随 access 日志（默认 14 天） | 过期自动清理 |

`extract-context.mjs` 的 `payloadFiles()` 会按轮转序号**正序**读出（旧段在前，
与写入时间一致），所以 `--list` 的时间排序是可信的。

## 6. 什么时候抓

- **只抓模型请求**：`/v1/chat/completions`、`/v1/messages`、`/v1/responses`
  （`MODEL_REQUEST_PATHS`）。`/health`、`/v1/models`、控制台 API 都不抓。
- **抓在发上游之前**：超时、建连失败这类最需要看上下文的请求**也有记录** ——
  等响应回来再写就晚了。
- **恒开启，无开关**：留底是排查前提；关掉之后「刚才那条请求发了什么」永远查不到。

## 7. 字节与压缩率的实测参考

| 场景 | 原始 | 压缩后 | 说明 |
| --- | --- | --- | --- |
| 短请求（1 条 user） | ~100 B | plain 存储 | 不走压缩 |
| 中等会话（50 条消息） | ~460 KB | ~180 KB | zstd |
| 长会话（2300 条消息） | ~6 MB | ~2 MB | zstd，接近单条上限 |

压缩率通常 2-3 倍（JSON 重复结构多）。`bytes` 字段记的是**原始**字节数。
