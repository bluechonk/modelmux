/**
 * 运行日志落盘与读回：按「类型 / 日期 / 结果」分文件，绝不把所有日志堆进一个文件
 * （文件清单见 docs/LOGGING.md §2，轮转与保留见 §6）。
 *
 * 规则：
 *  - 每类文件独立大小上限（默认 10MB），超限轮转 `<name>.1.log` … 最多保留 3 份
 *  - 日期目录按本地时区切分，默认保留 14 天，过期目录在当日首次写入时清理
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
} from "node:fs";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";

import * as paths from "./paths.js";
import { enforcePermissions } from "./permissions.js";
import { readRootPrefs, writeRootPrefs } from "./root-prefs.js";

export type AccessOutcome = "success" | "failure" | "other";

/** 单请求的访问日志上下文；由 HTTP 层创建，响应结束时落盘。 */
export interface RequestLog {
  id: string;
  method: string;
  path: string;
  startAt: number;
  model?: string;
  cid?: string;
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
  usage?: Record<string, unknown>;
  requestBytes?: number;
  messageCount?: number;
  systemChars?: number;
  toolCount?: number;
  written?: boolean;
}

const REQUEST_LOG = Symbol("modelmux.requestLog");

type WithRequestLog = ServerResponse & { [REQUEST_LOG]?: RequestLog };

const MAX_ROTATED = 3;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_SLOW_MS = 30_000;

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

function slowMs(): number {
  return envInt("MODELMUX_SLOW_MS", DEFAULT_SLOW_MS);
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

function appendAccessFile(outcome: AccessOutcome, record: RequestLog): void {
  pruneOnce();
  const date = localDate();
  const dir = join(logsRoot(), "access", date);
  const { written: _written, ...payload } = record;
  appendLine(join(dir, `${outcome}.log`), JSON.stringify({ ts: new Date(record.startAt).toISOString(), ...payload }));
  if ((record.durationMs ?? 0) >= slowMs()) {
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
  if (!log.outcome) {
    log.outcome = status >= 400 ? "failure" : status >= 200 ? "success" : "other";
  }
  // 成功的健康检查 / 模型轮询不记访问日志：Web 控制台每 5 秒拉一次 /v1/models，
  // 记下来只会把真正的 chat 请求淹没。失败与慢请求仍然记录。
  const routine = log.path === "/health" || log.path === "/v1/models";
  if (routine && log.outcome === "success" && (log.durationMs ?? 0) < slowMs()) return;
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
    // ⚠ 这里**不写 outcome**：outcome 表达的是**服务端这次请求的结果**，
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
 * `outcome`：success / failure / other。未给日期时取今天，今天没有则取最新日期。
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
 * `outcome` 取自**它所在的文件**（`success.log` / `failure.log` / `other.log`）而不是行内字段：
 * 文件归属是分桶的权威事实源，行内字段只作兜底。
 */
export interface AccessEntry {
  id: string;
  ts: string;
  method?: string;
  path?: string;
  cid?: string;
  model?: string;
  stream?: boolean;
  status?: number;
  outcome: AccessOutcome;
  error?: string;
  message?: string;
  durationMs?: number;
  upstreamMs?: number;
  ttfbMs?: number;
  requestBytes?: number;
  messageCount?: number;
  systemChars?: number;
  toolCount?: number;
  /** 上游 usage 归一化出的三数；键名依上游而异，缺则 null（失败请求通常没有）。 */
  tokens: { prompt: number | null; completion: number | null; total: number | null } | null;
  /** 耗时达慢阈值 —— 与 `slow.log` 同一判据，不另设标准。 */
  slow: boolean;
}

export interface AccessQuery {
  date?: string;
  outcome?: AccessOutcome;
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
  other: number;
  slow: number;
  avgDurationMs: number | null;
  /** 窗口内没有 usage 的条数（失败请求通常没有），避免把缺失当成 0。 */
  noUsage: number;
  tokens: { prompt: number; completion: number; total: number };
}

export interface AccessPage {
  /** 实际返回的日期（回落后的）；无任何日志时为空串。 */
  date: string;
  dates: string[];
  /** 扫描窗口内出现过的渠道（**未过滤**，供筛选下拉用，不会随筛选消失）。 */
  cids: string[];
  slowMs: number;
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
 * 只读这三个文件。
 *
 * ⚠ 刻意**不读** `slow.log`：它是成功/失败行的**并行副本**（同一请求写两处），
 * 一起读会让慢请求在列表里出现两遍。
 */
const ACCESS_OUTCOMES: AccessOutcome[] = ["success", "failure", "other"];

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
  return { prompt, completion, total };
}

/**
 * 读文件**尾部**最多 `maxBytes` 字节。
 *
 * 起点落在行中间时丢掉残缺的首行（半行解析必然失败，留着只会污染结果）；
 * 文件被并发轮转/删除时返回空 —— 读日志绝不能反过来影响主流程。
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
    return { text: "", truncated: false };
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
 * ⚠ 必须带上轮转文件：单文件超 10MB 后当天早期的行被挤到 `.1.log`…`.3.log`，
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
    .filter((date) => ACCESS_OUTCOMES.some((o) => existsSync(join(dir, date, `${o}.log`))))
    .sort()
    .reverse();
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
  const entry: AccessEntry = {
    id,
    ts: str(raw["ts"]) ?? "",
    outcome,
    tokens: tokensOf(raw["usage"]),
    slow: (durationMs ?? 0) >= slowMs(),
  };
  const cid = str(raw["cid"]);
  if (cid !== undefined) entry.cid = cid;
  const method = str(raw["method"]);
  if (method !== undefined) entry.method = method;
  const path = str(raw["path"]);
  if (path !== undefined) entry.path = path;
  const model = str(raw["model"]);
  if (model !== undefined) entry.model = model;
  const stream = bool(raw["stream"]);
  if (stream !== undefined) entry.stream = stream;
  const status = num(raw["status"]);
  if (status !== undefined) entry.status = status;
  const error = str(raw["error"]);
  if (error !== undefined) entry.error = error;
  const message = str(raw["message"]);
  if (message !== undefined) entry.message = message;
  if (durationMs !== undefined) entry.durationMs = durationMs;
  const upstreamMs = num(raw["upstreamMs"]);
  if (upstreamMs !== undefined) entry.upstreamMs = upstreamMs;
  const ttfbMs = num(raw["ttfbMs"]);
  if (ttfbMs !== undefined) entry.ttfbMs = ttfbMs;
  const requestBytes = num(raw["requestBytes"]);
  if (requestBytes !== undefined) entry.requestBytes = requestBytes;
  const messageCount = num(raw["messageCount"]);
  if (messageCount !== undefined) entry.messageCount = messageCount;
  const systemChars = num(raw["systemChars"]);
  if (systemChars !== undefined) entry.systemChars = systemChars;
  const toolCount = num(raw["toolCount"]);
  if (toolCount !== undefined) entry.toolCount = toolCount;
  return entry;
}

/**
 * 查询某天的访问日志。
 *
 * 读量有界：每个 outcome 文件只读尾部 1MB、总扫描行数上限 2 万 —— 超限时
 * `truncated=true`，调用方据此把统计口径标注成「窗口内」，而不是假装是全量。
 * 给出的 `stats` 基于**未过滤**的扫描窗口（当天概览），`total` 才是筛选后的条数。
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
    other: 0,
    slow: 0,
    avgDurationMs: null,
    noUsage: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
  };
  if (!date) {
    return { date: "", dates, cids: [], slowMs: slowMs(), scanned: 0, truncated: false, total: 0, stats, entries: [] };
  }

  const scanned: AccessEntry[] = [];
  let truncated = false;
  let durationSum = 0;
  let durationCount = 0;
  scan: for (const outcome of ACCESS_OUTCOMES) {
    for (const file of accessFiles(date, outcome)) {
      const tail = readTail(file, ACCESS_TAIL_BYTES);
      if (tail.truncated) truncated = true;
      for (const line of tail.text.split("\n")) {
        if (line.trim() === "") continue;
        if (scanned.length >= ACCESS_SCAN_LINES) {
          truncated = true;
          break scan;
        }
        const entry = parseAccessLine(line, outcome);
        if (!entry) continue;
        scanned.push(entry);
        stats.requests += 1;
        stats[outcome] += 1;
        if (entry.slow) stats.slow += 1;
        if (entry.durationMs !== undefined) {
          durationSum += entry.durationMs;
          durationCount += 1;
        }
        if (entry.tokens === null) {
          stats.noUsage += 1;
        } else {
          stats.tokens.prompt += entry.tokens.prompt ?? 0;
          stats.tokens.completion += entry.tokens.completion ?? 0;
          stats.tokens.total += entry.tokens.total ?? 0;
        }
      }
    }
  }
  stats.avgDurationMs = durationCount > 0 ? Math.round(durationSum / durationCount) : null;

  const cids = [...new Set(scanned.map((e) => e.cid).filter((c): c is string => c !== undefined))].sort();

  const needle = query.q?.toLowerCase();
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
    slowMs: slowMs(),
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
 * `JSON.parse` 时按消息渲染、截断时降级成原文。
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
}

const DEFAULT_PAYLOAD_MAX_BYTES = 256 * 1024;
const DEFAULT_PAYLOAD_DAYS = 3;

/**
 * 正文抓取开关：读根级偏好（`<root>/prefs.json`），**默认开启**。
 *
 * 每次现读而不缓存 —— 控制台的开关必须不重启就生效（这是「落盘的偏好」相对
 * 环境变量的全部意义）；文件只有几十字节，一次请求多两次读不值一提。
 */
export function payloadCaptureEnabled(): boolean {
  return readRootPrefs().payload_capture;
}

/** 设置正文抓取开关（控制台的开关按钮）：写盘，重启保持。返回生效值。 */
export function setPayloadCaptureEnabled(enabled: boolean): boolean {
  writeRootPrefs({ ...readRootPrefs(), payload_capture: enabled });
  return enabled;
}

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
 * 截断到单条上限。
 *
 * 截断可能切在 UTF-8 中间（会产生替换字符）—— 这是刻意的取舍：抓包的价值在
 * 「看到构造」，为了一个字符去做边界对齐不划算；`truncated` 已经如实标注。
 */
function clipPayload(body: Buffer | string): Pick<PayloadRecord, "body" | "bytes" | "truncated"> {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const max = payloadMaxBytes();
  return {
    body: buf.subarray(0, max).toString("utf8"),
    bytes: buf.length,
    truncated: buf.length > max,
  };
}

let payloadSeq = 0;
let payloadPermDate = "";

function appendPayload(record: Omit<PayloadRecord, "ts" | "seq">): void {
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
    const line = JSON.stringify({ ts: new Date().toISOString(), seq: payloadSeq, ...record });
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
  if (!log || !payloadCaptureEnabled()) return;
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
  if (!log || !payloadCaptureEnabled()) return;
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

function parsePayloadLine(line: string): PayloadRecord | null {
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
      body: typeof raw["body"] === "string" ? raw["body"] : "",
    };
    const attempt = num(raw["attempt"]);
    if (attempt !== undefined) rec.attempt = attempt;
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
export function readPayloads(id: string, date?: string): { enabled: boolean; records: PayloadRecord[] } {
  const enabled = payloadCaptureEnabled();
  if (id === "") return { enabled, records: [] };
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
        const rec = parsePayloadLine(line);
        if (rec && rec.id === id) found.push(rec);
      }
    }
  }
  // client 记录恒先于 upstream 写入，`ts`（带毫秒）本身就是正确顺序；同毫秒再按 seq。
  found.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
  return { enabled, records: found };
}
