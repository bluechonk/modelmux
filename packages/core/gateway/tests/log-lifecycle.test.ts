/**
 * 访问日志的写生命周期：attachRequestLog 挂上下文 → noteX 打点 → finish/close 落盘。
 *
 * 用最小假 ServerResponse（EventEmitter + statusCode + headersSent）驱动真实落盘，
 * 钉死三条语义：按状态码分桶、客户端先断不预判结果、/health 成功不记（慢与失败例外）。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
  attachRequestLog,
  localDate,
  noteClientDisconnect,
  noteFirstByte,
  noteFirstFrame,
  noteLastFrame,
  noteQueued,
  noteRequestError,
  noteUpstreamReady,
  noteUsage,
  queryAccessLogs,
  MODEL_REQUEST_PATHS,
} from "../dist/runtime/log-store.js";

const HOME = mkdtempSync(join(tmpdir(), "modelmux-log-lifecycle-"));
process.env["MODELMUX_HOME"] = HOME;

/** 最小假响应：attachRequestLog 只需要 once / headersSent / setHeader / statusCode。 */
function fakeRes(status = 200): EventEmitter & { statusCode: number; headersSent: boolean; setHeader: (k: string, v: string) => void; headers: Record<string, string> } {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; setHeader: (k: string, v: string) => void; headers: Record<string, string> };
  res.statusCode = status;
  res.headersSent = false;
  res.headers = {};
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  return res;
}

interface FakeLog {
  id: string;
  path: string;
  outcome?: string;
  error?: string;
  message?: string;
  ttfbMs?: number;
  upstreamMs?: number;
  queued?: boolean;
  usage?: Record<string, unknown>;
}

function logLine(file: string): FakeLog[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as FakeLog);
}

function accessDir(): string {
  return join(HOME, "logs", "access", localDate());
}

beforeEach(() => {
  rmSync(accessDir(), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(accessDir(), { recursive: true, force: true });
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("attachRequestLog：上下文与请求头", () => {
  it("生成 req_ id、挂 X-Request-Id 响应头", () => {
    const res = fakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    assert.match(log.id, /^req_[0-9a-f]{16}$/);
    assert.equal(res.headers["X-Request-Id"], log.id);
    assert.equal(log.path, "/v1/chat/completions");
  });

  it("headersSent 时不再写响应头（不抛异常）", () => {
    const res = fakeRes();
    res.headersSent = true;
    const log = attachRequestLog("GET", "/v1/models", res);
    assert.equal(res.headers["X-Request-Id"], undefined);
    assert.equal(log.id.startsWith("req_"), true);
  });
});

describe("打点函数", () => {
  it("firstByte 只记第一次；firstFrame/lastFrame/upstreamReady/queued/usage 各就各位", () => {
    const res = fakeRes();
    const log = attachRequestLog("POST", "/v1/chat/completions", res) as FakeLog;
    noteFirstByte(res);
    const first = log.ttfbMs;
    noteFirstByte(res);
    assert.equal(log.ttfbMs, first, "ttfb 只记第一次");
    noteFirstFrame(res);
    noteLastFrame(res);
    noteUpstreamReady(res);
    noteQueued(res);
    noteUsage(res, { prompt_tokens: 3, completion_tokens: 5 });
    noteUsage(res, { prompt_tokens: 7, completion_tokens: 9 });
    assert.ok(log.upstreamMs !== undefined);
    assert.equal(log.queued, true);
    assert.deepEqual(log.usage, { prompt_tokens: 7, completion_tokens: 9 }, "usage 覆盖式：最终帧为准");
    // 形状不对的 usage 不覆盖
    noteUsage(res, "garbage");
    noteUsage(res, [1, 2]);
    noteUsage(res, null);
    assert.deepEqual(log.usage, { prompt_tokens: 7, completion_tokens: 9 });
  });
});

describe("finish 落盘：按状态码分桶", () => {
  it("2xx/3xx → success.log；≥400 → failure.log；没写状态码（0）→ other.log", () => {
    for (const [status, file] of [[200, "success.log"], [502, "failure.log"], [0, "other.log"]] as const) {
      const res = fakeRes(status);
      attachRequestLog("POST", "/v1/chat/completions", res);
      res.emit("finish");
      assert.ok(existsSync(join(accessDir(), file)), `${status} 必须落 ${file}`);
    }
  });

  it("没有 outcome 的 2xx 健康检查不记日志；失败与慢例外", () => {
    const health = fakeRes(200);
    attachRequestLog("GET", "/health", health);
    health.emit("finish");
    assert.equal(existsSync(join(accessDir(), "success.log")), false, "/health 成功不进访问日志");

    const failed = fakeRes(503);
    attachRequestLog("GET", "/health", failed);
    failed.emit("finish");
    assert.ok(existsSync(join(accessDir(), "failure.log")), "/health 失败要记");
  });

  it("模型轮询 /v1/models 的成功同样静默", () => {
    const res = fakeRes(200);
    attachRequestLog("GET", "/v1/models", res);
    res.emit("finish");
    assert.equal(existsSync(join(accessDir(), "success.log")), false);
    assert.ok(MODEL_REQUEST_PATHS.length > 0);
  });
});

describe("close 落盘：客户端先断不预判结果", () => {
  it("未 finish 就 close：状态码 200 仍按 success 记，并留 disconnect 说明", async () => {
    const res = fakeRes(200);
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    noteClientDisconnect(res);
    res.emit("close");
    assert.match(log.message ?? "", /client disconnected/);
    const page = queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 10 });
    assert.equal(page.entries[0]?.outcome, "success", "断开只说明客户端不等了，结果由状态码说话");
    assert.equal(page.entries[0]?.message, log.message);
  });

  it("finish 之后的 close 不重复落盘", () => {
    const res = fakeRes(200);
    attachRequestLog("POST", "/v1/chat/completions", res);
    res.emit("finish");
    res.emit("close");
    const page = queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 10 });
    assert.equal(page.total, 1);
  });
});

describe("noteRequestError：失败标记与消息截断", () => {
  it("标记 outcome=failure + error code，超长消息截到 800", () => {
    const res = fakeRes(500);
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    noteRequestError(res, "upstream_error", "x".repeat(2000));
    res.emit("finish");
    assert.equal(log.outcome, "failure");
    assert.equal(log.error, "upstream_error");
    assert.equal(log.message?.length, 800);
  });

  it("没有日志上下文时全部打点都是空操作", () => {
    const res = fakeRes(200);
    noteRequestError(res, "x", "y");
    noteClientDisconnect(res);
    noteFirstByte(res);
    noteFirstFrame(res);
    noteLastFrame(res);
    noteUpstreamReady(res);
    noteQueued(res);
    noteUsage(res, {});
    res.emit("finish");
    assert.equal(queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 10 }).total, 0);
  });
});

describe("慢请求并行副本", () => {
  it("流式 + 首字 90s：条目进 slow.log，且不与主文件重复计数", () => {
    const res = fakeRes(200);
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    log["stream"] = true;
    log["model"] = "deepseek-v4.1-flash";
    log["cid"] = "lifecycle";
    log["ttfbMs"] = 90_000;
    log["durationMs"] = 91_000;
    log["usage"] = { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 };
    res.emit("finish");
    const slowPath = join(accessDir(), "slow.log");
    assert.ok(existsSync(slowPath), "慢请求必须有并行副本");
    const slowLines = logLine(slowPath);
    assert.equal(slowLines.length, 1);
    const page = queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 10 });
    assert.equal(page.total, 1, "slow.log 是副本不是第二份记录");
    assert.equal(page.entries[0]?.slow, true);
    assert.equal(page.entries[0]?.slowTtfb, true);
    assert.equal(page.entries[0]?.slowTps, false, "40 tokens / 1s ≈ 40 t/s，速率维度不慢");
  });

  it("速率慢也进 slow.log（写路径必须从 usage 提取 completion，与读路径同一口径）", () => {
    const res = fakeRes(200);
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    log["stream"] = true;
    log["model"] = "deepseek-v4.1-flash";
    log["cid"] = "lifecycle";
    log["ttfbMs"] = 500;
    // durationMs 由 finish 时钟算出 —— 把 startAt 前移出 3s 的假窗口
    log["startAt"] = Date.now() - 3_000;
    // 60 tokens / 2.5s = 24 t/s < 30（生成量 60 ≥ 20，可信窗口）
    log["usage"] = { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 };
    res.emit("finish");
    const slowPath = join(accessDir(), "slow.log");
    assert.ok(existsSync(slowPath), "24 t/s < 30，必须进 slow.log");
    assert.equal(logLine(slowPath).length, 1);
    const page = queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 10 });
    assert.equal(page.entries[0]?.slow, true);
    assert.equal(page.entries[0]?.slowTtfb, false, "首字 500ms 正常");
    assert.equal(page.entries[0]?.slowTps, true, "速率维度单独成立");
  });

  it("读路径重算走新口径：总时长 60s 但速率 154 t/s → 不判慢（旧口径必误判）", () => {
    const res = fakeRes(200);
    const log = attachRequestLog("POST", "/v1/chat/completions", res);
    log["stream"] = true;
    log["model"] = "deepseek-v4.1-flash";
    log["cid"] = "lifecycle";
    log["ttfbMs"] = 1_500;
    log["startAt"] = Date.now() - 60_000;
    log["usage"] = { prompt_tokens: 1000, completion_tokens: 9000, total_tokens: 10000 };
    res.emit("finish");
    assert.equal(existsSync(join(accessDir(), "slow.log")), false, "长输出但快，不进 slow.log");
    const page = queryAccessLogs({ paths: MODEL_REQUEST_PATHS, limit: 10 });
    assert.equal(page.entries[0]?.slow, false);
    assert.equal(page.entries[0]?.slowTtfb, false);
    assert.equal(page.entries[0]?.slowTps, false);
  });
});
