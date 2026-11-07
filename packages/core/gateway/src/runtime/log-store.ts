/**
 * 运行日志落盘与读回：按「类型 / 日期 / 结果」分文件，绝不把所有日志堆进一个文件
 * （文件清单见 docs/LOGGING.md §2，轮转与保留见 §6）。
 *
 * 规则：
 *  - 每类文件独立大小上限（默认 10MB）、超限轮转 `<name>.1.log` 最多保留 3 份；
 *    日期目录按本地时区切分、默认保留 14 天（过期目录在当日首次写入时清理）
 *  - 所有写入 best-effort：日志失败绝不影响请求
 *  - 控制台日志页经 `queryAccessLogs` 读回；请求正文抓取默认开启、偏好可关（见 docs/LOGGING.md §9）
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
// 命名空间导入 + 运行时探测：zstd 是 Node ≥ 22.15 才有的绑定，直接具名导入会让老版本
// 在 **模块链接期** 就报错（ESM 缺失导出是硬错误），一条日志旁路不值得拖垮进程启动。
import * as zlib from "node:zlib";
import type { ServerResponse } from "node:http";

import * as paths from "./paths.js";
import { enforcePermissions } from "./permissions.js";

/**
 * 一次请求的结果分桶 —— **只有成功与失败**。
 *
 * 历史上还有第三桶 `other`（「中断」：没拿到状态码就断开）。实测它恒为空
 * （`status<200` 才落，正常请求拿不到这种状态；客户端提前断开也在 `finishRequestLog`
 * 之前就被 2xx 定了 success），却在界面上多给用户一个看不懂的分段。
 * 读旧 `other.log` 的行按 **failure** 计（没有状态码 = 服务端没给出结果）。
 */
export type AccessOutcome = "success" | "failure";

/** 单请求的访问日志上下文；由 HTTP 层创建，响应结束时落盘。 */
export interface RequestLog {
  id: string;
  method: string;
  path: string;
  startAt: number;
  /** 客户端请求的模型 —— **规范 deepseek 名**（如 `deepseek-v4.1-flash`；别名已归并）。 */
  model?: string;
  /** 入站协议名（anthropic / responses；chat 透传路径不落字段）。 */
  protocol?: string;
  /** **承接**这次请求的渠道（跨渠道选路后由 `http/chat/attempt.ts` 逐次尝试写入）。 */
  cid?: string;
  /**
   * 承接请求的**账号 key**（池内账号标识，控制台的账号行按它归集 token）。
   *
   * 为什么必须有：账号池要按账号展示「今日 tokens」，而账本只记 ok/fail/credits，
   * 逐请求的 token 只在访问日志里 —— 不落这个字段就只能按渠道汇总。
   */
  key?: string;
  stream?: boolean;
  status?: number;
  outcome?: AccessOutcome;
  error?: string;
  message?: string;
  /** 从请求开始到第一个响应字节（首帧）的毫秒数。 */
  ttfbMs?: number;
  /** 从请求开始到上游响应头到达的毫秒数。 */
  upstreamMs?: number;
  /** 请求总耗时（响应 finish/close 时写入）。 */
  durationMs?: number;
  /**
   * 上游**首个内容帧**到达的时刻（相对 `startAt` 的毫秒数）。
   *
   * 与 `ttfbMs` 的区别：`ttfbMs` 记的是**我们写出首个字节**的时刻 —— 流式下两者几乎相同，
   * 非流式下我们收完才写，`ttfbMs` 于是等于总耗时、完全测不到生成速度。本字段两边都记
   * 「上游什么时候开始吐」。
   */
  firstFrameAt?: number;
  /** 上游**末个内容帧**到达的时刻（相对 `startAt`）；与 `firstFrameAt` 之差即纯生成窗口。 */
  lastFrameAt?: number;
  /**
   * 纯生成窗口 = `lastFrameAt - firstFrameAt`（毫秒）。TPS 的唯一可信分母。
   *
   * 为什么不复用 `durationMs - ttfbMs`：见 `firstFrameAt` 的说明 —— 那个减法在非流式下分母趋 0，
   * 会把几十 t/s 算成几万 t/s（2026-10-30 实测 76000 t/s）。
   */
  generateMs?: number;
  usage?: Record<string, unknown>;
  requestBytes?: number;
  messageCount?: number;
  systemChars?: number;
  toolCount?: number;
  /**
   * 这次请求**进过上游排队**（收到了排队帧、等待后重试）。
   *
   * 为什么单独记：耗时区分不了「上游慢」与「上游在排队」（实测 qoder 排队能拖到 290s，
   * 只看耗时会把它混进「慢」里），而控制台的模型列表要按它打「排队」标签。见 `noteQueued`。
   */
  queued?: boolean;
  written?: boolean;
}

const REQUEST_LOG = Symbol("modelmux.requestLog");

type WithRequestLog = ServerResponse & { [REQUEST_LOG]?: RequestLog };

const MAX_ROTATED = 3;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;

let lastPruneDate = "";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function maxBytes(): number {
  return envInt("MODELMUX_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
}

function retentionDays(): number {
  return envInt("MODELMUX_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
}

/**
 * 生成窗口下限（毫秒）：小于它算不出可信速率（首末帧同毫秒 = 测不到）。
 *
 * 与 UI 侧 `packages/ui/src/lib/log-format.ts` 的 `GENERATE_FLOOR_MS` **必须同值** ——
 * 两边算的是同一个 TPS，只是服务端用于聚合与「慢」判定、前端用于单条展示。改一处就要改两处。
 */
const GENERATE_FLOOR_MS = 50;

/**
 * 速率上限（tokens/s）：超过它说明分母算错了（非流式把 ttfb 当生成时间等）。
 *
 * 与 UI 侧 `MEASURE_CEILING_TPS` 同值，理由同上。
 */
const MEASURE_CEILING_TPS = 1000;

/**
 * 单个请求的生成速率（tokens/s）；算不出可信值时返回 null。
 *
 * 算法逐行对齐 UI 的 `tokensPerSecOf`：分母优先用**纯生成窗口** `generateMs`，
 * 缺失时按 `durationMs` 减掉首字节 / 上游接单时间兜底；流式与非流式的兜底基准不同
 * （非流式 `ttfbMs` 等于总耗时，减它会把分母压到 0）。
 * 为什么服务端要再实现一遍：UI 包不依赖 `@modelmux/gateway`，两边各自构建。
 */
export function tokensPerSecOf(entry: {
  tokens: { completion: number | null } | null;
  durationMs?: number;
  ttfbMs?: number;
  upstreamMs?: number;
  generateMs?: number;
  stream?: boolean;
}): number | null {
  const completion = entry.tokens?.completion ?? null;
  const durationMs = entry.durationMs;
  if (completion === null || !Number.isFinite(completion) || completion <= 0) return null;
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  /** 可用的绝对耗时：必须为正且小于总耗时（非流式 ttfbMs ≈ durationMs，不裁掉分母会趋 0，口径见 docs/LOGGING.md §3.1）。 */
  const cut = (v: number | undefined): number =>
    v !== undefined && Number.isFinite(v) && v > 0 && v < durationMs ? v : 0;

  const direct = cut(entry.generateMs);
  let generateMs: number;
  if (direct > 0) {
    generateMs = direct;
  } else {
    const ttfb = cut(entry.ttfbMs);
    const upstream = cut(entry.upstreamMs);
    const base =
      entry.stream === true
        ? ttfb || upstream
        : entry.stream === false
          ? upstream
          : ttfb > 0 && upstream > 0
            ? Math.min(ttfb, upstream)
            : ttfb || upstream;
    generateMs = base > 0 ? durationMs - base : durationMs;
  }
  if (generateMs < GENERATE_FLOOR_MS) return null;
  const perSec = completion / (generateMs / 1000);
  return perSec > MEASURE_CEILING_TPS ? null : perSec;
}

// ---------------------------------------------------------------------------
// 慢请求判定（首字延迟 + 生成速率；总时长不作为判据）
// ---------------------------------------------------------------------------

/**
 * 首字 token 延迟阈值（毫秒）：**流式**请求的 `ttfbMs` 达到它即判「首字慢」。
 *
 * 实测（2026-11-05，1816 条）：流式 ttfb p95 = 4.5s、p99 = 34.5s —— 10s 落在两档之间，
 * 能抓住真异常（排队 / 上游接单卡住）又不滥发。非流式的 `ttfbMs` ≈ `durationMs`
 * （见 docs/LOGGING.md §3.1），没有判别力，不参与该判定。
 */
export const SLOW_TTFB_MS = envInt("MODELMUX_SLOW_TTFB_MS", 10_000);

/**
 * 生成速率阈值（tokens/s）：可信速率低于它即判「速率慢」。
 *
 * 实测（2026-11-05，1816 条）分布：p05 = 54 t/s —— 30 落在正常分布之外，抓的是真龟速；
 * 模型清单的「慢」标签另有口径（`model-health.ts` 的 `SLOW_TPS = 100`，长期平均），
 * 请求级用更宽的值避免把慢渠道的每条请求都标满。
 */
export const SLOW_TPS = envInt("MODELMUX_SLOW_TPS", 30);

/** 生成量下限（tokens）：少于它不判速率慢 —— 1-3 个 token 的窗口太小，速率数值天然不可信（实测 2026-11-05：tps<30 的命中里 p50 completion=3，全是 ping 类短请求）。 */
export const SLOW_MIN_COMPLETION = 20;

/** 单条请求的「慢」判定结果（两个维度独立成立，任一命中即慢）。 */
export interface SlowVerdict {
  /** 首 token 延迟超标（仅流式参与判定）。 */
  slowTtfb: boolean;
  /** 生成速率超标（可信速率 < `SLOW_TPS` 且生成量 ≥ `SLOW_MIN_COMPLETION`）。 */
  slowTps: boolean;
  /** slowTtfb 或 slowTps。 */
  slow: boolean;
}

/**
 * 单条请求的「慢」判定：**首字 token 延迟 + 生成速率**；总时长不作为判据 ——
 * 输出长同样会拉长总时长（2026-11-05 实测：总时长 ≥30s 的 94 条里 89 条只是长输出）。
 *
 * 写路径（`slow.log` 副本）与读路径（历史行重算）共用这一份 —— 历史日志没有
 * 重写机会，但读出来时按当前口径重算，展示与统计自动统一。
 */
export function slowVerdictOf(input: {
  stream?: boolean;
  ttfbMs?: number;
  durationMs?: number;
  upstreamMs?: number;
  generateMs?: number;
  completion?: number | null;
}): SlowVerdict {
  // 首字慢只对流式有判别力：非流式 ttfbMs ≈ durationMs，减它没有意义
  const slowTtfb = input.stream === true && (input.ttfbMs ?? 0) >= SLOW_TTFB_MS;
  const tps =
    input.completion != null && input.completion >= SLOW_MIN_COMPLETION
      ? tokensPerSecOf({
          tokens: { completion: input.completion },
          durationMs: input.durationMs,
          ttfbMs: input.ttfbMs,
          upstreamMs: input.upstreamMs,
          generateMs: input.generateMs,
          stream: input.stream,
        })
      : null;
  const slowTps = tps !== null && tps < SLOW_TPS;
  return { slow: slowTtfb || slowTps, slowTtfb, slowTps };
}

/** 本地日期 `YYYY-MM-DD`（用户按本地时间看日志，不用 UTC）。 */
export function localDate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 日志根目录（供 CLI / 文档引用）。 */
export function logsRoot(): string {
  return paths.logsDir();
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * 单文件大小轮转：`name.log` → `name.1.log` → …，最多保留 `MAX_ROTATED` 份。
 * 导出给 worker stderr 等由外部 fd 写入的文件在打开前调用。
 */
export function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return;
    const limit = maxBytes();
    if (statSync(file).size < limit) return;
    for (let i = MAX_ROTATED; i >= 1; i -= 1) {
      const target = `${file}.${i}.log`;
      const source = i === 1 ? file : `${file}.${i - 1}.log`;
      if (!existsSync(source)) continue;
      if (existsSync(target)) unlinkSync(target);
      renameSync(source, target);
    }
  } catch {
    /* 轮转失败不阻塞写入（最多继续追加） */
  }
}

/** 追加一行；自动建目录、轮转、补齐换行。 */
function appendLine(file: string, line: string): void {
  try {
    ensureDir(dirname(file));
    rotateIfNeeded(file);
    const text = line.endsWith("\n") ? line : `${line}\n`;
    appendFileSync(file, text, "utf8");
  } catch {
    /* 日志是旁路，任何失败都不能影响主流程 */
  }
}

function jsonLine(record: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), ...record });
}

/** 删除超过保留期的日期目录与 `<date>.log` 文件；`cutoff` 是 epoch 毫秒。 */
function pruneDir(dir: string, cutoff: number): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        const at = new Date(`${entry.name}T00:00:00`).getTime();
        if (Number.isFinite(at) && at < cutoff) {
          try {
            rmSync(full, { recursive: true, force: true });
          } catch {
            /* 被占用则下次再清 */
          }
        }
      } else {
        pruneDir(full, cutoff);
      }
    } else if (/^\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) {
      const at = new Date(`${entry.name.slice(0, 10)}T00:00:00`).getTime();
      if (Number.isFinite(at) && at < cutoff) {
        try {
          unlinkSync(full);
        } catch {
          /* 被占用则下次再清 */
        }
      }
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 清理过期日志；每个进程每天只跑一次。 */
function pruneOnce(): void {
  const today = localDate();
  if (lastPruneDate === today) return;
  lastPruneDate = today;
  const root = logsRoot();
  try {
    // 请求正文抓取含用户 prompt 且体积大，保留期比普通日志短 —— 必须先按它清一遍，
    // 否则全局那遍（14 天）会把 payload 目录一起放过期。
    pruneDir(join(root, "payload"), Date.now() - payloadDays() * DAY_MS);
    pruneDir(root, Date.now() - retentionDays() * DAY_MS);
  } catch {
    /* 清理失败不影响日志 */
  }
}

/**
 * 写路径的慢判定（读路径 `parseAccessLine` 同一份口径）。
 *
 * `RequestLog` 的 token 数只存在 `usage` 原始对象里（`completion_tokens` / `output_tokens`），
 * 不提取成顶层 `completion` 就喂给 `slowVerdictOf` 的话，「速率慢」维度恒判不出 ——
 * `slow.log` 只剩首字慢，与读路径重算的结果分叉。
 */
function slowVerdictOfLog(log: RequestLog): SlowVerdict {
  return slowVerdictOf({ ...log, completion: tokensOf(log.usage)?.completion ?? null });
}

function appendAccessFile(outcome: AccessOutcome, record: RequestLog): void {
  pruneOnce();
  const date = localDate();
  const dir = join(logsRoot(), "access", date);
  // `firstFrameAt` / `lastFrameAt` 是生成窗口的**中间量**，落盘只保留算好的 `generateMs`，
  // 免得日志多两个没人读的绝对时刻（口径见 docs/LOGGING.md §3.1）。
  const { written: _written, firstFrameAt: _first, lastFrameAt: _last, ...payload } = record;
  appendLine(join(dir, `${outcome}.log`), JSON.stringify({ ts: new Date(record.startAt).toISOString(), ...payload }));
  if (slowVerdictOfLog(record).slow) {
    appendLine(join(dir, "slow.log"), JSON.stringify({ ts: new Date(record.startAt).toISOString(), ...payload }));
  }
  if (outcome === "failure") {
    appendError(record.message ?? record.error ?? "request failed", {
      request_id: record.id,
      status: record.status,
      model: record.model,
      cid: record.cid,
      error: record.error,
      duration_ms: record.durationMs,
      ttfb_ms: record.ttfbMs,
      upstream_ms: record.upstreamMs,
    });
  }
}

/** 写一条访问日志；响应 finish/close 时调用，幂等。 */
export function finishRequestLog(log: RequestLog, status: number): void {
  if (log.written) return;
  log.written = true;
  log.status = status;
  log.durationMs = Date.now() - log.startAt;
  // 生成窗口（首帧→末帧）：TPS 的分母。只有一个内容帧时为 0 → 不落该字段（口径上是「测不到」，
  // 不是「0 毫秒生成完」，前端据此显示 `—`）。
  if (log.firstFrameAt !== undefined && log.lastFrameAt !== undefined && log.lastFrameAt > log.firstFrameAt) {
    log.generateMs = log.lastFrameAt - log.firstFrameAt;
  }
  if (!log.outcome) {
    // 没有状态码（`status < 200`，通常为 0）= 服务端没给出结果 → 按失败记。
    // 不再单列「中断」：见 `AccessOutcome` 的说明。
    log.outcome = status >= 200 && status < 400 ? "success" : "failure";
    if (status < 200) log.error ??= "no_status";
  }
  // 成功的健康检查 / 模型轮询不记访问日志：Web 控制台每 5 秒拉一次 /v1/models，
  // 记下来只会把真正的 chat 请求淹没。失败与慢请求仍然记录。
  const routine = log.path === "/health" || log.path === "/v1/models";
  if (routine && log.outcome === "success" && !slowVerdictOfLog(log).slow) return;
  appendAccessFile(log.outcome, log);
}

/** 给响应挂上访问日志上下文；返回该上下文供调用方补充 model/cid 等字段。 */
export function attachRequestLog(method: string, path: string, res: ServerResponse): RequestLog {
  const log: RequestLog = {
    id: `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    method,
    path,
    startAt: Date.now(),
  };
  (res as WithRequestLog)[REQUEST_LOG] = log;
  try {
    if (!res.headersSent) res.setHeader("X-Request-Id", log.id);
  } catch {
    /* 头已发出的极端情况 */
  }
  let finished = false;
  res.once("finish", () => {
    finished = true;
    finishRequestLog(log, res.statusCode);
  });
  res.once("close", () => {
    if (finished) return;
    // 这里**不写 outcome**：outcome 表达的是**服务端这次请求的结果**，
    // 由 `finishRequestLog` 按状态码统一分类（2xx → success ✓）。
    // 客户端先关连接只说明「客户端不等了」—— 上游该回的已经回了（200 ✓），
    // 把它记成 other 会让「按 success.log 统计成功率」失真
    // （实测成功请求 100% 落 other.log ✓）。
    log.message ??= "client disconnected before response finished";
    finishRequestLog(log, res.statusCode);
  });
  return log;
}

/** 取当前响应的访问日志上下文（测试/非 HTTP 调用可能没有）。 */
export function getRequestLog(res: ServerResponse): RequestLog | undefined {
  return (res as WithRequestLog)[REQUEST_LOG];
}

/** 标记请求失败（HTTP 错误、流内错误、超时等）。 */
export function noteRequestError(res: ServerResponse, code: string, message: string): void {
  const log = getRequestLog(res);
  if (!log) return;
  log.outcome = "failure";
  log.error ??= code;
  log.message = message.slice(0, 800);
}

/** 标记客户端主动断开（不算服务端失败）。 */
export function noteClientDisconnect(res: ServerResponse): void {
  const log = getRequestLog(res);
  if (!log) return;
  // 同 `attachRequestLog` 的 close 分支：只留说明，**不预判 outcome** ✓
  // —— 这次请求服务端到底成没成，由状态码说话 ✓。
  log.message ??= "client disconnected";
}

/** 记录首帧耗时（只记第一次）。 */
export function noteFirstByte(res: ServerResponse): void {
  const log = getRequestLog(res);
  if (!log || log.ttfbMs !== undefined) return;
  log.ttfbMs = Date.now() - log.startAt;
}

/**
 * 记「上游第一个内容帧到达」（仅记一次）。
 *
 * 与 `noteFirstByte` 分开是刻意的：那个记的是我们**写出**首字节的时刻，非流式下要等聚合完，
 * 拿它当生成窗口的起点会把分母压到 0。本函数只回答「上游什么时候开始吐字」。
 */
export function noteFirstFrame(res: ServerResponse): void {
  const log = getRequestLog(res);
  if (!log || log.firstFrameAt !== undefined) return;
  log.firstFrameAt = Date.now() - log.startAt;
}

/** 记「上游最后一个内容帧到达」（覆盖式：取最后一次）。 */
export function noteLastFrame(res: ServerResponse): void {
  const log = getRequestLog(res);
  if (!log) return;
  log.lastFrameAt = Date.now() - log.startAt;
}

/** 记录上游响应头到达耗时。 */
export function noteUpstreamReady(res: ServerResponse): void {
  const log = getRequestLog(res);
  if (!log || log.upstreamMs !== undefined) return;
  log.upstreamMs = Date.now() - log.startAt;
}

/** 记录 token 用量（流式在 usage 帧到达时调用，非流式在聚合后调用）。 */
export function noteUsage(res: ServerResponse, usage: unknown): void {
  const log = getRequestLog(res);
  if (!log || !usage || typeof usage !== "object" || Array.isArray(usage)) return;
  log.usage = usage as Record<string, unknown>;
}

/**
 * 记「这次请求进过上游排队」（置位式：一次就够）。
 *
 * 由排队探测在**收到排队帧**时调用（`http/chat/attempt.ts::runQueueProbe`）——
 * 那是「上游明确说还在排队」的唯一事实点；用耗时反推会把慢请求误标成排队。
 */
export function noteQueued(res: ServerResponse): void {
  const log = getRequestLog(res);
  if (!log) return;
  log.queued = true;
}

/** 系统层事件（start/stop/worker spawn/restart）。 */
export function appendSystem(event: string, fields: Record<string, unknown> = {}): void {
  pruneOnce();
  appendLine(join(logsRoot(), "system", localDate(), "lifecycle.log"), jsonLine({ event, ...fields }));
}

/** worker/网关自身的普通输出（按日一个文件，避免旧 gateway.log 无限膨胀）。 */
export function appendGateway(message: string): void {
  pruneOnce();
  const stamp = new Date().toISOString();
  appendLine(join(logsRoot(), "system", localDate(), "gateway.log"), `[${stamp}] ${message}`);
}

/** 错误日志（带上下文的结构化行）。 */
export function appendError(message: string, fields: Record<string, unknown> = {}): void {
  pruneOnce();
  appendLine(join(logsRoot(), "error", localDate(), "error.log"), jsonLine({ message, ...fields }));
}

/** 渠道维度日志（渠道自查/排查用）。 */
export function appendChannel(cid: string, message: string): void {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(cid)) return;
  pruneOnce();
  const stamp = new Date().toISOString();
  appendLine(join(logsRoot(), "channels", cid, `${localDate()}.log`), `[${stamp}] ${message}`);
}

export interface LogFileInfo {
  path: string;
  size: number;
  mtime: number;
}

/** 列出日志文件（CLI `mx log --list` 用），按修改时间倒序。 */
export function listLogFiles(): LogFileInfo[] {
  const out: LogFileInfo[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          const st = statSync(full);
          out.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* 文件刚被轮转/删除 */
        }
      }
    }
  };
  walk(logsRoot());
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 某分类下最新一个包含目标文件的日期（按文件名倒序）。 */
function latestDateDir(categoryDir: string, fileName: (date: string) => string): string | null {
  let entries;
  try {
    entries = readdirSync(categoryDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dates = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const date of dates) {
    if (existsSync(fileName(date))) return date;
  }
  return null;
}

/**
 * 解析 CLI 要 tail 的日志文件。
 *
 * `kind`：access / error / system / lifecycle / worker / channel；
 * `outcome`：success / failure。未给日期时取今天，今天没有则取最新日期。
 */
export function resolveLogPath(options: {
  kind?: string;
  outcome?: AccessOutcome;
  date?: string;
  cid?: string;
}): string | null {
  const root = logsRoot();
  const kind = options.kind ?? "system";

  const pick = (category: string, file: string): string | null => {
    const categoryDir = join(root, category);
    if (options.date) {
      const candidate = join(categoryDir, options.date, file);
      return existsSync(candidate) ? candidate : null;
    }
    const today = join(categoryDir, localDate(), file);
    if (existsSync(today)) return today;
    const latest = latestDateDir(categoryDir, (date) => join(categoryDir, date, file));
    return latest ? join(categoryDir, latest, file) : null;
  };

  if (kind === "access") {
    const outcome = options.outcome ?? "success";
    return pick("access", `${outcome}.log`);
  }
  if (kind === "error") return pick("error", "error.log");
  if (kind === "lifecycle") return pick("system", "lifecycle.log");
  if (kind === "worker") return pick("system", "worker.log");
  if (kind === "channel") {
    if (!options.cid) return null;
    const categoryDir = join(root, "channels", options.cid);
    if (options.date) {
      const candidate = join(categoryDir, `${options.date}.log`);
      return existsSync(candidate) ? candidate : null;
    }
    const today = join(categoryDir, `${localDate()}.log`);
    if (existsSync(today)) return today;
    const latest = latestDateDir(categoryDir, (date) => join(categoryDir, `${date}.log`));
    return latest ? join(categoryDir, `${latest}.log`) : null;
  }
  // 默认 system：今天的 gateway/lifecycle 优先，再看历史日期
  if (!options.date) {
    const todayGateway = join(root, "system", localDate(), "gateway.log");
    if (existsSync(todayGateway)) return todayGateway;
    const todayLifecycle = join(root, "system", localDate(), "lifecycle.log");
    if (existsSync(todayLifecycle)) return todayLifecycle;
  }
  return pick("system", "gateway.log") ?? pick("system", "lifecycle.log");
}

// ─────────────────────────────────────────────────────────────────────────────
// 访问日志读回（控制台日志页）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单条访问日志的可读形态（字段语义见 docs/LOGGING.md §3.1）。
 *
 * `outcome` 取自**它所在的文件**（`success.log` / `failure.log`；旧 `other.log` 读入时按 failure）而不是行内字段：
 * 文件归属是分桶的权威事实源，行内字段只作兜底。
 */
export interface AccessEntry {
  id: string;
  ts: string;
  method?: string;
  path?: string;
  cid?: string;
  model?: string;
  /** 承接请求的账号 key（与 `cid` 一对：渠道 + 账号才能定位到具体凭据）。 */
  key?: string;
  stream?: boolean;
  status?: number;
  outcome: AccessOutcome;
  error?: string;
  message?: string;
  durationMs?: number;
  upstreamMs?: number;
  ttfbMs?: number;
  /**
   * 纯生成窗口（首帧→末帧，毫秒）；缺省 = 测不到（不是 0）。
   *
   * TPS 的分母只认它（见 `usage-stats` 之外的 `tokensPerSecOf`）——`durationMs - ttfbMs`
   * 那套减法在非流式下分母趋 0，会把几十 t/s 算成几万 t/s。
   */
  generateMs?: number;
  requestBytes?: number;
  messageCount?: number;
  systemChars?: number;
  toolCount?: number;
  /**
   * 上游 usage 归一化出的三数 + 缓存命中情况；键名依上游而异，缺则 null（失败请求通常没有）。
   * `cache` 为 null 表示**上游没给缓存字段**（与「命中 0」不同，见 docs/CACHE-HIT-RATE.md §6）；
   * `cache.miss` 按上游形态推出（`hit + miss` 即命中率分母），推不出时为 null。
   */
  tokens: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
    cache: { hit: number | null; miss: number | null } | null;
  } | null;
  /** 进过上游排队（收到过排队帧）。缺省 = 没有排队帧，不代表「没等过」。 */
  queued?: boolean;
  /**
   * 「慢」判定（读路径按当前口径重算，历史行自动跟随，见 `slowVerdictOf`）。
   * 两个维度独立成立：`slowTtfb` 首字延迟超标（仅流式）、`slowTps` 生成速率超标。
   */
  slow: boolean;
  slowTtfb: boolean;
  slowTps: boolean;
}

/**
 * 模型请求的路径集合（三种入站协议：OpenAI chat / Anthropic Messages / OpenAI Responses）。
 *
 * 日志页与用量统计都只认它们 —— `/health` 之类的非模型请求同样会落进 access 日志
 * （`http/server.ts` 只跳过 console 路径），混进来会让「调用次数 / 累计 tokens」失真。
 */
export const MODEL_REQUEST_PATHS = ["/v1/chat/completions", "/v1/messages", "/v1/responses"] as const;

/** 旧常量（OpenAI 路径）；统计口径已换成 `isModelRequestPath`。 */
export const MODEL_REQUEST_PATH = MODEL_REQUEST_PATHS[0];

/** 是否为模型请求路径（统计只看是不是模型调用，不分协议）。 */
export function isModelRequestPath(path: string | undefined): boolean {
  return path !== undefined && (MODEL_REQUEST_PATHS as readonly string[]).includes(path);
}

export interface AccessQuery {
  date?: string;
  outcome?: AccessOutcome;
  /** 精确匹配请求路径（与 `paths` 二选一）。 */
  path?: string;
  /** 精确匹配多个请求路径（日志页固定传 `MODEL_REQUEST_PATHS`，三协议一起查）。 */
  paths?: readonly string[];
  cid?: string;
  model?: string;
  stream?: boolean;
  slow?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AccessStats {
  requests: number;
  success: number;
  failure: number;
  /** 判定为慢的条数（口径见 `slowVerdictOf`）。 */
  slow: number;
  /** 其中首字延迟超标的条数（仅流式参与判定）。 */
  slowTtfb: number;
  /** 其中生成速率超标的条数。 */
  slowTps: number;
  avgDurationMs: number | null;
  /**
   * 窗口内**成功请求**的平均生成速率（tokens/s）；一条都算不出时为 null。
   *
   * 只算成功请求（口径同 `UsageModelRow.avgTps`）：失败的 usage 多为空，混进去会把
   * 速率拉成「丑但成功不了」的假象。分母是**每条速率各算一次再平均**，不是
   * `Σcompletion / Σ生成窗口` —— 后者被长请求主导，答不了「一条请求通常多快」。
   */
  avgTps: number | null;
  /** 窗口内没有 usage 的条数（失败请求通常没有），避免把缺失当成 0。 */
  noUsage: number;
  tokens: { prompt: number; completion: number; total: number };
  /**
   * 缓存命中（口径见 docs/CACHE-HIT-RATE.md §6）：`hitRate = hit / total`，且是**加权**
   * （`Σhit / Σ(hit+miss)`，不是各请求命中率的平均 —— 平均会让长请求的权重被抹平）。
   *
   * `total` = 参与计算的总输入 token（命中分母），由各上游形态归一化而来
   * （见 `cacheOf`）—— 不用 `tokens.prompt`，因为 Anthropic 风格下它不含缓存读/写。
   * 只累加**有缓存字段**的记录：上游没给字段的渠道不进分母。
   * 窗口内一条都没采集到缓存字段时 `total === 0` → `hitRate` 为 null（显示 `—`，不是 0%）。
   */
  cache: { hit: number; total: number; hitRate: number | null };
}

export interface AccessPage {
  /** 实际返回的日期（回落后的）；无任何日志时为空串。 */
  date: string;
  dates: string[];
  /** 扫描窗口内出现过的渠道（**未过滤**，供筛选下拉用，不会随筛选消失；受 `path`/`paths` 范围约束，见 `inScope`）。 */
  cids: string[];
  /** 「慢」判定的两个阈值（前端展示归因用；阈值定义见 `SLOW_TTFB_MS` / `SLOW_TPS`）。 */
  slowThresholds: { ttfbMs: number; tps: number };
  scanned: number;
  /** 尾部窗口是否被截断：true 时统计只代表窗口内，不代表全天。 */
  truncated: boolean;
  total: number;
  stats: AccessStats;
  entries: AccessEntry[];
}

/** 单文件尾部读取上限、总扫描行上限（都用于把一次查询的读盘量钉死）。 */
const ACCESS_TAIL_BYTES = 1 << 20;
const ACCESS_SCAN_LINES = 20_000;
const ACCESS_DEFAULT_LIMIT = 100;
const ACCESS_MAX_LIMIT = 500;
/**
 * 读取的三个文件（**含历史 `other.log`**）。
 *
 * 新写入只有 success / failure 两类；`other.log` 只为「旧版本落过盘的机器」保留读取，
 * 其中的行按 failure 计（见 `AccessOutcome`）。刻意**不读** `slow.log`：它是成功/失败行的
 * 并行副本（同一请求写两处），一起读会让慢请求在列表里出现两遍。
 */
const ACCESS_OUTCOMES: AccessOutcome[] = ["success", "failure"];

/** 历史「中断」桶的文件名（读到时并入 failure；不再写入）。 */
const LEGACY_OTHER_FILE = "other.log";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 从上游 `usage` 里提取**缓存命中**情况（口径见 docs/CACHE-HIT-RATE.md §6）。
 *
 * 必须**按字段形态分派**，不能把各家的别名串成一条链：缓存字段有两套互斥语义 ——
 * 「含在总输入内」（DeepSeek `prompt_cache_hit_tokens`、OpenAI `cached_tokens`）
 * 与「不含在总输入内」（Anthropic `cache_read_input_tokens`，其 `input_tokens` 明确
 * 不含缓存读/写）。混用会让后者算出接近 100% 的假命中率。
 *
 * 因此命中值取「有哪类字段」，**未命中值由该类的语义推出**，命中率恒等于
 * `hit / (hit + miss)`，无需外部再给分母：
 * ① DeepSeek：`hit` 与 `miss` 上游都给了（缺失时按 `prompt_tokens = hit + miss` 兜底）
 * ② OpenAI 风格：`cached_tokens` 是 `prompt_tokens` 的子集 → `miss = prompt_tokens - hit`
 * ③ Anthropic 风格：`cache_read_input_tokens` 是唯一命中来源，`miss = input_tokens +
 *    cache_creation_input_tokens`（写缓存不算命中；仅当没有 `input_tokens`、只有
 *    `prompt_tokens` 时才退回 `prompt - hit`）
 *
 * 写缓存字段（`cache_creation_input_tokens` / `prompt_cache_write_tokens`）语义是
 * 「为后续命中做写入」，**不算命中**；一类字段都没有时返回 null —— 不补 0，
 * 否则会把「上游没给」显示成「完全没命中」。
 */
function cacheOf(
  usage: Record<string, unknown>,
  prompt: number | null,
): { hit: number | null; miss: number | null } | null {
  const details = (usage["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  // ① DeepSeek：唯一有官方加和关系的形态，信度最高
  const dsHit = num(usage["prompt_cache_hit_tokens"]);
  if (dsHit !== undefined) {
    const miss = num(usage["prompt_cache_miss_tokens"]) ?? (prompt !== null ? Math.max(prompt - dsHit, 0) : null);
    return { hit: dsHit, miss };
  }
  // ② OpenAI / Azure：cached_tokens ⊆ prompt_tokens
  const oaHit = num(details["cached_tokens"]) ?? num(usage["cached_tokens"]);
  if (oaHit !== undefined) {
    return { hit: oaHit, miss: prompt !== null ? Math.max(prompt - oaHit, 0) : null };
  }
  // ③ Anthropic 风格：`input_tokens` **不含**缓存读/写（官方口径：总输入 = 三者之和）
  const anRead = num(usage["cache_read_input_tokens"]);
  const anWrite = num(usage["cache_creation_input_tokens"]);
  if (anRead !== undefined || anWrite !== undefined) {
    const hit = anRead ?? 0;
    const input = num(usage["input_tokens"]);
    if (input !== undefined) {
      // 写缓存不算命中，但它是总输入的一部分
      return { hit, miss: input + (anWrite ?? 0) };
    }
    // 只有 `prompt_tokens`（代理把独占的输入塞进了这个名字）：无法与「含在总输入内」区分，
    // 按该字段自洽解释（miss = prompt - hit），免得凭空放大分母
    return { hit, miss: prompt !== null ? Math.max(prompt - hit, 0) : null };
  }
  return null;
}

/** 从上游 `usage` 里防御性提取 token 数（键名依上游而异，兼容 input/output 命名）。 */
function tokensOf(usage: unknown): AccessEntry["tokens"] {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const pick = (...names: string[]): number | null => {
    for (const name of names) {
      const value = num(u[name]);
      if (value !== undefined) return value;
    }
    return null;
  };
  const prompt = pick("prompt_tokens", "input_tokens");
  const completion = pick("completion_tokens", "output_tokens");
  const total =
    pick("total_tokens") ??
    (prompt !== null && completion !== null ? prompt + completion : null);
  if (prompt === null && completion === null && total === null) return null;
  return { prompt, completion, total, cache: cacheOf(u, prompt) };
}

/**
 * 读文件**尾部**最多 `maxBytes` 字节。
 *
 * 起点落在行中间时丢掉残缺的首行（半行解析必然失败，留着只会污染结果）；
 * 读不到（并发轮转 / 删除 / 锁）按 `truncated` 上报 —— 读日志绝不能反过来影响主流程，
 * 但也不能把「读不到」伪装成「没有」。
 */
function readTail(file: string, maxBytes: number): { text: string; truncated: boolean } {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return { text: "", truncated: false };
    fd = openSync(file, "r");
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl < 0) return { text: "", truncated: true };
      text = text.slice(nl + 1);
      return { text, truncated: true };
    }
    return { text, truncated: false };
  } catch {
    // 读失败（锁 / 轮转 / 权限）**不能当成空文件**：那样这一天的统计会静默少算，
    // 页面也不显示「统计只覆盖窗口内」的横幅。置 `truncated` 让残缺可见。
    return { text: "", truncated: true };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 某 outcome 在指定日期要读的文件，按**时间正序**返回。
 *
 * 必须带上轮转文件：单文件超 10MB 后当天早期的行被挤到 `.1.log`…`.3.log`，
 * 只读 `<outcome>.log` 会丢掉当天的前半段。
 */
function accessFiles(date: string, outcome: AccessOutcome): string[] {
  const base = join(logsRoot(), "access", date, `${outcome}.log`);
  const out: string[] = [];
  for (let i = MAX_ROTATED; i >= 1; i -= 1) {
    const rotated = `${base}.${i}.log`;
    if (existsSync(rotated)) out.push(rotated);
  }
  if (existsSync(base)) out.push(base);
  return out;
}

/** 历史 `other.log`（含轮转）—— 只在读取时并入 failure，不再写入。 */
function legacyOtherFiles(date: string): string[] {
  const base = join(logsRoot(), "access", date, LEGACY_OTHER_FILE);
  const out: string[] = [];
  for (let i = MAX_ROTATED; i >= 1; i -= 1) {
    const rotated = `${base}.${i}.log`;
    if (existsSync(rotated)) out.push(rotated);
  }
  if (existsSync(base)) out.push(base);
  return out;
}

/** `access/` 下真正有日志的日期，倒序（新的在前）。 */
export function listAccessDates(): string[] {
  const dir = join(logsRoot(), "access");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .filter(
      (date) =>
        ACCESS_OUTCOMES.some((o) => existsSync(join(dir, date, `${o}.log`))) ||
        existsSync(join(dir, date, LEGACY_OTHER_FILE)),
    )
    .sort()
    .reverse();
}

/**
 * **全量**逐条访问日志（不走 `queryAccessLogs` 的扫描字节 / 行数上限）。
 *
 * 与 `queryAccessLogs` 的分工：那个服务交互式分页（要快、允许截断），本函数服务
 * **统计聚合**（要全、宁慢）—— 截断会让「累计 tokens」这类数字直接错。
 * 调用方自己负责节流与缓存（见 `usage-stats.ts`）。
 *
 * 返回**读失败被跳过**的文件数：调用方（统计聚合）据此避免把残缺结果缓存成
 * 「该日的真实累计」—— 文件被锁 / 正在轮转只是暂时的，缓存却是进程级的。
 */
/** 速率聚合样本（路由优先级用；只留和与条数，不留原始行）。 */
export interface TpsSample {
  sum: number;
  count: number;
}

/** 一次速率聚合的结果：按（渠道 × 模型）与按渠道两个维度。 */
export interface ModelTpsAggregate {
  /** 键 = `<cid>/<模型>`。 */
  byModel: Map<string, TpsSample>;
  byChannel: Map<string, TpsSample>;
}

/**
 * 聚合最近几天模型请求的**实测速率**（路由优先级用，见 `pool-usage.speedOf`）。
 *
 * 为什么不复用 `queryAccessLogs`：那个服务交互式分页（排序 + 统计 + 缓存），
 * 而且 `limit` 会按「最近 N 条」截断 —— 忙渠道一天的量上千，会把一天只有几条的
 * 慢渠道整个挤出样本（实测 qodercn 11-05 的 3 条就被 500 条窗口挡在外面）。
 * 本函数只读**尾部 1MB**（与 `queryAccessLogs` 同量）并按天遍历，只累加速度，
 * 不做排序 / 统计 / 缓存 —— 忙渠道占不满慢渠道的样本。
 *
 * 读失败的日子直接跳过（不抛）：速度是**先验**，缺一天不影响路由可用性。
 */
export function aggregateModelTps(days: readonly string[]): ModelTpsAggregate {
  const byModel = new Map<string, TpsSample>();
  const byChannel = new Map<string, TpsSample>();
  const add = (map: Map<string, TpsSample>, key: string, tps: number): void => {
    const prev = map.get(key);
    if (prev === undefined) map.set(key, { sum: tps, count: 1 });
    else {
      prev.sum += tps;
      prev.count += 1;
    }
  };
  for (const date of days) {
    for (const outcome of ACCESS_OUTCOMES) {
      for (const file of accessFiles(date, outcome)) {
        const tail = readTail(file, ACCESS_TAIL_BYTES);
        for (const line of tail.text.split("\n")) {
          if (line.trim() === "") continue;
          const entry = parseAccessLine(line, outcome);
          if (entry === null || entry.cid === undefined) continue;
          const tps = tokensPerSecOf(entry);
          if (tps === null) continue;
          add(byChannel, entry.cid, tps);
          if (entry.model !== undefined) add(byModel, `${entry.cid}/${entry.model}`, tps);
        }
      }
    }
  }
  return { byModel, byChannel };
}

export function scanAccessDate(date: string, visit: (entry: AccessEntry) => void): number {
  let skipped = 0;
  for (const outcome of ACCESS_OUTCOMES) {
    for (const file of accessFiles(date, outcome)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        skipped += 1; // 正在轮转 / 被删 / 被杀毒软件短暂锁定：跳过，不让整次统计失败
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const entry = parseAccessLine(line, outcome);
        if (entry) visit(entry);
      }
    }
  }
  // 历史「中断」桶：按 failure 计入（不再写入，只为旧机器上已落盘的正文保留可见性）
  for (const file of legacyOtherFiles(date)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const entry = parseAccessLine(line, "failure");
      if (entry) visit(entry);
    }
  }
  return skipped;
}

function parseAccessLine(line: string, outcome: AccessOutcome): AccessEntry | null {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    // 文件正在被追加：末行可能是半行。跳过它，不让整页失败。
    return null;
  }
  const id = str(raw["id"]);
  if (!id) return null;
  const durationMs = num(raw["durationMs"]);
  const stream = bool(raw["stream"]);
  const ttfbMs = num(raw["ttfbMs"]);
  const upstreamMs = num(raw["upstreamMs"]);
  const generateMs = num(raw["generateMs"]);
  const tokens = tokensOf(raw["usage"]);
  // 「慢」在**读路径重算**：行内的历史口径不回改，展示与统计恒按当前判据（首字延迟 + 生成速率）。
  // 历史行因此自动跟随新口径，不需要迁移。
  const verdict = slowVerdictOf({
    stream,
    ttfbMs,
    upstreamMs,
    generateMs,
    durationMs,
    completion: tokens?.completion ?? null,
  });
  const entry: AccessEntry = {
    id,
    ts: str(raw["ts"]) ?? "",
    outcome,
    tokens,
    ...verdict,
  };
  const cid = str(raw["cid"]);
  if (cid !== undefined) entry.cid = cid;
  const method = str(raw["method"]);
  if (method !== undefined) entry.method = method;
  const path = str(raw["path"]);
  if (path !== undefined) entry.path = path;
  const model = str(raw["model"]);
  if (model !== undefined) entry.model = model;
  const key = str(raw["key"]);
  if (key !== undefined) entry.key = key;
  if (stream !== undefined) entry.stream = stream;
  const status = num(raw["status"]);
  if (status !== undefined) entry.status = status;
  const error = str(raw["error"]);
  if (error !== undefined) entry.error = error;
  const message = str(raw["message"]);
  if (message !== undefined) entry.message = message;
  if (durationMs !== undefined) entry.durationMs = durationMs;
  if (upstreamMs !== undefined) entry.upstreamMs = upstreamMs;
  if (ttfbMs !== undefined) entry.ttfbMs = ttfbMs;
  if (generateMs !== undefined) entry.generateMs = generateMs;
  const requestBytes = num(raw["requestBytes"]);
  if (requestBytes !== undefined) entry.requestBytes = requestBytes;
  const messageCount = num(raw["messageCount"]);
  if (messageCount !== undefined) entry.messageCount = messageCount;
  const systemChars = num(raw["systemChars"]);
  if (systemChars !== undefined) entry.systemChars = systemChars;
  const toolCount = num(raw["toolCount"]);
  if (toolCount !== undefined) entry.toolCount = toolCount;
  const queued = bool(raw["queued"]);
  if (queued !== undefined) entry.queued = queued;
  return entry;
}

/**
 * 查询某天的访问日志。
 *
 * 读量有界：每个 outcome 文件只读尾部 1MB、总扫描行数上限 2 万 —— 超限时
 * `truncated=true`，调用方据此把统计口径标注成「窗口内」，而不是假装是全量。
 * 给出的 `stats`（与 `cids`）基于**未过滤**的扫描窗口（当天概览），`total` 才是筛选后的
 * 条数；两组数字唯一的范围差别是**路径**：统计只覆盖 `path` / `paths` 声明的范围
 * （否则分段计数会把列表永远显示不出来的非模型请求算进去，见 `inScope`）。
 */
export function queryAccessLogs(query: AccessQuery = {}): AccessPage {
  const dates = listAccessDates();
  const date = query.date !== undefined && dates.includes(query.date) ? query.date : (dates[0] ?? "");
  const limit = Math.min(Math.max(1, query.limit ?? ACCESS_DEFAULT_LIMIT), ACCESS_MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);
  const stats: AccessStats = {
    requests: 0,
    success: 0,
    failure: 0,
    slow: 0,
    slowTtfb: 0,
    slowTps: 0,
    avgDurationMs: null,
    avgTps: null,
    noUsage: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    cache: { hit: 0, total: 0, hitRate: null },
  };
  const slowThresholds = { ttfbMs: SLOW_TTFB_MS, tps: SLOW_TPS };
  if (!date) {
    return { date: "", dates, cids: [], slowThresholds, scanned: 0, truncated: false, total: 0, stats, entries: [] };
  }

  const scanned: AccessEntry[] = [];
  let truncated = false;
  let scannedLines = 0;
  let durationSum = 0;
  let durationCount = 0;
  let tpsSum = 0;
  let tpsCount = 0;
  /**
   * 统计是否覆盖这条记录：只认调用方声明的**范围**（路径 + 渠道）。
   *
   * 日志页与总览都传 `MODEL_REQUEST_PATHS`，但 access 日志里还有 `/health`、`/v1/models`
   * 的失败与慢请求，以及浏览器探测（`GET /.well-known/appspecific/com.chrome.devtools.json`
   * 404）。把它们计进统计，统计条就会说「请求 230」而列表只有 229 条，筛选分段的
   * 「失败 1」点进去还一条都没有（2026-11-06 实测，分段计数与列表必须同源）。
   * 不传路径时统计覆盖全部（CLI / 排障要全量）。
   *
   * 渠道同理：统计条是「当前筛选下的这一批请求」的画像 —— 选了某个渠道，成功率 /
   * 慢 / 平均 TPS 就该是那个渠道的，否则换渠道时这几个数纹丝不动，读者会以为统计没生效。
   */
  const inScope = (path: string | undefined, cid: string | undefined): boolean =>
    (query.path === undefined || path === query.path) &&
    (query.paths === undefined || query.paths.includes(path ?? "")) &&
    (query.cid === undefined || cid === query.cid);
  /**
   * 下拉用的渠道集合：只受**路径**范围约束，不受 `cid` 约束 ——
   * 否则选中某个渠道后，下拉里只剩它自己，用户没法再切回别的渠道。
   */
  const pathInScope = (path: string | undefined): boolean =>
    (query.path === undefined || path === query.path) &&
    (query.paths === undefined || query.paths.includes(path ?? ""));
  const seenCids = new Set<string>();
  // 历史 other.log 并入 failure 一起扫（新写入不再产生，只覆盖旧机器上已有的行）
  const buckets: Array<{ outcome: AccessOutcome; files: string[] }> = [
    ...ACCESS_OUTCOMES.map((outcome) => ({ outcome, files: accessFiles(date, outcome) })),
    { outcome: "failure" as const, files: legacyOtherFiles(date) },
  ];
  scan: for (const { outcome, files } of buckets) {
    for (const file of files) {
      const tail = readTail(file, ACCESS_TAIL_BYTES);
      if (tail.truncated) truncated = true;
      for (const line of tail.text.split("\n")) {
        if (line.trim() === "") continue;
        // 行数上限按**读到的行**算（不是进统计的行）：不然后半程全是范围外记录时，
        // 读量只受单文件字节上限约束，行数护栏形同虚设
        if (scannedLines >= ACCESS_SCAN_LINES) {
          truncated = true;
          break scan;
        }
        scannedLines += 1;
        const entry = parseAccessLine(line, outcome);
        if (!entry) continue;
        // 渠道下拉先收（路径范围内全部渠道），再按 cid 收口统计
        if (pathInScope(entry.path) && entry.cid !== undefined) seenCids.add(entry.cid);
        if (!inScope(entry.path, entry.cid)) continue;
        scanned.push(entry);
        stats.requests += 1;
        stats[outcome] += 1;
        if (entry.slow) stats.slow += 1;
        if (entry.slowTtfb) stats.slowTtfb += 1;
        if (entry.slowTps) stats.slowTps += 1;
        if (entry.durationMs !== undefined) {
          durationSum += entry.durationMs;
          durationCount += 1;
        }
        // 平均速率只采成功请求的样本（口径与 `usage-stats` 的 `avgTps` 一致）
        if (outcome === "success") {
          const tps = tokensPerSecOf(entry);
          if (tps !== null) {
            tpsSum += tps;
            tpsCount += 1;
          }
        }
        if (entry.tokens === null) {
          stats.noUsage += 1;
        } else {
          stats.tokens.prompt += entry.tokens.prompt ?? 0;
          stats.tokens.completion += entry.tokens.completion ?? 0;
          stats.tokens.total += entry.tokens.total ?? 0;
          // 缓存命中只统计**有字段**的记录（无字段的渠道不该拉低整体命中率）
          const cache = entry.tokens.cache;
          // miss 缺失说明这条连分母都推不出来（上游既没给 prompt_tokens 也没给 miss 字段）
          // → 不进分母，避免把「只剩命中」当成 100%
          if (cache?.hit !== null && cache?.hit !== undefined && cache.miss !== null) {
            stats.cache.hit += cache.hit;
            stats.cache.total += cache.hit + cache.miss;
          }
        }
      }
    }
  }
  stats.avgDurationMs = durationCount > 0 ? Math.round(durationSum / durationCount) : null;
  stats.avgTps = tpsCount > 0 ? tpsSum / tpsCount : null;
  stats.cache.hitRate = stats.cache.total > 0 ? stats.cache.hit / stats.cache.total : null;

  const cids = [...seenCids].sort();

  const needle = query.q?.toLowerCase();
  // `path` / `paths` 已在扫描时由 `inScope` 收口（统计与列表同一范围），这里不再重复判定 ——
  // 同一个「二选一」契约写两处，改一处就会让两边口径静默分叉
  const matched = scanned.filter((e) => {
    if (query.outcome !== undefined && e.outcome !== query.outcome) return false;
    if (query.cid !== undefined && e.cid !== query.cid) return false;
    if (query.stream !== undefined && e.stream !== query.stream) return false;
    if (query.slow === true && !e.slow) return false;
    if (query.model !== undefined && !(e.model ?? "").toLowerCase().includes(query.model.toLowerCase())) {
      return false;
    }
    if (needle !== undefined && needle !== "") {
      const hay = `${e.id} ${e.model ?? ""} ${e.error ?? ""} ${e.message ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  // 倒序：`ts` 是请求开始时刻；同毫秒内按 id 兜底，保证顺序稳定（分页不会抖）。
  matched.sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : -1) : a.ts < b.ts ? 1 : -1));

  return {
    date,
    dates,
    cids,
    slowThresholds,
    scanned: scanned.length,
    truncated,
    total: matched.length,
    stats,
    entries: matched.slice(offset, offset + limit),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 请求正文抓取（默认开启，偏好可关 —— 见 docs/LOGGING.md §9）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次请求的正文记录（形状与落盘行一致，`ts` / `seq` 由写入时补）。
 *
 * `body` 存**原样文本**（不解析成对象）：既忠实反映「构造了什么」，又让界面在能
 * `JSON.parse` 时按消息渲染、截断时降级成原文。客户端发的字节不是合法 UTF-8 时
 * （Windows GBK 控制台输出被原样塞进 JSON 等），呈现按替换符，原样字节仍在
 * 压缩块里无损保存 —— 损坏在源头，不在存储。
 */
export interface PayloadRecord {
  ts: string;
  /** 进程内单调序号：`ts` 只到毫秒，同毫秒多条靠它稳定排序。 */
  seq: number;
  id: string;
  phase: string;
  attempt?: number;
  cid?: string;
  model?: string;
  stream?: boolean;
  bytes: number;
  truncated: boolean;
  body: string;
  /** 正文存储形态（`plain` / `zstd` / `gzip`）；空串 = 旧行（等价 plain）。 */
  bodyEnc?: string;
  /** 原始字节里无效 UTF-8 序列覆盖的字节数（0 缺省 = 全部有效或旧行未统计）。 */
  invalidBytes?: number;
}

/**
 * 单条抓取上限：10MB —— agent 会话上下文（系统提示 + 多轮 + 工具结果）实测 1-8MB 级，
 * 256KB 老值几乎必然截断、最新对话全丢。超限走双端兜底（见 clipPayload）。
 */
const DEFAULT_PAYLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_PAYLOAD_DAYS = 3;

function payloadDays(): number {
  return envInt("MODELMUX_LOG_PAYLOAD_DAYS", DEFAULT_PAYLOAD_DAYS);
}

function payloadMaxBytes(): number {
  return envInt("MODELMUX_LOG_PAYLOAD_MAX_BYTES", DEFAULT_PAYLOAD_MAX_BYTES);
}

/** 渠道白名单；未设置 = 全部渠道都抓。 */
function payloadCids(): string[] | null {
  const raw = process.env["MODELMUX_LOG_PAYLOAD_CIDS"];
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return list.length > 0 ? list : null;
}

/**
 * 数无效 UTF-8 序列覆盖的**字节**数（WHATWG 状态机）。孤立续字节、坏第二字节、
 * overlong / 代理区 / 越界头与 `toString("utf8")` 的替换符一一对应；截断的
 * 不完整序列按「首字节 + 合法续字节前缀」整段计坏 —— 字节覆盖口径，数量可
 * 多于呈现层的替换符数（不完整序列只顶出一个 FFFD）。
 */
export function countInvalidUtf8(buf: Buffer): number {
  let bad = 0;
  let i = 0;
  while (i < buf.length) {
    const b0 = buf[i]!;
    let need: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (b0 < 0x80) {
      i += 1;
      continue;
    }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      lower = b0 === 0xe0 ? 0xa0 : 0x80;
      upper = b0 === 0xed ? 0x9f : 0xbf;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      lower = b0 === 0xf0 ? 0x90 : 0x80;
      upper = b0 === 0xf4 ? 0x8f : 0xbf;
    } else {
      // 0x80-0xbf 孤立续字节、0xc0/0xc1 overlong 头、0xf5-0xff
      bad += 1;
      i += 1;
      continue;
    }
    const b1 = i + 1 < buf.length ? buf[i + 1]! : -1;
    if (b1 < lower || b1 > upper) {
      // 首字节带不出合法第二字节：首字节坏，从下一个字节重试
      bad += 1;
      i += 1;
      continue;
    }
    let ok = true;
    for (let k = 2; k <= need; k += 1) {
      if (i + k >= buf.length || (buf[i + k]! & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
    }
    if (ok) {
      i += need + 1;
      continue;
    }
    // 截断或中途坏：首字节 + 合法续字节前缀都算坏字节
    let consumed = 2;
    while (consumed <= need && i + consumed < buf.length && (buf[i + consumed]! & 0xc0) === 0x80) {
      consumed += 1;
    }
    bad += consumed;
    i += consumed;
  }
  return bad;
}

/** clipPayload 的产物：字节直通（不 lossy），附带溯源统计。 */
interface ClippedPayload {
  /** 双端保留后的字节（未截断时即全量原字节）。 */
  data: Buffer;
  bytes: number;
  truncated: boolean;
  invalidBytes: number;
}

/**
 * 截断到单条上限：超过时**双端保留**（头尾各半），而不是保头弃尾 ——
 * agent 会话的最新消息（排查重点）在尾部，截旧尾等于没截在点子上。
 *
 * 返回**字节**而非字符串：客户端发的坏字节（GBK 等）必须原样进压缩块，
 * 在这里 toString 就永远找不回来了（2026-11-07 实测 meta bytes:107 vs 落盘 119）。
 */
function clipPayload(body: Buffer | string): ClippedPayload {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const max = payloadMaxBytes();
  if (buf.length <= max) {
    return { data: buf, bytes: buf.length, truncated: false, invalidBytes: countInvalidUtf8(buf) };
  }
  const note = Buffer.from(
    `\n\n…（请求体超 ${(max / 1024 / 1024).toFixed(0)}MB，仅保留首尾；共 ${buf.length} 字节）…\n\n`,
    "utf8",
  );
  // 头尾各 max/2（note 叠加在外）：上限被测试调到极小时 note 反超预算，
  // 从预算里扣会让 half 变负 —— 保头尾语义优先于落盘体严格 ≤ max
  const half = Math.max(1, Math.floor(max / 2));
  const data = Buffer.concat([
    buf.subarray(0, half),
    note,
    buf.subarray(buf.length - half),
  ]);
  // invalidBytes 只认**全量原文**的无效字节：自家切点劈开的合法字符不是「客户端发的坏字节」，
  // 按半段各自扫描会把切点悬空前缀错记进来（评审 2026-11-07）
  return {
    data,
    bytes: buf.length,
    truncated: true,
    invalidBytes: countInvalidUtf8(buf),
  };
}

let payloadSeq = 0;
let payloadPermDate = "";

/**
 * 正文压缩的形态标记（落盘用；读回时按它解码）。
 *
 * `plain` 是**向后兼容**的那一支：改造前落盘的行走的也是它（那些行连标记都没有，
 * 只有 `body` 字符串）。
 */
type BodyEncoding = "zstd" | "gzip" | "plain";

/** 小于这个长度不值得压缩：压缩后还要 base64，体积可能反而变大。 */
const PAYLOAD_COMPRESS_MIN_BYTES = 4096;

/**
 * 分块压缩的块大小（明文字节）。
 *
 * 为什么是 1 MiB：块越小存储开销越大 —— 实测（3.77 MB 真实正文）256K 块比整条压缩
 * 多 15.5%、512K 多 10.5%、1M 只多 5.4%；而读取路径按块解压，1 MiB 的块解一次
 * 仍是毫秒级。dsh 的会话日志按「每个 append batch 一帧」，本仓的 batch 就是整条正文，
 * 单帧会把「取一片 64 KiB」逼成「解压全量」，所以这里把一条正文切成多帧。
 */
const PAYLOAD_CHUNK_BYTES = 1024 * 1024;

const hasZstd = (): boolean => typeof zlib.zstdCompressSync === "function";

interface PackedBody {
  body?: string;
  bodyEnc?: BodyEncoding;
  bodyB64?: string;
  bodyChunks?: string[];
  /** 各块**解压后**的字节数（与 `bodyChunks` 一一对应）；读取侧靠它定位块号。 */
  bodyChunkLens?: number[];
  /** 原始字节的无效 UTF-8 计数（仅 >0 时落盘；旧行无此字段）。 */
  invalidBytes?: number;
}

/**
 * 把正文压成可内联进 JSON 行的形态。
 *
 * 输入是**字节**（clipPayload 的产物）：合法 UTF-8 的小正文维持 plain 字符串
 * （与旧行同形态），其余一律走压缩 —— 无效字节（GBK 等）只能活在这个分支里，
 * 任何「先转字符串」的动作都会把它们顶成替换符、原样字节永久丢失。
 *
 * `invalidBytes` 省略时自动检测（compact 重编码路径复用）；appendPayload 路径
 * clipPayload 已经算过，显式传入免第二次扫描。
 *
 * 为什么不学 dsh 做「内容寻址 blob + 去重」：实测本仓库 payload 的重复率是 **0**
 * （2 天 114 条正文，唯一 114 条；client 与 upstream 正文也无一字节相同），
 * 去重只多出一层目录与必须配套的 GC，收益为零。压缩才是这里的真实杠杆
 * （实测 agent 上下文正文 2.9x，见 docs/LOGGING.md §9）。
 *
 * 大正文按 `PAYLOAD_CHUNK_BYTES` 切成多帧（dsh 式）：读取按块局部解码，
 * 取一片不必解全量 —— 这是「上下文弹窗分片读取」的后端前提。
 */
function packBody(data: Buffer, invalidBytes?: number): PackedBody {
  const bad = invalidBytes ?? countInvalidUtf8(data);
  const mark = bad > 0 ? { invalidBytes: bad } : {};
  if (data.length < PAYLOAD_COMPRESS_MIN_BYTES && bad === 0) {
    return { body: data.toString("utf8"), bodyEnc: "plain" };
  }
  const enc: BodyEncoding = hasZstd() ? "zstd" : "gzip";
  const pack = (chunk: Buffer): Buffer =>
    enc === "zstd" ? zlib.zstdCompressSync(chunk) : zlib.gzipSync(chunk);
  const chunks: Buffer[] = [];
  const lens: number[] = [];
  for (let off = 0; off < data.length; off += PAYLOAD_CHUNK_BYTES) {
    const slice = data.subarray(off, Math.min(off + PAYLOAD_CHUNK_BYTES, data.length));
    chunks.push(pack(slice));
    lens.push(slice.length);
  }
  // 单块时直接落整帧（与旧行形态一致，省一层字段）；多块才走 bodyChunks
  if (chunks.length === 1) return { bodyEnc: enc, bodyB64: chunks[0]!.toString("base64"), ...mark };
  // 每块**明文长度**：读取侧据此算出 `total` 并直接定位命中的块号，
  // 从而只解压需要的那几块（不落这个数组就只能解全部块才知道边界）。
  return {
    bodyEnc: enc,
    bodyChunks: chunks.map((c) => c.toString("base64")),
    bodyChunkLens: lens,
    ...mark,
  };
}

/** 解码 `packBody` 的产物为**字节**；旧行的纯 `body`（字符串）由调用方自己转。 */
function unpackBody(rec: PackedBody): Buffer | null {
  const decode = (b64: string): Buffer | null => {
    try {
      const buf = Buffer.from(b64, "base64");
      if (rec.bodyEnc === "zstd") return (hasZstd() ? zlib.zstdDecompressSync(buf) : null);
      if (rec.bodyEnc === "gzip") return zlib.gunzipSync(buf);
      return null;
    } catch {
      // 解不开（外因截断/损坏）→ 交给调用方当作「无正文」，绝不让读日志把接口打挂
      return null;
    }
  };
  const parts: Buffer[] = [];
  if (rec.bodyChunks) {
    for (const b64 of rec.bodyChunks) {
      const part = typeof b64 === "string" ? decode(b64) : null;
      // 任一块损坏就整条作废：拼接出的正文会比真实内容「看起来完整实则缺段」，更坑
      if (!part) return null;
      parts.push(part);
    }
  } else if (rec.bodyB64) {
    const part = decode(rec.bodyB64);
    if (!part) return null;
    parts.push(part);
  } else {
    return null;
  }
  return Buffer.concat(parts);
}

/** appendPayload 的输入：元数据 + clipPayload 的字节产物（body 形态由 packBody 决定）。 */
type AppendPayloadInput = Omit<PayloadRecord, "ts" | "seq" | "body" | "bodyEnc"> & ClippedPayload;

function appendPayload(record: AppendPayloadInput): void {
  try {
    const date = localDate();
    const dir = join(logsRoot(), "payload", date);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (payloadPermDate !== date) {
      payloadPermDate = date;
      // 含用户 prompt，权限压到 0700/0600（POSIX 语义；Windows 上 chmod 作用有限）。
      enforcePermissions(logsRoot(), dir);
    }
    pruneOnce();
    const file = join(dir, "payload.log");
    rotateIfNeeded(file);
    payloadSeq += 1;
    const { data, bytes, truncated, invalidBytes, ...rest } = record;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq: payloadSeq,
      ...rest,
      bytes,
      truncated,
      ...packBody(data, invalidBytes),
    });
    appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    /* 抓包是旁路，写失败绝不影响请求 */
  }
}

/**
 * 记录**客户端发来的原始请求体**。
 *
 * 在请求校验通过后**立即**调用（不等响应）：上游失败、超时、客户端断连时，
 * 上下文照样留得住 —— 而那几类恰恰最需要看「客户端到底发了什么」。
 *
 * 此刻路由还没解析出渠道，故 `cid` 可能缺席；`model` 已是客户端原样串。
 */
export function noteClientPayload(res: ServerResponse, raw: Buffer): void {
  const log = getRequestLog(res);
  if (!log) return;
  appendPayload({ id: log.id, phase: "client", ...(log.model ? { model: log.model } : {}), ...clipPayload(raw) });
}

/**
 * 记录**真正发往上游的请求体**（已过渠道归一化 / 翻译 / `prepareChat` 前置）。
 *
 * 在 fetch **之前**调用：超时与建连失败时这条记录就是唯一的「我发了什么」证据。
 * 账号池重试会产生多条（`attempt` 递增），界面按尝试分组展示。
 */
export function noteUpstreamPayload(
  res: ServerResponse,
  info: { cid: string; model: string; stream: boolean; attempt: number },
  body: Buffer | string,
): void {
  const log = getRequestLog(res);
  if (!log) return;
  const allow = payloadCids();
  if (allow !== null && !allow.includes(info.cid)) return;
  appendPayload({
    id: log.id,
    phase: "upstream",
    attempt: info.attempt,
    cid: info.cid,
    model: info.model,
    stream: info.stream,
    ...clipPayload(body),
  });
}

/**
 * 就地压缩**已封存**的抓取轮转段（`payload.log.1.log`…`.3.log`）。
 *
 * 只动封存段：活跃段随时可能被并发追加，而本项目**没有文件锁**，
 * 重写它有丢记录的窗口。新写入的正文本就走压缩（见 `packBody`），
 * 这里的价值全在**改造前落盘的存量**（实测 82MB 里约 76MB 在封存段）。
 *
 * 重编码是**全形态**的：明文压成块、单帧旧行重切成分块 —— 让存量也吃到
 * 「读取按块局部解码」的红利（dsh 的帧结构天生如此，存量该重写到同一形态）。
 *
 * 写临时文件再 `rename`（同目录内原子替换）；任何一步失败都保留原文件。
 */
export function compactPayloads(): { files: number; before: number; after: number } {
  const result = { files: 0, before: 0, after: 0 };
  for (const date of payloadDates()) {
    const base = join(logsRoot(), "payload", date, "payload.log");
    for (let i = MAX_ROTATED; i >= 1; i -= 1) {
      const file = `${base}.${i}.log`;
      if (!existsSync(file)) continue;
      const saved = compactPayloadFile(file);
      if (saved === null) continue;
      result.files += 1;
      result.before += saved.before;
      result.after += saved.after;
    }
  }
  return result;
}

/** 压缩单个封存段；无可压缩内容或失败返回 null。 */
function compactPayloadFile(file: string): { before: number; after: number } | null {
  try {
    const before = statSync(file).size;
    const text = readFileSync(file, "utf8");
    const out: string[] = [];
    let migrated = 0; // 单帧 → 分块的重编码数：零迁移说明该段没有改写价值
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let raw: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          out.push(line);
          continue;
        }
        raw = parsed as Record<string, unknown>;
      } catch {
        // 半行（写入时被打断）原样留着：不猜、不丢
        out.push(line);
        continue;
      }
      // 统一取字节：明文行（含历史 FFFD 的字符串，本身是合法 UTF-8）与压缩行一致处理，
      // invalidBytes 由 packBody 自动检测 —— 无效字节的行重编码后标注不丢
      const data =
        typeof raw["body"] === "string"
          ? Buffer.from(raw["body"], "utf8")
          : unpackBody(raw as PackedBody);
      if (data === null) {
        out.push(line);
        continue;
      }
      // 单帧行重编码为分块；重压后仍是单帧（不足两块）就原样保留（无收益不冒险）
      const repacked = packBody(data);
      if (repacked.bodyChunks === undefined) {
        out.push(line);
        continue;
      }
      const { body: _b, bodyEnc: _e, bodyB64: _x, bodyChunks: _c, invalidBytes: _i, ...rest } = raw;
      migrated += 1;
      out.push(JSON.stringify({ ...rest, ...repacked }));
    }
    const next = Buffer.from(`${out.join("\n")}\n`, "utf8");
    // 重编码的目标是「读取按块局部解码」，体积略涨（实测 +3.5%，分块压缩率损失）
    // 是接受的成本 —— 与明文压缩那次不同，这里的判据是**形态迁移完成**而非变小；
    // 零迁移（该段没有单帧行可转）时没有改写价值，别动文件。
    if (migrated === 0) return null;
    const tmp = `${file}.compact`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, file);
    return { before, after: next.length };
  } catch {
    return null;
  }
}

/** `logs/payload/` 下有内容的日期，倒序。 */
function payloadDates(): string[] {
  const dir = join(logsRoot(), "payload");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .filter((date) => existsSync(join(dir, date, "payload.log")))
    .sort()
    .reverse();
}

/** 某天的抓取文件，按时间正序（轮转文件在前）。 */
function payloadFiles(date: string): string[] {
  const base = join(logsRoot(), "payload", date, "payload.log");
  const out: string[] = [];
  for (let i = MAX_ROTATED; i >= 1; i -= 1) {
    const rotated = `${base}.${i}.log`;
    if (existsSync(rotated)) out.push(rotated);
  }
  if (existsSync(base)) out.push(base);
  return out;
}

function parsePayloadLine(line: string, withBody = true): PayloadRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const id = str(raw["id"]);
    if (!id) return null;
    const rec: PayloadRecord = {
      ts: str(raw["ts"]) ?? "",
      seq: num(raw["seq"]) ?? 0,
      id,
      phase: str(raw["phase"]) ?? "unknown",
      bytes: num(raw["bytes"]) ?? 0,
      truncated: bool(raw["truncated"]) ?? false,
      // 新行把正文压进 bodyChunks / bodyB64（按 bodyEnc 解码）；旧行直接是 body 字符串。
      // 三种形态都要能读 —— 已落盘的正文按保留期陪着老版本一起走完。
      // 呈现按 UTF-8 文本（无效字节显示替换符）；原样字节留在压缩块里无损。
      //
      // `withBody=false` 时**跳过解压**：解压是这条读路径上唯一的重量级操作
      // （实测单行 1.2 MB 压缩 → 数 MB 明文），而列表与首屏只需要元数据。
      body: withBody
        ? str(raw["body"]) ?? unpackBody(raw as PackedBody)?.toString("utf8") ?? ""
        : "",
      bodyEnc: str(raw["bodyEnc"]) || (str(raw["body"]) ? "plain" : ""),
    };
    const attempt = num(raw["attempt"]);
    if (attempt !== undefined) rec.attempt = attempt;
    const invalid = num(raw["invalidBytes"]);
    if (invalid !== undefined && invalid > 0) rec.invalidBytes = invalid;
    const cid = str(raw["cid"]);
    if (cid !== undefined) rec.cid = cid;
    const model = str(raw["model"]);
    if (model !== undefined) rec.model = model;
    const stream = bool(raw["stream"]);
    if (stream !== undefined) rec.stream = stream;
    return rec;
  } catch {
    return null;
  }
}

/** 本地日期 `date` 的前一天（payload 查找窗口用；正确处理跨月/跨年）。 */
function previousDay(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  if (Number.isNaN(at.getTime())) return date;
  at.setDate(at.getDate() - 1);
  return localDate(at);
}

/**
 * 按请求 id 读回抓取记录（控制台「上下文」弹窗用）。
 *
 * 查找窗口必须**跨两天**：抓取记录落在「写入时刻」的日期文件，访问日志行却落在
 * 「响应结束」的日期文件 —— 跨午夜的长请求两边会分家（23:58 开始的流式请求，
 * 正文在当晚、访问行在次日）。而抓取只发生在解析与发送时，必不晚于响应结束
 * （请求生命周期受上游空闲超时约束，远短于一天），所以给定日期时连**前一天**一起扫即完备；
 * 不给日期则在保留期内全查。
 *
 * 读回不受开关门控：关闭只停止新增，已落盘的记录在保留期内仍可核对。`enabled` 仍然返回，
 * 供调用方在「没有任何记录」时措辞（是「没开抓取」还是「这条没抓到」）。
 */
export function readPayloads(
  id: string,
  date?: string,
  options: { withBody?: boolean } = {},
): PayloadRecord[] {
  if (id === "") return [];
  const withBody = options.withBody ?? true;
  const days = date !== undefined && date !== "" ? [date, previousDay(date)] : payloadDates();
  const found: PayloadRecord[] = [];
  for (const day of days) {
    for (const file of payloadFiles(day)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line === "" || !line.includes(id)) continue;
        const rec = parsePayloadLine(line, withBody);
        if (rec && rec.id === id) found.push(rec);
      }
    }
  }
  // client 记录恒先于 upstream 写入，`ts`（带毫秒）本身就是正确顺序；同毫秒再按 seq。
  found.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
  return found;
}

/** 分片读取的默认片大小（64 KiB：一帧内可渲染，且不足以拖慢首屏）。 */
export const PAYLOAD_SLICE_BYTES = 64 * 1024;

/**
 * 找到目标记录并返回**原始压缩块**（不解压）。
 *
 * 供分片读取按块定位：三种落盘形态统一成块序列 —— 明文 `body` 视作一块未压缩、
 * 单帧 `bodyB64` 一块、分块 `bodyChunks` 多块。
 * `lens` 是各块明文长度（**新写入的多块行才有**）：有它就能只解命中块，
 * 没有（旧行）则读取侧退回解全部块。找不到记录返回 `null`。
 */
function locatePayloadChunks(
  id: string,
  date: string | undefined,
  phase: string | undefined,
): { enc: string; chunks: string[]; plain: boolean; lens: number[] | null } | null {
  for (const day of date !== undefined && date !== "" ? [date, previousDay(date)] : payloadDates()) {
    for (const file of payloadFiles(day)) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line === "" || !line.includes(id)) continue;
        const rec = parsePayloadLine(line, false);
        if (!rec || rec.id !== id) continue;
        if (phase !== undefined && rec.phase !== phase) continue;
        let raw: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          raw = (parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {}) as Record<string, unknown>;
        } catch {
          continue;
        }
        // 明文行（旧格式）：`parsePayloadLine(…, false)` 会把 body 置空，这里从原始行取
        if (typeof raw["body"] === "string") {
          if (raw["body"] === "") continue;
          return { enc: "plain", chunks: [raw["body"]], plain: true, lens: null };
        }
        const chunks = Array.isArray(raw["bodyChunks"])
          ? raw["bodyChunks"].filter((c): c is string => typeof c === "string")
          : typeof raw["bodyB64"] === "string"
            ? [raw["bodyB64"] as string]
            : [];
        if (chunks.length === 0) continue;
        // 块长数组必须与块数一致才可用（半行 / 手工改过的行不给乱定位的机会）
        const rawLens = Array.isArray(raw["bodyChunkLens"]) ? raw["bodyChunkLens"] : null;
        const lens =
          rawLens !== null &&
          rawLens.length === chunks.length &&
          rawLens.every((n) => typeof n === "number" && n >= 0)
            ? (rawLens as number[])
            : null;
        return { enc: rec.bodyEnc ?? "zstd", chunks, plain: false, lens };
      }
    }
  }
  return null;
}

/**
 * 按字节窗口读取某条记录的正文分片。
 *
 * 为什么需要它：单条正文解压后可达 MB 级，首屏塞整段会把弹窗拖到秒级。
 * 调用方先取元数据（`withBody: false`），再按 `offset`/`limit` 逐片取正文。
 *
 * 落盘是**分块的**（dsh 式多帧，`PAYLOAD_CHUNK_BYTES` 一块）。新写入的多块行带
 * `bodyChunkLens`（各块明文长度），于是 `total` 直接由它累加、块号由 `offset` 定位，
 * **只解压命中窗口覆盖的那几块**；旧行没有这个数组，退回「解全部块」的慢路径
 *（实测 4.2 MB / 5 块：只解命中块 2.3 ms，解全部 10.5 ms）。
 *
 * 输出是 **base64**：分片窗口常落在多字节字符中间，如果这里转字符串再传，
 * 接缝就会劈出替换符（且 UI 侧无法复原）；字节交给 UI 拼齐后一次性解码，
 * 接缝问题在字节层自然消失。`offset` / `length` / `total` 恒为字节
 *（明文行也转字节后再切，旧实现按字符切是另一处乱码源）。
 *
 * @param phase 指定取哪一份（`client` / `upstream`）；不指定则取第一条有正文的记录。
 * @returns `{ offset, length, total, bodyB64 }`；未命中返回 `null`
 */
export function readPayloadSlice(
  id: string,
  date: string | undefined,
  phase: string | undefined,
  offset = 0,
  limit = PAYLOAD_SLICE_BYTES,
): { offset: number; length: number; total: number; bodyB64: string } | null {
  const located = locatePayloadChunks(id, date, phase);
  if (!located) return null;
  // 明文行（旧格式 / <4KB）：字符串本身是合法 UTF-8，转字节后与压缩块同一套几何
  if (located.plain) {
    const raw = Buffer.from(located.chunks[0] ?? "", "utf8");
    const start = Math.max(0, Math.min(offset, raw.length));
    const end = Math.max(start, Math.min(start + limit, raw.length));
    return {
      offset: start,
      length: end - start,
      total: raw.length,
      bodyB64: raw.subarray(start, end).toString("base64"),
    };
  }
  const decode = (b64: string): Buffer | null => {
    try {
      const buf = Buffer.from(b64, "base64");
      if (located.enc === "zstd") return hasZstd() ? zlib.zstdDecompressSync(buf) : null;
      if (located.enc === "gzip") return zlib.gunzipSync(buf);
      return null;
    } catch {
      // 解不开（外因截断/损坏）→ 当作无正文，绝不让读日志把接口打挂
      return null;
    }
  };
  // 快路径：块长齐备 → total 免解压，且只解命中窗口覆盖的块。
  // 边界仍按块解压后再裁：块内偏移是精确的，跨块窗口由相邻两块拼出。
  if (located.lens !== null) {
    const lens = located.lens;
    const total = lens.reduce((sum, n) => sum + n, 0);
    const start = Math.max(0, Math.min(offset, total));
    const end = Math.max(start, Math.min(start + limit, total));
    let acc = Buffer.alloc(0);
    let chunkStart = 0;
    for (let i = 0; i < located.chunks.length; i += 1) {
      const size = lens[i] ?? 0;
      const chunkEnd = chunkStart + size;
      if (chunkEnd > start && chunkStart < end) {
        const part = decode(located.chunks[i]!);
        // 命中的块解不开就整片作废：拼接出的正文会「看起来完整实则缺段」，更坑
        if (!part) return null;
        const hitStart = Math.max(start, chunkStart);
        const hitEnd = Math.min(end, chunkEnd);
        acc = Buffer.concat([acc, part.subarray(hitStart - chunkStart, hitEnd - chunkStart)]);
      }
      chunkStart = chunkEnd;
      if (chunkStart >= end) break;
    }
    return { offset: start, length: end - start, total, bodyB64: acc.toString("base64") };
  }
  // 慢路径（旧行无块长）：解全部块累加 total —— 只把命中区间拼进结果。
  let total = 0;
  let accumulated = Buffer.alloc(0);
  let hit = false;
  for (const b64 of located.chunks) {
    const part = decode(b64);
    if (!part) return null;
    const chunkStart = total;
    total += part.length;
    const hitStart = Math.max(offset, chunkStart);
    const hitEnd = Math.min(offset + limit, total);
    if (hitEnd > hitStart) {
      accumulated = Buffer.concat([
        accumulated,
        part.subarray(hitStart - chunkStart, hitEnd - chunkStart),
      ]);
      hit = true;
    }
  }
  if (!hit) return null;
  const start = Math.max(0, Math.min(offset, total));
  return { offset: start, length: Math.min(limit, total - start), total, bodyB64: accumulated.toString("base64") };
}
