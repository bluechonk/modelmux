# 存储优化：借鉴 dsh 的机制（调研结论 + 移植方案）

本文件记录**对 dsh（`@deepseek-ai/dsh`）存储机制的调研结论**，以及 modelmux 的移植方案与取舍。
实施状态见文末「实施计划」。

## 0. 为什么看 dsh

modelmux 的 `~/.modelmux/logs/` 实测约 **99M**，其中 `payload/`（请求正文抓取）**86M**、
`access/` 9.2M。两个问题：

1. **大量重复**：agent 会话的 system prompt / 工具定义每请求几乎相同，却逐条完整落盘；
2. **无处理落地**：正文按明文追加，无压缩、无去重。

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

### 5.1 优先级
1. **payload 内容寻址去重 + 压缩**（收益最大：86M 的大头，且正文高度重复）
2. **已轮转的历史日志段压缩**（`.1.log` → `.1.log.gz`）
3. （可选）日志字段按 cid 白名单减量

### 5.2 payload 去重 + 压缩（设计）
- 写正文前算 `sha256`；正文落到 `<root>/logs/payload/_blobs/<前2位>/<sha256>`（**一个内容一份**）；
- `payload.log` 的 `body` 改为**引用行**：`{ sha256, bytes, truncated, compression }`；
- 压缩用 **`node:zlib`**：优先 `zstdCompress`（22.15+/23.8+，`typeof` 探测），否则 `gzipSync`；
- 读取路径（`readPayloads`）先解析引用、再按需解压；
- **不改变既有约束**：日志失败不影响主流程（`runtime/log-store.ts:138`）、单条上限 10MB、`0600` 权限。

### 5.3 轮转段压缩（设计）
- 只压**已封存**的轮转段（`.1.log` / `.2.log`），活跃段保持裸文本（保留 tail 零解压快路径）；
- `accessFiles` / `payloadFiles` 需同时识别 `.gz` 并透明解压；
- 补 `mx log --compact` 手动触发 + 后台随轮转自动压。

### 5.4 blob GC（dsh 没有，但本项目需要）
因为本项目**有**保留策略（日志按天删），blob 必须跟着引用一起回收：
方案：`--compact` 时扫描活跃日志引用的 sha256 集合，未被引用的 blob 删除（mark-and-sweep）。

## 6. 实施计划（状态）

| # | 事项 | 状态 |
|---|---|---|
| 1 | payload 去重 + 压缩（含读取路径与向后兼容：旧明文行仍可读） | 待实施 |
| 2 | blob GC（mark-and-sweep，随 `--compact`） | 待实施 |
| 3 | 轮转段压缩 + `mx log --compact` | 待实施 |
| 4 | 文档与 `mx log --list` 输出同步 | 待实施 |

## 7. 参考来源

| 结论 | 来源（dsh 包内路径） |
|---|---|
| 无日志器 / JSONL 即日志 / 无轮转无删除 | `dsh-session-persistence-jsonl/README.md:167`、全库 grep |
| 逐批 zstd、checksum 帧、触发时机 | `dsh-session-persistence-jsonl/lib/index.js:1296,1565-1567,3279-3282` |
| 大内容内容寻址 blob + 去重 + 硬链接 | `dsh-attachment-local/lib/index.js:275-298,659`、`dsh-attachment/README.md` |
| 上下文压缩不落盘改动（视图 vs 原始） | `dsh-compaction/README.md`、`dsh-compaction-tool-result-pruner/README.md` |
| 本项目现有保留策略（对照） | `packages/core/gateway/src/runtime/log-store.ts:66-68`、`docs/LOGGING.md` |
