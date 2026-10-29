# 存储优化：借鉴 dsh 的机制（调研结论 + 移植方案）

本文件记录**对 dsh（`@deepseek-ai/dsh`）存储机制的调研结论**，以及 modelmux 的移植方案与取舍。
实施状态见文末「实施计划」。

## 0. 为什么看 dsh

modelmux 的 `~/.modelmux/logs/` 实测约 **99M**，其中 `payload/`（请求正文抓取）**86M**、
`access/` 9.2M。初判两个问题：

1. **疑似大量重复**：agent 会话的 system prompt / 工具定义每请求几乎相同，怀疑逐条完整落盘；
2. **无处理落地**：正文按明文追加，无压缩、无去重。

⚠ 第 1 条**实测不成立**（重复率 0，见 §5.1）—— 「每请求几乎相同」是**语义上**相近，
字节上并不相同（历史消息每轮都在增长）。真问题只有第 2 条：**没压缩**。
这一条修正直接决定了方案：不做内容寻址去重，只做压缩。

dsh 是同类本地 Agent 工具，且同样把「会话如何落盘」当核心问题，故对照其实现。

## 1. dsh 源码形态（先说清楚能拿到什么）

- `@deepseek-ai/dsh` 本体是**薄壳**：`/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/*.js`（15 个文件）
  + `lib/types/*.d.ts`；`bin.dsh` → `lib/bin.js`。
- 真实逻辑在 **305 个 `@deepseek-ai/dsh-*` workspace 包**（同目录 `node_modules/@deepseek-ai/` 下），
  每包 = 单个**打包后的 ESM `lib/index.js`**（未混淆，带完整 JSDoc）+ `lib/types/*.d.ts` + README。
- **没有随包发布 `.ts` 源码**（README 引用的 `src/*.ts` 是仓库路径，本机不存在）。
- 上游：`git+https://github.com/deepseek-ai/deepseek-harness.git`（monorepo）。

> 下文 `文件:行` 均指这些 `lib/index.js`。

## 2. dsh 的日志系统（核心事实）

| 维度 | dsh 的做法 | 证据 |
|---|---|---|
| 有没有日志器 | **没有**（全库无 pino/winston/bunyan）—— 日志 = 会话 append-only 事件流 JSONL | 全库 grep 为空 |
| 目录组织 | 按**会话**（`<root>/--<encoded-cwd>--/<encoded-id>/session.vN.jsonl[.zstd]`） | `dsh-session-persistence-jsonl/lib/index.js` L886-920 |
| 写入 | **追加单文件**；头部一帧 + 每批一帧；**写后不合并** | `:3269-3282`、`appendLines` `:3299-3326` |
| 持久性 | 每批 `handle.sync()`（fsync）；失败 `rollbackAppend()` 截断回原长 | `:3313`、`:3327-3335` |
| 批处理窗口 | live 事件先入 `buffered`，`setTimeout(200)` 后 drain（per-handle promise chain） | `:190-193`、`:200-221` |
| **轮转与保留** | **完全没有** —— README 原话：*"Nothing deletes session files — logs accumulate under `root` until removed externally; the seam has no deletion API."* | `README.md:167` |
| **压缩格式** | **Zstandard**，用 **Node 内置 `node:zlib`**（`createZstdCompress` / `zstdCompress`） | `:16`、`:1294-1296`、`:1374-1384` |
| 压缩默认值 | `DEFAULT_COMPRESSION="zstd"`（可配 `'none'`）；带 **checksum 帧** | `:2290`、`:1296`、`:1565-1567` |
| **压缩触发时机** | **逐批压**（每个 append batch 一帧）—— 不是逐条、不是定时、不是退出时；无压缩级别旋钮 | `encodeEventBatch` `:3279-3281` |
| 读取 | 多帧扫描 `scanZstdFrames()`；**全量读需解压所有帧**；只读头部只解第一帧；被截断的尾帧可只解前缀 | `:1305-1314`、`:2981-3024`、`:3378`、`:1400` |
| 单条结构 | **一行一个 JSON**（`JSON.stringify` + `\n`）；存储层**无字段裁剪/截断上限** | `eventLine()` `:959-961` |
| 值级压缩 | 连续序号（≥3）压成 `[start,end]` 对（无损游程） | `dsh-session/lib/index.js` L985-996、`dsh-session/lib/types/seq-ranges.js` L11-27 |

## 3. dsh 的会话上下文落盘

1. **形式**：单文件 append-only JSONL，按**格式代**（generation）分段（`v1/v2/v3`），
   不是按 turn 分段；`SessionLogScanner` 顺序扫描。
2. **大内容不内联**（关键）：长消息 / 工具输出 / 附件走**独立内容寻址 blob**，事件只引用 id。
   - 图片：`<DSH_HOME>/attachments/v1/objects/<sha256 前 2 位>/<sha256>`，id 形如 `sha256:<64hex>`
     （`dsh-attachment-local/lib/index.js` L275-298）。
   - 通用文件：唯一对象 + 只读**硬链接**发布（`file-objects/<prefix>/<digest>` + `files/<prefix>/<digest>/<name>`，`:659`）。
   - README 明确：*"Durable session events exclude browser paths, provider URLs, local storage paths, and base64"*。
3. **去重与压缩**：
   - **内容寻址去重：有** —— *"equal bytes deduplicate to one object and one `sha256:` id"*（`README.md:84`）。
   - **会话 JSONL 本身无跨会话去重、无 delta**；只有 zstd 帧压缩 + 游程编码。
4. **上下文压缩与存储解耦**：compaction（摘要替换旧 span、工具输出裁剪、图片卸载）**只改模型可见视图，
   原始事件仍留在 log**（`dsh-compaction/README.md`、`dsh-compaction-tool-result-pruner/README.md`）。

## 4. 可迁移性评估（约束：Node 20+ / TS / 单机 / 零第三方运行依赖）

| 机制 | 收益 | 移植成本 | 风险 |
|---|---|---|---|
| **逐批压缩落盘** | payload/access 体量降 5–10×（文本 JSON 压缩比高） | 低（`node:zlib` 一行调用） | **Node 20 无 `zstdCompress`** → 必须 feature-detect，回退 `gzip` |
| **内容寻址去重**（附件那套） | 直接命中「同一 system prompt/tools 反复落盘」痛点 | 中（blob 目录 + sha256 + 引用行；纯 `node:crypto`/`node:fs`） | 需 GC（dsh 自己也没有）；读取路径要同时解析引用 |
| 原子写 temp+rename | 防半行/损坏 | 低 | **本项目已有**（`runtime/secret-file.ts`） |
| 按会话/按域分文件 | 防单文件膨胀 | 低 | 本项目已按「类型/日期/结果」分层，无需改 |
| 值级游程编码 | 对「序号数组」省字节 | 低 | 对本项目日志增量价值小 |
| **轮转与保留** | dsh **没有** —— 这条反倒是本项目更强（10MB 轮转 ×3 / 14 天 / payload 3 天，`runtime/log-store.ts:66-68`） | — | 反向结论：dsh 该学本项目 |

### 明确**不**移植
- **原生 flock / koffi / `node-addon-system`**（dsh 的跨进程写锁）→ 违反「零第三方运行依赖」；
  本项目单机单进程，不需要跨进程锁。
- **每行 fsync 的持久性等级** → 本项目日志是 best-effort 旁路（`runtime/log-store.ts:8`），每行 fsync 会拖垮吞吐。
- **格式代 + 迁移链（v0→v4）** → 无此兼容需求。
- **「永不删除」**（dsh README:167）→ 与本项目保留策略冲突，**不要学**。
- **按会话单文件 + 头部/批次帧边界** → 本项目是代理网关，无「会话」语义。
- **附件 sharp/libvips 图像归一化** → 重型原生依赖，无关。
- **zstd 设为强默认** → 会让 Node 20 直接崩（必须探测后回退）。

## 5. 移植方案（本项目）

### 5.1 实测结论（2026-10-29，实施前的量测 —— 先量再改）

| 量测 | 结果 | 含义 |
|---|---|---|
| `~/.modelmux` 总占用 | 98MB（其中 `logs/payload` 85MB、`logs/access` 9.4MB、`logs/system` 2.6MB、`logs/error` 1.4MB） | 大头是抓取正文 |
| payload 正文**重复率** | 2 天 114 条正文，**唯一 114 条**（重复率 0） | **内容寻址去重收益为零** |
| `client` 与 `upstream` 正文是否同体 | 61 对，**0 对字节相同** | 归一化总会改动，跨 phase 也去不掉 |
| 全 `~/.modelmux` 文件级重复 | 只有 10 份「`credentials.json` 与 `accounts/<key>.json` 同内容」，合计约 10KB | 「大量重复文件」不成立 |
| zstd 压缩率（真实正文） | 2.9x（默认档，77MB → 26.7MB；level 9 3.2x、level 19 3.4x） | **压缩才是真实杠杆** |
| 存量分布 | 82MB 里约 **76MB 在已封存的轮转段** | 存量 compression 该打在封存段上 |

> 结论：**不做内容寻址 blob（dsh 的核心机制）** —— 它解决的是「同一内容多份」，而本仓库
> 实测没有这种情况；做了只会多一层目录 + 必须配套的 GC，收益为零。改为**正文压缩**。

### 5.2 正文压缩（已实施）
- 写入：正文 ≥ 4KB 就压（`zstdCompressSync`，`typeof` 探测；不可用回落 `gzipSync`），
  结果 base64 内联进行（`bodyEnc` + `bodyB64`）；小于 4KB 保持明文 `body`。
- 读取：`parsePayloadLine` 先看 `body`、再按 `bodyEnc` 解 `bodyB64`，**旧明文行照旧可读**；
  解不开的退化为空正文而不抛错（读日志不能反过来影响接口）。
- 落盘体积：**78MB → 42MB**（`mx log --compact` 跑完 6 个封存段：64.4MB → 27.7MB，2.3x）。

### 5.3 存量压缩入口 `mx log --compact`（已实施）
- 只压**已封存**的轮转段（`payload.log.1.log`…`.3.log`）：活跃段随时被并发追加，
  而本项目**没有文件锁**，重写它有丢记录的窗口；
- 逐行重编码（不是整文件 gzip）：这样读路径**完全不用改**（同一套 `parsePayloadLine`）；
- 写临时文件再 `rename` 原子替换；没变小就不动（重写有风险，零收益时不冒险）。

### 5.4 明确**不**做，及其理由

| 事项 | 不做的理由（实测/约束） |
|---|---|
| 内容寻址 blob 去重 | 实测重复率 0（见 5.1） |
| blob GC（mark-and-sweep） | 因为没有 blob；这是上一条的连带结论 |
| 轮转段整体 `.gz`（含 access/system） | 收益仅 9.4MB（access），却要给 `readTail` 加「整段解压再取尾部」的慢路径；存量会在 14 天保留期内自然过期 |
| `slow.log` 去除 | 它是刻意留的并行副本（便于直接 grep），且各文件 < 1.1MB |

## 6. 实施计划（状态）

| # | 事项 | 状态 |
|---|---|---|
| 1 | payload 正文压缩（含向后兼容读取：旧明文行仍可读） | **已完成** |
| 2 | `mx log --compact` 存量压缩（只动封存段） | **已完成** |
| 3 | blob 去重 + blob GC | **不做**（实测重复率 0，见 5.1/5.4） |
| 4 | 文档同步（`docs/LOGGING.md` §9 行字段与入口） | **已完成** |


## 7. 参考来源

| 结论 | 来源（dsh 包内路径） |
|---|---|
| 无日志器 / JSONL 即日志 / 无轮转无删除 | `dsh-session-persistence-jsonl/README.md:167`、全库 grep |
| 逐批 zstd、checksum 帧、触发时机 | `dsh-session-persistence-jsonl/lib/index.js:1296,1565-1567,3279-3282` |
| 大内容内容寻址 blob + 去重 + 硬链接 | `dsh-attachment-local/lib/index.js:275-298,659`、`dsh-attachment/README.md` |
| 上下文压缩不落盘改动（视图 vs 原始） | `dsh-compaction/README.md`、`dsh-compaction-tool-result-pruner/README.md` |
| 本项目现有保留策略（对照） | `packages/core/gateway/src/runtime/log-store.ts:66-68`、`docs/LOGGING.md` |
