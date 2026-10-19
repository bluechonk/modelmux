/**
 * 运行日志落盘：按「类型 / 日期 / 结果」分文件，绝不把所有日志堆进一个文件。
 *
 * 布局（见 docs/LOGGING.md）：
 *
 *   <root>/logs/
 *   ├── access/<YYYY-MM-DD>/{success,failure,other,slow}.log
 *   ├── error/<YYYY-MM-DD>/error.log
 *   ├── system/<YYYY-MM-DD>/{gateway,lifecycle,worker}.log
 *   └── channels/<cid>/<YYYY-MM-DD>.log
 *
 * 规则：
 * - 每类文件独立大小上限（默认 10MB），超限轮转 `<name>.1.log` … 最多保留 3 份；
 * - 日期目录按本地时区切分，默认保留 14 天，过期目录在当日首次写入时清理；
 * - 所有写入 best-effort：日志失败绝不影响请求。
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";

import * as paths from "./paths.js";

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

/** 删除超过保留期的日期目录/文件；每个进程每天只跑一次。 */
function pruneOnce(): void {
  const today = localDate();
  if (lastPruneDate === today) return;
  lastPruneDate = today;
  const root = logsRoot();
  const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;

  const pruneDir = (dir: string): void => {
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
          pruneDir(full);
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
  };

  try {
    pruneDir(root);
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
    log.outcome ??= "other";
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
  log.outcome = "other";
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
